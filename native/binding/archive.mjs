// native/binding/archive.mjs —— 档案引擎:三种 kind + **硬隔离**
//
// 里程碑 M3 的验收:三种 kind 落地 · **cookie 跨档案读写必须失败** · 100 seed 零矛盾
// (本文件管前两条;seed 那一半在 `fingerprint.mjs`)
//
// ## 为什么要有这个(证据,不是设计洁癖)
//
// `docs/证据-R1-ego-lite网络调研.md:42` 记着 ego **#319**:
//
//   > Task Space 里的 `Storage.getCookies`/`setCookies` **不是 profile 级作用域**:
//   > 脚本在 Profile 6 读到默认 profile 的 **1,105 个 cookie** 并写入。
//   > 维护者回复:「A space is not the same as a profile, and **spaces do not isolate cookies**.」
//
// 也就是说:它的 Space 隔离**文档上写着有、实际没有**。这不是"功能缺失",
// 是**隔离失效却宣称隔离** —— 对多档案产品是致命的:所有档案共用一个 cookie 池,
// 换个档案等于没换。所以我们的硬隔离必须是**结构性**的,不能是"记得加检查"。
//
// ## 三层防线(从便宜到贵,前两层是本文件的核心)
//
// 1. **句柄层(结构性)**:`archive.cookiesFor(profileId)` 交出的是**绑死该档案的句柄**,
//    `browserContextId` 由句柄**自动注入**。调用方**没有途径**省略它 ——
//    #319 的成因正是"省略了 browserContextId 于是落到默认档案"。正确用法是**默认用法**。
// 2. **闸层(发送侧)**:真要绕过句柄直接发 CDP 命令时,`checkCookieCommand()` 拦下来。
//    和 user-control 门同一条道理(见 `task-spaces.mjs` 抬头):交给用户之后只有**我们这层**
//    知道当前该用哪个档案,浏览器那边不知道"是谁在发命令"。
// 3. **内核层**:CDP 双端补丁(阶段 A)—— 不在本文件。
//
// ## kind 的语义(ADR-007)
//
// | kind | 归属 | 可否创建 | 可否销毁 | 持久化 | 说明 |
// |---|---|---|---|---|---|
// | `real` | 用户的真实档案 | ❌ **绝不由 agent 创建** | ❌ 绝不销毁 | ✅ | 机器上**恰好一个**,且是 `isDefault` |
// | `persona` | 长期画像(养号) | ✅ | ✅(需显式) | ✅ | 每个 persona 一套自洽指纹 |
// | `disposable` | 一次性 | ✅ | ✅(关闭即销毁) | ❌ | 用完即弃,不留痕 |
//
// **`real` 的特殊性**:它是使用者的真实身份。agent 能**读到它的存在**(否则不能告诉用户
// "别在 real 里跑任务"),但**不能创建第二个、不能销毁它** —— 这两条做成硬错误。

import { parseProxy, redactProxy } from "./proxy.mjs";

/** 三种 kind,顺序即文档顺序。 */
export const KINDS = Object.freeze(["real", "persona", "disposable"]);

/** 跨档案读写被拦下时用的代号(M3 硬隔离验收;`docs/原生层接口.md` §三 已预留)。 */
export const ISOLATION_VIOLATION = "OUUUT_PROFILE_ISOLATION_VIOLATION";
export const PROFILE_NOT_FOUND = "EGO_PROFILE_NOT_FOUND";
export const INVALID_ARGUMENT = "EGO_INVALID_ARGUMENT";

export class ArchiveError extends Error {
  constructor(message, errorCode) {
    super(message);
    this.name = "ArchiveError";
    this.error_code = errorCode;
  }
}

/**
 * 会碰到 cookie / storage 的 CDP 方法 —— 逐个列出,不用前缀匹配。
 * 理由:前缀匹配(`Storage.`)会把 `Storage.clearDataForOrigin` 这种
 * **破坏性但只作用于自己档案**的方法也误伤;而漏掉一个则**隔离静默失效**。
 * 隔离失效的代价远大于误伤,所以这里**宁可列全**。
 */
export const COOKIE_CDP_METHODS = Object.freeze([
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
  "Network.getCookies",
  "Network.getAllCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
]);

/** 这些方法**天然没有** `browserContextId` 参数 → 只能作用于当前档案,不需要闸。 */
const BROWSER_WIDE_ONLY = Object.freeze([]);

// ---- 档案的定义与校验 ------------------------------------------------------

/**
 * 校验一条档案定义。
 *
 * `isDefault` 的语义:harness 要求 `listProfiles()` 逐字段校验,所以这里主动规范化 ——
 * **`real` 必为默认**。上游机器上只有一个 profile 也就恒为默认,这里保持一致。
 */
function normalizeProfile(raw, index) {
  if (!raw || typeof raw !== "object") {
    throw new ArchiveError(`档案 #${index} 不是对象`, INVALID_ARGUMENT);
  }
  const { id, name, kind } = raw;
  if (typeof id !== "string" || id === "") {
    throw new ArchiveError(`档案 #${index} 缺 id(必须是字符串)`, INVALID_ARGUMENT);
  }
  if (typeof name !== "string" || name === "") {
    throw new ArchiveError(`档案 ${id} 缺 name(必须是字符串)`, INVALID_ARGUMENT);
  }
  if (!KINDS.includes(kind)) {
    throw new ArchiveError(
      `档案 ${id} 的 kind=${JSON.stringify(kind)} 不合法;只允许 ${KINDS.join(" / ")}`,
      INVALID_ARGUMENT,
    );
  }
  // `real` 的寻址方式与其它 kind **在协议层就不一样**,所以簿记值也不同:
  // Chrome 的「默认 browser context」**没有 id**,`Target.getBrowserContexts` 也不列它,
  // 只能靠**省略** `browserContextId` 来寻址。
  // 2026-10-25 真机实测(Chromium 156,`probe-ctx.mjs`):
  //   * 省略 → `README OK`(拿到默认 context 的 cookie)
  //   * `browserContextId:"default"` → `Failed to find browser context for id default`
  //   * 任意假 id → 同样失败
  // ⇒ real 的簿记值恒为 `null`(语义:**省略**),**不接受**调用方传字符串进来 ——
  //   传了不会"更严格",只会让真机报错(这正是 2026-10-25 接线时发现的缝隙)。
  // **按档案绑代理**(F13):代理串在这里就校验,别拖到 launch 才炸。
  // 对外(listProfiles)只给**脱敏**形式;原文留在 `_proxy` 里,只给"丢给浏览器"那一步用。
  const proxy = parseProxy(raw.proxy ?? null);
  const isReal = kind === "real";
  return Object.freeze({
    id,
    name,
    proxy: proxy ? proxy.redacted : null,
    _proxy: proxy ? proxy.raw : null,
    kind,
    isDefault: isReal,
    // 内部簿记,不出现在 listProfiles() 的对外形状里
    _browserContextId: isReal
      ? null
      : typeof raw.browserContextId === "string" && raw.browserContextId !== ""
        ? raw.browserContextId
        : id,
  });
}

// ---- 引擎本体 --------------------------------------------------------------

/**
 * @param {{profiles?: Array<{id:string,name:string,kind:string,browserContextId?:string}>}} [opts]
 */
export function createArchive({ profiles = [] } = {}) {
  if (!Array.isArray(profiles)) {
    throw new ArchiveError("profiles 必须是数组", INVALID_ARGUMENT);
  }

  /** id -> 记录 */
  const byId = new Map();
  for (const [i, raw] of profiles.entries()) {
    const p = normalizeProfile(raw, i);
    if (byId.has(p.id)) {
      throw new ArchiveError(`档案 id 重复:${p.id}`, INVALID_ARGUMENT);
    }
    byId.set(p.id, p);
  }

  // `real` 恰好一个 —— 这是不变量,启动时就查,不留到运行时(竞品缺点 C8:不静默降级)
  const realCount = [...byId.values()].filter((p) => p.kind === "real").length;
  if (realCount > 1) {
    throw new ArchiveError(`机器上只能有一个 real 档案,给了 ${realCount} 个`, INVALID_ARGUMENT);
  }

  /** 已销毁的 disposable(销毁后不可再用) */
  const destroyed = new Set();
  /** taskSpaceId -> profileId(档案在**建空间时**绑定,见 §二) */
  const binding = new Map();

  function require(profileId) {
    const p = byId.get(profileId);
    if (!p) {
      throw new ArchiveError(`没有这个档案:${profileId}`, PROFILE_NOT_FOUND);
    }
    if (destroyed.has(profileId)) {
      throw new ArchiveError(`档案已被销毁:${profileId}`, PROFILE_NOT_FOUND);
    }
    return p;
  }

  function requireMutableKind(kind, action) {
    if (kind === "real") {
      throw new ArchiveError(
        `${action} 对 real 档案是禁止的 —— 那是使用者的真实身份,agent 不可创建/销毁`,
        INVALID_ARGUMENT,
      );
    }
  }

  const archive = {
    KINDS,

    /** harness 逐字段校验 `{id:string,name:string,isDefault:boolean}`;`kind` 是我们的扩展。 */
    listProfiles() {
      const out = [];
      for (const p of byId.values()) {
        if (destroyed.has(p.id)) continue;
        out.push({ id: p.id, name: p.name, isDefault: p.isDefault, kind: p.kind, proxy: p.proxy ?? null });
      }
      return { profiles: out };
    },

    /** 内部用:拿到档案的完整记录(含 browserContextId)。 */
    resolve(profileId) {
      return require(profileId);
    },

    /**
     * 三种 kind 的落地:建档案。
     * `real` **不许建** —— 它只能来自"本机已存在",不是 agent 的产物。
     */
    createProfile({ id, name, kind, browserContextId, proxy } = {}) {
      if (kind === "real") {
        throw new ArchiveError(
          "real 档案不能由 agent 创建 —— 它代表使用者的真实身份",
          INVALID_ARGUMENT,
        );
      }
      if (typeof id !== "string" || id === "") {
        throw new ArchiveError("createProfile 需要 id", INVALID_ARGUMENT);
      }
      if (byId.has(id) && !destroyed.has(id)) {
        throw new ArchiveError(`档案 id 已存在:${id}`, INVALID_ARGUMENT);
      }
      const p = normalizeProfile({ id, name, kind, browserContextId, proxy }, byId.size);
      destroyed.delete(id);
      byId.set(id, p);
      return { id: p.id, name: p.name, isDefault: p.isDefault, kind: p.kind, proxy: p.proxy };
    },

    /** 销毁。`real` 不许销毁;销毁后该档案的绑定一并清掉,免得留下悬空绑定。 */
    destroyProfile(profileId) {
      const p = require(profileId);
      requireMutableKind(p.kind, "销毁档案");
      destroyed.add(profileId);
      for (const [tsId, bound] of binding) {
        if (bound === profileId) binding.delete(tsId);
      }
      return { destroyed: profileId };
    },

    /** 档案在**建空间时**绑定(上游如此,我们不另起一套)。 */
    bindTaskSpace(taskSpaceId, profileId) {
      const p = require(profileId);
      binding.set(taskSpaceId, p.id);
      return { taskSpaceId, profileId: p.id, kind: p.kind };
    },

    boundProfileOf(taskSpaceId) {
      const id = binding.get(taskSpaceId);
      if (!id) {
        throw new ArchiveError(
          `空间 ${taskSpaceId} 没有绑定档案 —— 未绑定的空间绝不能读 cookie(那就会落到默认档案,#319)`,
          ISOLATION_VIOLATION,
        );
      }
      return require(id);
    },

    // ---- 第一层防线:绑死档案的句柄 ----------------------------------------

    /**
     * 交出**绑死该档案**的 cookie 句柄。
     *
     * 契约:`send()` 是"把参数发给浏览器"的回调(测试里可注入假对端)。
     * `browserContextId` **由句柄自动注入**,调用方**没有参数**能覆盖它 ——
     * 这是结构性的,不依赖调用方守规矩。
     */
    /**
     * 该档案对应的 **browser context id**(`real` 是 `null` = 默认 context)。
     *
     * 调用方:运行时的 `createTab` —— **页面必须建在档案自己的 context 里**,
     * 否则那个 context 上绑的代理/隔离全都落空(2026-10-25 抓到过:persona + `--proxy`
     * 因为页面落在默认 context 而**静默直连**)。返回 `null` 时调用方应**省略**该参数
     * (Chrome 用「省略」寻址默认 context,见 normalizeProfile 里的真机实测)。
     */
    browserContextFor(profileId) {
      return require(profileId)._browserContextId;
    },

    cookiesFor(profileId, send) {
      const p = require(profileId);
      if (typeof send !== "function") {
        throw new ArchiveError("cookiesFor 需要 send 回调", INVALID_ARGUMENT);
      }
      const bound = p._browserContextId;
      const call = (method, params = {}) => {
        if (!COOKIE_CDP_METHODS.includes(method)) {
          throw new ArchiveError(
            `${method} 不是 cookie 方法;用 sendCDPMessage 走普通通路`,
            INVALID_ARGUMENT,
          );
        }
        // 覆盖式:调用方硬塞的 browserContextId 一律丢掉
        const { browserContextId: _dropped, ...rest } = params ?? {};
        // real 的寻址是**省略**(`bound === null`)—— 见 normalizeProfile 里的真机实测
        return bound === null
          ? send(method, rest)
          : send(method, { ...rest, browserContextId: bound });
      };
      return Object.freeze({
        profileId: p.id,
        kind: p.kind,
        browserContextId: bound,
        getCookies: (params) => call("Storage.getCookies", params),
        setCookies: (params) => call("Storage.setCookies", params),
        clearCookies: (params) => call("Storage.clearCookies", params),
      });
    },

    // ---- 第二层防线:发送侧闸 ----------------------------------------------

    /**
     * 拦下"绕过句柄、直接发 cookie 命令"的尝试。
     *
     * 规则(`sessionProfileId` = 当前空间绑定的档案):
     *   * 方法不在 cookie 名单里 → 放行(只读/无关命令不该被误伤)
     *   * 方法在名单里 **但没给 `browserContextId`** → **拦** ——
     *     这正是 #319:省略参数 → 落到默认档案 → 读到 1,105 个别人的 cookie
     *   * 给了但**指向别的档案** → **拦**
     *   * 给了且**就是本档案** → 放行
     *
     * @returns {{ok:true, browserContextId:string}}
     * @throws {ArchiveError} error_code = OUUUT_PROFILE_ISOLATION_VIOLATION
     */
    checkCookieCommand({ sessionProfileId, method, params }) {
      if (!COOKIE_CDP_METHODS.includes(method)) {
        return { ok: true, browserContextId: null, reason: "不是 cookie 方法" };
      }
      if (BROWSER_WIDE_ONLY.includes(method)) {
        return { ok: true, browserContextId: null, reason: "无 browserContextId 参数" };
      }

      const mine = require(sessionProfileId);
      const want = params?.browserContextId;
      const absent = want === undefined || want === null || want === "";

      // real 的寻址是「省略」:默认 context 没有 id,带上 id 反而**只可能指向别的档案**。
      // (2026-10-25 真机:带 `"default"` 会被 Chrome 直接拒 —— `Failed to find browser context for id default`。)
      if (mine._browserContextId === null) {
        if (absent) return { ok: true, browserContextId: null };
        const owner = [...byId.values()].find((x) => x._browserContextId === want);
        throw new ArchiveError(
          `当前档案是 ${mine.id}(kind=real,即默认 browser context),它的寻址方式是**省略**` +
            `browserContextId;带上 ${JSON.stringify(want)}${owner ? `(${owner.id})` : "(未知档案)"}` +
            ` 只可能指向别的档案,拦下`,
          ISOLATION_VIOLATION,
        );
      }

      if (absent) {
        throw new ArchiveError(
          `${method} 没带 browserContextId —— 会落到默认档案,可能读到别的档案的 cookie` +
            `(这正是 ego #319:1,105 个 cookie 泄漏)。当前档案是 ${mine.id}`,
          ISOLATION_VIOLATION,
        );
      }
      if (want !== mine._browserContextId) {
        const owner = [...byId.values()].find((x) => x._browserContextId === want);
        throw new ArchiveError(
          `跨档案 cookie 读写被拦下:当前空间绑的是 ${mine.id}(${mine.kind}),` +
            `命令却指向 ${want}${owner ? `(${owner.id})` : "(未知档案)"}`,
          ISOLATION_VIOLATION,
        );
      }
      return { ok: true, browserContextId: want };
    },

    /** 诊断用:当前全部绑定关系。 */
    bindings() {
      return new Map(binding);
    },
  };

  return archive;
}
