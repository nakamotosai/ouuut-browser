"""site: CreepJS —— 自动化 / headless 迹象(**按布尔 tell 判,不按百分比**)。

---

## 这个探针量什么,以及它**不**量什么

量的:页面上 `Headless` 段列出的那组**布尔 tell**(`noChrome`、`noPlugins`、
`notificationIsDenied`、`hasPermissionsBug` …),以及该段的**等级百分比**。

**不量**:它**不**是我们缺的那个「指纹一致性」独立站 —— 它覆盖的是
**headless / 自动化迹象**这一根轴,和 `bot-detector` 的 `headless` 测试**同一根轴**。
所以它是**二次确认**,不是独立维度。(缺口登记在 `docs/M0-结论.md` §四。)

---

## 两次猜错的记录(留着免得后来人再猜)

**第一次**:以为它显示 `trust score: NN%`,写了一套 `.trust-score` 选择器 + 文本正则。
实测:当前版本主页面**根本没有 trust score** —— 剥离 base64 后的全文里 `trust` 零命中
(14 处命中全是 `TrustedTypePolicyFactory` 这类 DOM API 名)。

**第二次**:改用 `probe/tools/recon_site.py` 看到一份文本,里面有
`like headless: d31f1ac1 100% headless: 44172120 0%`,于是写了「哈希 + 百分比」的正则。
**同一天再跑,页面渲染成另一种形态**:

```
Headlesse02c2159  chromium: true 88%
  like headless: d31f1ac1   × Like Headless
  noChrome: true   hasPermissionsBug: true   noPlugins: true   noMimeTypes: true
  notificationIsDenied: true   hasKnownBgColor: false   prefersLightColor: true
  uaDataIsBlank: false   pdfIsDisabled: ...
```

`like headless` **没有百分比**了。按百分比解析必然落空。

**教训**:一个站点的**文本渲染形态会变**,而且同一天内就变。所以判据要挑
**语义最稳定**的那部分 —— 这里是「布尔 tell 的名字与取值」,不是排版。
"""

from __future__ import annotations

from probe.base import VERDICT_DETECTED, VERDICT_ERROR, VERDICT_PASSED, Site, register_site

URL = "https://abrahamjuliot.github.io/creepjs/"
SETTLE_MS = 25000

# 判定阈值(显式、可复算)。
# 该段的等级是**站点自己算的 headless 相似度**;实测四个被测对象的分离度很干净:
#   pw-naive 88% · patchright-hardened 38% · cloak 25% · ego 19%
# 所以取 50% 作分界。改阈值必须同时改 probe/README.md 的方法说明。
GRADE_DETECTED = 50

# 这些 tell 为 true 时说明浏览器带 headless / 自动化特征(名字与该站输出一致)
HEADLESS_TELLS = {
    "noChrome": "window.chrome 缺失(桌面 Chrome 一定有)",
    "noPlugins": "navigator.plugins 为空",
    "noMimeTypes": "navigator.mimeTypes 为空",
    "notificationIsDenied": "Notification.permission 被拒而 permissions.query 说 prompt",
    "hasPermissionsBug": "permissions API 行为与真实 Chrome 不一致",
    "hasHeadlessWorkerUa": "Web Worker 里带 headless UA",
    "hasHeadlessUa": "UA 里带 headless",
    "noDownlinkMax": "NetworkInformation.downlinkMax 缺失",
    "hasBadWebgl": "WebGL 渲染器异常",
    "uaDataIsBlank": "userAgentData 为空",
    "pdfIsDisabled": "PDF 查看器被禁用",
}

_EXTRACT_JS = r"""
() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = {
    title: document.title,
    url: location.href,
    htmlBytes: document.documentElement.outerHTML.length,
  };

  // CreepJS 往 DOM 里塞大量 base64(字体/脚本),直接 textContent 会被噪声淹没
  // (实测 documentElement.textContent 有 17.7 万字符)。剥掉再取。
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,link,svg,img,canvas,iframe').forEach((e) => e.remove());
  const text = norm(clone.textContent);
  out.textLen = text.length;

  // 1) 按**已知名字逐个查**,不做通用词法切分。
  // 原因:该站把名字**粘连**输出(例如 `× Like HeadlessnoChrome: true`),
  // 通用正则 `\b(\w+):\s*(true|false)` 会把前缀吃进名字里
  // —— 实测抓到过 `truehasheadlessworkerua` 这种错键。
  // 逐个名字查子串就绕开了粘连问题。
  const tellNames = ["noChrome", "hasPermissionsBug", "noPlugins", "noMimeTypes",
                     "notificationIsDenied", "hasHeadlessWorkerUa", "hasHeadlessUa",
                     "noDownlinkMax", "hasBadWebgl", "uaDataIsBlank", "pdfIsDisabled",
                     "hasKnownBgColor", "prefersLightColor"];
  const tells = {};
  for (const name of tellNames) {
    const mm = text.match(new RegExp(name + "\\s*:\\s*(true|false)", "i"));
    if (mm) tells[name] = (mm[1].toLowerCase() === 'true');
  }
  out.tells = tells;

  // 2) Headless 段开头的等级:形如 `Headlesse02c2159 chromium: true 88%`
  const g = text.match(/Headless[0-9a-f]{6,10}\s+chromium\s*:\s*(true|false)\s+(\d{1,3})%/i);
  if (!g) {
    // 退一步:任意 `NN%` 里找最像段等级的
    const g2 = text.match(/\bchromium\s*:\s*true\s+(\d{1,3})%/i);
    out.headlessGrade = g2 ? Number(g2[1]) : null;
  } else {
    out.headlessGrade = Number(g[2]);
  }

  out.headSection = (text.match(/Headless[0-9a-f]{6,10}.{0,400}/i) || [''])[0];
  return out;
}
"""


def _classify(detail: dict) -> str:
    tells = detail.get("tells") or {}
    grade = detail.get("headlessGrade")

    if grade is None and not tells:
        return VERDICT_ERROR  # 什么都没抓到 → 探针无效(不等于通过)
    if grade is not None:
        return VERDICT_DETECTED if grade >= GRADE_DETECTED else VERDICT_PASSED
    # 没有等级时退回到 tell:任一 headless 特征的 tell 为 true 即为 detected
    return VERDICT_DETECTED if any(v for k, v in tells.items() if k in HEADLESS_TELLS) else VERDICT_PASSED


def run(br) -> tuple[str, dict]:
    br.goto(URL, wait_until="domcontentloaded", timeout_ms=90000)
    br.wait(SETTLE_MS)

    detail = br.eval(_EXTRACT_JS)

    tells = detail.get("tells") or {}
    detail["tellCount"] = len(tells)
    detail["headlessHits"] = {
        k: {"value": v, "why": HEADLESS_TELLS[k]} for k, v in tells.items() if v and k in HEADLESS_TELLS
    }
    detail["thresholds"] = {"grade_detected": GRADE_DETECTED}
    detail["settle_ms"] = SETTLE_MS

    if not tells and detail.get("headlessGrade") is None:
        detail["calibration"] = (
            "未校准:等级与 tell 都没抓到。该站渲染形态可能又变了 —— "
            "先用 probe/tools/recon_site.py 重看结构。本项不参与结论。"
        )

    try:
        detail["screenshot"] = br.screenshot("creepjs")
    except Exception as exc:
        detail["screenshot_error"] = repr(exc)

    return _classify(detail), detail


register_site(
    Site(
        name="creepjs",
        url=URL,
        run=run,
        note="Headless 段的布尔 tell(noChrome / noPlugins / notificationIsDenied …)"
        "—— 与 bot-detector 的 headless 测试同一根轴,属二次确认",
    )
)
