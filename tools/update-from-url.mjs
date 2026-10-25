#!/usr/bin/env node
// tools/update-from-url.mjs —— **联网**更新:P7 的那条真链路
//
// 用法:
//   # 只看计划(默认,**不动盘**)
//   node tools/update-from-url.mjs --dir <安装目录> --base-url https://example/updates/0.1.4 [--pubkey release/ouuut-release.pub.pem]
//   # 真的应用
//   node tools/update-from-url.mjs ... --apply
//   # 回滚到上一次应用前
//   node tools/update-from-url.mjs --dir <安装目录> --rollback
//
// 顺序(**每一步失败都 fail-closed**):
//   1. 取 `<base>/manifest.json` + `<base>/manifest.sig`;
//   2. **用钉住的公钥验签** —— 公钥来自本地(`--pubkey`),**不来自更新源**(源自己带公钥 = 自己给自己发证书);
//   3. 读安装目录里的当前清单(`<dir>/.ouuut-release/manifest.json`,安装/上次更新时留下的)并**也验一次签**;
//   4. 比版本(降级一律拒),算出 changed/added/removed;`--apply` 时才动盘;
//   5. 应用:`applyUpdate()`(整份复制到暂存 → 逐文件校验 → 一次性换名;失败时安装目录一个字节都不动);
//   6. 落一份 `<dir>/.ouuut-update.json`(记 backup 路径与版本)→ 回滚靠它。
//
// 为什么公钥要"钉住":更新是**唯一的远程代码执行入口**。公钥跟包走,就等于任何人都能给你发"更新"。

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import {
  applyUpdate,
  compareVersions,
  planUpdate,
  rollbackUpdate,
  verifyManifest,
} from "../native/binding/release.mjs";

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--rollback") o.rollback = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.dir) {
  process.stderr.write(
    "用法: node tools/update-from-url.mjs --dir <安装目录> --base-url <url> [--pubkey <公钥.pem>] [--apply]\n" +
      "      node tools/update-from-url.mjs --dir <安装目录> --rollback\n",
  );
  process.exit(2);
}
if (!args.rollback && !args["base-url"]) {
  process.stderr.write("要更新必须给 --base-url(更新源的地址)\n");
  process.exit(2);
}

const DIR = path.resolve(args.dir);
const PUBKEY = args.pubkey ?? path.join("release", "ouuut-release.pub.pem");
const STATE = path.join(DIR, ".ouuut-update.json");
const CURRENT_MANIFEST = path.join(DIR, ".ouuut-release", "manifest.json");
const CURRENT_SIG = path.join(DIR, ".ouuut-release", "manifest.sig");

const die = (msg, code = 1) => {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(code);
};

/** 取一个 URL 的字节(node:http/https,零依赖)。 */
function fetchBytes(url, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} → HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`GET ${url} 超时`)));
    req.on("error", reject);
  });
}

// ---- 回滚 ----------------------------------------------------------------
if (args.rollback) {
  if (!existsSync(STATE)) die(`没有更新记录(${STATE})—— 回滚只能回到"上一次真正应用过"的版本`);
  const state = JSON.parse(await readFile(STATE, "utf8"));
  try {
    await rollbackUpdate({ dir: DIR, backupDir: state.backupDir });
  } catch (err) {
    die(`回滚失败:${err?.message ?? err}`);
  }
  await writeFile(
    STATE,
    JSON.stringify({ ...state, rolledBackAt: new Date().toISOString(), rolledBack: true }, null, 2) + "\n",
  );
  process.stdout.write(`✅ 已回滚到 ${state.fromVersion ?? "(未知)"}(备份 ${state.backupDir})\n`);
  process.exit(0);
}

// ---- 更新 ----------------------------------------------------------------
const pubkeyPem = await readFile(PUBKEY, "utf8").catch(() => die(`读不到公钥 ${PUBKEY}`));
const base = args["base-url"].replace(/\/+$/, "");

let nextManifest;
let nextSig;
try {
  nextManifest = JSON.parse((await fetchBytes(`${base}/manifest.json`)).toString("utf8"));
  nextSig = (await fetchBytes(`${base}/manifest.sig`)).toString("utf8").trim();
} catch (err) {
  die(`取更新源失败:${err?.message ?? err}`);
}
try {
  verifyManifest(nextManifest, nextSig, pubkeyPem);
} catch (err) {
  die(`更新源验签失败:${err?.message ?? err}`);
}
process.stdout.write(`✅ 更新源验签通过:版本 ${nextManifest.version}(${nextManifest.files.length} 个文件)\n`);

if (!existsSync(CURRENT_MANIFEST)) {
  die(
    `安装目录里没有当前清单(${CURRENT_MANIFEST})—— 这个目录不是我们装出来的,` +
      "更新它等于盲改别人的目录。请先用 tools/install-release.mjs 装一次。",
  );
}
const currentManifest = JSON.parse(await readFile(CURRENT_MANIFEST, "utf8"));
if (existsSync(CURRENT_SIG)) {
  try {
    verifyManifest(currentManifest, (await readFile(CURRENT_SIG, "utf8")).trim(), pubkeyPem);
  } catch (err) {
    die(`安装目录里的清单**验签失败**(说明它被动过):${err?.message ?? err}`);
  }
}
const cmp = compareVersions(nextManifest.version, currentManifest.version);
if (cmp === 0) {
  process.stdout.write(`· 已经是最新(${currentManifest.version}),没什么要做的\n`);
  process.exit(0);
}
if (cmp < 0) {
  die(`更新源版本 ${nextManifest.version} **低于**已装版本 ${currentManifest.version} —— 降级请走 --rollback`);
}

const plan = planUpdate({ currentManifest, nextManifest });
const added = plan.changed.filter((c) => c.reason === "added").length;
process.stdout.write(
  `· 计划:${currentManifest.version} → ${nextManifest.version} ` +
    `改动 ${plan.changed.length - added} · 新增 ${added} · 删除 ${plan.removed.length}` +
    `${plan.noop ? " · 内容无变化" : ""}\n`,
);

if (!args.apply) {
  process.stdout.write("· 只看了计划(要真升加 --apply)\n");
  process.exit(0);
}

const fetchBlob = async (f) => {
  const buf = await fetchBytes(`${base}/payload/${f.path}`);
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== f.sha256) throw new Error(`文件 ${f.path} 哈希不符(期望 ${f.sha256},实际 ${got})`);
  return buf;
};

let result;
try {
  result = await applyUpdate({ dir: DIR, plan, fetchBlob });
} catch (err) {
  die(`应用更新失败(安装目录应保持原样):${err?.message ?? err}`);
}
if (!result.applied) {
  process.stdout.write("· 没有需要应用的变化\n");
  process.exit(0);
}

// 更新之后的**自我描述**:清单换成新的,并记下备份路径(回滚要用)
await mkdir(path.join(DIR, ".ouuut-release"), { recursive: true });
await writeFile(CURRENT_MANIFEST, JSON.stringify(nextManifest, null, 2) + "\n");
await writeFile(CURRENT_SIG, nextSig + "\n");
await writeFile(
  STATE,
  JSON.stringify(
    {
      version: nextManifest.version,
      fromVersion: currentManifest.version,
      backupDir: result.backupDir,
      appliedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`✅ 已更新到 ${nextManifest.version}(备份留在 ${result.backupDir})\n`);
