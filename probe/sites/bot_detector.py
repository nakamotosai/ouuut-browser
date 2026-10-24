"""site: bot-detector.rebrowser.net —— **M0 最直接的证据来源**。

该站逐项探测 CDP 留下的页面可观测痕迹(`Runtime.enable` 泄漏、栈帧命名泄漏、
执行世界名泄漏、`navigator.webdriver`、headless 迹象、启动参数残留等)。
它直接回答 M0 的核心问题。

**判定依据是站点自己的状态符号,不是文本正则。**
第一版曾用关键词正则,结果把 patchright 的 `"No leak detected."` 判成失败 ——
教训:优先解析**结构化信号**,不要用自然语言猜。

该站每行首字符即状态:
    红圆 = 失败(失败项)  /  黄圆 = 警告  /  绿圆 = 通过  /  白圆 = 未触发(不参与判定)
"""

from __future__ import annotations

from probe.base import VERDICT_DETECTED, VERDICT_ERROR, VERDICT_PASSED, Site, register_site

URL = "https://bot-detector.rebrowser.net/"
SETTLE_MS = 13000

# ---- 状态符号 → 语义 --------------------------------------------------------
# 注意 ⚪️ 带变体选择符(U+FE0F),所以按前缀码位判定而不是整串比较。
STATUS_FAIL = "fail"
STATUS_WARN = "warn"
STATUS_PASS = "pass"
STATUS_SKIP = "skip"

_EMOJI_STATUS = {
    "\U0001f534": STATUS_FAIL,  # 🔴
    "\U0001f7e1": STATUS_WARN,  # 🟡
    "\U0001f7e2": STATUS_PASS,  # 🟢
    "\U0001f7e0": STATUS_WARN,  # 🟠
    "\U0001f536": STATUS_WARN,  # 🔶
    "\U0001f6a8": STATUS_FAIL,  # 🚨
    "\u26aa": STATUS_SKIP,  # ⚪ (含 ⚪️)
    "\U0001f535": STATUS_SKIP,  # 🔵
    "\u2b1c": STATUS_SKIP,  # ⬜
}
_SKIPPED_NAMES = {"Test name"}

_EXTRACT_JS = r"""
() => {
  const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const rows = [...document.querySelectorAll('table tr')];

  // 注意:不能用 /\S/ 取状态符号 —— 🔴(U+1F534)是代理对,正则不带 u 标志时
  // \S 只吃到高代理项,匹配失败。所以按第一个空格硬切。
  const splitMark = (s) => {
    const sp = s.indexOf(' ');
    if (sp < 0) return { mark: '', name: s };
    return { mark: s.slice(0, sp), name: s.slice(sp + 1).trim() };
  };

  const tests = rows.map((tr) => {
    const tds = [...tr.children].map((td) => norm(td.innerText || td.textContent));
    if (tds.length < 2) return null;
    const { mark, name } = splitMark(tds[0] || '');
    return {
      raw: tds[0] || '',
      mark,
      name,
      ms: tds[1] || '',
      note: tds[2] || '',
    };
  }).filter((t) => t && t.name);

  const out = {
    title: document.title,
    url: location.href,
    tests,
    bodyText: norm(document.body.innerText).slice(0, 20000),
    htmlBytes: document.documentElement.outerHTML.length,
  };
  return out;
}
"""


def _status_of(mark: str) -> str | None:
    if not mark:
        return None
    m = mark.replace("\ufe0f", "").strip()  # 去掉变体选择符(⚪️ → ⚪)
    if not m:
        return None
    return _EMOJI_STATUS.get(m) or _EMOJI_STATUS.get(m[0])


def _classify(tests: list[dict]) -> str:
    """任何红项 = detected;无红项且有绿项 = passed;其余 = error(没抓到结果)。"""
    scored = [(t["name"], _status_of(t.get("mark", ""))) for t in tests]
    scored = [(n, s) for n, s in scored if n not in _SKIPPED_NAMES and s is not None]

    if not scored:
        return VERDICT_ERROR
    if any(s == STATUS_FAIL for _, s in scored):
        return VERDICT_DETECTED
    if any(s == STATUS_PASS for _, s in scored):
        return VERDICT_PASSED
    return VERDICT_ERROR


def run(br) -> tuple[str, dict]:
    br.goto(URL, wait_until="load", timeout_ms=90000)
    br.wait(SETTLE_MS)

    detail = br.eval(_EXTRACT_JS)
    tests = detail.get("tests") or []

    # 结构化:每项测试的语义状态 —— 这是 M0 差分表的原始数据
    detail["checks"] = [
        {
            "name": t["name"],
            "status": _status_of(t.get("mark", "")) or "unknown",
            "mark": t.get("mark", ""),
            "ms": t.get("ms", ""),
            "note": t.get("note", "")[:1200],
        }
        for t in tests
        if t["name"] not in _SKIPPED_NAMES
    ]
    detail["failed"] = [c["name"] for c in detail["checks"] if c["status"] == STATUS_FAIL]
    detail["warned"] = [c["name"] for c in detail["checks"] if c["status"] == STATUS_WARN]
    detail["passed_checks"] = [c["name"] for c in detail["checks"] if c["status"] == STATUS_PASS]
    detail["settle_ms"] = SETTLE_MS

    try:
        detail["screenshot"] = br.screenshot("bot-detector")
    except Exception as exc:
        detail["screenshot_error"] = repr(exc)

    return _classify(tests), detail


register_site(
    Site(
        name="bot-detector",
        url=URL,
        run=run,
        note="逐项探测 CDP 的页面可观测痕迹;判定用站点自身的红/黄/绿状态符号",
    )
)
