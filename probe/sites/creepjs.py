"""site: CreepJS —— 指纹一致性与「谎言」检测。

CreepJS 的价值不是「过/不过」,而是**它报出的具体不一致项**:原生属性被改写、
API 行为与声明不符(lies)、headless / 自动化迹象、时区与语言和 IP 不匹配等。

**提取策略**:先原样抓分数与文本,再按显式规则给 verdict。
阈值写在 `TRUST_MIN` / `BOT_MAX` 里,**改阈值必须同时改 probe/README.md 的方法说明**。
"""

from __future__ import annotations

import re

from probe.base import VERDICT_DETECTED, VERDICT_ERROR, VERDICT_PASSED, Site, register_site

URL = "https://abrahamjuliot.github.io/creepjs/"
# CreepJS 要收集完所有指纹后才算信任分,实测 15s 不够(抓到的文本里连 "trust" 字样都没有)
SETTLE_MS = 20000
# 信任分出现前最多再等这么久
WAIT_FOR_SCORE_MS = 45000
SCORE_SELECTORS = [".trust-score", "#trust-score", ".fingerprint-header", "[class*='trust']"]

# 规则阈值(显式,可复算)
TRUST_MIN = 0.5  # trust score 低于此 → detected
BOT_MAX = 0.5  # bot 概率高于此 → detected

_EXTRACT_JS = r"""
() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = {};
  out.title = document.title;
  out.url = location.href;

  const grab = (sel, limit = 30) => [...document.querySelectorAll(sel)]
    .map((e) => norm(e.innerText || e.textContent)).filter(Boolean).slice(0, limit);

  out.h = grab('h1,h2,h3,h4');
  out.fingerprint = grab('.fingerprint-header, .fingerprint-header .ellipsis');
  out.trustScoreNodes = grab('.trust-score, .trust-score > *');
  out.botNodes = grab('.bot-detector, .bot-detector > *');
  out.lies = grab('.lies, .lies > *, .lie');
  // 实测类名会变,所以再按「class 里含关键词」兜一层
  out.byKeyword = grab(
    "[class*='trust'], [class*='Trust'], [class*='bot'], [class*='Bot'], "
    + "[class*='score'], [class*='Score']",
    60
  );
  out.fingerprintText = norm(((document.querySelector('#fingerprint') || {}).innerText) || '').slice(0, 8000);
  // CreepJS 会把大量 base64(字体/脚本)塞进 DOM,textContent 直接取会被噪声淹没
  // (实测 documentElement.textContent 有 17.7 万字符,真正的文本看不到)。
  // 所以先克隆一份、剥掉 script/style/svg/img 等,再取文本。
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,link,svg,img,canvas,iframe').forEach((e) => e.remove());
  out.cleanText = norm(clone.textContent).slice(0, 60000);
  out.bodyText = norm(document.body.innerText).slice(0, 40000);
  out.bodyTextContent = out.cleanText;
  out.htmlBytes = document.documentElement.outerHTML.length;

  // 尽量直接取分数
  const num = (txt) => {
    if (txt == null) return null;
    const m = String(txt).match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? Number(m[1]) / 100 : null;
  };
  out.trustParsed = num((document.querySelector('.trust-score') || {}).innerText);
  out.botParsed = num((document.querySelector('.bot-detector') || {}).innerText);
  return out;
}
"""


def _classify(detail: dict) -> str:
    trust = detail.get("trustParsed")
    bot = detail.get("botParsed")
    # innerText 会漏掉隐藏/懒渲染区块,CreepJS 正好是这种页 —— 所以退回 textContent
    text = detail.get("bodyText") or ""
    if not text.strip():
        text = detail.get("bodyTextContent") or ""
    if "trust" not in text.lower() and detail.get("bodyTextContent"):
        text = detail["bodyTextContent"]

    if trust is None and bot is None and not text:
        return VERDICT_ERROR
    # 没取到结构化分数时,退回到文本里的模式
    if trust is None:
        m = re.search(r"trust score[:\s]*(\d+(?:\.\d+)?)\s*%", text, re.I)
        trust = float(m.group(1)) / 100 if m else None
    if bot is None:
        m = re.search(r"\bbot\b[:\s]*(\d+(?:\.\d+)?)\s*%", text, re.I)
        bot = float(m.group(1)) / 100 if m else None

    if bot is not None and bot > BOT_MAX:
        return VERDICT_DETECTED
    if trust is not None and trust < TRUST_MIN:
        return VERDICT_DETECTED
    if trust is None and bot is None:
        return VERDICT_ERROR
    return VERDICT_PASSED


def run(br) -> tuple[str, dict]:
    br.goto(URL, wait_until="domcontentloaded", timeout_ms=90000)
    br.wait(SETTLE_MS)

    # 等信任分真正渲染出来 —— 否则整页 innerText 里连 "trust" 都没有
    score_appeared = any(br.has(sel, timeout_ms=8000) for sel in SCORE_SELECTORS)
    if score_appeared:
        br.wait(3000)

    detail = br.eval(_EXTRACT_JS)
    detail["thresholds"] = {"trust_min": TRUST_MIN, "bot_max": BOT_MAX}
    detail["settle_ms"] = SETTLE_MS
    detail["score_element_seen"] = score_appeared

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
        note="指纹一致性 / 原生改写 / 自动化迹象;报 trust score 与 bot%",
    )
)
