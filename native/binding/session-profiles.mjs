// native/binding/session-profiles.mjs —— 把 `--profile-kind` 接到**真会话**上
//
// ## 为什么需要这一层(证据,不是设计洁癖)
//
// `native/bin/launch-args.mjs` 早就解析并校验 `--profile-kind`,但 `git grep profileKind`
// 全仓只命中它自己(+ 它的测试)—— **没有任何下游消费者**。`createOuUutRuntime()` 被调用时
// 没传 `profiles`,于是 `listProfiles()` 恒返回硬编码的单条 `{id:"default",name:"默认档案"}`。
// 换句话说:`archive.mjs` 的三种 kind 与两层硬隔离**从来没上过真链路** ——
// 「三种 kind 各起一次」只会得到三个一模一样的会话,什么都证明不了。本文件是那条缺失的接线。
//
// ## kind → 浏览器侧的映射
//
// Chrome 的 **browser context** 就是「一个用户数据目录里的一个隔离 cookie/storage 池」:
//
//   | kind         | 浏览器侧                                              | 持久化 |
//   |--------------|-------------------------------------------------------|--------|
//   | `real`       | **默认 browser context**(不发 `createBrowserContext`)| 由 `--user-data-dir` 决定 |
//   | `persona`    | `Target.createBrowserContext { disposeOnDetach:false }`| 留在该 user-data-dir 里 |
//   | `disposable` | `Target.createBrowserContext { disposeOnDetach:true }` | 不留痕(detach 即销毁) |
//
// **按档案绑代理(F13)**:`Target.createBrowserContext` 支持 `proxyServer` / `proxyBypassList`
// (Chromium 156 源码:`content/browser/devtools/protocol/target_handler.cc` 的 `CreateBrowserContext`),
// 所以 persona/disposable 的出口是**context 级**的 —— 同一个浏览器里两个档案走两个出口。
// ⚠️ `real` 用的是**默认 context**,没有地方给它挂 `proxyServer`;它的出口只能靠浏览器级
// `--proxy-server`(见 `launch-args.mjs` 里那条按 kind 分流的规则)。
//
// 这张表与 `archive.mjs` 头部 ADR-007 的 kind 表一一对应 —— kind 的语义**只在那边定义**,
// 这里只做「把它落到 Chrome 的哪个池」这一件事,不重新发明一套。
//
// ## 为什么 kind 没给时**不**造档案引擎
//
// 不给 `--profile-kind` = 使用者没要求任何档案隔离。此时会话里只有一条默认档案,
// **不存在跨档案风险**(`archive` 的闸是为多档案准备的),所以既不该建 browser context,
// 也不该把 cookie 命令的闸打开 —— 那会把"今天能用的"变成"今天不能用的"。
// 于是 `kind === null` 直接返回 `archive: null`,运行时据此**逐字节**退回今天的行为
// (见 `ouuut-runtime.mjs` 里 `archive` 缺席时那条路)。

import { createArchive, KINDS, ArchiveError, INVALID_ARGUMENT } from "./archive.mjs";
import { assertProxyUsable, PROXY_BYPASS_LIST } from "./proxy.mjs";

/** 会话里 `real` 档案的簿记 id —— 它是机器上恰好一个的默认档案,由 `--user-data-dir` 决定。 */
const REAL_PROFILE_ID = "real";

/** 未给 kind 时的默认档案:形状与 `ouuut-runtime.mjs` 的硬编码兜底**逐字段**一致。 */
const FALLBACK_PROFILE = Object.freeze({ id: "default", name: "默认档案", isDefault: true });

/** 三种 kind 的自拟默认名(id 当名会让人看不出这是哪个档案)。 */
const DEFAULT_NAMES = Object.freeze({
  real: "真实档案",
  persona: "长期画像",
  disposable: "一次性档案",
});

/**
 * 开一次会话的档案集合。
 *
 * @param {object} o
 * @param {object} o.cdp        `spawnCdpPipe()` 的返回值(要能 `send`)
 * @param {"real"|"persona"|"disposable"|null} [o.kind] 使用者选的档案种类;null = 没选
 * @param {string|null} [o.userDataDir] 档案目录(CLI 显式给的那个;没给 = 没给)
 * @param {string|null} [o.profileId]   档案 id(不传时 persona/disposable 用 kind 当 id)
 * @param {string|null} [o.name]        档案名(不传时用 kind 的默认名)
 * @param {string|null} [o.proxy]       该会话档案的出口(`socks5://user:pass@host:port`);只给 persona/disposable
 * @returns {Promise<{archive: object|null, profiles: Array, sessionProfileId: string|null, dispose: () => Promise<void>}>}
 */
export async function openSessionProfiles({
  cdp,
  kind = null,
  userDataDir = null,
  profileId = null,
  name = null,
  proxy = null,
  /**
   * **额外**档案(双档案双出口):`[{ id?, kind, name?, proxy? }]`。
   * 每个都会拿到自己的 browser context(因而可以各自绑**不同出口**)。
   * 页面归属由**当前任务空间**决定 —— 见 `ouuut-runtime.mjs` 的 `createTab`/`profileIdForNewPage`。
   */
  extraProfiles = [],
} = {}) {
  // 没选 kind 且没有额外档案:**不建浏览器 context,也不建档案引擎**。今天怎么跑,现在还怎么跑。
  if (kind === null && extraProfiles.length === 0) {
    return {
      archive: null,
      profiles: [FALLBACK_PROFILE],
      sessionProfileId: null,
      dispose: async () => {},
    };
  }
  // ⚠️ `kind === null` 是**合法**的 —— 它表示"这次会话没有主档案,档案都从 `extraProfiles` 来"
  // (双档案双出口那条路:用户只给 `--profiles`,不给 `--profile-kind`)。
  if (kind !== null && !KINDS.includes(kind)) {
    throw new ArchiveError(
      `kind=${JSON.stringify(kind)} 不合法;只允许 ${KINDS.join(" / ")}`,
      INVALID_ARGUMENT,
    );
  }
  if (!cdp || typeof cdp.send !== "function") {
    throw new ArchiveError("openSessionProfiles 需要一个 CDP 客户端(cdp.send)", INVALID_ARGUMENT);
  }

  const definitions = [];
  // 代理串在这里校验一次:`real` 用不上它(默认 context 挂不了),所以只给被选中的 kind。
  // 走**共用**校验:形状非法与带凭据都早失败(凭据串 Chromium 两条路都不收,坑-41)。
  const parsedProxy = assertProxyUsable(proxy);

  // `real` 恒为默认那一档。**给了档案目录**时它就在会话里(它代表这个 user-data-dir 的默认身份);
  // 没给目录 = 会话用的是本次会话专用的临时目录,那里的默认 context **不是**使用者的真实身份,
  // 不能拿它冒充 real —— 所以那种情况下会话里只有被选中的那个 kind。
  if (userDataDir) {
    definitions.push({
      id: REAL_PROFILE_ID,
      name: DEFAULT_NAMES.real,
      kind: "real",
      // **刻意不给 `browserContextId`**:默认 context 在 Chrome 那边没有 id,
      // 只能靠**省略**参数寻址(2026-10-25 真机:传 "default" 会被拒)。
      // `archive.mjs` 会把 real 的簿记值规范成 `null`,那正是"省略"的记号。
    });
  }

  let sessionProfileId = null;
  const disposableContextIds = [];

  /** 建一个 context 级档案(persona / disposable),返回它的定义。主档案与额外档案共用这一段。 */
  async function createContextProfile({ kind: k, id, nickname, proxy: proxyRaw, label }) {
    const parsed = assertProxyUsable(proxyRaw ?? null);
    // persona 要**留在** user-data-dir 里(长期画像),disposable 用完即弃 —— 差别就在这一个布尔。
    const created = await cdp.send("Target.createBrowserContext", {
      disposeOnDetach: k === "disposable",
      // **出口绑在这个 context 上**(F13)。值由 `assertProxyUsable()` 校验过(不免凭据),别打印它。
      ...(parsed ? { proxyServer: parsed.chromeValue, proxyBypassList: PROXY_BYPASS_LIST } : {}),
    });
    const contextId = created?.browserContextId;
    if (typeof contextId !== "string" || contextId === "") {
      throw new ArchiveError(
        `${label} 的 Target.createBrowserContext 没返回 browserContextId(收到 ${JSON.stringify(created)})`,
        INVALID_ARGUMENT,
      );
    }
    if (k === "disposable") disposableContextIds.push(contextId);
    return {
      id,
      name: nickname,
      kind: k,
      browserContextId: contextId,
      proxy: parsed ? parsed.chromeValue : null, // 已校验(无凭据);对外形状见 archive 的 `proxy`
    };
  }

  if (kind === "real") {
    // `parseArgs` 已经强制 real 必须给目录;这里再兜一次,免得别的入口绕过 CLI 传进来。
    if (!userDataDir) {
      throw new ArchiveError(
        "real 档案必须给出档案目录 —— 那是使用者的真实身份,不能替他造",
        INVALID_ARGUMENT,
      );
    }
    sessionProfileId = REAL_PROFILE_ID;
    // `real` = 默认 context,**没有**挂 proxyServer 的地方 —— 调用方给了代理就必须明说,
    // 静默忽略会让人以为"绑上了"(浏览器级那条路见 launch-args 的按 kind 分流)。
    if (parsedProxy) {
      throw new ArchiveError(
        "real 档案用默认 browser context,挂不了 context 级代理;real 会话的出口请走浏览器级 --proxy",
        INVALID_ARGUMENT,
      );
    }
  } else if (kind !== null) {
    const id = typeof profileId === "string" && profileId !== "" ? profileId : kind;
    const nickname = typeof name === "string" && name !== "" ? name : DEFAULT_NAMES[kind];
    // 传**原始串**:校验在 helper 里做一次(上面那次 `parsedProxy` 只用于 real 分支的「不许带代理」判断)
    definitions.push(await createContextProfile({ kind, id, nickname, proxy, label: `档案 ${id}` }));
    sessionProfileId = id;
  }

  // ---- 额外档案(双档案双出口)------------------------------------------------
  // 每个额外档案都有自己的 browser context —— 因而可以各自绑**不同出口**、互不串味。
  // `real` 只能有一个(它就是那个 user-data-dir 的默认身份,再来一个只会打架)。
  const seenIds = new Set(definitions.map((d) => d.id));
  for (const extra of extraProfiles ?? []) {
    const k = extra?.kind;
    if (!KINDS.includes(k)) {
      throw new ArchiveError(
        `额外档案的 kind=${JSON.stringify(k)} 不合法;只允许 ${KINDS.join(" / ")}`,
        INVALID_ARGUMENT,
      );
    }
    const id = typeof extra.id === "string" && extra.id !== "" ? extra.id : k;
    if (seenIds.has(id)) {
      throw new ArchiveError(`额外档案的 id ${JSON.stringify(id)} 与已有档案重名`, INVALID_ARGUMENT);
    }
    seenIds.add(id);
    if (k === "real") {
      if (!userDataDir) {
        throw new ArchiveError("额外档案是 real 时必须给出档案目录(那是使用者的真实身份)", INVALID_ARGUMENT);
      }
      if (extra.proxy) throw new ArchiveError("额外档案 real 用默认 context,挂不了 context 级代理", INVALID_ARGUMENT);
      definitions.push({ id, name: DEFAULT_NAMES.real, kind: "real" });
      continue;
    }
    definitions.push(
      await createContextProfile({
        kind: k,
        id,
        nickname: typeof extra.name === "string" && extra.name !== "" ? extra.name : DEFAULT_NAMES[k],
        proxy: extra.proxy ?? null,
        label: `额外档案 ${id}`,
      }),
    );
  }

  const archive = createArchive({ profiles: definitions });
  let disposed = false;

  return {
    archive,
    // 对外形状以档案引擎为准(`{id,name,isDefault,kind}`),不在这里另抄一份
    profiles: archive.listProfiles().profiles,
    sessionProfileId,
    /**
     * 收尾:销毁 disposable 的 browser context。
     *
     * * **幂等** —— 收尾路径可能被走两次(正常结束 + 异常兜底),重复调用是常态,不该炸。
     * * **绝不在 `real` 上动手** —— real 是使用者的真实身份(它压根不在这个名单里)。
     * * persona **不销毁** —— 长期画像要留在 user-data-dir 里(ADR-007)。
     * * **多个** disposable(双档案时会同时存在)一个都不许漏 —— 漏一个就是"用完没弃"。
     */
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const browserContextId of disposableContextIds) {
        try {
          await cdp.send("Target.disposeBrowserContext", { browserContextId });
        } catch (err) {
          // 收尾阶段的失败不该盖住主流程的结果(浏览器可能已经死了)—— 记一行,别抛。
          process.stderr.write(
            `[session-profiles] 销毁 disposable context 失败(${browserContextId}):${err?.message ?? err}\n`,
          );
        }
      }
    },
  };
}
