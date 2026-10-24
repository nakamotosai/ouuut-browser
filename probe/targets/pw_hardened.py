"""target: pw-hardened —— 裸 Playwright + **修好的启动参数**,协议层不动。

**这是 M0 的关键第三点。** 三个点连起来才能分离变量:

| target | 协议层 | 启动参数层 | 内核/无头模式 | 看到它就知道 |
|---|---|---|---|---|
| `pw-naive` | 脏(`Runtime.enable` 开着) | 脏(Playwright 默认) | headless-shell | 起点 |
| `patchright` | **干净** | 仍脏 | headless-shell | 「只修协议」能走多远 |
| `pw-hardened` | 脏 | **干净** | 完整 Chromium | 「只修参数」能走多远 |

三格交叉后:
- 若 `pw-hardened` 把红项清干净了 → 协议层不是瓶颈,F17(自研协议)可取消
- 若两者各有互补红项 → 两者都得做
- 若都清不干净 → 需要内核层补丁(印证 v3 §五「C++ 源码级补丁是唯一站得住的隐身层」)

---

### 实现踩过的坑(务必保留,别再试)

| 写法 | 结果 |
|---|---|
| `ignore_default_args=True` | ❌ **起不来**。Playwright 连 `--headless` 之类一起丢掉,浏览器 `<launched>` 后立刻 close |
| `ignore_default_args=True` 且不加 `channel` | ❌ 20s **超时**。headless-shell 起来了但 Playwright 连不上 |
| `ignore_default_args=[具体名单]` + `channel="chromium"` | ✅ **可用** |

实测收益(2026-10-24,`channel="chromium"` + `--disable-blink-features=AutomationControlled`):
- `navigator.webdriver` → **false**(原来 true)
- `typeof window.chrome` → **object**(原来 undefined)
- UA 仍是 `HeadlessChrome/...` —— **这一项参数层修不掉**,属内核/无头模式层
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

from probe.base import LaunchSpec, register_target

from ._playwright_facade import PlaywrightFacade

# Playwright 默认参数里,会被检测站点名、且我们不需要的那几个
HARDENED_IGNORE_DEFAULTS: list[str] = [
    "--disable-ipc-flooding-protection",  # 300/300 replaceState 全过 → 一眼假
    "--disable-popup-blocking",  # 无点击即弹窗
    "--enable-unsafe-swiftshader",  # 强制软件 WebGL → 一眼假
]

# 我们自己的参数
HARDENED_ARGS: list[str] = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",  # navigator.webdriver = false
    # 覆盖 Playwright 那一长串默认 --disable-features(它含 ThirdPartyStoragePartitioning,
    # 会让第三方存储分区失效)。我们的参数在默认参数之后追加 → 后出现的开关生效。
    "--disable-features=Translate,BackForwardCache",
]

# 视口:不要用 Playwright 默认的 1280x720(检测站把这个当指纹)
HARDENED_VIEWPORT = {"width": 1920, "height": 1080}


def make_context_kwargs() -> dict[str, Any]:
    return {"viewport": dict(HARDENED_VIEWPORT)}


@contextlib.contextmanager
def launch(spec: LaunchSpec) -> Iterator[PlaywrightFacade]:
    from playwright.sync_api import sync_playwright

    spec.profile_dir.mkdir(parents=True, exist_ok=True)

    kwargs: dict[str, Any] = {
        "headless": spec.headless,
        # 完整 Chromium 的 headless,而不是默认的 chrome-headless-shell
        # (后者 UA 写 HeadlessChrome 且没有 window.chrome)
        "channel": "chromium",
        "ignore_default_args": list(HARDENED_IGNORE_DEFAULTS),
        "args": list(HARDENED_ARGS),
    }
    if spec.egress.proxy:
        kwargs["proxy"] = {"server": spec.egress.proxy}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(**kwargs)
        context = browser.new_context(**make_context_kwargs())
        page = context.new_page()
        facade = PlaywrightFacade(
            name="pw-hardened",
            browser=browser,
            context=context,
            page=page,
            out_dir=spec.out_dir,
        )
        try:
            yield facade
        finally:
            facade.close()


register_target("pw-hardened")(launch)
