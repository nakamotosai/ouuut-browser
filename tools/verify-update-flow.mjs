#!/usr/bin/env node
// tools/verify-update-flow.mjs —— P7 的验收:**真升、真回滚**(不是单测)
//
// 用法(默认:本地造一个"小包"当 0.1.3,并起一个本地静态服务当更新源 —— 秒级跑完):
//   node tools/verify-update-flow.mjs
//
// 用真实的发布目录 + 远端更新源:
//   node tools/verify-update-flow.mjs --package dist/ouuut-0.1.3-win-x64 \
//        --base-url https://<vps-jp>/updates/0.1.4 --key <凭据目录>\ouuut-release.pem
//
// 流程(每一步都是**真的**):
//   1. 造一个 0.1.3 的包(默认小包:只有 manifest/签名 + 几个小文件);
//   2. 装到临时目录(`installRelease`:验签 → 逐文件校验 → 一次性换名);
//   3. 造一个 0.1.4 的**更新源**(变更文件 + 新清单 + 签名);
//   4. 起静态服务,让 `tools/update-from-url.mjs` 走 **HTTP** 把更新拉下来并应用;
//   5. 断言:安装目录里出现了 0.1.4 的变更文件、清单版本变成 0.1.4;
//   6. `--rollback` 回滚,断言:变更文件**没了**、清单版本回到 0.1.3。
//
// 为什么默认用"小包":这一片要验的是**流程**(验签/计划/换名/回滚),不是 545 MB 的拷贝速度。
// 真要拿发布目录跑,给 `--package` + `--base-url` 即可(同一条代码路径)。

import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest, installRelease, signManifest } from "../native/binding/release.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const realPackage = arg("--package");
const realBaseUrl = arg("--base-url");

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const ok = (m) => process.stdout.write(`✅ ${m}\n`);
const die = (m) => {
  process.stderr.write(`❌ ${m}\n`);
  process.exit(1);
};

const run = (exe, args) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [exe, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, out, err }));
  });

const work = await mkdtemp(path.join(tmpdir(), "ouuut-update-"));
const servers = [];
try {
  // ---- 密钥:给了 --key 就用真的,否则现造一对(验收自己的链路,不需要跟发布密钥一样)----
  let privatePem;
  let publicPem;
  const keyPath = arg("--key");
  if (keyPath) {
    privatePem = readFileSync(keyPath, "utf8");
    publicPem = (await import("node:crypto")).createPublicKey(privatePem).export({ type: "spki", format: "pem" });
  } else {
    const kp = generateKeyPairSync("ed25519");
    privatePem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
    publicPem = kp.publicKey.export({ type: "spki", format: "pem" });
  }
  const pubPath = path.join(work, "pub.pem");
  await writeFile(pubPath, publicPem);

  // ---- 1. 造 0.1.3 的"包" ---------------------------------------------------
  const pkgDir = path.join(work, "ouuut-0.1.3");
  const payload = path.join(pkgDir, "payload");
  await mkdir(payload, { recursive: true });
  const oldFiles = [
    ["launcher.txt", "ouuut 0.1.3 的入口(占位)\n"],
    ["js/app.mjs", "export const VERSION = '0.1.3';\n"],
  ];
  if (realPackage) {
    // 真包:直接用它的清单当"当前版本"(不必再拷一份 545 MB —— 我们只关心流程)
    process.stdout.write(`· 用真实发布目录的清单:${realPackage}\n`);
  } else {
    const entries = [];
    for (const [rel, content] of oldFiles) {
      const buf = Buffer.from(content, "utf8");
      await mkdir(path.dirname(path.join(payload, ...rel.split("/"))), { recursive: true });
      await writeFile(path.join(payload, ...rel.split("/")), buf);
      entries.push({ path: rel, sha256: sha(buf), size: buf.length });
    }
    const m = buildManifest({ version: "0.1.3", files: entries, meta: { platform: "verify" } });
    await writeFile(path.join(pkgDir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
    await writeFile(path.join(pkgDir, "manifest.sig"), signManifest(m, privatePem) + "\n");
  }

  // ---- 2. 装到临时目录 -----------------------------------------------------
  const installDir = path.join(work, "install");
  if (!realPackage) {
    const manifest = JSON.parse(await readFile(path.join(pkgDir, "manifest.json"), "utf8"));
    const sig = (await readFile(path.join(pkgDir, "manifest.sig"), "utf8")).trim();
    await installRelease({
      dir: installDir,
      manifest,
      signatureBase64: sig,
      publicKeyPem: publicPem,
      fetchBlob: async (f) => readFile(path.join(payload, ...f.path.split("/"))),
    });
    ok(`装好 0.1.3 → ${installDir}`);
  } else {
    const r = await run(path.join(ROOT, "tools", "install-release.mjs"), [
      "--package", realPackage, "--dir", installDir, "--pubkey", path.join(ROOT, "release", "ouuut-release.pub.pem"),
    ]);
    if (r.code !== 0) die(`装 0.1.3 失败:\n${r.out}\n${r.err}`);
    ok(`装好 0.1.3(真实包)→ ${installDir}`);
  }

  const readInstalledVersion = async () => {
    const p = path.join(installDir, ".ouuut-release", "manifest.json");
    if (!existsSync(p)) return null;
    return JSON.parse(await readFile(p, "utf8")).version;
  };
  if ((await readInstalledVersion()) !== "0.1.3") die("安装后目录里的清单版本不是 0.1.3(安装没留清单?)");
  ok("安装目录自带清单:版本 0.1.3");

  // ---- 3. 造 0.1.4 的更新源 -------------------------------------------------
  let baseUrl = realBaseUrl;
  if (!baseUrl) {
    const srcDir = path.join(work, "source-0.1.4");
    const r = await run(path.join(ROOT, "tools", "make-update-source.mjs"), [
      "--from", realPackage ?? pkgDir, "--version", "0.1.4", "--out", srcDir,
      "--key", keyPath ?? (await (async () => {
        const p = path.join(work, "priv.pem");
        await writeFile(p, privatePem);
        return p;
      })()),
      "--set", "payload/VERSION=0.1.4",
      "--set", "payload/js/app.mjs=export const VERSION = '0.1.4';\n",
    ]);
    if (r.code !== 0) die(`造更新源失败:\n${r.out}\n${r.err}`);
    process.stdout.write(r.out);

    // ---- 4. 静态服务 -------------------------------------------------------
    const server = http.createServer(async (req, res) => {
      const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
      const abs = path.join(srcDir, ...rel.split("/").filter(Boolean));
      try {
        const buf = await readFile(abs);
        res.writeHead(200, { "content-length": buf.length });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise((r2) => server.listen(0, "127.0.0.1", r2));
    servers.push(server);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    ok(`更新源已就绪:${baseUrl}`);
  } else {
    ok(`用远端更新源:${baseUrl}`);
    if (!keyPath) die("对着远端更新源跑时,请用 --key 给出与它匹配的私钥(造源要用)");
  }

  // ---- 5. 真升 -------------------------------------------------------------
  const updArgs = ["--dir", installDir, "--base-url", baseUrl];
  if (!keyPath) updArgs.push("--pubkey", pubPath);
  const plan = await run(path.join(ROOT, "tools", "update-from-url.mjs"), updArgs);
  if (plan.code !== 0) die(`看更新计划失败:\n${plan.out}\n${plan.err}`);
  process.stdout.write(plan.out);
  const applied = await run(path.join(ROOT, "tools", "update-from-url.mjs"), [...updArgs, "--apply"]);
  if (applied.code !== 0) die(`应用更新失败:\n${applied.out}\n${applied.err}`);
  process.stdout.write(applied.out);

  const vAfter = await readInstalledVersion();
  if (vAfter !== "0.1.4") die(`升完版本不对:${vAfter}`);
  const marker = path.join(installDir, "payload", "VERSION");
  if (!realPackage && !existsSync(marker)) die("0.1.4 的变更文件没落地");
  ok(`真升成功:版本 ${vAfter}${existsSync(marker) ? `,变更文件 ${JSON.stringify((await readFile(marker, "utf8")).trim())}` : ""}`);

  // ---- 6. 真回滚 -----------------------------------------------------------
  const rb = await run(path.join(ROOT, "tools", "update-from-url.mjs"), ["--dir", installDir, "--rollback"]);
  if (rb.code !== 0) die(`回滚失败:\n${rb.out}\n${rb.err}`);
  process.stdout.write(rb.out);
  const vBack = await readInstalledVersion();
  if (vBack !== "0.1.3") die(`回滚后版本不对:${vBack}`);
  if (!realPackage && existsSync(marker)) die("回滚后 0.1.4 的变更文件还在(说明没真回滚)");
  ok(`真回滚成功:版本回到 ${vBack}${existsSync(marker) ? "" : ",变更文件已消失"}`);

  process.stdout.write("\n✅ P7 验收通过:真升 0.1.3 → 0.1.4,真回滚回 0.1.3\n");
} catch (err) {
  die(`验收自身出错:${err?.stack ?? err}`);
} finally {
  for (const s of servers) s.close();
  await rm(work, { recursive: true, force: true });
}
