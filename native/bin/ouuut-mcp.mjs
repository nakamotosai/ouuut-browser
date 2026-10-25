#!/usr/bin/env node
// native/bin/ouuut-mcp.mjs —— 入口三:MCP stdio(P5 / F14)
//
// 用法(由 MCP 宿主按标准方式起进程,自己接管 stdin/stdout):
//   node native/bin/ouuut-mcp.mjs --headless [--browser <chrome.exe>] [--proxy <url>] [--profile-kind persona] …
//
// ⚠️ **stdout 是协议通道**:我们只往里写 JSON-RPC 行;所有日志/警告一律 stderr
//    (混一句进 stdout,对面会报"JSON 解析失败",而错误现象与那句话毫无关系)。

import { runMcpServer } from "../serve/mcp.mjs";
import { bootServeCore } from "../serve/boot.mjs";

const argv = process.argv.slice(2);
let booted;
try {
  booted = await bootServeCore({ argv });
} catch (err) {
  process.stderr.write(`[ouuut-mcp] ${err?.message ?? err}\n`);
  process.exit(2);
}
const { session, core } = booted;

process.stderr.write("[ouuut-mcp] 就绪(JSON-RPC over stdio;工具:browser_goto / browser_snapshot / browser_tabs / browser_version)\n");

let code = 0;
try {
  code = await runMcpServer({ core, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
} catch (err) {
  process.stderr.write(`[ouuut-mcp] ${err?.stack ?? err}\n`);
  code = 1;
} finally {
  await session.close();
}
process.exit(code);
