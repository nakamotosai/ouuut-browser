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

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ---- 随包发的 JS:入口一个文件 + 实现放 `js/`(P6 / ADR-017)------------------
//
// 「一个 tar + node」要成立,JS 就必须**进包**,而且进**签名覆盖的 `payload/`**:
//   <payload>/ouuut.mjs                        ← 入口(一个文件)
//   <payload>/js/native/**                     ← 原生层(不发 *.test.mjs)
//   <payload>/js/harness/package/ego-browser/  ← harness dist + 它运行时唯一的第三方依赖 acorn
//
// 为什么**不**打成"真·单文件":harness 的 dist 里有动态 `import()`,还依赖第三方 `acorn`
// —— 上打包器要么改写 vendored 代码、要么把 acorn 也塞进去,买到的主要是观感(理由写在 ADR-017)。
//
// 目录白名单的纪律与浏览器那边一致:**只发列出来的**,不列就不发,免得包里悄悄长出东西。

/** 入口模板:纯粹转发,真正的实现在 `./js/`。 */
const LAUNCHER = `#!/usr/bin/env node
// ouuut —— 入口。实现在 ./js/ 下(原生层 + 随包携带的 harness),布局与理由见 ADR-017。
// 用法:node ouuut.mjs nodejs --script <脚本> [--headless] [--browser <chrome.exe>]
// 入口单独一个文件,是为了让命令行**不随内部目录结构漂**;别把它当"单文件实现"宣传。
import { cli } from "./js/native/bin/ouuut.mjs";
process.exit(await cli());
`;

const JS_DIRS = [
  { from: "native/bin", to: "js/native/bin", keep: (n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs") },
  { from: "native/binding", to: "js/native/binding", keep: (n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs") },
  // 服务端两个入口(P5)也随包发 —— 它们只是把同一套原生层换个传输露出来。
  // `fixtures.mjs` 是测试夹具,不发。
  {
    from: "native/serve",
    to: "js/native/serve",
    keep: (n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs") && n !== "fixtures.mjs",
  },
  { from: "harness/package/ego-browser/dist", to: "js/harness/package/ego-browser/dist", keep: () => true },
  {
    from: "harness/package/ego-browser/node_modules/acorn",
    to: "js/harness/package/ego-browser/node_modules/acorn",
    keep: () => true,
  },
];

/** 单文件白名单(许可证义务 + harness 的元信息)。 */
const JS_FILES = [
  ["harness/package/ego-browser/package.json", "js/harness/package/ego-browser/package.json"],
  ["harness/package/ego-browser/README.md", "js/harness/package/ego-browser/README.md"],
  ["LICENSES/ego-lite-MIT.txt", "js/LICENSES/ego-lite-MIT.txt"],
  ["LICENSE", "js/LICENSE"],
  ["NOTICE", "js/NOTICE"],
];

/** 把一棵目录树按白名单拷进 `payload/<to>`,返回 manifest 记录。 */
async function shipTree(payload, fromRoot, relFrom, relTo, keep) {
  const records = [];
  const absFrom = path.join(fromRoot, ...relFrom.split("/"));
  const walkInto = async (absDir, relDir) => {
    for (const e of await readdir(absDir, { withFileTypes: true })) {
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) await walkInto(path.join(absDir, e.name), rel);
      else if (e.isFile() && keep(e.name)) {
        const dst = path.join(payload, ...rel.split("/"));
        await mkdir(path.dirname(dst), { recursive: true });
        await cp(path.join(absDir, e.name), dst);
        records.push({ path: rel, sha256: await sha256File(dst), size: (await stat(dst)).size });
      }
    }
  };
  await walkInto(absFrom, relTo);
  return records;
}

/** 把 JS(白名单 + 入口)放进 `payload/`。返回 manifest 记录(payload 相对路径)。 */
async function shipJs(payload, repoRoot) {
  const records = [];
  for (const d of JS_DIRS) {
    const abs = path.join(repoRoot, ...d.from.split("/"));
    if (!existsSync(abs)) throw new Error(`要随包发的目录不存在:${d.from}(在发布机上应该存在)`);
    records.push(...(await shipTree(payload, repoRoot, d.from, d.to, d.keep)));
  }
  for (const [from, to] of JS_FILES) {
    const src = path.join(repoRoot, ...from.split("/"));
    if (!existsSync(src)) throw new Error(`要随包发的文件不存在:${from}`);
    const dst = path.join(payload, ...to.split("/"));
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst);
    records.push({ path: to, sha256: await sha256File(dst), size: (await stat(dst)).size });
  }
  await writeFile(path.join(payload, "ouuut.mjs"), LAUNCHER);
  records.push({
    path: "ouuut.mjs",
    sha256: await sha256File(path.join(payload, "ouuut.mjs")),
    size: Buffer.byteLength(LAUNCHER),
  });
  return records;
}

/** 上一次打包留下的 JS 记录(用于 `--js-only` 重放时把它们换掉)。 */
const isJsPath = (p) => p === "ouuut.mjs" || p.startsWith("js/");

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--js-only") o.jsOnly = true; // 无值开关,必须显式认,否则会被当成"带值"吃掉下一个参数
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
if (!args.version || (!args.jsOnly && !args.src) || !args.out) {
  process.stderr.write(
    "用法: node tools/package-release.mjs --src <构建目录> --out <输出目录> --version <x.y.z> --key <私钥.pem> [--dry-run]\n" +
      "      node tools/package-release.mjs --out <已有输出目录> --version <x.y.z> --key <私钥.pem> --js-only\n" +
      "        ↑ 只重放随包发的 JS(入口 + js/)并**重新签名**;用在「只改了 native/、不想再拷贝一遍浏览器」的时候\n",
  );
  process.exit(2);
}

// `--js-only`:从**已有的** manifest 里拿掉旧的 JS 记录、补上新的,再签一次。
// 单独一条路的意义:JS 改动频繁,而浏览器部分是 27 GB 的拷贝 —— 不该为了改一行 JS 再拷一遍。
if (args.jsOnly) {
  if (!args.key) {
    process.stderr.write("打包必须签名:缺 --key <私钥.pem>\n");
    process.exit(2);
  }
  const manifestPath = path.join(args.out, "manifest.json");
  if (!existsSync(manifestPath)) {
    process.stderr.write(`--js-only 需要已有的清单:${manifestPath} 不存在\n`);
    process.exit(2);
  }
  const payload = path.join(args.out, "payload");
  if (!existsSync(payload)) {
    process.stderr.write(`--js-only 需要已有的 payload:${payload} 不存在\n`);
    process.exit(2);
  }
  const prev = JSON.parse(await readFile(manifestPath, "utf8"));
  const kept = (prev.files ?? []).filter((f) => !isJsPath(f.path));
  const jsRecords = await shipJs(payload, repoRoot);
  const manifest = buildManifest({
    version: args.version,
    files: [...kept, ...jsRecords],
    meta: { generatedAt: new Date().toISOString(), platform: "win-x64" },
  });
  const signatureBase64 = signManifest(manifest, readFileSync(args.key, "utf8"));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(path.join(args.out, "manifest.sig"), signatureBase64 + "\n");
  process.stdout.write(
    `\n✅ ${args.out}\n   只顾了 JS:${jsRecords.length} 个文件(其余 ${kept.length} 个沿用上次清单)· 已重新签名\n`,
  );
  process.exit(0);
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
      "随包发的 JS:入口 ouuut.mjs + js/(native + harness dist + acorn + 许可证)\n",
    );
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

  // 随包发的 JS:**进签名覆盖的 `payload/`**,不是"另放一个目录"(改一行 JS 不该让完整性覆盖断掉)。
  const jsRecords = await shipJs(payload, repoRoot);
  records.push(...jsRecords);
  process.stdout.write(`随包发的 JS:${jsRecords.length} 个文件(入口 ouuut.mjs + js/)\n`);

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
