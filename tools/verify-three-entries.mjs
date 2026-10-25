#!/usr/bin/env node
// tools/verify-three-entries.mjs —— P5 的验收:同一段任务经**三条入口**驱动,快照文本一致
//
// 用法:`node tools/verify-three-entries.mjs [--url https://example.com] [--headless]`
// 退出码:0 = 三条一致;1 = 不一致或有入口失败;2 = 自身出错。
//
// 三条入口:
//   1. **CLI**   —— `native/bin/ouuut.mjs` 跑一段 heredoc 脚本(harness 那条路)
//   2. **HTTP**  —— `native/bin/ouuut-serve.mjs` 起来后 `POST /goto` + `GET /snapshot`
//   3. **MCP**   —— `native/bin/ouuut-mcp.mjs` 走 JSON-RPC over stdio(`browser_goto` + `browser_snapshot`)
//
// 比较的是**快照正文**(`snapshotBody`:去掉头部那行)—— 头部里有空间名与页数,
// 三条路的空间名按设计可以不同;正文(页面文本 + ref)才是"同一个东西"的判据。
//
// ⚠️ 三条路的**等待语义不同**:CLI 那条 `p.goto()` 会等加载完,而 HTTP/MCP 的 `createTab(url)` 不等。
// 所以这里对后两条做"轮询到正文出现"的归一化,否则比出来的是加载进度差,不是入口差。

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotBody } from "../native/serve/core.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const argv = process.argv.slice(2);
const url = argv.includes("--url") ? argv[argv.indexOf("--url") + 1] : "https://example.com";
const browserFlags = argv.includes("--headless") ? ["--headless"] : [];

// `--payload <发布目录>`:用**发布包里**的入口跑一次 —— 源码里一致不等于发出去的那份一致
// (包里的 JS 是拷过去的副本,ADR-017 之后它们是同一批文件,但只有跑一遍才算验过)。
const payloadArg = argv.indexOf("--payload");
const PAYLOAD = payloadArg === -1 ? null : argv[payloadArg + 1];
const BIN = PAYLOAD ? path.join(PAYLOAD, "js", "native", "bin") : path.join(ROOT, "native", "bin");
const CLI = path.join(BIN, "ouuut.mjs");
const SERVE = path.join(BIN, "ouuut-serve.mjs");
const MCP = path.join(BIN, "ouuut-mcp.mjs");
if (PAYLOAD) process.stdout.write(`(用发布包里的入口:${BIN})\n`);

const TEXT = url.includes("example.com") ? "Example Domain" : null; // 拿不到期望文本时只比"非空"

const run = (exe, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [exe, ...args], { cwd: opts.cwd ?? ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });

// ---- 入口一:CLI ------------------------------------------------------------

async function viaCli(workdir) {
  const script = path.join(workdir, "snap.mjs");
  await writeFile(
    script,
    [
      'const t = await taskSpace("serve");', // 与服务端用同一个空间名(否则头部里的名字不同)
      "const p = await t.newPage();",
      `await p.goto(${JSON.stringify(url)}, { timeout: 30000 });`,
      // **等到稳定再输出**:OOPIF(浏览器自己的 chrome-untrusted 工具条)是独立 target,
      // 它出现在快照里的早晚取决于 attach 时机 —— 不等的话,比出来的是"谁先 attach",不是入口差异。
      "let prev = null, cur = null;",
      "for (let i = 0; i < 30; i += 1) {",
      "  cur = String(await p.snapshot());",
      "  if (cur === prev) break;",
      "  prev = cur;",
      "  await new Promise((r) => setTimeout(r, 300));",
      "}",
      'console.log("__SNAP__" + JSON.stringify(cur));',
    ].join("\n") + "\n",
  );
  const r = await run(CLI, ["nodejs", "--script", script, ...browserFlags]);
  const m = /__SNAP__(.*)/.exec(r.out);
  if (!m) throw new Error(`CLI 入口没拿到快照:code=${r.code}\n${r.out}\n${r.err}`);
  return JSON.parse(m[1]);
}

// ---- 入口二:HTTP ----------------------------------------------------------

async function viaHttp() {
  const srv = spawn(process.execPath, [SERVE, ...browserFlags], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  srv.stdout.on("data", (d) => (out += d));
  srv.stderr.on("data", (d) => (err += d));
  try {
    const line = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const m = /监听 (\S+)/.exec(out);
        if (m) {
          clearInterval(tick);
          resolve(m[1]);
        } else if (Date.now() - t0 > 60000) {
          clearInterval(tick);
          reject(new Error(`HTTP 入口没起来:\n${out}\n${err}`));
        }
      }, 100);
    });
    const auth = { Authorization: `Bearer ${new URL(line).searchParams.get("token") ?? ""}` };
    const base = line.split("?")[0];
    const goto = await (
      await fetch(`${base}/goto`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ url }) })
    ).json();
    if (!goto.targetId) throw new Error(`HTTP /goto 失败:${JSON.stringify(goto)}`);
    // 等到**连续两次相同**(理由同 CLI 那条:OOPIF 的出现早晚不该算成入口差异)
    let prev = null;
    for (let i = 0; i < 40; i += 1) {
      const r = await (await fetch(`${base}/snapshot`, { headers: auth })).json();
      const text = r.text;
      if (typeof text === "string" && (TEXT ? text.includes(TEXT) : text.trim() !== "") && text === prev) return text;
      prev = text;
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error("HTTP 入口:快照没稳定下来(或没出现期望内容)");
  } finally {
    srv.kill("SIGTERM");
  }
}

// ---- 入口三:MCP -----------------------------------------------------------

async function viaMcp() {
  const child = spawn(process.execPath, [MCP, ...browserFlags], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const replies = new Map();
  let err = "";
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line.trim() === "") continue;
      try {
        const msg = JSON.parse(line);
        replies.set(msg.id, msg);
      } catch {
        /* 忽略非协议行(不该出现,但别让它把验收搞崩) */
      }
    }
  });
  child.stderr.on("data", (d) => (err += d));
  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (replies.has(id)) {
          clearInterval(tick);
          resolve(replies.get(id));
        } else if (Date.now() - t0 > 60000 || child.exitCode !== null) {
          clearInterval(tick);
          reject(new Error(`MCP 没回 id=${id}(退出码 ${child.exitCode}):\n${err}`));
        }
      }, 50);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    const init = await call(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    if (init.error) throw new Error(`MCP initialize 失败:${JSON.stringify(init.error)}`);
    const goto = await call(2, "tools/call", { name: "browser_goto", arguments: { url } });
    if (goto.result?.isError) throw new Error(`MCP browser_goto 失败:${goto.result.content?.[0]?.text}`);
    let prevMcp = null;
    for (let i = 0; i < 40; i += 1) {
      const snap = await call(10 + i, "tools/call", { name: "browser_snapshot", arguments: {} });
      if (snap.result?.isError) throw new Error(`MCP browser_snapshot 失败:${snap.result.content?.[0]?.text}`);
      const text = snap.result.content?.[0]?.text ?? "";
      if ((TEXT ? text.includes(TEXT) : text.trim() !== "") && text === prevMcp) return text;
      prevMcp = text;
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error("MCP 入口:快照没稳定下来(或没出现期望内容)");
  } finally {
    child.kill("SIGTERM");
  }
}

// ---- 比一比 ---------------------------------------------------------------

const workdir = await mkdtemp(path.join(tmpdir(), "ouuut-three-"));
try {
  const results = {};
  const failures = [];
  for (const [name, fn] of [
    ["CLI", () => viaCli(workdir)],
    ["HTTP", () => viaHttp()],
    ["MCP", () => viaMcp()],
  ]) {
    try {
      results[name] = await fn();
      process.stdout.write(`✅ ${name} 入口拿到快照(${String(results[name]).length} 字符)\n`);
    } catch (e) {
      failures.push(`${name}: ${e.message}`);
    }
  }

  const bodies = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, snapshotBody(v)]));
  const names = Object.keys(bodies);
  const first = bodies[names[0]];
  const differ = names.filter((n) => bodies[n] !== first);
  if (failures.length > 0 || differ.length > 0) {
    process.stderr.write("\n❌ 三入口不一致\n\n");
    for (const f of failures) process.stderr.write(`  入口失败 —— ${f}\n`);
    if (differ.length > 0) {
      // **定位到第一个不同处**再给窗口 —— 只把三份正文打出来,人眼在大文本里找不到差异在哪。
      const base = names[0];
      for (const n of names) {
        if (n === base) continue;
        let i = 0;
        while (i < Math.min(bodies[base].length, bodies[n].length) && bodies[base][i] === bodies[n][i]) i += 1;
        process.stderr.write(
          `  ${base} vs ${n}:第 ${i} 个字符起不同(长度 ${bodies[base].length} vs ${bodies[n].length})\n` +
            `    ${base}: ${JSON.stringify(bodies[base].slice(Math.max(0, i - 60), i + 120))}\n` +
            `    ${n}: ${JSON.stringify(bodies[n].slice(Math.max(0, i - 60), i + 120))}\n\n`,
        );
      }
    }
    process.exit(1);
  }
  process.stdout.write(`\n✅ 三入口一致(正文 ${first.length} 字符):\n${first.slice(0, 300)}\n`);
} finally {
  await rm(workdir, { recursive: true, force: true });
}