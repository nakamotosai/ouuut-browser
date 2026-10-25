#!/usr/bin/env node
// tools/install-release.mjs —— **第三方视角**的安装器
//
// 用法:
//   node tools/install-release.mjs --package dist/ouuut-0.1.0-win-x64 \
//        --dir "F:\apps\ouuut-browser\0.1.0" --pubkey release/ouuut-release.pub.pem
//
// 这个脚本刻意**只依赖包里的东西**:
//   * 公钥来自参数(或仓库里那份),不来自包 —— 包自己带公钥等于自己给自己发证书
//   * 清单 + 签名 + payload 全部来自 `--package`
//   * 落盘走 `installRelease()`:验签 → 暂存 → 逐文件校验 → 一次性换名
//
// 也就是说,这里模拟的正是"别人下载到我们的包,在他的机器上装"。

import { readFile } from "node:fs/promises";
import path from "node:path";

import { installRelease, verifyManifest, ReleaseError } from "../native/binding/release.mjs";

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // 无值开关必须单独认 —— 否则 `--verify-only` 会把下一个参数当自己的值吃掉,
    // 落在末尾时值是 undefined,开关就"静默失效"了(这个坑真踩过一次)。
    if (a === "--verify-only") o.verifyOnly = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.package || !args.dir) {
  process.stderr.write(
    "用法: node tools/install-release.mjs --package <包目录> --dir <安装目录> [--pubkey <公钥.pem>] [--verify-only]\n",
  );
  process.exit(2);
}

const pubkeyPath = args.pubkey ?? path.join("release", "ouuut-release.pub.pem");

try {
  const manifest = JSON.parse(await readFile(path.join(args.package, "manifest.json"), "utf8"));
  const signatureBase64 = (await readFile(path.join(args.package, "manifest.sig"), "utf8")).trim();
  const publicKeyPem = await readFile(pubkeyPath, "utf8");

  // 先单独验一次:让"验签通过"这件事**自己**有个可打印的结果,
  // 而不是混在安装成功里 —— 出问题时能立刻分清是签名还是内容。
  verifyManifest(manifest, signatureBase64, publicKeyPem);
  process.stdout.write(`✅ 验签通过:版本 ${manifest.version},${manifest.files.length} 个文件\n`);

  if (args.verifyOnly) process.exit(0);

  const payload = path.join(args.package, "payload");
  const r = await installRelease({
    dir: args.dir,
    manifest,
    signatureBase64,
    publicKeyPem,
    fetchBlob: (f) => readFile(path.join(payload, f.path)),
  });

  process.stdout.write(`✅ 已安装到 ${args.dir}\n   版本 ${r.version} · ${r.files} 个文件\n`);
} catch (err) {
  const code = err instanceof ReleaseError ? ` [${err.error_code}]` : "";
  process.stderr.write(`❌ 安装被拒绝${code}\n   ${err?.message ?? err}\n`);
  process.exit(1);
}
