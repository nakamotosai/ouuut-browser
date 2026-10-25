// native/binding/ouuut-runtime.mjs —— 注入 `globalThis.ouuut` 的**运行时**
//
// 这是 `docs/原生层接口.md` §一 图里「原生层」在 JS 侧的落地:harness 只认这一个全局对象。
//
// ## 本片只做「规格已经确定」的部分
//
// 上游 HARNESS 的**生产代码**实际只用到这些(实测 grep,不含测试):
//
//   | 用途 | 方法 | 调用点数 |
//   |---|---|---|
//   | 通道(地基) | `sendCDPMessage` / `onCDPMessage` / `onSendCDPMessageError` | 核心 |
//   | 版本 | `getBrowserVersion` | 1 |
//   | 任务控制(可选) | `setAgentTaskState` / `animationHighlightMouseToPosition` | 2(+1 探测) |
//   | 任务空间 | `useTaskSpace` `createTaskSpace` `claimTaskSpace` `listTaskSpaces` `closeTaskSpace` `completeTaskSpace` `handOffTaskSpace` `takeOverTaskSpace` `listProfiles` | 多 |
//   | 页面 | `createTab` / `snapshot` | 多 |
//
// **注意 `listTabs` 不在上表里** —— harness 自己用 CDP 枚举 target,不依赖原生层。
//
// 本片实现**通道 + CDP 直通原语**(`getBrowserVersion`),因为它们的语义完全由上游代码定死;
// 任务空间 / 快照 / 交接的语义是**产品行为**(所有权、`EGO_TASK_SPACE_USER_IN_CONTROL` 门、
// 快照化简规则),要在下一片按 `docs/原生层接口.md` §三～§五 逐条定,不在这里顺手发明。
//
// ## 通道的确切契约(从上游源码抄下来的,不是猜的)
//
// 出站 `browser-runtime.ts:461-465`:
// ```js
// const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
// runtime.sendCDPMessage(payload);      // 注意:**不是 await**,返回值被忽略
// ```
// 入站 `browser-runtime.ts:1418`:
// ```js
// function handleMessage(message) { const data = JSON.parse(message); ... }
// ```
// ⇒ **id 是 harness 自己分配的**。所以我们的层必须是**透传管道**:
//   原样转发出去、原样送回来。绝不能自己重编 id,否则 harness 永远等不到配对的响应。

import { CdpPipeError } from "./cdp-pipe.mjs";
import { createCdpGuard, ACTION } from "./cdp-guard.mjs";
import {
  createTaskSpaceRegistry,
  isCdpBlockedByUserControl,
  TaskSpaceError,
  USER_IN_CONTROL,
} from "./task-spaces.mjs";
import { buildHeader, buildSnapshot } from "./snapshot.mjs";
import { buildMultiFrameSnapshot } from "./oopif.mjs";

/** 与上游一致的默认响应超时(见 browser-runtime.ts 的 RESPONSE_TIMEOUT_MS 量级)。 */
const VERSION_TIMEOUT_MS = 10_000;

export class OuUutRuntimeError extends Error {
  constructor(message, errorCode = "OUUUT_RUNTIME") {
    super(message);
    this.name = "OuUutRuntimeError";
    this.error_code = errorCode;
  }
}

/**
 * 把一条 CDP 管道包成 harness 认识的 `globalThis.ouuut`。
 *
 * @param {object} o
 * @param {object} o.cdp           `spawnCdpPipe()` 的返回值
 * @param {string} [o.namespace]   仅用于错误信息
 * @param {object} [o.registry]    任务空间注册表(默认新建一个空表)
 * @param {Array}  [o.profiles]    `listProfiles()` 的数据源(M3 才做三种 kind)
 */
export function createOuUutRuntime({ cdp, namespace = "ouuut", registry, profiles, cdpGuard } = {}) {
  if (!cdp || typeof cdp.sendRaw !== "function" || typeof cdp.onRaw !== "function") {
    throw new OuUutRuntimeError("createOuUutRuntime 需要一个 spawnCdpPipe() 的返回值");
  }
  const spaces = registry ?? createTaskSpaceRegistry();
  // 默认**强制**(`enforce`)。要做取证/对照实验时显式传 `mode:"audit"` ——
  // 刻意不把"默认不拦"作为选项:那就等于 M4 的保护默认是关的。
  const guard = cdpGuard ?? createCdpGuard();
  const profileList =
    Array.isArray(profiles) && profiles.length > 0
      ? profiles
      : [{ id: "default", name: "默认档案", isDefault: true }];

  /** harness 会**直接给这两个槽赋值**,所以它们必须是可写的普通属性(不是 getter)。 */
  const runtime = {
    onCDPMessage: undefined,
    onSendCDPMessageError: undefined,
  };

  // ---- 入站:每一条 CDP 消息都原样交给 harness --------------------------------
  const offRaw = cdp.onRaw((msg) => {
    const cb = runtime.onCDPMessage;
    if (typeof cb !== "function") return; // 通道活着但没人订 —— 丢掉,不报错
    try {
      cb(JSON.stringify(msg));
    } catch (err) {
      // **绝不**让 JS 侧的异常穿过回原生边界(上游 guardNativeCallback 的同一考虑);
      // 但也绝不能静默 —— 走 stderr,别污染 CDP 通道
      process.stderr.write(`[${namespace}] onCDPMessage 抛错:${err?.message ?? err}\n`);
    }
  });

  // ---- 出站:透传 -----------------------------------------------------------
  /** 上游签名:`sendCDPMessage(payload: string)`,返回值被忽略(失败走 onSendCDPMessageError)。 */
  runtime.sendCDPMessage = function sendCDPMessage(payload) {
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return reportSendError(payload, "OUUUT_INVALID_ARGUMENT", "sendCDPMessage 收到的不是合法 JSON");
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.method !== "string") {
      return reportSendError(parsed, "OUUUT_INVALID_ARGUMENT", "sendCDPMessage 的载荷缺少 method");
    }
    // **user-control 门**:已交给用户时,会改浏览器的命令一律拒绝。
    // 只读查询放行 —— 挡了只会让 agent 变瞎,而不会让它更守规矩。
    if (spaces.isUserInControl && isCdpBlockedByUserControl(parsed.method)) {
      return reportSendError(
        parsed,
        USER_IN_CONTROL,
        `任务已交给用户,拒绝执行会改变浏览器状态的命令:${parsed.method}`,
      );
    }
    // **驱动层守卫**(M4):按住有页面副作用的 CDP 命令。
    // 放在 user-control 门**之后**:所有权是更外层的语义,先挡那个。
    // 依据见 `cdp-guard.mjs` 抬头 —— 每条规则都有实测出处,不是照抄某个库的黑名单。
    const verdict = guard.inspect(parsed.method, parsed.params ?? {});
    if (verdict.action === ACTION.HOLD) {
      return reportSendError(parsed, "OUUUT_CDP_COMMAND_HELD", verdict.reason);
    }
    const outgoing = parsed;
    if (verdict.action === ACTION.REWRITE) {
      const md = parsed.params?.userAgentMetadata;
      const ok = Array.isArray(md?.brands) && md.brands.length > 0;
      if (!ok) {
        // **fail-closed**:补不齐 metadata 就绝不能发 —— 发了就是 `brands: []` 那个红(M1 实测)
        return reportSendError(parsed, "OUUUT_UA_METADATA_REQUIRED", verdict.reason);
      }
    }
    try {
      cdp.sendRaw(outgoing);
    } catch (err) {
      return reportSendError(
        parsed,
        err instanceof CdpPipeError ? err.error_code : "OUUUT_CDP_PIPE",
        err?.message ?? String(err),
      );
    }
  };

  function reportSendError(message, errorCode, detail) {
    const cb = runtime.onSendCDPMessageError;
    if (typeof cb === "function") {
      try {
        cb(message, errorCode);
        return;
      } catch (err) {
        process.stderr.write(`[${namespace}] onSendCDPMessageError 抛错:${err?.message ?? err}\n`);
      }
    }
    process.stderr.write(`[${namespace}] CDP 发送失败(${errorCode}):${detail}\n`);
  }

  // ---- CDP 直通原语(语义完全由上游定死,不含产品决策) ----------------------
  /** `update-notice.ts:18` 期望拿到的形状。 */
  runtime.getBrowserVersion = async function getBrowserVersion() {
    const res = await cdp.send("Browser.getVersion", {}, { timeoutMs: VERSION_TIMEOUT_MS });
    return {
      currentVersion: res?.product ?? "",
      updateAvailable: false, // 我们不查更新(ADR:不打扰用户)
      revision: res?.revision ?? "",
      userAgent: res?.userAgent ?? "",
      jsVersion: res?.jsVersion ?? "",
    };
  };

  // ---- 标签页(语义由 harness 的用法定死,见下) -----------------------------
  //
  // `browser-runtime.ts:604-610` 是唯一决定形状的地方:
  // ```js
  // const result = await invokeEgo("listTabs", () => browserEgo().listTabs());
  // const tabs = result?.tabs || result?.targetInfos || [];
  // const preferred = state.preferredTargetId ? tabs.find(t => t.targetId === state.preferredTargetId) : null;
  // const active = preferred || tabs.find(t => t.active) || tabs[tabs.length - 1];
  // if (!active) throw new Error("no active tab to attach session");
  // ```
  // ⇒ 必须给 `tabs`,每条要有 `targetId`(string)与 `active`(boolean,且**至少一条为 true**),
  //    否则 harness 会在「no active tab」处抛错。
  runtime.listTabs = async function listTabs() {
    const res = await cdp.send("Target.getTargets", {}, { timeoutMs: VERSION_TIMEOUT_MS });
    const infos = Array.isArray(res?.targetInfos) ? res.targetInfos : [];
    const pages = infos.filter((t) => t.type === "page");
    // 「active」的判定:CDP 不给"哪个是前台页"。取**最后一条**为活跃页 ——
    // 与 harness 自己的兜底(`tabs[tabs.length - 1]`)同口径,不会互相打架。
    const activeIndex = pages.length - 1;
    return {
      tabs: pages.map((t, i) => ({
        targetId: t.targetId,
        active: i === activeIndex,
        url: t.url ?? "",
        title: t.title ?? "",
        type: t.type ?? "page",
        attached: Boolean(t.attached),
      })),
    };
  };

  /** `nav.ts:159-162` 只读 `result.targetId`,没有就抛「newTab returned no targetId」。 */
  runtime.createTab = async function createTab(url = "about:blank") {
    const res = await cdp.send("Target.createTarget", { url }, { timeoutMs: VERSION_TIMEOUT_MS });
    if (typeof res?.targetId !== "string" || res.targetId.length === 0) {
      throw new OuUutRuntimeError("Target.createTarget 没返回 targetId", "OUUUT_CREATE_TAB_FAILED");
    }
    return { targetId: res.targetId };
  };

  // ---- 任务空间(契约逐字来自 harness 源码,见 task-spaces.mjs 顶部)----
  // `spaces` 在本函数顶部已绑定(可注入,便于测试)

  runtime.listTaskSpaces = async function listTaskSpaces() {
    return spaces.list(); // **必须包成 {taskSpaces}**
  };

  runtime.createTaskSpace = async function createTaskSpace(name, profileId) {
    const created = spaces.create(name, profileId);
    spaces.select(created.id); // harness 期望"创建并选中"
    return created;
  };

  runtime.claimTaskSpace = async function claimTaskSpace(id, name) {
    const claimed = spaces.claim(id, name);
    spaces.select(claimed.id);
    return claimed;
  };

  runtime.useTaskSpace = async function useTaskSpace(id) {
    spaces.select(id); // 返回值被忽略,但不能抛
  };

  runtime.closeTaskSpace = async function closeTaskSpace() {
    return spaces.close();
  };

  runtime.completeTaskSpace = async function completeTaskSpace(options) {
    return spaces.complete(options ?? {});
  };

  runtime.handOffTaskSpace = async function handOffTaskSpace() {
    return spaces.handOff();
  };

  runtime.takeOverTaskSpace = async function takeOverTaskSpace() {
    return spaces.takeOver();
  };

  /** `helpers.ts:105-121` 逐字段校验:`id`/`name` 非空 string、`isDefault` boolean。 */
  runtime.listProfiles = async function listProfiles() {
    return { profiles: profileList.map((p) => ({ id: p.id, name: p.name, isDefault: Boolean(p.isDefault) })) };
  };

  // ---- user-control 门(**发送侧**强制)-------------------------------------
  // 交给用户之后,agent 不得再改浏览器。这一步必须在**我们这层**做:
  // 浏览器那边不知道"现在轮到用户了",只有我们知道当前空间的所有权。
  //
  // 无关的可选项:上游在 `page-model.ts:740` 用 `typeof ego.setAgentTaskState !== "function"`
  // 判断"这个原生层支不支持",所以这两个**可以缺席**,不算违约。
  runtime.setAgentTaskState = async function setAgentTaskState(state) {
    runtime._agentTaskState = state;
  };
  runtime.animationHighlightMouseToPosition = async function animationHighlightMouseToPosition(x, y) {
    runtime._highlight = { x, y };
  };

  // ---- 快照(§四)。**必须**在交给用户时 reject,且代号精确 ------------------
  //
  // `helpers.test.mjs:1334` 明写:探针 key 的是 `snapshot()` 的 **reject** 上带的
  // `error_code === EGO_TASK_SPACE_USER_IN_CONTROL`(文档化契约),**不看文案**。
  // 所以这里抛的必须是 TaskSpaceError 且 error_code 精确匹配 —— 文案随便写。
  runtime.snapshot = async function snapshot(options = {}) {
    if (spaces.isUserInControl) {
      throw new TaskSpaceError(
        "任务已交给用户,暂时不能拍快照",
        USER_IN_CONTROL,
      );
    }
    let header;
    if (Number.isFinite(options?.maxResultLength) ? options.maxResultLength > 8 : true) {
      try {
        const tabsRes = await runtime.listTabs();
        const tabs = (tabsRes?.tabs ?? []).map((t, i) => ({
          label: `p${i + 1}`,
          title: t.title ?? "",
          active: Boolean(t.active),
          targetId: t.targetId,
        }));
        const activeIdx = tabs.findIndex((t) => t.active);
        const active = tabs[activeIdx] ?? tabs[tabs.length - 1];
        header = buildHeader({
          label: active?.label,
          title: active?.title,
          space: spaces.selected,
          tabs,
        });
      } catch {
        // 拿不到标签页时也别把快照整个搞失败 —— 头可以退化
        header = buildHeader({ label: "p?", title: "", space: spaces.selected, tabs: [] });
      }
    }
    // **默认带上 OOPIF**。跨进程 iframe 的内容在主 frame 的 AX 树里是**看不到**的,
    // 不取的话 agent 会以为那块是空的 —— 而它可能正是页面主体。
    // 没有 OOPIF 时只多一次 `Target.getTargets` 往返。
    if (options?.includeFrames === false) {
      return buildSnapshot({ cdp, header, options });
    }
    return buildMultiFrameSnapshot({ cdp, header, options });
  };

  return {
    api: runtime,
    /** 释放:摘掉我们自己的订阅与回调(**只在回调仍归本实例所有时才摘** —— 上游 dispose 契约)。 */
    dispose() {
      offRaw();
      // 只有当槽里还是"外面塞进来的"回调时才清;但我们无法区分,所以只清我们自己设过的。
      // harness 的 disposeEgoSdk 会自己摘它的;这里不动它塞的,避免把别人的回调打掉。
    },
    get closed() {
      return cdp.closed;
    },
  };
}

/**
 * 起进程 + 包成 harness 认识的运行时。给 CLI 入口用。
 *
 * ⚠️ 本函数会**真的起一个浏览器进程**。项目策略:开发机上的自动化请走
 * `browser.open`,或由使用者显式运行本产品的 CLI —— 见 native/README.md §六。
 */
export function attachOuUutRuntime({ cdp, namespace } = {}) {
  return createOuUutRuntime({ cdp, namespace });
}
