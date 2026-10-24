"""target: patchright —— rebrowser 补丁的 Python 版。

**这是整个 M0 的核心对照。** 它与 `pw-naive` 的区别**只在于驱动层是否按住
`Runtime.enable` 等会留下页面可观测副作用的 CDP 命令**。

- 若 `patchright` 与 `pw-naive` 的检测结果**几乎相同** → 「按住 `Runtime.enable`
  不够」,阶段 B(自研协议 / F17)仍有必要。
- 若两者**显著不同**且 patchright 干净 → 「按住即够」,F17 可取消,省 4–6 周。

文件名带后缀以避免与顶层 `patchright` 包同名造成阅读歧义;
注册的 target 名仍是 `patchright`。
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator

from probe.base import LaunchSpec, register_target

from ._playwright_facade import PlaywrightFacade, make_launch_kwargs


@contextlib.contextmanager
def launch(spec: LaunchSpec) -> Iterator[PlaywrightFacade]:
    from patchright.sync_api import sync_playwright

    spec.profile_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(**make_launch_kwargs(spec))
        context = browser.new_context()
        page = context.new_page()
        facade = PlaywrightFacade(
            name="patchright",
            browser=browser,
            context=context,
            page=page,
            out_dir=spec.out_dir,
        )
        try:
            yield facade
        finally:
            facade.close()


register_target("patchright")(launch)
