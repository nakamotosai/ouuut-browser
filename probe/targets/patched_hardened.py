"""target: patchright-hardened —— 协议层 + 启动参数层**同时**修好。

**这是矩阵里最关键的一格。**

第 2 轮已经证明 `patchright`(只修协议)与 `pw-hardened`(只修参数)的红项
**完全不重叠** —— 那么把两者叠加,剩下的红项就是**真的只能靠内核层解决**的部分。

这一格给出「**不写一行内核代码的前提下,能做到的最好水平**」,直接决定:

- 若叠加后只剩 `useragent` / `headless`(内核品牌与无头标识)类红项 → F17(自研协议)
  可以**大幅收窄**:不需要自研 IPC 协议栈,只需要驱动层补丁 + 参数纪律 + 内核品牌补丁
- 若叠加后仍剩意料之外的红项 → 说明还有第三个变量没被识别,需要继续拆

实现:复用 `pw-hardened` 的参数名单与 `patchright` 的驱动包。
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

from probe.base import LaunchSpec, register_target

from ._playwright_facade import PlaywrightFacade
from .pw_hardened import HARDENED_ARGS, HARDENED_IGNORE_DEFAULTS, make_context_kwargs


@contextlib.contextmanager
def launch(spec: LaunchSpec) -> Iterator[PlaywrightFacade]:
    from patchright.sync_api import sync_playwright

    spec.profile_dir.mkdir(parents=True, exist_ok=True)

    kwargs: dict[str, Any] = {
        "headless": spec.headless,
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
            name="patchright-hardened",
            browser=browser,
            context=context,
            page=page,
            out_dir=spec.out_dir,
        )
        try:
            yield facade
        finally:
            facade.close()


register_target("patchright-hardened")(launch)
