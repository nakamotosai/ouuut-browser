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

/**
 * 在**真实页面**里跑一次审计。
 *
 * 需要 `Runtime.evaluate` —— 这是一次**自检**,不是正常操作路径,所以用它是合适的;
 * 正常驱动路径仍然按住 `Runtime.enable`(ADR-005)。
 *
 * @returns {{ok: boolean, counts: object, leaks: Array, warnings: Array, error: string|null}}
 */
export async function auditWebrtc({ cdp, gatherMs = 2_000, timeoutMs = 20_000, sessionId } = {}) {
  const expression = buildWebrtcProbeScript({ gatherMs });
  const res = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, silent: true },
    { timeoutMs, ...(sessionId ? { sessionId } : {}) },
  );
  const value = res?.result?.value;
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      counts: { total: 0, public: 0, lan: 0, mdns: 0, loopback: 0, unknown: 0 },
      leaks: [],
      warnings: [],
      error: "探针没有返回结果(页面可能禁止了 WebRTC 或 evaluate 被拦)",
    };
  }
  const verdict = auditCandidates(value.candidates ?? []);
  return { ...verdict, error: value.error ?? null };
}
