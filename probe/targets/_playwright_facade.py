"""Playwright 家族(playwright / patchright)共用的 BrowserFacade 与启动参数。

playwright 与 patchright 的 API 逐字兼容,所以两者共用这一份门面;
差别只在于载入哪个顶层包(见 `pw_naive.py` 与 `patched_playwright.py`)。
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from probe.base import LaunchSpec


def make_launch_kwargs(spec: LaunchSpec) -> dict[str, Any]:
    """把 LaunchSpec 翻成 `chromium.launch(**kwargs)` 的参数。

    **刻意保持最小**:只设 headless 与 proxy。不注入任何反检测参数 ——
    基线必须是「诚实的默认行为」,否则后面的对照没有意义。
    """
    kwargs: dict[str, Any] = {"headless": spec.headless}
    if spec.egress.proxy:
        kwargs["proxy"] = {"server": spec.egress.proxy}
    return kwargs


@dataclass
class PlaywrightFacade:
    """把 Playwright 的 Page 包装成契约要求的门面。"""

    name: str
    browser: Any
    context: Any
    page: Any
    out_dir: Path
    _closed: bool = False

    # ---- 门面接口 ----------------------------------------------------------

    def goto(self, url: str, *, wait_until: str = "load", timeout_ms: int = 60000) -> None:
        self.page.goto(url, wait_until=wait_until, timeout=timeout_ms)

    def eval(self, js: str) -> Any:
        return self.page.evaluate(js)

    def wait(self, ms: int) -> None:
        self.page.wait_for_timeout(ms)

    def click(self, selector: str, *, timeout_ms: int = 30000) -> None:
        self.page.click(selector, timeout=timeout_ms)

    def has(self, selector: str, *, timeout_ms: int = 5000) -> bool:
        try:
            self.page.wait_for_selector(selector, timeout=timeout_ms)
            return True
        except Exception:
            return False

    def screenshot(self, name: str) -> str:
        path = Path(self.out_dir) / "screenshots" / f"{name}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(path), full_page=True)
        return str(path)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            self.context.close()
        with contextlib.suppress(Exception):
            self.browser.close()
