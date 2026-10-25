#!/usr/bin/env node
// tools/verify-shipped-layout.mjs —— 发布形态的**验收闸**(P6 / ADR-017)
//
// 用法:
//   node tools/verify-shipped-layout.mjs --dir dist/ouuut-0.1.3-win-x64 [--key <凭据目录>\ouuut-release.pem | --pub <公钥.pem>] [--smoke]
//
// 检查什么(**顺序即失败顺序**,任何一条不过就非零退出):
//   1. 清单验签(缺公钥时从 `--key` 的私钥推出来);
//   2. 清单覆盖**交付形态**:入口 `ouuut.mjs`、`js/native/bin/ouuut.mjs`、harness 的 `dist/src/run.js`、
//      `node_modules/acorn` 都在清单里 —— 少了任何一条,第三方拿到的是"跑不起来的一包文件";
//   3. **逐文件重算 sha256**(不只信清单里的数);
//   4. 冷启动:`node <payload>/ouuut.mjs --help` 在**另一个 CWD** 下能跑(不需要浏览器);
//   5. `--smoke`:真跑一次(用包里那个浏览器,不传 `--browser`)—— 这才是"装着能用"的证据。
//
// 为什么要有这个脚本:上面 1–3 是"包是完整的",4–5 是"包**能跑**"。P6 之前的缺口正是后者:
// 浏览器 payload 与 JS 分居两处,清单再漂亮也装不起来。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256File, verifyManifest } from "../native/binding/release.mjs";

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--smoke") o.smoke = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.dir) {
  process.stderr.write(
    "用法: node tools/verify-shipped-layout.mjs --dir <发布目录> [--key <私钥.pem> | --pub <公钥.pem>] [--smoke]\n",
  );
  process.exit(2);
}
if (!args.key && !args.pub) {
  process.stderr.write("验收必须验签:给 --pub <公钥.pem>,或用 --key <私钥.pem> 推出公钥\n");
  process.exit(2);
}

// **绝对化**:下面要在临时的 CWD 里起子进程,相对路径会按子进程的 CWD 解析(踩过一次)
const outDir = path.resolve(args.dir);
const payload = path.join(outDir, "payload");
const ok = (msg) => process.stdout.write(`✅ ${msg}\n`);
const die = (msg) => {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(1);
};

/** 交付形态**必须**在清单里的路径(模式)。少了任何一条 ⇒ 第三方跑不起来。 */
const REQUIRED_IN_MANIFEST = [
  { label: "入口", path: "ouuut.mjs" },
  { label: "原生层 CLI", path: "js/native/bin/ouuut.mjs" },
  { label: "harness 入口", match: (p) => p.startsWith("js/harness/package/ego-browser/dist/src/") },
  { label: "harness 的第三方依赖 acorn", match: (p) => p.includes("node_modules/acorn/") },
  { label: "服务端入口(HTTP/WS)", path: "js/native/bin/ouuut-serve.mjs" },
  { label: "服务端入口(MCP stdio)", path: "js/native/bin/ouuut-mcp.mjs" },
  { label: "服务端实现", path: "js/native/serve/mcp.mjs" },
  { label: "浏览器可执行文件", path: "chrome.exe" },
];

const run = (cmd, argv, cwd) =>
  new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });

const manifestPath = path.join(outDir, "manifest.json");
if (!existsSync(manifestPath)) die(`没有清单:${manifestPath}`);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const sig = (await readFile(path.join(outDir, "manifest.sig"), "utf8")).trim();

// 1) 验签
let pubPem = null;
if (args.pub) {
  pubPem = await readFile(args.pub, "utf8");
} else {
  pubPem = createPublicKey(await readFile(args.key, "utf8")).export({ type: "spki", format: "pem" });
}
try {
  verifyManifest(manifest, sig, pubPem);
  ok(`验签通过:版本 ${manifest.version},${manifest.files.length} 个文件`);
} catch (e) {
  die(`验签失败:${e.message}`);
}

// 2) 清单覆盖交付形态
const paths = new Set(manifest.files.map((f) => f.path));
for (const req of REQUIRED_IN_MANIFEST) {
  const hit = req.path ? paths.has(req.path) : manifest.files.some((f) => req.match(f.path));
  if (!hit) die(`清单里少了「${req.label}」(${req.path ?? "模式:" + req.match}) —— 这包装起来跑不了`);
}
ok(`交付形态齐全:入口 + 原生层 + harness + acorn + 浏览器`);

// 3) 逐文件重算 sha256
let bad = 0;
let bytes = 0;
for (const f of manifest.files) {
  const abs = path.join(payload, ...f.path.split("/"));
  if (!existsSync(abs)) {
    process.stderr.write(`  缺文件:${f.path}\n`);
    bad += 1;
    continue;
  }
  const h = await sha256File(abs);
  if (h !== f.sha256) {
    process.stderr.write(`  哈希不符:${f.path}\n`);
    bad += 1;
  }
  bytes += f.size ?? 0;
}
if (bad > 0) die(`${bad} 个文件与清单不符`);
ok(`逐文件哈希一致(${(bytes / 1048576).toFixed(1)} MB)`);

// 4) 冷启动:另一个 CWD 下跑入口(`--help` 不需要浏览器)
const workdir = await mkdtemp(path.join(tmpdir(), "ouuut-shipped-"));
try {
  const entry = path.join(payload, "ouuut.mjs");
  const help = await run(process.execPath, [entry, "--help"], workdir);
  if (help.code !== 0 || !/用法|ouuut/i.test(help.out)) {
    die(`冷启动失败(--help):code=${help.code}\n${help.out}\n${help.err}`);
  }
  ok(`冷启动通过:从 ${workdir} 用包内入口跑 --help`);

  // 5) 真跑一次:用**包里**的浏览器(不传 --browser)
  if (args.smoke) {
    const script = path.join(workdir, "smoke.mjs");
    await writeFile(
      script,
      [
        'const t = await taskSpace("shipped-smoke");',
        "const p = await t.newPage();",
        'await p.goto("https://api.ipify.org", { timeout: 20000 });',
        'const ip = (await p.evaluate("document.body.innerText")).trim();',
        'const snap = String(await p.snapshot());',
        'console.log("EXIT-IP=" + ip + " SNAP-LEN=" + snap.length);',
      ].join("\n") + "\n",
    );
    const smoke = await run(process.execPath, [entry, "nodejs", "--script", script, "--headless"], workdir);
    if (smoke.code !== 0 || !/EXIT-IP=/.test(smoke.out)) {
      die(`冒烟失败:code=${smoke.code}\n${smoke.out}\n${smoke.err}`);
    }
    ok(`冒烟通过:${smoke.out.trim().split("\n").pop()}`);
  } else {
    process.stdout.write("· 没加 --smoke:只验到「入口能跑」,没验「能开页」\n");
  }
} finally {
  await rm(workdir, { recursive: true, force: true });
}

process.stdout.write(`\n✅ 发布形态验收通过:${args.dir}\n`);
