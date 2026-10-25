// native/binding/webrtc-audit.mjs —— WebRTC 候选泄漏审计(ADR-014)
//
// 背景(ADR-014,M0 实测 `browserleaks.com/webrtc`):
//   我方候选泄漏 **4 个公网候选**(两个 mDNS `.local`、一个全局 IPv6、一个 IPv4),
//   而 CloakBrowser **0 个候选** → 🟢。它不是协议层修的,是启动参数
//   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`。
//
// 这个模块负责**验它真的生效**:
//   * 在页面里建一个空 ICE 连接,收集候选
//   * 把候选按「暴露了什么」分类
//   * 只要出现**公网 IP** 就判泄漏(那才是暴露真实出口的东西)
//
// 为什么不把 LAN 候选也算致命:局域网地址(192.168/10./172.16)暴露的是内网拓扑,
// 不是真实出口 IP。降级成"警告",但仍要报出来 —— 它同样是可被指纹化的信息。

/** 页面里跑的探针。**自包含** —— 不依赖页面上的任何东西。 */
export function buildWebrtcProbeScript({ gatherMs = 2_000 } = {}) {
  // 负数 / NaN / 字符串都退回安全值 —— 生成出来的脚本里塞进非法时长会让
  // setTimeout 立刻触发,收集到 0 个候选,**看起来像"没泄漏"**。这是最坏的假绿。
  const n = Number(gatherMs);
  const ms = Number.isFinite(n) && n > 0 ? Math.floor(n) : 2_000;
  return `(async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const cands = [];
  pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.candidate); };
  try {
    pc.createDataChannel("ouuut");
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, ${ms}));
  } catch (err) {
    return { error: String((err && err.message) || err), candidates: cands };
  } finally {
    try { pc.close(); } catch {}
  }
  return { error: null, candidates: cands };
})()`;
}

const IPV4_PRIVATE = [
  /^10\./,
  /^127\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local
];

function isIpv4(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

/**
 * 把一条 ICE 候选分类。
 *
 * 候选串形如:
 *   `candidate:842163049 1 udp 1677729535 124.211.130.95 54321 typ srflx ...`
 * 第 5 个字段是地址。
 *
 * @returns {{address: string, scope: "mdns"|"loopback"|"lan"|"public"|"unknown", typ: string}}
 */
export function classifyCandidate(candidate) {
  const parts = String(candidate ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const address = parts[4] ?? "";
  // `typ` 之后那个词是候选类型(host / srflx / relay / prflx)
  const typIdx = parts.indexOf("typ");
  const typ = typIdx >= 0 ? (parts[typIdx + 1] ?? "") : "";

  let scope = "unknown";
  if (address.endsWith(".local")) {
    // Chrome 默认用 mDNS 名字代替真实局域网地址 —— 这是**缓解**不是泄漏
    scope = "mdns";
  } else if (address === "::1" || address === "0.0.0.0" || /^127\./.test(address)) {
    scope = "loopback";
  } else if (isIpv4(address)) {
    scope = IPV4_PRIVATE.some((re) => re.test(address)) ? "lan" : "public";
  } else if (address.includes(":")) {
    // IPv6:链路本地(fe80::)与唯一本地(fc00::/7)不算公网
    const lower = address.toLowerCase();
    if (lower.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(lower)) scope = "lan";
    else scope = "public";
  }

  return { address, scope, typ };
}

/**
 * 给一批候选下判定。
 *
 * **只有公网地址才算致命** —— 那是暴露真实出口的东西。mDNS / loopback 是缓解手段,
 * 局域网地址降级成警告。
 */
export function auditCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const classified = list.map(classifyCandidate);
  const publicOnes = classified.filter((c) => c.scope === "public");
  const lanOnes = classified.filter((c) => c.scope === "lan");
  const counts = {
    total: classified.length,
    public: publicOnes.length,
    lan: lanOnes.length,
    mdns: classified.filter((c) => c.scope === "mdns").length,
    loopback: classified.filter((c) => c.scope === "loopback").length,
    unknown: classified.filter((c) => c.scope === "unknown").length,
  };
  return {
    ok: publicOnes.length === 0,
    counts,
    leaks: publicOnes,
    warnings: lanOnes,
    classified,
  };
}

/** 启动期的**暂时性**失败 —— 值得重试,而不是判死。 */
const TRANSIENT = /Execution context was destroyed|Cannot find context|wasn't found|Target closed|Session with given id/i;

/**
 * 挑一个适合 evaluate 的 page。
 *
 * **优先"真页面"**:启动时那个 `chrome://newtab/` 在换 document 的窗口里 evaluate 会得到
 * `Execution context was destroyed` —— 2026-10-25 实测:**照着"不挑页"的写法,同一条命令 10 次里 7 次失败**。
 * 这就是为什么这里要按 URL 优先挑 https/file 页,而不是无脑取 `pages[0]`。
 */
async function pickPageTarget(cdp, timeoutMs) {
  const t = await cdp.send("Target.getTargets", {}, { timeoutMs });
  const pages = (t?.targetInfos ?? []).filter((x) => x.type === "page");
  const real = pages.filter((x) => /^(https?|file):/i.test(x.url ?? ""));
  return real[0] ?? pages[0];
}

/** 探针拿不到结果时的标准返回 —— **不通过**不是"没泄漏"。 */
function noResult(error) {
  return {
    ok: false,
    counts: { total: 0, public: 0, lan: 0, mdns: 0, loopback: 0, unknown: 0 },
    leaks: [],
    warnings: [],
    error,
  };
}

/**
 * 在**真实页面**里跑一次审计。
 *
 * 需要 `Runtime.evaluate` —— 这是一次**自检**,不是正常操作路径,所以用它是合适的;
 * 正常驱动路径仍然按住 `Runtime.enable`(ADR-005)。
 *
 * ⚠️ **消费这个返回值时:`ok === false` 时 `counts` 全是 0、`leaks` 是空数组** ——
 * 那只表示"**没量成**",**不是**"公网候选 = 0"。判据必须**先看 `ok`**(见坑-36)。
 *
 * @returns {{ok: boolean, counts: object, leaks: Array, warnings: Array, error: string|null}}
 */
export async function auditWebrtc({ cdp, gatherMs = 2_000, timeoutMs = 20_000, sessionId } = {}) {
  const expression = buildWebrtcProbeScript({ gatherMs });
  // 调用方给了 sessionId 就只试一次(他要为自己的选择负责);
  // 没给 ⇒ 自己去挂页面,允许重试 —— 挂到启动页会有**暂时性**失败。
  const attempts = sessionId ? 1 : 4;
  const fromCaller = Boolean(sessionId);
  let sid = sessionId;
  let lastErr;

  for (let i = 0; i < attempts; i += 1) {
    try {
      if (!sid) {
        const page = await pickPageTarget(cdp, timeoutMs);
        if (page) {
          const a = await cdp.send(
            "Target.attachToTarget",
            { targetId: page.targetId, flatten: true },
            { timeoutMs },
          );
          sid = a?.sessionId;
        }
      }
      const res = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true, silent: true },
        { timeoutMs, ...(sid ? { sessionId: sid } : {}) },
      );
      const value = res?.result?.value;
      if (!value || typeof value !== "object") {
        return noResult("**未通过**:探针没有返回结果(页面可能禁止了 WebRTC 或 evaluate 被拦)");
      }
      const verdict = auditCandidates(value.candidates ?? []);
      return { ...verdict, error: value.error ?? null };
    } catch (e) {
      lastErr = e;
      // 只对"暂时性"失败重试;调用方自己给的 sessionId 出错当场收手(那是他的输入问题),
      // 别的情形把原文如实带出去。
      if (fromCaller || !TRANSIENT.test(String(e?.message)) || i === attempts - 1) break;
      sid = undefined; // 重新挑一个页面
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return noResult(`**未通过**:自检没能执行:${lastErr?.message ?? lastErr}`);
}
