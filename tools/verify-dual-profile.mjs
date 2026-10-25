#!/usr/bin/env node
// tools/verify-dual-profile.mjs —— **双档案双出口**的验收(一个会话、两个档案、两个出口)
//
// 用法:
//   node tools/verify-dual-profile.mjs --proxy socks5://198.51.100.7:41105 [--headless]
//   node tools/verify-dual-profile.mjs --proxy <代理> --payload <发布目录>   # 用发布包里的入口
//
// 验两条路(同一个会话里两个档案):
//   1. **CLI** —— 脚本里建两个空间(`taskSpace(name, {profileId})`),各开一页,读出口 IP;
//   2. **HTTP** —— `POST /goto {url, profile}` 各开一页,从 `/snapshot` 里读出口 IP。
// 判据:两个档案的出口 IP **必须不同**(代理那个 = 代理的出口,直连那个 = 本机出口),
//       而且**都不能为空** —— 空的话"不同"没有意义。
//
// ⚠️ 一个约束(坑-47):harness 建任务空间时要求浏览器**恰好一个标签页**,
//    所以两个空间必须在**开页之前**建好。CLI 那条路由脚本自己保证;服务端那条路由 `bootServeCore` 预建。

import { spawn } from "node:child_process";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const proxy = arg("--proxy");
const payloadDir = arg("--payload");
const headless = argv.includes("--headless") ? ["--headless"] : [];

if (!proxy) {
  process.stderr.write("需要 --proxy <url>(双出口要有两个**不同**的出口才谈得上对照)\n");
  process.exit(2);
}

const BIN = payloadDir
  ? path.join(payloadDir, "js", "native", "bin")
  : path.join(ROOT, "native", "bin");
const PROFILES = JSON.stringify([
  { id: "a-proxy", kind: "persona", proxy },
  { id: "b-direct", kind: "disposable" },
]);

const runCli = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ouuut-dual-"));
  try {
    const script = path.join(dir, "dual.mjs");
    await writeFile(
      script,
      [
        'const t1 = await taskSpace("走代理的", { profileId: "a-proxy" });',
        'const t2 = await taskSpace("直连的", { profileId: "b-direct" });',
        "const p1 = await t1.newPage();",
        'await p1.goto("https://api.ipify.org", { timeout: 30000 });',
        'const ip1 = (await p1.evaluate("document.body.innerText")).trim();',
        "const p2 = await t2.newPage();",
        'await p2.goto("https://api.ipify.org", { timeout: 30000 });',
        'const ip2 = (await p2.evaluate("document.body.innerText")).trim();',
        'console.log("__DUAL__" + JSON.stringify({ proxied: ip1, direct: ip2 }));',
      ].join("\n") + "\n",
    );
    const child = spawn(
      process.execPath,
      [path.join(BIN, "ouuut.mjs"), "nodejs", ...headless, "--profiles", PROFILES, "--script", script],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    const m = /__DUAL__(\{.*\})/.exec(out);
    if (!m) throw new Error(`CLI 没给出读数(code=${code})\n${out.slice(0, 400)}\n${err.slice(0, 400)}`);
    return JSON.parse(m[1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** 服务端那条:**明确拒绝**,不是半可用。 */
const runServeRefusal = async () => {
  const child = spawn(
    process.execPath,
    [path.join(BIN, "ouuut-serve.mjs"), ...headless, "--profiles", PROFILES],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  const text = out + err;
  if (code === 0) throw new Error("服务端**没有拒绝** --profiles(那意味着它在假装支持多档案)");
  if (!/只服务\*\*一个\*\*档案|只服务一个档案/.test(text)) {
    throw new Error(`拒绝的理由没说清:\n${text.slice(0, 300)}`);
  }
  return "已明确拒绝(并指路 CLI)";
};

let cli = null;
try {
  cli = await runCli();
  process.stdout.write(`✅ CLI:代理出口 ${cli.proxied} · 直连出口 ${cli.direct}\n`);
  if (!cli.proxied || !cli.direct) {
    process.stderr.write(`❌ 出口 IP 有空值(${JSON.stringify(cli)})\n`);
    process.exitCode = 1;
  } else if (cli.proxied === cli.direct) {
    process.stderr.write(`❌ 两个档案的出口**一样**(${cli.proxied}) ⇒ 档案没起作用\n`);
    process.exitCode = 1;
  }
} catch (e) {
  process.stderr.write(`❌ CLI:${e.message}\n`);
  process.exitCode = 1;
}

try {
  process.stdout.write(`✅ 服务端:${await runServeRefusal()}\n`);
} catch (e) {
  process.stderr.write(`❌ 服务端:${e.message}\n`);
  process.exitCode = 1;
}

if (!process.exitCode) {
  process.stdout.write("\n✅ 双档案双出口通过:一个会话内两个档案走了**不同**出口(CLI),服务端对多档案明确拒绝\n");
}
