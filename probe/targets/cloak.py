"""target: CloakBrowser —— 商业反检测浏览器的参照点。

它是本项目最直接的「隐身」对照:`cloakbrowser.launch()` 返回的是标准 Playwright
`Browser` 对象,并在内核层打了指纹补丁(C++ 源码级),同时替换了驱动默认参数
(`ignore_default_args=["--enable-automation","--enable-unsafe-swiftshader"]`)。

**它回答的问题**:「花钱买的商业方案,在同一个检测站上到什么水平?」
—— 这是我方要达到或超过的下限基准。

**诚实标注**:本机安装的是**免费档二进制**(Chromium **146**,见竞品缺点表 C9),
不是 Pro(154/155)。两者行为可能不同,结论必须带上这个限定。
"""

from __future__ import annotations

import contextlib
import os
from collections.abc import Iterator
from pathlib import Path

from probe.base import LaunchSpec, register_target

from ._playwright_facade import PlaywrightFacade

# 本机免费档二进制(与竞品缺点表 C9 记录一致)
LOCAL_BINARY = Path(r"<你的家目录>\.cloakbrowser\chromium-146.0.7680.177.5\chrome.exe")


@contextlib.contextmanager
def launch(spec: LaunchSpec) -> Iterator[PlaywrightFacade]:
    from cloakbrowser import launch as cloak_launch

    spec.profile_dir.mkdir(parents=True, exist_ok=True)

    # 用本机已有的二进制,避免 probe venv 再去下一份
    if LOCAL_BINARY.exists():
        os.environ.setdefault("CLOAKBROWSER_BINARY_PATH", str(LOCAL_BINARY))

    proxy = spec.egress.proxy  # cloakbrowser 接受 URL 字符串
    browser = cloak_launch(headless=spec.headless, proxy=proxy)

    context = browser.new_context()
    page = context.new_page()
    facade = PlaywrightFacade(
        name="cloak",
        browser=browser,
        context=context,
        page=page,
        out_dir=spec.out_dir,
    )
    try:
        yield facade
    finally:
        facade.close()


register_target("cloak")(launch)
