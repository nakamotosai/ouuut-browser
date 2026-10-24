"""诊断:`ignore_default_args=True` 到底为什么让 Playwright 起不来。

打印每一步,并把 Playwright 自己的报错(含浏览器 stderr)完整吐出来。
用 `timeout 120` 包着跑,避免无限挂。
"""
import sys, traceback
from pathlib import Path

sys.path.insert(0, r"F:/projects/ouuut-browser")
from playwright.sync_api import sync_playwright  # noqa: E402

print("=== A: ignore_default_args=True + 自定 args + channel=chromium ===", flush=True)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(
            headless=True,
            channel="chromium",
            ignore_default_args=True,
            args=["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
            timeout=20000,
        )
        print("  launched OK", flush=True)
        print("  UA:", b.new_context().new_page().evaluate("() => navigator.userAgent"), flush=True)
        b.close()
except Exception:
    traceback.print_exc()

print("=== B: 同上但去掉 channel ===", flush=True)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(
            headless=True,
            ignore_default_args=True,
            args=["--no-first-run", "--no-default-browser-check"],
            timeout=20000,
        )
        print("  launched OK", flush=True)
        b.close()
except Exception:
    traceback.print_exc()

print("=== C: ignore_default_args=具体名单(保留其它默认) ===", flush=True)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(
            headless=True,
            channel="chromium",
            ignore_default_args=[
                "--disable-ipc-flooding-protection",
                "--disable-popup-blocking",
                "--enable-unsafe-swiftshader",
            ],
            args=["--no-first-run", "--disable-blink-features=AutomationControlled"],
            timeout=20000,
        )
        pg = b.new_context().new_page()
        print("  launched OK", flush=True)
        print("  UA:", pg.evaluate("() => navigator.userAgent"), flush=True)
        print("  webdriver:", pg.evaluate("() => navigator.webdriver"), flush=True)
        print("  window.chrome:", pg.evaluate("() => typeof window.chrome"), flush=True)
        b.close()
except Exception:
    traceback.print_exc()
print("DONE", flush=True)
