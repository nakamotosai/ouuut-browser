#!/usr/bin/env node
// tools/check-syntax.mjs —— 语法闸:仓库里每个 .mjs/.js 都要能解析
//
// 用法:`node tools/check-syntax.mjs`
// 退出码:0 = 全过;1 = 有文件解析不了(逐条列出)。
//
// 为什么单独一个脚本、而不是靠"跑测试":测试只会加载**被 import 到**的模块 ——
// 一个谁都没引用的新文件里的语法错,测试是看不见的。而语法错这类事(尤其**中文串里的 ASCII 引号**)
// 在写的时候极难用眼睛发现,一到运行时就是"整套挂掉"。
// (2026-10-25:同一个坑在同一个会话里踩了 5 次,才想起该有这个闸。)

import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

/** 只查我们自己的代码:第三方 vendored、Chromium 产物、探针输出、harness 的 skill 片段都不算。 */
const SKIP = [
  /^chromium\//,
  /^probe\/out\//,
  /^\.logs\//,
  /^dist\//,
  /^harness\/package\/ego-browser\/(node_modules|dist)\//,
  // harness 自带的 skill 片段:它们是**被包在工厂函数里**喂给浏览器的,单独一个文件本来就不是合法模块
  /^harness\/skills\//,
];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0")
  .filter(Boolean)
  .filter((f) => /\.(mjs|js)$/.test(f))
  .filter((f) => !SKIP.some((re) => re.test(f)));

const bad = [];
for (const f of tracked) {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
  } catch (err) {
    const msg = String(err.stderr ?? err.message)
      .split("\n")
      .slice(0, 4)
      .join("\n      ");
    bad.push({ file: f, msg });
  }
}

if (bad.length === 0) {
  process.stdout.write(`✅ 语法闸:${tracked.length} 个 .mjs/.js 都能解析\n`);
  process.exit(0);
}
process.stdout.write(`❌ 语法闸:${bad.length} / ${tracked.length} 个文件解析不了\n\n`);
for (const b of bad) process.stdout.write(`  ${b.file}\n      ${b.msg}\n`);
process.exit(1);