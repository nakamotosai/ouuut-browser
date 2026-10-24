"""site: BrowserLeaks / WebRTC —— **代理是否真的盖住了整个浏览器**。

这是最容易被忽略、后果最严重的一类失败:**HTTP 走了代理,WebRTC 却把真实 IP 捅出去**。
判据是**自洽的、不依赖外部知识**的:

  页面自己 fetch 一次 `api.ipify.org` 得到「HTTP 出口 IP」,
  再取 WebRTC 报出的公网候选地址。
  → 两者不一致 = **泄漏**(detected)
  → WebRTC 没报任何公网地址 = 干净(passed)

这样即使出口 IP 变了,判定依然成立。
"""

from __future__ import annotations

from probe.base import VERDICT_DETECTED, VERDICT_ERROR, VERDICT_PASSED, Site, register_site

URL = "https://browserleaks.com/webrtc"
SETTLE_MS = 10000

_EXTRACT_JS = r"""
async () => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = {};
  out.title = document.title;
  out.url = location.href;

  // 1) HTTP 出口 IP(页面自己看到的)
  try {
    const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
    out.httpExitIp = (await r.json()).ip;
  } catch (e) { out.httpExitIpError = String(e); }

  // 2) WebRTC 公网候选
  const isPublic = (ip) => !(
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) || /^127\./.test(ip) || /^0\./.test(ip) ||
    /^fe80:/i.test(ip) || /^fc|^fd/i.test(ip) || /^::1$/.test(ip)
  );

  out.rtcCandidates = [];
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('probe');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      pc.onicecandidate = (e) => { if (!e.candidate) finish(); };
      setTimeout(finish, 6000);
    });
    const sdp = pc.localDescription ? pc.localDescription.sdp : '';
    out.rtcSdpAddresses = [...sdp.matchAll(/candidate:[^\s]+ \d+ (udp|tcp) \d+ (\S+) \d+ typ (\w+)/g)]
      .map((m) => ({ proto: m[1], addr: m[2], typ: m[3], public: isPublic(m[2]) }));
    out.rtcPublic = out.rtcSdpAddresses.filter((c) => c.public).map((c) => c.addr);
    pc.close();
  } catch (e) { out.rtcError = String(e); }

  // 3) 页面自己展示的表(作为人类的第二份证据)
  out.pageRows = [...document.querySelectorAll('table tr, .table tr, [class*="result"]')]
    .map((e) => norm(e.innerText)).filter(Boolean).slice(0, 60);
  out.bodyText = norm(document.body.innerText).slice(0, 15000);
  return out;
}
"""


def _classify(detail: dict) -> str:
    http_ip = detail.get("httpExitIp")
    public = detail.get("rtcPublic") or []

    if detail.get("rtcError") and not http_ip:
        return VERDICT_ERROR

    if public:
        if http_ip and all(p != http_ip for p in public):
            return VERDICT_DETECTED          # WebRTC 报了与 HTTP 出口不同的公网地址
        return VERDICT_DETECTED              # 只要有公网候选就算暴露(即使与出口一致)
    if http_ip:
        return VERDICT_PASSED                # 只有 HTTP 出口,无 WebRTC 公网候选
    return VERDICT_ERROR


def run(br) -> tuple[str, dict]:
    br.goto(URL, wait_until="domcontentloaded", timeout_ms=90000)
    br.wait(SETTLE_MS)

    detail = br.eval(_EXTRACT_JS)
    detail["settle_ms"] = SETTLE_MS

    try:
        detail["screenshot"] = br.screenshot("browserleaks-webrtc")
    except Exception as exc:
        detail["screenshot_error"] = repr(exc)

    return _classify(detail), detail


register_site(Site(
    name="browserleaks",
    url=URL,
    run=run,
    note="WebRTC 是否泄漏非出口 IP;页面自证式判据(HTTP 出口 vs RTC 候选)",
))
