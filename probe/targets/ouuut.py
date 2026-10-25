"""target: ouuut —— **我们自己的栈**(自有内核 + 自有原生层 + 自有驱动)。

## 它在矩阵里的角色

M1 收尾时留了一条「干净的检测分数拿不到」:当时那次测量是借 **omp 的 CDP harness** 驱动的,
而 harness 会覆盖 UA、发 CDP 命令,于是 `platformMismatch` / `runtimeEnableLeak` 这类红
**是驱动的产物,不是内核的**。要回答"我们自己这套到底多少分",就必须用它自己的驱动。

## 执行模型(与 ego 的适配器不同 —— 这里**能保状态**)

ego 是"一次一进程、靠持久化 TaskSpace 接回上次的页面";我们的 CLI 是"一次一进程、进程结束浏览器就关",
所以**不能**用 ego 那种"每个操作跑一次 CLI"的写法(那样每次都是一个全新的浏览器)。

本适配器改成:**起一个长驻 CLI 进程**,`--script <file>` 喂驱动脚本,然后:

    命令  →  追加进一个 `.jsonl` 文件(驱动**轮询**它)
    结果  ←  stdout 上的 `__PROBE_JSON__{...}` 一行

⚠️ **为什么命令不走 stdin**(2026-10-25 实测,踩了两次才定位):
CLI 在 **stdin 到达 EOF 之前不会开始干活** —— 即使脚本是用 `--script` 从文件读的也一样。
证据:同一份命令,`< 文件`(立刻 EOF)2 秒内就回;而"管道保持打开"(命令早就写进去了)要**等到
20 秒后管道关闭**才回。所以我们**必须**给子进程一个会立刻 EOF 的 stdin(`DEVNULL`),
另找一条通道传命令 —— 就是那个被轮询的文件。
(踩坑顺序也值得记:第一版用 stdin 行协议 → 探针一声不响地挂住;中间还误判过一次
"stderr 管道没人读导致死锁",那是**错**的:改成 `STDOUT` 合并后照样挂。)

## 与 probe 契约的两处**有意偏离**(照实记)

1. **不用 `spec.profile_dir`** —— 我们让 CLI 用它自己的**每会话临时档案目录**(带 pid、会话结束自动删)。
   效果比"每个 target×egress 一个固定目录"更干净:每次探针都是一份全新档案,而且跑完不留垃圾。
2. **可以走代理** —— 上游 ego CLI 没有代理开关(所以它的适配器写死只能 `direct`);我们的 CLI 有 `--proxy`,
   所以本 target **允许**在 `pin-jp-41105` 这类出口上跑(对照实验仍要守 ADR-013:固定出口、轮换池禁用于对照)。

## 页面 API(来自 harness,实测确认)

`p.goto(url)` / `p.evaluate(表达式)`(**表达式语义**,要自己包 IIFE)/ `p.waitForTimeout(ms)` /
`p.click(selector)` / `p.screenshot({path})`(path 必须绝对)。**没有** `waitForSelector` 这类东西。
`console.log` 走 **stdout**(ego 是 stderr)—— 这是行协议能成立的前提。
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from probe.base import LaunchSpec, ProbeError, register_target

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "native" / "bin" / "ouuut.mjs"
SCRIPT_DIR = Path(__file__).resolve().parent.parent / "_ouuut_scripts"
MARK = "__PROBE_JSON__"

DRIVER = r"""
const fs = await import("node:fs");
const send = (obj) => fs.appendFileSync(RES, MARK + JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = await taskSpace("probe-ouuut");
const p = await t.newPage();

let offset = 0;
let stopping = false;
while (!stopping) {
  let text = "";
  try { text = fs.readFileSync(CMDS, "utf8"); } catch { text = ""; }
  if (text.length > offset) {
    const chunk = text.slice(offset);
    offset = text.length;
    for (const raw of chunk.split("\n")) {
      if (!raw.trim()) continue;
      let cmd;
      try { cmd = JSON.parse(raw); } catch { send({ ok: false, error: "命令不是合法 JSON" }); continue; }
      try {
        let v = null;
        if (cmd.op === "goto") { await p.goto(cmd.url); }
        else if (cmd.op === "wait") { await p.waitForTimeout(cmd.ms); }
        else if (cmd.op === "eval") { v = await p.evaluate("(" + cmd.js + ")()"); }
        else if (cmd.op === "click") { await p.click(cmd.selector); }
        else if (cmd.op === "has") { v = await p.evaluate("(() => !!document.querySelector(" + JSON.stringify(cmd.selector) + "))()"); }
        else if (cmd.op === "screenshot") { await p.screenshot({ path: cmd.path }); }
        else if (cmd.op === "close") { send({ ok: true }); stopping = true; break; }
        else { send({ ok: false, error: "未知 op:" + cmd.op }); continue; }
        send({ ok: true, value: v === undefined ? null : v });
      } catch (e) {
        send({ ok: false, error: String((e && e.message) || e) });
      }
    }
  }
  if (!stopping) await sleep(50);
}
"""


class OuUutFacade:
    """把长驻 CLI 进程门面化成一个有状态的浏览器门面。"""

    def __init__(self, proc: subprocess.Popen, cmdlog: Path, reslog: Path, logfile: Path, name: str, timeout: int):
        self.proc = proc
        self.cmdlog = cmdlog
        self.reslog = reslog
        self.logfile = logfile
        self.name = name
        self.timeout = timeout
        self._offset = 0

    def _tail(self) -> str:
        try:
            return self.logfile.read_text(encoding="utf-8", errors="replace")[-600:] or "(空)"
        except OSError:
            return "(读不到日志)"

    # ---- 行协议 --------------------------------------------------------------

    def _read_result(self) -> str | None:
        """结果行从 `reslog` 里读(**不走 stdout** —— 见文件头那段血泪)。返回 None = 暂时没有。"""
        try:
            text = self.reslog.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        if len(text) <= self._offset:
            return None
        chunk = text[self._offset :]
        self._offset = len(text)
        for line in chunk.split("\n"):
            if line.startswith(MARK):
                return line[len(MARK) :]
        return ""

    def _call(self, **cmd: Any) -> Any:
        if self.proc.poll() is not None:
            raise ProbeError(f"{self.name} 的 CLI 进程已经退出(rc={self.proc.returncode})")

        # **每次调用都要有上限**:探针卡住时,不能让整场矩阵运行跟着卡住。
        deadline = time.monotonic() + self.timeout
        with self.cmdlog.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(cmd, ensure_ascii=False) + "\n")

        while time.monotonic() < deadline:
            raw = self._read_result()
            if raw:
                msg = json.loads(raw)
                if not msg.get("ok"):
                    raise ProbeError(f"{self.name}:{msg.get('error')}")
                return msg.get("value")
            if self.proc.poll() is not None:
                raise ProbeError(
                    f"{self.name} 的 CLI 中途退出(rc={self.proc.returncode});尾部:{self._tail()}"
                )
            time.sleep(0.05)

        with contextlib.suppress(Exception):
            self.proc.kill()
        raise ProbeError(
            f"{self.name}:等一条结果超过 {self.timeout}s 还没来 —— 已杀掉 CLI;尾部:{self._tail()}"
        )

    # ---- 门面接口 ------------------------------------------------------------

    def goto(self, url: str, *, wait_until: str = "load", timeout_ms: int = 60000) -> None:
        # `wait_until` 这里没有对应物:harness 的 goto 自己会等文档就绪,调用方随后还会 wait。
        self._call(op="goto", url=url)

    def eval(self, js: str) -> Any:
        return self._call(op="eval", js=js)

    def wait(self, ms: int) -> None:
        self._call(op="wait", ms=int(ms))

    def click(self, selector: str, *, timeout_ms: int = 30000) -> None:
        self._call(op="click", selector=selector)

    def has(self, selector: str, *, timeout_ms: int = 5000) -> bool:
        return bool(self._call(op="has", selector=selector))

    def screenshot(self, name: str) -> str:
        path = SCRIPT_DIR / f"{name}-{os.getpid()}-{id(self)}.png"
        self._call(op="screenshot", path=str(path))
        return str(path)

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._call(op="close")
        with contextlib.suppress(Exception):
            self.proc.wait(timeout=20)
        if self.proc.poll() is None:
            with contextlib.suppress(Exception):
                self.proc.kill()


@contextlib.contextmanager
def launch(spec: LaunchSpec) -> Iterator[OuUutFacade]:
    SCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = f"{os.getpid()}-{int.from_bytes(os.urandom(3), 'big')}"
    cmdlog = SCRIPT_DIR / f"cmds-{stamp}.jsonl"
    reslog = SCRIPT_DIR / f"res-{stamp}.jsonl"
    logfile = SCRIPT_DIR / f"log-{stamp}.txt"
    cmdlog.write_text("", encoding="utf-8")
    reslog.write_text("", encoding="utf-8")
    driver = SCRIPT_DIR / f"driver-{stamp}.mjs"
    driver.write_text(
        f"const MARK = {json.dumps(MARK)};\n"
        f"const CMDS = {json.dumps(str(cmdlog))};\n"
        f"const RES = {json.dumps(str(reslog))};\n"
        f"{DRIVER}",
        encoding="utf-8",
        newline="\n",
    )

    node = os.environ.get("OUUUT_PROBE_NODE", "node")
    argv = [node, str(CLI), "nodejs", "--script", str(driver)]
    if spec.headless:
        argv.append("--headless")
    if spec.egress.proxy:
        argv += ["--proxy", spec.egress.proxy]
    argv += ["--timeout", str(max(30, spec.timeout_ms // 1000))]

    # ⚠️ 三条都是踩出来的(见文件头):stdin 要立刻 EOF;stdout/stderr 都**不要用管道**,
    # 直接落文件 —— 结果也走文件,一行一条。
    with logfile.open("wb") as logfh:
        proc = subprocess.Popen(
            argv,
            cwd=str(REPO),
            stdin=subprocess.DEVNULL,
            stdout=logfh,
            stderr=subprocess.STDOUT,
        )
    facade = OuUutFacade(proc, cmdlog, reslog, logfile, "ouuut", max(30, spec.timeout_ms // 1000))
    try:
        yield facade
    finally:
        facade.close()
        for f in (cmdlog, reslog, logfile, driver):
            f.unlink(missing_ok=True)


register_target("ouuut")(launch)
