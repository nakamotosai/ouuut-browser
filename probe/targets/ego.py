"""target: ego lite —— 「进程内通道 + 不发 `Runtime.enable`」的现成实证。

**它在本矩阵里的角色**:验证 REA 结论 B1/B2 的**运行时**含义 ——
ego 的主通道是 Mojo/ipcz 私有 IPC,CDP 只是按需子通道。
如果「按住 `Runtime.enable` + 进程内通道」真的够,ego 应当在这一项上干净。

**执行模型(与 Playwright 系不同)**:
`ego-browser nodejs` 是**一次一进程**的脚本执行器,不是长驻会话。
但同一台机器上的 **TaskSpace 会持久化** —— 用同一个 `taskSpace(name)` 重新调用,
就能接回上次的页面(已实测:第 3 次调用取回了第 1 次 `goto` 的 URL)。
所以门面的每次操作 = 一次 CLI 调用,脚本里重新 attach 到同名 TaskSpace + 同一 page label。

**两个实测坑**:
1. 脚本里 `console.log` 的输出走 **stderr**,不是 stdout。
2. 文件路径必须绝对;`process.env` 不继承。

**限制(写死,防止污染对照)**:ego CLI 没有代理开关 → 只允许在 `direct` 出口运行。
"""

from __future__ import annotations

import contextlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Iterator

from probe.base import LaunchSpec, ProbeError, register_target

EGO_BIN = r"<你的家目录>\.local\bin\ego-browser.cmd"
_MARK = "__PROBE_JSON__"
_SCRIPT_DIR = Path(__file__).resolve().parent.parent / "_ego_scripts"


class EgoFacade:
    """把「一次一进程的 CLI」伪装成有状态的浏览器门面。"""

    def __init__(self, name: str, space: str, label: str, out_dir: Path, timeout: int = 120):
        self.name = name
        self.space = space
        self.label = label
        self.out_dir = Path(out_dir)
        self.timeout = timeout
        self._script_dir = _SCRIPT_DIR / space
        self._script_dir.mkdir(parents=True, exist_ok=True)
        self._n = 0

    # ---- 内部 --------------------------------------------------------------

    def _exec(self, body: str) -> str:
        """把 body 包成完整脚本跑一次,返回 stdout+stderr 的合并文本。"""
        self._n += 1
        script = (
            f'const t = await taskSpace({json.dumps(self.space)});\n'
            f'const p = t.page({json.dumps(self.label)});\n'
            f"{body}\n"
        )
        path = self._script_dir / f"op-{self._n:03d}.mjs"
        path.write_text(script, encoding="utf-8", newline="\n")

        with open(path, "rb") as fh:
            r = subprocess.run(
                [EGO_BIN, "nodejs"],
                stdin=fh,
                capture_output=True,
                timeout=self.timeout,
            )
        out = (r.stdout or b"").decode("utf-8", "replace")
        err = (r.stderr or b"").decode("utf-8", "replace")
        if r.returncode != 0:
            raise ProbeError(f"ego 脚本失败(rc={r.returncode}): {(err or out).strip()[:600]}")
        return out + "\n" + err

    def _eval_json(self, js_expr: str) -> Any:
        """在页面里求值 js_expr 并把结果以 JSON 取回。

        js_expr 必须是**表达式**(可直接作为 evaluate 的字符串参数)。
        """
        body = (
            f"const v = await p.evaluate({js_expr});\n"
            f'console.log({json.dumps(_MARK)} + JSON.stringify(v === undefined ? null : v));'
        )
        text = self._exec(body)
        for line in text.splitlines():
            idx = line.find(_MARK)
            if idx >= 0:
                return json.loads(line[idx + len(_MARK):])
        raise ProbeError(f"ego 未返回结果标记;输出片段: {text.strip()[:400]}")

    # ---- 门面接口 ----------------------------------------------------------

    def goto(self, url: str, *, wait_until: str = "load", timeout_ms: int = 60000) -> None:
        self._exec(f"await p.goto({json.dumps(url)});")

    def eval(self, js: str) -> Any:
        return self._eval_json(json.dumps(js))

    def wait(self, ms: int) -> None:
        self._exec(f"await p.waitForTimeout({int(ms)});")

    def click(self, selector: str, *, timeout_ms: int = 30000) -> None:
        self._exec(f"await p.click({json.dumps(selector)});")

    def has(self, selector: str, *, timeout_ms: int = 5000) -> bool:
        body = (
            "let ok = false;\n"
            f"try {{ await p.waitForSelector({json.dumps(selector)}, {{ state: 'attached', timeout: {int(timeout_ms)} }}); ok = true; }} catch (e) {{ ok = false; }}\n"
            f'console.log({json.dumps(_MARK)} + JSON.stringify(ok));'
        )
        text = self._exec(body)
        for line in text.splitlines():
            idx = line.find(_MARK)
            if idx >= 0:
                return bool(json.loads(line[idx + len(_MARK):]))
        return False

    def screenshot(self, name: str) -> str:
        path = self.out_dir / "screenshots" / f"{name}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        # go 风格路径:ego 在 Windows 上也接受正斜杠绝对路径
        self._exec(f"await p.screenshot({{ path: {json.dumps(str(path).replace(chr(92), '/'))} }});")
        return str(path)

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._exec("await t.finish({ keep: [] });")


@contextlib.contextmanager
def launch(spec: LaunchSpec) -> Iterator[EgoFacade]:
    if spec.egress.proxy:
        raise ProbeError(
            "ego target 不支持代理(CLI 无代理开关);请在 `direct` 出口上运行,"
            "否则会破坏「同一轮同一出口」的对照纪律。"
        )

    space = f"m0-{spec.target}-{spec.profile_dir.name}"[:60]
    space = re.sub(r"[^A-Za-z0-9_.-]", "-", space)

    # 建空间 + 建页,取回 page label
    setup = (
        f'const t = await taskSpace({json.dumps(space)});\n'
        f"const p = await t.newPage();\n"
        f'console.log({json.dumps(_MARK)} + JSON.stringify({{ space: t.spaceId, label: p.label }}));'
    )
    _SCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    p0 = _SCRIPT_DIR / f"setup-{space}.mjs"
    p0.write_text(setup, encoding="utf-8", newline="\n")

    with open(p0, "rb") as fh:
        r = subprocess.run([EGO_BIN, "nodejs"], stdin=fh, capture_output=True, timeout=180)
    text = (r.stdout or b"").decode("utf-8", "replace") + "\n" + (r.stderr or b"").decode("utf-8", "replace")
    label = None
    for line in text.splitlines():
        idx = line.find(_MARK)
        if idx >= 0:
            label = json.loads(line[idx + len(_MARK):])["label"]
    if not label:
        raise ProbeError(f"ego 建页失败,输出:{text.strip()[:500]}")

    facade = EgoFacade(name="ego", space=space, label=label, out_dir=spec.out_dir)
    try:
        yield facade
    finally:
        facade.close()


register_target("ego")(launch)
