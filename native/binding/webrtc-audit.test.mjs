// native/binding/webrtc-audit.test.mjs —— WebRTC 候选泄漏审计(ADR-014)
//
// 守的是「抑制真的生效」这件事本身。ADR-014 的实测结论:
//   我方候选泄漏 4 个**公网**候选,CloakBrowser **0 个**。
// 所以判据必须是「有没有公网地址」,而不是「有没有候选」——
// 把 mDNS `.local` 当泄漏会误报(那是缓解手段)。

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWebrtcProbeScript,
  classifyCandidate,
  auditCandidates,
  auditWebrtc,
} from "./webrtc-audit.mjs";

const cand = (ip, typ = "host") => `candidate:1 1 udp 2122260223 ${ip} 54321 typ ${typ} generation 0`;

// ---- 1. 分类 --------------------------------------------------------------

test("classifyCandidate:第 5 个字段才是地址,typ 要取对", () => {
  const c = classifyCandidate(cand("124.211.130.95", "srflx"));
  assert.equal(c.address, "124.211.130.95");
  assert.equal(c.typ, "srflx");
});

test("classifyCandidate:mDNS `.local` 是**缓解**不是泄漏", () => {
  assert.equal(classifyCandidate(cand("a1b2-3c4d.local")).scope, "mdns");
});

test("classifyCandidate:IPv4 私网段判 lan,其余判 public", () => {
  for (const ip of ["10.1.2.3", "172.16.5.4", "172.31.255.1", "192.168.1.9", "169.254.1.1"]) {
    assert.equal(classifyCandidate(cand(ip)).scope, "lan", ip);
  }
  for (const ip of ["124.211.130.95", "8.8.8.8", "1.1.1.1", "172.32.0.1", "11.0.0.1"]) {
    assert.equal(classifyCandidate(cand(ip)).scope, "public", ip);
  }
});

test("classifyCandidate:loopback 与 IPv6 三态", () => {
  assert.equal(classifyCandidate(cand("127.0.0.1")).scope, "loopback");
  assert.equal(classifyCandidate(cand("::1")).scope, "loopback");
  assert.equal(classifyCandidate(cand("fe80::1")).scope, "lan", "链路本地 IPv6 不算公网");
  assert.equal(classifyCandidate(cand("fd12:3456::1")).scope, "lan", "唯一本地 IPv6 不算公网");
  assert.equal(classifyCandidate(cand("240f:77:160:1:abcd::1")).scope, "public", "全局 IPv6 是泄漏");
});

test("classifyCandidate:空串 / 垃圾输入不许抛", () => {
  assert.equal(classifyCandidate("").scope, "unknown");
  assert.equal(classifyCandidate(null).scope, "unknown");
  assert.equal(classifyCandidate("candidate:1 1 udp 1").scope, "unknown");
});

// ---- 2. 判定 --------------------------------------------------------------

test("★ auditCandidates:0 个候选 → 通过(CloakBrowser 那种)", () => {
  const v = auditCandidates([]);
  assert.equal(v.ok, true);
  assert.equal(v.counts.total, 0);
});

test("★ auditCandidates:只有 mDNS → 通过(mDNS 是缓解,不是泄漏)", () => {
  const v = auditCandidates([cand("aaa-111.local"), cand("bbb-222.local")]);
  assert.equal(v.ok, true);
  assert.equal(v.counts.mdns, 2);
  assert.equal(v.leaks.length, 0);
});

test("★ auditCandidates:ADR-014 那组真实泄漏 → 判不通过,并点名公网项", () => {
  // 复刻 ADR-014 记录的那 4 条
  const v = auditCandidates([
    cand("7d3f-9a2b.local"),
    cand("c1e4-77aa.local"),
    cand("240f:77:160:1:abcd:ef01:2345:6789"),
    cand("124.211.130.95", "srflx"),
  ]);
  assert.equal(v.ok, false, "有公网地址就必须判失败");
  assert.equal(v.leaks.length, 2, "两个公网:一个 IPv6 一个 IPv4");
  assert.deepEqual(
    v.leaks.map((l) => l.address).sort(),
    ["124.211.130.95", "240f:77:160:1:abcd:ef01:2345:6789"],
  );
  assert.equal(v.counts.mdns, 2, "mDNS 那两条要单列,不许混进泄漏");
});

test("★ auditCandidates:局域网地址只算警告,不算致命", () => {
  const v = auditCandidates([cand("192.168.1.50")]);
  assert.equal(v.ok, true, "LAN 暴露的是内网拓扑,不是真实出口");
  assert.equal(v.warnings.length, 1);
  assert.equal(v.leaks.length, 0);
});

// ---- 3. 探针脚本 ----------------------------------------------------------

test("buildWebrtcProbeScript:自包含、用空 iceServers、会自己 close", () => {
  const js = buildWebrtcProbeScript({ gatherMs: 1234 });
  assert.match(js, /new RTCPeerConnection\(\{ iceServers: \[\] \}\)/, "不许用 STUN —— 那本身就会出网");
  assert.match(js, /createDataChannel/, "要有 data channel 才会真的开始收集");
  assert.match(js, /setLocalDescription/, "要下 offer 才出候选");
  assert.match(js, /1234/, "收集时长要能调");
  assert.match(js, /pc\.close\(\)/, "必须自己收尾,别把连接挂着");
});

test("★ buildWebrtcProbeScript:是**可等待的表达式**,不是裸语句", () => {
  const js = buildWebrtcProbeScript();
  assert.match(js.trim(), /^\(async \(\) => \{/, "要包成 IIFE 才能 awaitPromise");
  assert.match(js.trim(), /\}\)\(\)$/, "要立刻调用");
});

test("★ buildWebrtcProbeScript:gatherMs 传垃圾也要退到安全值", () => {
  assert.match(buildWebrtcProbeScript({ gatherMs: "abc" }), /setTimeout\(r, 2000\)/);
  assert.match(buildWebrtcProbeScript({ gatherMs: -5 }), /setTimeout\(r, 2000\)/);
});

// ---- 4. 端到端(假 CDP)----------------------------------------------------

function fakeCdp(value, { withPage = true } = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params, opts = {}) {
      calls.push({ method, params, sessionId: opts.sessionId });
      if (method === "Target.getTargets") {
        return {
          targetInfos: withPage ? [{ targetId: "T-1", type: "page", url: "https://example.com" }] : [],
        };
      }
      if (method === "Target.attachToTarget") return { sessionId: "S-auto" };
      return { result: { value } };
    },
  };
}

test("★ auditWebrtc:把候选接上判定,并透传 error", async () => {
  const cdp = fakeCdp({ error: null, candidates: [cand("124.211.130.95", "srflx")] });
  const v = await auditWebrtc({ cdp });
  assert.equal(v.ok, false);
  assert.equal(v.leaks.length, 1);
  assert.equal(v.error, null);
  // 没给 sessionId ⇒ 先自己挂一个 page session,再带着 sessionId 发 evaluate
  assert.deepEqual(
    cdp.calls.map((c) => c.method),
    ["Target.getTargets", "Target.attachToTarget", "Runtime.evaluate"],
    "应先把 page 挂上再 evaluate(2026-10-25 真机:裸发 evaluate 会得到 'wasn't found')",
  );
  const ev = cdp.calls.at(-1);
  assert.equal(ev.sessionId, "S-auto");
  assert.equal(ev.params.awaitPromise, true, "必须等 promise,否则拿到空数组");
});

test("★ auditWebrtc:evaluate 被拒 → 返回可读原因,**不抛**(自检失败不是通道坏了)", async () => {
  const cdp = {
    async send(method) {
      if (method === "Target.getTargets") return { targetInfos: [] };
      throw new Error("'Runtime.evaluate' wasn't found");
    },
  };
  const v = await auditWebrtc({ cdp });
  assert.equal(v.ok, false);
  assert.match(v.error, /自检没能执行/);
  assert.match(v.error, /Runtime\.evaluate/);
});

test("★ auditWebrtc:探针没返回结果 → 判不通过并说明(不能当成「没泄漏」)", async () => {
  const cdp = fakeCdp(undefined);
  const v = await auditWebrtc({ cdp });
  assert.equal(v.ok, false, "拿不到结果不等于安全");
  assert.match(v.error, /探针没有返回结果/);
});

test("★ auditWebrtc:给了 sessionId 就不再去挂 page(OOPIF 的透传路径)", async () => {
  const cdp = fakeCdp({ error: null, candidates: [] });
  await auditWebrtc({ cdp, sessionId: "S-x" });
  assert.deepEqual(cdp.calls.map((c) => c.method), ["Runtime.evaluate"]);
  assert.equal(cdp.calls[0].sessionId, "S-x");
});
