"""site: Cloudflare Turnstile demo —— **只观测,不交互**。

---

## 这个探针量什么

**「Cloudflare 是否让这个浏览器免交互通过」** —— 这是一个**二元**的实战判据:

- 页面里的 `input#cf-chl-widget-*_response` 拿到**非空 token** → Cloudflare **直接放行**
  (`passed`)。真人 Chrome 经常是这个结果。
- 控件渲染出来了但 token **一直为空** → Cloudflare **要求人工交互**(`detected`)。
- 控件根本没渲染 → `error`(探针或页面失败,**不等于通过**)。

## 为什么不点那个勾

**我们不做验证码破解、不做自动过验证码**(法律红线 L3 / 功能范围 §2.1 N1)。
自动去点 Turnstile 的复选框就是「自动过验证码」。
所以本探针**只看 Cloudflare 的初始判定**,不施加任何交互 ——
测的是「浏览器本身够不够干净」,不是「我们能不能破它」。

## 为什么不用 iframe API

Turnstile 把控件放在 shadow DOM / 封闭 iframe 里,跨域且拿不到文本。
但**不需要进去**:token 字段 `input#cf-chl-widget-<id>_response` 在主页面上,
它的 `value` 就是 Cloudflare 的裁决结果。

## 站址选择(**踩过一次**)

第一次用的是 Cloudflare **官方** dummy login demo `demo.turnstile.workers.dev`。
它返回 200、控件正常渲染、还真发 token —— 看起来完美。但实测发现:

> token 的值是 **`XXXX.DUMMY.TOKEN`** —— 该站用的是 Cloudflare 的 **dummy sitekey**,
> **对任何客户端都直接发假 token、不做任何评分**。

也就是说,那一轮 `pw-naive` 与 `ego` 都 `passed`,**什么都不证明**。
本探针现在会识别这个假 token 并把结果判为 `error`(而非 `passed`),
同时在 `detail.calibration` 里明说「本次无判别力」。

**要真正测「浏览器够不够干净」,必须用一个用真 sitekey 的演示站。**
用 `PROBE_TURNSTILE_URL` 环境变量切换:

```bash
PROBE_TURNSTILE_URL=https://2captcha.com/demo/cloudflare-turnstile \
  probe/.venv/Scripts/python.exe probe/run.py --targets pw-naive --sites turnstile
```

实测可达性(2026-10-24):`demo.turnstile.workers.dev` 200(但假 sitekey)、
`2captcha.com/demo/cloudflare-turnstile` 200、`peet.ws/turnstile-test/` 200;
`nopecha.com/demo/cloudflare` 与 `turnstile.zeroclover.io` 直连 **403,别用**。
"""

from __future__ import annotations

import os

from probe.base import VERDICT_DETECTED, VERDICT_ERROR, VERDICT_PASSED, Site, register_site

# 站址可用环境变量覆盖 —— 因为「哪个站真的有判别力」需要实测才知道(见下)
URL = os.environ.get("PROBE_TURNSTILE_URL", "https://demo.turnstile.workers.dev/")

WIDGET_SELECTOR = ".cf-turnstile"
# 官方 dummy demo 发的是这个假 token。**它不代表通过** —— 见文件头「假 token」一节。
DUMMY_TOKEN_PREFIX = "XXXX.DUMMY"
# 主页面上那个藏 token 的 input(组件的 id 带随机后缀,所以用前缀匹配)
TOKEN_JS = r"""
() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const widgets = document.querySelectorAll('.cf-turnstile');
  const inputs = [...document.querySelectorAll('input[id^="cf-chl-widget-"]')].map((i) => ({
    id: i.id, name: i.name || '', valueLen: (i.value || '').length,
    valueHead: (i.value || '').slice(0, 16),
  }));
  const solved = inputs.some((i) => i.valueLen > 10);
  return {
    title: document.title,
    url: location.href,
    widgetCount: widgets.length,
    widgetHtmlLen: widgets.length ? (widgets[0].innerHTML || '').length : 0,
    inputs,
    tokenPresent: solved,
    bodyText: norm(document.body.innerText).slice(0, 1500),
  };
}
"""

# 等了这么久还没 token,就认为 Cloudflare 在要求交互
CHALLENGE_WAIT_MS = 25000
POLL_EVERY_MS = 1500
# 控件还没渲染出来时,给它的宽限期;超过这个时间还没控件就认输(探针无效)
WIDGET_GRACE_MS = 6000


def _snapshot(br) -> dict:
    return br.eval(TOKEN_JS)


def _classify(detail: dict, timed_out: bool) -> str:
    if detail.get("widgetCount", 0) == 0:
        return VERDICT_ERROR  # 控件没渲染,探针无效
    if detail.get("dummyTokenPresent"):
        # 假 token = 该站根本没做评分。**这是探针无效,不是通过。**
        return VERDICT_ERROR
    if detail.get("tokenPresent"):
        return VERDICT_PASSED  # Cloudflare 免交互放行
    # 控件在了但始终不给 token = Cloudflare 要求人工交互
    return VERDICT_DETECTED


def run(br) -> tuple[str, dict]:
    br.goto(URL, wait_until="domcontentloaded", timeout_ms=90000)

    detail: dict = {}
    timed_out = False
    waited = 0
    # 轮询等 token —— `BrowserFacade` 没有 waitForFunction,所以自己循环
    while waited < CHALLENGE_WAIT_MS:
        br.wait(POLL_EVERY_MS)
        waited += POLL_EVERY_MS
        try:
            detail = _snapshot(br)
        except Exception as exc:
            detail = {"error": repr(exc), "widgetCount": 0}
            break
        if detail.get("tokenPresent") or (detail.get("widgetCount", 0) == 0 and waited > WIDGET_GRACE_MS):
            break
    else:
        timed_out = True
        detail = _snapshot(br)

    detail["waited_ms"] = waited
    detail["challenge_wait_ms"] = CHALLENGE_WAIT_MS
    detail["interaction_performed"] = False  # 本探针**从不**交互(见文件头)
    detail["timed_out_without_token"] = bool(timed_out and not detail.get("tokenPresent"))

    # 假 sitekey 检测:官方 dummy demo 对所有人直接发 `XXXX.DUMMY.TOKEN`。
    # 拿到它只能说明**这个站没做评分**,不能说明浏览器通过了 —— 所以判 error。
    inputs = detail.get("inputs") or []
    detail["dummyTokenPresent"] = any(
        (i.get("valueHead") or "").startswith(DUMMY_TOKEN_PREFIX) for i in inputs
    )
    if detail["dummyTokenPresent"]:
        detail["calibration"] = (
            "该站使用 Cloudflare 的 **dummy sitekey**,直接发 `XXXX.DUMMY.TOKEN` 假 token、"
            "不做任何评分。**本次结果无判别力,不参与结论。**"
            "请把 PROBE_TURNSTILE_URL 指到一个用真 sitekey 的演示站。"
        )

    try:
        detail["screenshot"] = br.screenshot("turnstile")
    except Exception as exc:
        detail["screenshot_error"] = repr(exc)

    return _classify(detail, timed_out), detail


register_site(
    Site(
        name="turnstile",
        url=URL,
        run=run,
        note="Cloudflare 是否免交互放行(只看 token,不点勾;法律红线 L3)",
    )
)
