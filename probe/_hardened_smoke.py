
import sys, traceback
sys.path.insert(0, r"F:/projects/ouuut-browser")
from probe.base import LaunchSpec, EGRESSES
from probe.targets import pw_hardened
from pathlib import Path

spec = LaunchSpec(target="pw-hardened", egress=EGRESSES["direct"],
                  profile_dir=Path(r"F:/projects/ouuut-browser/probe/out/_smoke/profile"),
                  out_dir=Path(r"F:/projects/ouuut-browser/probe/out/_smoke"),
                  headless=True)
try:
    with pw_hardened.launch(spec) as br:
        br.goto("https://example.com", timeout_ms=45000)
        print("TITLE:", br.eval("() => document.title"))
        print("UA:", br.eval("() => navigator.userAgent"))
        print("webdriver:", br.eval("() => navigator.webdriver"))
        print("window.chrome:", br.eval("() => typeof window.chrome"))
        print("brands:", br.eval("() => JSON.stringify(navigator.userAgentData && navigator.userAgentData.brands)"))
except Exception:
    traceback.print_exc()
