#!/usr/bin/env node
// native/bin/ouuut-mcp.mjs —— 入口三:MCP stdio(P5 / F14)
//
// 用法(由 MCP 宿主按标准方式起进程,自己接管 stdin/stdout):
//   node native/bin/ouuut-mcp.mjs --headless [--browser <chrome.exe>] [--proxy <url>] [--profile-kind persona] …
//
// 轨迹:每次 `tools/call` 追加一行到 `<runs>/<sessionId>/trajectory.jsonl`
//   * `<runs>` 默认 `os.tmpdir()/ouuut-mcp-runs`,用 `OUUUT_MCP_RUNS_DIR` 改;
//   * 会话 id 默认按时间 + pid 生成,用 `OUUUT_MCP_SESSION_ID` 指定(冒烟/复跑时有用);
//   * 快照正文单独存 `snapshots/`(轨迹行里只留字符数与相对路径)。
//
// ⚠️ **stdout 是协议通道**:我们只往里写 JSON-RPC 行;所有日志/警告一律 stderr
//    (混一句进 stdout,对面会报"JSON 解析失败",而错误现象与那句话毫无关系)。

import { runMcpServer } from "../serve/mcp.mjs";
import { bootServeCore } from "../serve/boot.mjs";
import { createTrajectoryRecorder, resolveRunsDir, SESSION_ID_ENV } from "../serve/trajectory.mjs";

const argv = process.argv.slice(2);
let booted;
try {
  booted = await bootServeCore({ argv });
} catch (err) {
  process.stderr.write(`[ouuut-mcp] ${err?.message ?? err}\n`);
  process.exit(2);
}
const { session, core } = booted;

// 轨迹记录器**不建目录**(懒建):只发 tools/list 的会话不在磁盘上留垃圾。
const recorder = createTrajectoryRecorder({
  runsDir: resolveRunsDir(process.env),
  sessionId: process.env[SESSION_ID_ENV] || undefined,
  stderr: process.stderr,
});

process.stderr.write(
  "[ouuut-mcp] 就绪(JSON-RPC over stdio;工具:browser_goto / browser_snapshot / browser_tabs / " +
    "browser_version / browser_batch / browser_wait / browser_profile)\n",
);
process.stderr.write(`[ouuut-mcp] 轨迹:${recorder.trajectoryPath}(快照另存 snapshots/)\n`);

let code = 0;
try {
  code = await runMcpServer({ core, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, recorder });
} catch (err) {
  process.stderr.write(`[ouuut-mcp] ${err?.stack ?? err}\n`);
  code = 1;
} finally {
  await session.close();
}
process.exit(code);
