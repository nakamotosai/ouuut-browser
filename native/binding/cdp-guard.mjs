// native/binding/cdp-guard.mjs —— M4 驱动层:按住**有页面副作用的 CDP 命令**
//
// ## 为什么是这一层(证据,不是设计洁癖)
//
// `docs/M0-结论.md` §2.3 的判定:
//
//   > 问题:「按住 `Runtime.enable` 是否已足够过检测」→ **不够。**
//   > 证据:`patchright`(按住 `Runtime.enable`)之后仍有 3 红;
//   > `pw-hardened`(参数全干净)**`runtimeEnableLeak` 照样红**
//   > → 说明协议层有独立贡献,两者都**必要**。
//
// 同时 §2.3 把范围收窄:
//
//   > 原假设(自研进程内 IPC 协议栈,4–6 周)
//   > → **驱动层按住副作用命令(约几百行)+ 启动参数白名单(约 10 行)**,**1 周以内**
//
// 启动参数白名单在 M2 的 `native/bin/launch-args.mjs`(已有 6 项断言)。
// **本文件是"驱动层"那一半。**
//
// ## 一条硬约束:**不要直接用 patchright**
//
// `docs/M0-结论.md` §2.4 记着检测方已**点名** patchright。所以这里是
// **抄做法、自己实现** —— 也是为什么每一类拦截都要求有实测证据支撑,
// 而不是照抄某个库的命令黑名单。
//
// ## 我们拦什么、为什么(每条都有出处)
//
// | 命令 | 拦的理由 | 出处 |
// |---|---|---|
// | `Runtime.enable` | 它本身是一次**可观测的协议动作**;`pw-hardened` 参数全干净仍红此项 | §2.3 |
// | `Debugger.enable` / `Profiler.enable` / `Console.enable` / `DOM.enable` / `Log.enable` | 会在页面里留下 **CDP 绑定的全局对象**(检测站的 `cdpBindingGlobals`) | 检测项清单 |
// | `Page.addScriptToEvaluateOnNewDocument` | 检测站的 `pwInitScripts` / `documentInterception` 就是抓它 | 检测项清单 |
// | `Page.setBypassCSP` | 检测站的 `bypassCsp` | 检测项清单 |
// | `Emulation.setUserAgentOverride` **不带** `userAgentMetadata` | **M1 实测**:UA 被覆盖而 metadata 缺失 → `brands: []` → 检测站直接判红(`platformMismatch` / `useragent`) | M1 对照实验 |
// | `Emulation.setDeviceMetricsOverride` / `setTouchEmulationEnabled` | 检测站的 `mobileEmulation` | 检测项清单 |
// | `Emulation.setAutomationOverride` | 名字就写着 automation | — |
//
// **放行**的(harness 实测在用,而且不泄漏):
// `Target.setAutoAttach` / `Target.getTargets` / `Target.attachToTarget` /
// `Page.enable` / `Network.enable` / `Browser.getVersion` —— 见本仓记的实测流量。
//
// ## 两种动作:**拦** 与 **改写**
//
// 有些命令**不必拦死**,补齐它缺的参数就行 —— 典型是 `setUserAgentOverride`:
// 检测站红的不是"覆盖了 UA",而是"覆盖了 UA 却没给 metadata"。
// 所以那条规则是**改写**(补齐 `userAgentMetadata`),不是拦。

/** 拦截动作。 */
export const ACTION = Object.freeze({ PASS: "pass", HOLD: "hold", REWRITE: "rewrite" });

/** 为什么必须给 `Emulation.setUserAgentOverride` 配上 metadata —— 检测站抓的就是"缺 metadata"。 */
export const UA_METADATA_REQUIRED = "brands-empty";

/**
 * 会往页面里留下 CDP 绑定全局对象的命令。
 * 依据:检测站的 `cdpBindingGlobals` 项 —— 这些 domain 一旦 `enable`,
 * 绑定对象就会出现在页面可观测的范围内。
 */
const BINDING_DOMAINS = Object.freeze([
  "Debugger.enable",
  "Profiler.enable",
  "Console.enable",
  "DOM.enable",
  "Log.enable",
  "HeapProfiler.enable",
  "Runtime.enable", // 既是绑定全局,也是独立可观测动作 —— 双重理由
]);

/** 页面注入类:检测站的 `pwInitScripts` / `documentInterception` 抓的就是这些。 */
const PAGE_INJECTION = Object.freeze([
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.setBypassCSP",
  "Page.setDocumentContent",
  // ⚠️ `Page.setInterceptFileChooserDialog` **曾经**在这个名单里 —— 那是按名字归类,不是按事实。
  //    它既不注入脚本、也不留绑定,只是让浏览器把"文件选择对话框"交给调用方;
  //    而 harness 的**每一个动作**(click / fill / press / type)都会先发它 ⇒ 拦下它等于
  //    **动作全废:能看快照、点不动任何东西**(2026-10-25 写 shadow DOM 探针时实测到)。
  //    放行依据:实测动作恢复 + 检测站读数不变(见 KNOWN_SAFE 里的那条)。
]);

/** 移动端模拟类:检测站的 `mobileEmulation`。 */
const MOBILE_EMULATION = Object.freeze([
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setEmitTouchEventsForMouse",
  "Emulation.setAutomationOverride",
]);

/** 已知安全的(实测流量里 harness 自己在用)。列出来是为了让"放行"也是**有据**的。 */
export const KNOWN_SAFE = Object.freeze([
  "Target.setAutoAttach",
  "Target.getTargets",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Page.enable",
  "Network.enable",
  "Browser.getVersion",
  "Page.navigate",
  "Page.reload",
  "Page.captureScreenshot",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Accessibility.getFullAXTree",
  "Storage.getCookies",
  "Storage.setCookies",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  // harness 的每个动作都会先发这条(文件选择对话框拦截)。放行依据(2026-10-25 实测):
  //   1) 它不注入脚本、不留绑定 ⇒ 不属于"页面注入"那类(按名字归类会误伤);
  //   2) 放行后 click/fill/press 恢复可用;不拦时检测站读数**没变**(仍是 0 红 0 黄)。
  "Page.setInterceptFileChooserDialog",
]);

/**
 * 判定一条命令该怎么处理。
 *
 * @param {string} method
 * @param {object} params
 * @returns {{action:string, reason:string|null, evidence:string|null, patched?:object}}
 */
export function inspectCommand(method, params = {}) {
  if (typeof method !== "string" || method === "") {
    return { action: ACTION.HOLD, reason: "方法名空", evidence: null };
  }

  if (BINDING_DOMAINS.includes(method)) {
    return {
      action: ACTION.HOLD,
      reason: `${method} 会在页面留下 CDP 绑定的全局对象(检测项 cdpBindingGlobals)`,
      evidence: "docs/M0-结论.md §2.3 + 检测项清单",
    };
  }

  if (PAGE_INJECTION.includes(method)) {
    return {
      action: ACTION.HOLD,
      reason: `${method} 属于页面注入,检测项 pwInitScripts / documentInterception / bypassCsp 抓的就是它`,
      evidence: "检测项清单",
    };
  }

  if (MOBILE_EMULATION.includes(method)) {
    return {
      action: ACTION.HOLD,
      reason: `${method} 属于设备/自动化模拟,检测项 mobileEmulation`,
      evidence: "检测项清单",
    };
  }

  // ★ 改写而非拦截:证据来自 M1 实测
  if (method === "Emulation.setUserAgentOverride") {
    const md = params?.userAgentMetadata;
    const hasBrands = Array.isArray(md?.brands) && md.brands.length > 0;
    if (hasBrands) {
      return { action: ACTION.PASS, reason: null, evidence: null };
    }
    return {
      action: ACTION.REWRITE,
      reason:
        "setUserAgentOverride 没带可用的 userAgentMetadata.brands —— " +
        "检测站红的不是「覆盖了 UA」,而是「覆盖了 UA 却没给 metadata」(brands 会变成 [])",
      evidence: "M1 对照实验:原生 Chromium 在同一 harness 下同样得到 brands: []",
      patched: { ...params, userAgentMetadata: { ...(md ?? {}), brands: [] } },
      // 上面这个 patched 只是占位;真正的 metadata 必须由调用方提供 —— 见 `createCdpGuard`
      needsUserAgentMetadata: true,
    };
  }

  return { action: ACTION.PASS, reason: null, evidence: null };
}

/**
 * 建一个守卫。
 *
 * @param {object} [opts]
 * @param {"enforce"|"audit"|"off"} [opts.mode] `audit` 只记账不拦(取证用);
 *   `enforce` 拦下(生产);`off` 完全不管(只在测"拦不拦得住"的对照里用)
 * @param {object} [opts.userAgentMetadata] 被 `REWRITE` 时用来补齐的 metadata
 * @param {boolean} [opts.throwOnHold] 拦下时是抛错(默认)还是静默丢弃
 */
export function createCdpGuard({
  mode = "enforce",
  userAgentMetadata = null,
  throwOnHold = true,
} = {}) {
  const held = [];
  const rewritten = [];
  const seen = [];

  function record(entry) {
    seen.push(entry);
    if (entry.action === ACTION.HOLD) held.push(entry);
    if (entry.action === ACTION.REWRITE) rewritten.push(entry);
  }

  return {
    mode,
    get held() {
      return held.slice();
    },
    get rewritten() {
      return rewritten.slice();
    },
    get seen() {
      return seen.slice();
    },

    /** 只判定，不执行。 */
    inspect(method, params = {}) {
      const v = inspectCommand(method, params);
      if (mode === "off") return { ...v, action: ACTION.PASS };
      if (mode === "audit" && v.action === ACTION.HOLD) {
        return { ...v, wouldHold: true, action: ACTION.PASS };
      }
      return v;
    },

    /**
     * 包住一个 `send`。
     *
     * 关键是**在这里拦**,不是等浏览器报错:交给用户 / 进了别人的页面之后,
     * 浏览器那边不知道"是谁在发命令",只有我们这层知道。
     * (与 `task-spaces.mjs` 的 user-control 门同一条道理。)
     */
    wrap(send) {
      if (typeof send !== "function") {
        throw new TypeError("cdp-guard.wrap 需要一个 send 函数");
      }
      return (method, params = {}) => {
        const v = this.inspect(method, params);
        if (v.action === ACTION.HOLD) {
          record({ method, action: ACTION.HOLD, reason: v.reason, evidence: v.evidence });
          if (throwOnHold) {
            const e = new Error(`CDP 命令被驱动层拦下:${v.reason}`);
            e.name = "CdpGuardError";
            e.error_code = "OUUUT_CDP_COMMAND_HELD";
            e.method = method;
            throw e;
          }
          return undefined;
        }
        if (v.action === ACTION.REWRITE) {
          const md = userAgentMetadata ?? params?.userAgentMetadata;
          const ok = Array.isArray(md?.brands) && md.brands.length > 0;
          if (!ok) {
            record({ method, action: ACTION.HOLD, reason: `${v.reason}(而且调用方没提供可用的 metadata,无法补齐)`, evidence: v.evidence });
            if (throwOnHold) {
              const e = new Error(`CDP 命令缺 userAgentMetadata 且无法补齐:${v.reason}`);
              e.name = "CdpGuardError";
              e.error_code = "OUUUT_UA_METADATA_REQUIRED";
              e.method = method;
              throw e;
            }
            return undefined;
          }
          record({ method, action: ACTION.REWRITE, reason: v.reason, evidence: v.evidence });
          return send(method, { ...params, userAgentMetadata: { ...(params.userAgentMetadata ?? {}), ...md } });
        }
        record({ method, action: ACTION.PASS, reason: null, evidence: null });
        return send(method, params);
      };
    },

    /** 验收用:一次会话的所有命令里有没有漏网的。 */
    audit() {
      return {
        ok: held.length === 0,
        total: seen.length,
        held: held.slice(),
        rewritten: rewritten.slice(),
        runtimeEnableSent: seen.some((e) => e.method === "Runtime.enable" && e.action === ACTION.PASS),
      };
    },
  };
}

// ---- M4 验收:对**录到的命令流**做离线判定 ---------------------------------
//
// M4 的验收原文:「检测台 CDP 项全绿,**且抓包证明无 TCP 调试端口、无 `Runtime.enable` 发出**」。
//
// 前半句要真浏览器(受阻);**后半句可以对一份录到的命令流离线证**。
// 所以这里给一个纯函数:吃一段命令流,吐违规清单。没录到流就等于没证 —— 不给"大概没问题"。

/**
 * @param {Array<{method:string, params?:object}>} commands 录到的命令流
 * @returns {{ok:boolean, violations:Array, total:number, runtimeEnable:number}}
 */
export function auditCommandStream(commands) {
  const list = Array.isArray(commands) ? commands : [];
  const violations = [];
  let runtimeEnable = 0;
  for (const [i, c] of list.entries()) {
    const method = c?.method;
    if (method === "Runtime.enable") runtimeEnable += 1;
    const v = inspectCommand(method, c?.params ?? {});
    if (v.action !== ACTION.PASS) {
      violations.push({ index: i, method, action: v.action, reason: v.reason, evidence: v.evidence });
    }
  }
  return { ok: violations.length === 0, violations, total: list.length, runtimeEnable };
}

/** 检测"有没有开 TCP 调试端口" —— 启动参数或命令行里不该出现它。 */
export function auditNoTcpDebugPort(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const bad = list.filter((a) => typeof a === "string" && /^--remote-debugging-port(=|$)/.test(a));
  return { ok: bad.length === 0, offenders: bad };
}

// ---- 拍快照期间的额外禁令(§4.2)-------------------------------------------
//
// §4.2 最后一条:「拍快照**不得**激活 / focus / reload 任何 frame」。
//
// 这与上面那份"始终拦"的清单是**两件事**:`Page.reload` 平时有正当用途
// (agent 确实可能想刷新),但**拍快照期间**一条都不能发 —— 否则你拍到的
// 是"你刚把人家弄成什么样"而不是"人家本来什么样"。
//
// 所以这里单独一个函数,调用方在快照阶段用它审命令流。

/** 拍快照期间禁止的命令。与 `snapshot-refs.mjs` 的 `SNAPSHOT_FORBIDDEN` 同源。 */
// 注意:`export { X } from "..."` 只做**再导出**,**不会**在本文件里建局部绑定。
// 下面这个默认参数需要局部绑定,所以必须真 import 一次。
import { SNAPSHOT_FORBIDDEN as SNAPSHOT_FORBIDDEN_LIST } from "./snapshot-refs.mjs";
export { SNAPSHOT_FORBIDDEN } from "./snapshot-refs.mjs";

/**
 * 审一段"快照期间"的命令流。
 * @param {Array<{method:string}>} commands
 * @param {string[]} [forbidden] 默认用 `SNAPSHOT_FORBIDDEN`
 */
export function auditSnapshotPhase(commands, forbidden = SNAPSHOT_FORBIDDEN_LIST) {
  const list = Array.isArray(commands) ? commands : [];
  const bad = [];
  for (const [i, c] of list.entries()) {
    if (forbidden.includes(c?.method)) {
      bad.push({ index: i, method: c.method, reason: "拍快照期间不得激活/focus/reload 任何 frame(§4.2)" });
    }
  }
  return { ok: bad.length === 0, violations: bad, total: list.length };
}
