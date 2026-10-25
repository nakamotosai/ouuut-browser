#!/usr/bin/env node
// tools/package-release.mjs —— 把构建产物打成**可分发的一个版本**
//
// 用法:
//   node tools/package-release.mjs --src chromium/src/out/Release --out dist/ouuut-0.1.0-win-x64 \
//        --version 0.1.0 --key F:\.secrets\ouuut-release.pem [--dry-run]
//
// 产物:
//   <out>/payload/        ← 要装到用户机器上的全部文件
//   <out>/manifest.json   ← 每个文件的 sha256(签过名的那份)
//   <out>/manifest.sig    ← Ed25519 签名(base64)
//
// ## 为什么目录用白名单而不是黑名单
//
// `out/Release` 不是"一个安装目录",它是"一个构建目录":27 GB 里躺着
// `gen/`(8.7 万文件)、`obj/`、`.siso_*`、`rust-toolchain`、`clang-*`,
// 以及 **`thinlto-cache`(7.4 万文件 / 7.5 GB)** 这类 ThinLTO 对象缓存。
//
// 用黑名单逐个排除是错的方向:Chromium 会不断往 `out/` 里加新的缓存目录,
// 漏掉一个就是几个 GB 的垃圾进包 —— 而且**不会报错**,只是包莫名其妙变大。
// 所以反过来:只发白名单里的目录,其余一律不发,并在输出里**列出来**,
// 让"多了一个没见过的目录"这件事看得见,而不是被静默吞掉。

import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildManifest, signManifest, sha256File } from "../native/binding/release.mjs";

/**
 * 真正会装到用户机器上的目录(标准 Chrome 安装布局)。
 * 顶层**文件**另算,不受这个集合约束。
 */
const SHIP_DIRS = new Set([
  "locales",
  "resources",
  "Dictionaries",
  "MEIPreload",
  "IwaKeyDistribution",
  "swiftshader",
  "angledata",
  "hyphen-data",
]);

/**
 * 真正会跑在用户机器上的可执行文件 —— **白名单**。
 *
 * `out/Release` 顶层躺着 31 个 `.exe`,其中 25 个是**构建期工具**
 * (`mksnapshot` 54 MB、`v8_context_snapshot_generator` 170 MB、
 * `code_cache_generator` 150 MB、`protoc`、`flatc`、`llvm-tblgen`、`torque`、`nasm`…)。
 * 它们一个都不该进用户的包:既没用,又白占几百 MB。
 */
const SHIP_EXE = new Set([
  "chrome.exe",
  "chrome_proxy.exe",
  "chrome_pwa_launcher.exe",
  "notification_helper.exe",
  "elevation_service.exe",
  "elevated_tracing_service.exe",
]);

/** 文件名级别不发的东西。 */
const EXCLUDE = [
  /\.pdb$/i,
  /\.lib$/i,
  /\.exp$/i,
  /\.ilk$/i,
  /\.obj$/i,
  /\.runtime_deps$/i,
  /\.ninja$/i,
  /\.ninja_deps$/i,
  /\.ninja_log$/i,
  // 测试与模糊测试二进制:构建机上有,用户机器上一个都不该有
  /_test\.exe$/i,
  /_unittests?\.exe$/i,
  /^test\.exe$/i,
  /fuzzer\.exe$/i,
  /perftests?\.exe$/i,
  // siso 的构建日志与状态:注意它们**不带前导点**,所以只靠 `/^\./` 是拦不住的
  /^siso_/i,
  /\.siso_/i,
  // 构建配置本身:`args.gn` 会把我们的编译开关(branding / PGO / 符号级别)一起发出去
  /^args\.gn$/i,
  // 测试用的清单文件(`*_unittest_exes.txt` 之类),真实安装目录里没有 .txt
  /\.txt$/i,
  // Vulkan 的 mock ICD 与校验层:只在开发机上用,发出去白白多几个 DLL
  /^VkICD_mock_icd\./i,
  /^VkLayer_khronos_validation\./i,
  // 构建系统的残留:真实安装目录里不会有 ninja 的依赖/时间戳文件
  /^build\.ninja/i,
  /^debug\.log$/i,
  /^environment\.(x64|x86)$/i,
  /\.filelist$/i,
  /^package\.json$/i,
  // 符号服务器与 DIA SDK 调试组件:开发机专用
  /^symsrv\./i,
  /^msdia140\./i,
  // 其余点文件(.siso_config / .gitignore / .siso_fs_state.0 …)
  /^\./,
];

const skipFile = (name) => EXCLUDE.some((re) => re.test(name));

/**
 * 走一遍构建目录。
 * @returns {{files: string[], skippedDirs: string[]}} files 是相对路径(正斜杠)
 */
async function walk(root) {
  const files = [];
  const skippedDirs = [];
  let skippedExes = 0;

  // 顶层:文件按黑名单 + exe 白名单,目录只认白名单
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isFile()) {
      if (skipFile(e.name)) continue;
      if (/\.exe$/i.test(e.name) && !SHIP_EXE.has(e.name)) {
        skippedExes += 1;
        continue;
      }
      files.push(e.name);
    } else if (e.isDirectory()) {
      if (!SHIP_DIRS.has(e.name)) {
        skippedDirs.push(e.name);
        continue;
      }
      files.push(...(await walkAll(path.join(root, e.name), e.name)));
    }
  }
  return { files, skippedDirs, skippedExes };
}

/** 白名单目录内部:整棵递归(里面全是这个目录自己的东西)。 */
async function walkAll(absDir, relDir) {
  const out = [];
  for (const e of await readdir(absDir, { withFileTypes: true })) {
    const r = `${relDir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walkAll(path.join(absDir, e.name), r)));
    else if (e.isFile() && !skipFile(e.name)) out.push(r);
  }
  return out;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.src || !args.out || !args.version) {
  process.stderr.write(
    "用法: node tools/package-release.mjs --src <构建目录> --out <输出目录> --version <x.y.z> --key <私钥.pem> [--dry-run]\n",
  );
  process.exit(2);
}

try {
  const { files, skippedDirs, skippedExes } = await walk(args.src);

  let total = 0;
  const sized = [];
  for (const f of files) {
    const s = (await stat(path.join(args.src, f))).size;
    total += s;
    sized.push({ path: f, size: s });
  }

  const report = () => {
    process.stdout.write(`将打包 ${sized.length} 个文件 / ${(total / 1048576).toFixed(1)} MB\n`);
    process.stdout.write(
      `跳过 ${skippedDirs.length} 个非发布目录:${skippedDirs.slice(0, 8).join(" ")}${skippedDirs.length > 8 ? " …" : ""}\n`,
    );
    process.stdout.write(`跳过 ${skippedExes} 个构建期可执行文件(mksnapshot / protoc / torque …)\n\n`);
    const byExt = new Map();
    for (const f of sized) {
      const ext = path.extname(f.path).toLowerCase() || "(无扩展名)";
      const cur = byExt.get(ext) ?? { n: 0, bytes: 0 };
      cur.n += 1;
      cur.bytes += f.size;
      byExt.set(ext, cur);
    }
    [...byExt.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 10)
      .forEach(([ext, v]) =>
        process.stdout.write(
          `  ${ext.padEnd(16)} ${String(v.n).padStart(5)} 个  ${(v.bytes / 1048576).toFixed(1).padStart(9)} MB\n`,
        ),
      );
  };

  if (args.dryRun) {
    report();
    process.exit(0);
  }

  if (!args.key) {
    process.stderr.write("打包必须签名:缺 --key <私钥.pem>\n");
    process.exit(2);
  }

  const payload = path.join(args.out, "payload");
  // 先清空 —— 否则上一次打包留下、这次被排除掉的文件会**继续留在包里**,
  // 清单里没有它们,但目录里躺着:用户装到的和清单描述的不是同一个东西。
  await rm(payload, { recursive: true, force: true });
  await mkdir(payload, { recursive: true });

  process.stdout.write(`复制 ${sized.length} 个文件 / ${(total / 1048576).toFixed(1)} MB …\n`);
  const records = [];
  for (const f of sized) {
    const dst = path.join(payload, f.path);
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(path.join(args.src, f.path), dst);
    records.push({ path: f.path, sha256: await sha256File(dst), size: f.size });
  }

  const manifest = buildManifest({
    version: args.version,
    files: records,
    meta: { generatedAt: new Date().toISOString(), platform: "win-x64" },
  });
  const signatureBase64 = signManifest(manifest, readFileSync(args.key, "utf8"));

  await writeFile(path.join(args.out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(path.join(args.out, "manifest.sig"), signatureBase64 + "\n");

  process.stdout.write(
    `\n✅ ${args.out}\n   ${manifest.files.length} 个文件 · 清单 ${Buffer.byteLength(JSON.stringify(manifest), "utf8")} 字节 · 已签名\n`,
  );
} catch (err) {
  process.stderr.write(`打包失败:${err?.message ?? err}\n`);
  process.exit(1);
}
