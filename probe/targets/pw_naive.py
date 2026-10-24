"""target: 裸 Playwright + stock Chromium。

**这是矩阵的基线。** 它代表「最容易、最直白」的自动化方式:Playwright 默认行为
(发 `Runtime.enable`、注入 UtilityScript、留 `pptr:`/`__puppeteer_utility_world__`
之类痕迹)。任何改进都必须相对它才有意义。

刻意**不做**任何反检测配置:
- 不加 `--disable-blink-features=AutomationControlled`
- 不改 UA / viewport / locale / timezone
- 不加 stealth 脚本
基线一旦被优化,后面的对照就全是假的。
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator

from probe.base import LaunchSpec

from ._playwright_facade import PlaywrightFacade, make_launch_kwargs


@contextlib.contextmanager
def launch(spec: LaunchSpec) -> Iterator[PlaywrightFacade]:
    from playwright.sync_api import sync_playwright

    spec.profile_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(**make_launch_kwargs(spec))
        context = browser.new_context()
        page = context.new_page()

        facade = PlaywrightFacade(
            name="pw-naive",
            browser=browser,
            context=context,
            page=page,
            out_dir=spec.out_dir,
        )
        try:
            yield facade
        finally:
            facade.close()


# 注册在主模块底部,避免 import 顺序问题
from probe.base import register_target  # noqa: E402

register_target("pw-naive")(launch)
