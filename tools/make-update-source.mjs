#!/usr/bin/env node
// tools/make-update-source.mjs —— 从**已有版本**造一个"更新源"(新版本的清单 + 签名 + 变更文件)
//
// 用法:
//   node tools/make-update-source.mjs --from dist/ouuut-0.1.3-win-x64 --version 0.1.4 \
//        --out dist/updates/0.1.4 --key <凭据目录>\ouuut-release.pem \
//        --set payload/VERSION=0.1.4 [--set payload/js/xxx.mjs=@本地文件]
//
// 产出(可直接用 `python3 -m http.server` 或任何静态服务发出去):
//   <out>/manifest.json          新版本的完整清单(逐文件 sha256)
//   <out>/manifest.sig           Ed25519 签名
//   <out>/payload/...            **只有变更的文件**
//
// ⚠️ 为什么只放变更文件:升级只**拉变更**(`planUpdate` 算出来的 changed)。
//    全新安装要全量源 —— 两者用途不同,别拿这个目录当全量源(README/计划里都写明)。
//
// 为什么不重打一遍 payload:一个版本里 90% 以上的文件(整个浏览器)没变。
// 清单靠**已有版本的哈希**就能组出来,只有变更的文件需要新内容。

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildManifest, signManifest } from "../native/binding/release.mjs";

function parseArgs(argv) {
  const o = { set: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--set") o.set.push(argv[++i]);
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.from || !args.version || !args.out || !args.key) {
  process.stderr.write(
    "用法: node tools/make-update-source.mjs --from <已有发布目录> --version <x.y.z> --out <输出目录> \\\n" +
      '        --key <私钥.pem> [--set <path>=<内容> | --set <path>=@<本地文件>]...\n',
  );
  process.exit(2);
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const prev = JSON.parse(await readFile(path.join(args.from, "manifest.json"), "utf8"));
const files = new Map(prev.files.map((f) => [f.path, { ...f }]));

/** 变更文件:payload 相对路径 → 内容。 */
const changed = new Map();
for (const spec of args.set) {
  const eq = spec.indexOf("=");
  if (eq <= 0) {
    process.stderr.write(`--set 要写成 <path>=<内容>:${JSON.stringify(spec)}\n`);
    process.exit(2);
  }
  const rel = spec.slice(0, eq);
  const raw = spec.slice(eq + 1);
  const isFile = raw.startsWith("@");
  const buf = isFile ? await readFile(raw.slice(1)) : Buffer.from(raw, "utf8");
  const entry = { path: rel, sha256: sha(buf), size: buf.length };
  files.set(rel, entry);
  changed.set(rel, buf);
}

const manifest = buildManifest({
  version: args.version,
  files: [...files.values()],
  meta: {
    generatedAt: new Date().toISOString(),
    platform: prev.platform ?? "win-x64",
    // 记一笔来源,便于复核"这份清单是从哪个版本组出来的"
    ...(prev.version ? { baseVersion: prev.version } : {}),
  },
});
const signatureBase64 = signManifest(manifest, readFileSync(args.key, "utf8"));

await mkdir(args.out, { recursive: true });
await writeFile(path.join(args.out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(args.out, "manifest.sig"), signatureBase64 + "\n");
for (const [rel, buf] of changed) {
  const dst = path.join(args.out, "payload", ...rel.split("/"));
  await mkdir(path.dirname(dst), { recursive: true });
  await writeFile(dst, buf);
}

process.stdout.write(
  `✅ 更新源 ${args.out}\n` +
    `   版本 ${prev.version ?? "(未知)"} → ${manifest.version} · 清单 ${manifest.files.length} 个文件 · ` +
    `变更 ${changed.size} 个(${[...changed.keys()].join(", ") || "无"})\n` +
    "   ⚠️ 这里只放**变更文件**:升级只拉变更;要全量安装源请用 tools/package-release.mjs 的完整产物\n",
);
