#!/usr/bin/env node
// tools/check-public-ready.mjs —— 「转 public」前的闸(ADR-010)
//
// 用法:
//   node tools/check-public-ready.mjs            # 查路径 + 内容
//   node tools/check-public-ready.mjs --paths    # 只查路径(快)
//   node tools/check-public-ready.mjs --json     # 机器可读
//
// 退出码:0 = 可以公开;1 = 有违规(逐条列出);2 = 自身出错。
//
// 为什么要有这个脚本而不是"记得删":ADR-010 是一条**决策**,不是一次动作。
// 决策要变成闸才守得住 —— 尤其当仓库会持续变动、每次改动都可能把材料带回来。

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { auditPublicMaterial } from "../native/binding/public-audit.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

/** 只查**会进公开仓库**的文件:用 git 自己的索引,别去扫 node_modules 与构建产物。 */
function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

const args = new Set(process.argv.slice(2));
const pathsOnly = args.has("--paths");
const asJson = args.has("--json");

try {
  const files = listTrackedFiles();
  const result = await auditPublicMaterial({
    files,
    // 大文件与二进制都不该被当文本扫;这里按扩展名过滤已在模块里做了,
    // 再额外跳过明显的产物目录
    readFile: pathsOnly ? null : (p) => readFile(path.join(ROOT, p), "utf8"),
    skipContent: ["chromium/", "probe/out/", ".logs/"],
  });

  if (asJson) {
    process.stdout.write(JSON.stringify({ checked: files.length, ...result }, null, 2) + "\n");
  } else if (result.ok) {
    process.stdout.write(`✅ 可以公开:检查了 ${files.length} 个受版本控制的文件,没有 ADR-010 材料或密钥\n`);
  } else {
    process.stdout.write(`❌ 还不能公开:${result.violations.length} 项违规\n\n`);
    for (const v of result.violations) {
      process.stdout.write(`  [${v.kind}] ${v.path}\n      ${v.why}\n`);
    }
    process.stdout.write(
      "\n处理方式(ADR-010):把材料**移出**仓库到私有位置,不是删掉 —— 以备将来内部查证。\n",
    );
  }
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`check-public-ready 自身出错:${err?.message ?? err}\n`);
  process.exit(2);
}
