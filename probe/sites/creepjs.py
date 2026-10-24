"""site: CreepJS —— 自动化 / headless 迹象 + 指纹一致性。

---

## 关于「trust score」的教训(2026-10-24 实测更正)

我最初以为该站会显示 `trust score: NN%`,为此写了一套按 `.trust-score` 选择器 + 文本正则
的提取逻辑。**实测发现:当前版本的主页面根本不显示 trust score** ——
剥离 base64 后的 6 万字符全文里没有任何 `trust` 字样(唯一的命中全是
`TrustedTypePolicyFactory` 这类 DOM API 名)。等 20s、再等 45s 元素都不出现。

改用 `probe/tools/recon_site.py` 摊开真实 DOM 后,看清它现在报的是**按段列出的哈希 + 百分比**:

```
FP ID: e2ab833c… Fuzzy: 134d40c8…
… Headlesse02c2159 chromium: true 88% like headless: d31f1ac1 100% headless: 44172120 0%
  stealth: 0c019315 platform hints: Arial,"Microsoft YaHei UI" 0:73:100:91:91
  Resistanceeb6b354a privacy: unknown security: unknown mode: unknown extension: unknown
```

**决策相关的是 `like headless` 与 `headless` 两个百分比** —— 它们正好落在我们
M0 里那两项内核层红项(`useragent` / `headless`)的同一根轴上。

**教训**:写站点探针前先用 `recon_site.py` 看真实结构,别凭印象猜选择器。
本文件保留这段记录,免得后来人再猜一遍。
"""

from __future__ import annotations

import re

from probe.base import VERDICT_DETECTED, VERDICT_ERROR, VERDICT_PASSED, Site, register_site

URL = "https://abrahamjuliot.github.io/creepjs/"
SETTLE_MS = 25000
# 该段百分比的出现最多再等这么久
WAIT_FOR_SECTION_MS = 20000

# 判定阈值(显式,可复算)
LIKE_HEADLESS_MAX = 50.0   # 「像 headless」超过此值 → detected
HEADLESS_MAX = 50.0        # 「headless」超过此值 → detected

_EXTRACT_JS = r"""
() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = {
    title: document.title,
    url: location.href,
    htmlBytes: document.documentElement.outerHTML.length,
  };

  // CreepJS 会把大量 base64(字体/脚本)塞进 DOM,直接 textContent 会被噪声淹没
  // (实测 documentElement.textContent 有 17.7 万字符)。剥掉再取。
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,link,svg,img,canvas,iframe').forEach((e) => e.remove());
  out.cleanText = norm(clone.textContent).slice(0, 40000);

  // 结构化取「段名 + 哈希 + 百分比」这种行 —— 这是当前版本的实际格式
  const rows = [];
  const re = /([A-Za-z][A-Za-z \/-]{2,24}?):\s*(?:([0-9a-f]{8})|(true|false|unknown))\s+([0-9]+(?:\.[0-9]+)?)%/g;
  let m;
  while ((m = re.exec(out.cleanText)) !== null && rows.length < 40) {
    rows.push({ name: m[1].trim().toLowerCase(), hash: m[2] || "", flag: m[3] || "", pct: Number(m[4]) });
  }
  out.rows = rows;
  return out;
}
"""


def _find(rows: list[dict], name: str) -> float | None:
    for r in rows:
        if r["name"] == name:
            return r["pct"]
    return None


def _classify(detail: dict) -> str:
    like = detail.get("likeHeadless")
    head = detail.get("headless")
    if like is None and head is None:
        return VERDICT_ERROR          # 没取到判据 —— 不等于通过
    if (like is not None and like > LIKE_HEADLESS_MAX) or (head is not None and head > HEADLESS_MAX):
        return VERDICT_DETECTED
    return VERDICT_PASSED


def run(br) -> tuple[str, dict]:
    br.goto(URL, wait_until="domcontentloaded", timeout_ms=90000)
    br.wait(SETTLE_MS)

    detail = br.eval(_EXTRACT_JS)
    rows = detail.get("rows") or []

    like = _find(rows, "like headless")
    head = _find(rows, "headless")
    if like is None or head is None:
        # 再等一轮(该段是异步算出来的)
        br.wait(WAIT_FOR_SECTION_MS)
        detail = br.eval(_EXTRACT_JS)
        rows = detail.get("rows") or []
        like = _find(rows, "like headless")
        head = _find(rows, "headless")

    detail["rows"] = rows
    detail["likeHeadless"] = like
    detail["headless"] = head
    detail["stealth"] = _find(rows, "stealth")
    detail["thresholds"] = {"like_headless_max": LIKE_HEADLESS_MAX, "headless_max": HEADLESS_MAX}
    detail["settle_ms"] = SETTLE_MS

    # 只保留判定相关的行,别把 4 万字符全塞进矩阵
    detail.pop("cleanText", None)

    if like is None and head is None:
        detail["calibration"] = (
            "未校准:未取到 'like headless' / 'headless' 百分比。"
            "该站格式可能又变了 —— 先用 probe/tools/recon_site.py 重看结构。**本项不参与结论**."
        )

    try:
        detail["screenshot"] = br.screenshot("creepjs")
    except Exception as exc:
        detail["screenshot_error"] = repr(exc)

    return _classify(detail), detail


register_site(Site(
    name="creepjs",
    url=URL,
    run=run,
    note="Headless 段百分比(like headless / headless)+ 指纹段;判定按显式阈值",
))
