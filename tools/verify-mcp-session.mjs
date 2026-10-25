#!/usr/bin/env node
// tools/verify-mcp-session.mjs —— MCP stdio 的**真链路**冒烟(P5 / F14 的改造验收)
//
// 用法:`node tools/verify-mcp-session.mjs [--headless] [--url <url>] [--runs-dir <dir>] [--profile-kind persona|disposable|real]`
// 退出码:0 = 全过;1 = 有断言失败;2 = 自身起不来。
//
// 它做的是**协议层**的事,不是"直接调 core":
//   起 `native/bin/ouuut-mcp.mjs` → initialize → tools/list(必须 7 个工具)
//   → [给了 --profile-kind 时] browser_profile → browser_goto
//   → browser_batch(快照 + wait + tabs + version)→ browser_wait(文本)
//   → 关 stdin → 读 `runs/<sessionId>/trajectory.jsonl` 逐行核对。
//
// 默认页面是**本地临时 HTML**(file://),这样冒烟不依赖外网;要测真站点用 `--url`。
// 所有 JSON-RPC 往来都落到 `<session>/transcript.jsonl`(证据,不在 stdout 里混协议)。

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MCP = path.join(ROOT, "native", "bin", "ouuut-mcp.mjs");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const browserFlags = flag("--headless") ? ["--headless"] : [];
const profileKind = value("--profile-kind", null);
const runsDir = value("--runs-dir", null);
const sessionId = `smoke-${new Date()
  .toISOString()
  .replace(/\.\d+Z$/, "")
  .replace(/[-:]/g, "")
  .replace("T", "-")}`;

const fail = (msg) => {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(1);
};

// 本地靶页:标题 + 一个可等到的选择器 + 一段可等的文本。
const pageDir = await mkdtemp(path.join(os.tmpdir(), "ouuut-mcp-smoke-page-"));
const pagePath = path.join(pageDir, "smoke.html");
await writeFile(
  pagePath,
  "<!doctype html><html><head><title>ouuut mcp smoke</title></head>" +
    '<body><h1 id="ready">hello ouuut mcp</h1><p>batch and wait</p></body></html>',
  "utf8",
);
const url = value("--url", `file:///${pagePath.replace(/\\/g, "/")}`);

const env = { ...process.env, OUUUT_MCP_SESSION_ID: sessionId };
if (runsDir) env.OUUUT_MCP_RUNS_DIR = path.resolve(runsDir);

const child = spawn(process.execPath, [MCP, ...browserFlags, ...(profileKind ? ["--profile-kind", profileKind] : [])], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  env,
});

const transcript = [];
let stdoutBuf = "";
let stderrBuf = "";
const replies = new Map();

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  let nl = stdoutBuf.indexOf("\n");
  while (nl !== -1) {
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    nl = stdoutBuf.indexOf("\n");
    if (line.trim() === "") continue;
    transcript.push({ dir: "in", line });
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.id !== null) replies.set(msg.id, msg);
    } catch {
      fail(`stdout 里出现了非协议行(会毁掉 JSON-RPC):${line.slice(0, 200)}`);
    }
  }
});
child.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString("utf8");
});

const send = (obj, { waitFor = null, timeoutMs = 120000 } = {}) => {
  const line = JSON.stringify(obj);
  transcript.push({ dir: "out", line });
  child.stdin.write(line + "\n");
  if (waitFor === null) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = setInterval(() => {
      if (replies.has(waitFor)) {
        clearInterval(tick);
        resolve(replies.get(waitFor));
      } else if (child.exitCode !== null) {
        clearInterval(tick);
        reject(new Error(`MCP 进程已退出(code=${child.exitCode}):\n${stderrBuf.slice(-2000)}`));
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`等 id=${waitFor} 超时(${timeoutMs}ms):\n${stderrBuf.slice(-2000)}`));
      }
    }, 50);
  });
};

const toolCall = (id, name, args) =>
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, { waitFor: id });

const textOf = (reply) => reply?.result?.content?.[0]?.text ?? "";

let exitCode = 0;
try {
  const init = await send(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
    { waitFor: 1 },
  );
  if (init.error) fail(`initialize 失败:${JSON.stringify(init.error)}`);
  if (init.result?.serverInfo?.name !== "ouuut") fail(`serverInfo 不对:${JSON.stringify(init.result)}`);
  process.stdout.write(`initialize: ok(${init.result.protocolVersion})\n`);

  const list = await send({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { waitFor: 2 });
  const names = (list.result?.tools ?? []).map((t) => t.name);
  const expected = [
    "browser_goto",
    "browser_snapshot",
    "browser_tabs",
    "browser_version",
    "browser_batch",
    "browser_wait",
    "browser_profile",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`tools/list 不对:${JSON.stringify(names)}`);
  process.stdout.write(`tools/list: ${names.length} 个工具 ${names.join(" / ")}\n`);

  const expectedTools = [];
  if (profileKind) {
    const prof = await toolCall(3, "browser_profile", {});
    if (prof.result?.isError) fail(`browser_profile 失败:${textOf(prof)}`);
    const p = JSON.parse(textOf(prof));
    if (p.kind !== profileKind) fail(`browser_profile 的 kind=${JSON.stringify(p.kind)},应为 ${profileKind}`);
    if (p.archiveReachable !== true) fail(`档案引擎不可达(archiveReachable=false):${JSON.stringify(p)}`);
    process.stdout.write(`browser_profile: ${p.profileId}/${p.kind} archiveReachable=${p.archiveReachable}\n`);
    expectedTools.push("browser_profile");
  }

  const goto = await toolCall(4, "browser_goto", { url });
  if (goto.result?.isError) fail(`browser_goto 失败:${textOf(goto)}`);
  const gotoBody = JSON.parse(textOf(goto));
  if (!gotoBody.targetId) fail(`browser_goto 没给 targetId:${JSON.stringify(gotoBody)}`);
  process.stdout.write(`browser_goto: targetId=${gotoBody.targetId}\n`);
  expectedTools.push("browser_goto");

  const batch = await toolCall(5, "browser_batch", {
    steps: [
      { op: "snapshot" },
      { op: "wait", selector: "#ready", timeoutMs: 15000 },
      { op: "tabs" },
      { op: "version" },
    ],
  });
  if (batch.result?.isError) fail(`browser_batch 失败:${textOf(batch)}`);
  const batchBody = JSON.parse(textOf(batch));
  if (!batchBody.ok || batchBody.steps?.length !== 4) fail(`browser_batch 结果不对:${JSON.stringify(batchBody)}`);
  if (!batchBody.steps[0].result?.text?.includes("hello ouuut mcp")) {
    fail(`batch 里的快照没拿到靶页文本:${JSON.stringify(batchBody.steps[0]).slice(0, 400)}`);
  }
  process.stdout.write(
    `browser_batch: ${batchBody.steps.map((s) => `${s.op}:${s.ok ? "ok" : "FAIL"}`).join(" ")}\n`,
  );
  expectedTools.push("browser_batch");

  const wait = await toolCall(6, "browser_wait", { text: "hello ouuut mcp", timeoutMs: 15000 });
  if (wait.result?.isError) fail(`browser_wait 失败:${textOf(wait)}`);
  const waitBody = JSON.parse(textOf(wait));
  if (waitBody.waitedFor !== "text") fail(`browser_wait 结果不对:${JSON.stringify(waitBody)}`);
  process.stdout.write(`browser_wait: ${waitBody.waitedFor} ${waitBody.elapsedMs}ms\n`);
  expectedTools.push("browser_wait");

  // 关 stdin → 服务端收尾 → 读轨迹
  child.stdin.end();
  const closeCode = await new Promise((resolve) => child.on("close", resolve));
  if (closeCode !== 0) fail(`MCP 进程退出码 ${closeCode}(应为 0):\n${stderrBuf.slice(-2000)}`);

  const sessionDir = path.join(runsDir ? path.resolve(runsDir) : path.join(os.tmpdir(), "ouuut-mcp-runs"), sessionId);
  const trajectoryPath = path.join(sessionDir, "trajectory.jsonl");
  const lines = (await readFile(trajectoryPath, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const tools = lines.map((l) => l.tool);
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
    fail(`轨迹里的工具序列不对:${JSON.stringify(tools)}(应为 ${JSON.stringify(expectedTools)})`);
  }
  for (const line of lines) {
    if (!line.ts || !line.ok || typeof line.durationMs !== "number") {
      fail(`轨迹行字段不全:${JSON.stringify(line).slice(0, 300)}`);
    }
  }
  const batchLine = lines.find((l) => l.tool === "browser_batch");
  const snapFile = batchLine?.result?.steps?.[0]?.result?.file;
  if (!snapFile) fail("轨迹里没有 batch 快照文件指针");
  const snapText = await readFile(path.join(sessionDir, snapFile), "utf8");
  if (!snapText.includes("hello ouuut mcp")) fail("快照文件内容不对");

  await writeFile(
    path.join(sessionDir, "transcript.jsonl"),
    transcript.map((t) => JSON.stringify(t)).join("\n") + "\n",
    "utf8",
  );

  process.stdout.write(`轨迹:${trajectoryPath}(${lines.length} 行,快照 ${snapFile})\n`);
  process.stdout.write(`transcript:${path.join(sessionDir, "transcript.jsonl")}\n`);
  process.stdout.write("✅ MCP stdio 冒烟通过\n");
} catch (err) {
  process.stderr.write(`\n--- stderr(尾部)---\n${stderrBuf.slice(-3000)}\n`);
  process.stderr.write(`❌ ${err?.stack ?? err}\n`);
  exitCode = 1;
  child.kill("SIGKILL");
}

await rm(pageDir, { recursive: true, force: true }).catch(() => {});
process.exit(exitCode);
