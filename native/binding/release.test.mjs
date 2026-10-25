// native/binding/release.test.mjs —— 签名发布 + 自动更新(M7)
//
// 这是整个产品里**唯一**会被远程内容驱动去改本地文件的地方。
// 所以这里的断言重点不是"能装上",而是"**验不过就一个字节都不动**"。

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildManifest,
  signManifest,
  verifyManifest,
  compareVersions,
  planUpdate,
  applyUpdate,
  rollbackUpdate,
  sha256File,
  ReleaseError,
  RELEASE_ERRORS,
} from "./release.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem = publicKey.export({ type: "spki", format: "pem" });

const otherKeys = generateKeyPairSync("ed25519");
const otherPubPem = otherKeys.publicKey.export({ type: "spki", format: "pem" });

async function tmpDir() {
  return mkdtemp(path.join(os.tmpdir(), "ouuut-release-"));
}

const fileRec = (p, content) => ({ path: p, sha256: sha(Buffer.from(content)) });

// ---- 1. 清单 --------------------------------------------------------------

test("buildManifest:路径归一成正斜杠、去 ./、按路径排序", () => {
  const m = buildManifest({
    version: "1.0.0",
    files: [
      fileRec(".\\b\\x.dll", "b"),
      fileRec("./a/x.exe", "a"),
      { path: "bad", sha256: "not-a-hash" }, // 非法哈希要丢掉
    ],
  });
  assert.deepEqual(
    m.files.map((f) => f.path),
    ["a/x.exe", "b/x.dll"],
  );
});

test("buildManifest:没 version 就报错(清单不能没有版本)", () => {
  assert.throws(() => buildManifest({ files: [] }), (e) => e.error_code === RELEASE_ERRORS.MANIFEST_TAMPERED);
});

// ---- 2. 签名 --------------------------------------------------------------

test("★ 签名 → 验签通过", () => {
  const m = buildManifest({ version: "1.0.0", files: [fileRec("a.txt", "a")] });
  const sig = signManifest(m, privPem);
  assert.equal(verifyManifest(m, sig, pubPem), true);
});

test("★ 清单被改一个字节 → 验签失败(fail-closed)", () => {
  const m = buildManifest({ version: "1.0.0", files: [fileRec("a.txt", "a")] });
  const sig = signManifest(m, privPem);
  const tampered = { ...m, version: "1.0.1" };
  assert.throws(
    () => verifyManifest(tampered, sig, pubPem),
    (e) => e.error_code === RELEASE_ERRORS.BAD_SIGNATURE,
  );
});

test("★ 换一把公钥 → 验签失败(不是「有签名就行」)", () => {
  const m = buildManifest({ version: "1.0.0", files: [] });
  const sig = signManifest(m, privPem);
  assert.throws(
    () => verifyManifest(m, sig, otherPubPem),
    (e) => e.error_code === RELEASE_ERRORS.BAD_SIGNATURE,
  );
});

test("★ 没有签名 → 明确报「没有签名」,不许当成通过", () => {
  const m = buildManifest({ version: "1.0.0", files: [] });
  for (const bad of ["", "   ", null, undefined]) {
    assert.throws(
      () => verifyManifest(m, bad, pubPem),
      (e) => e.error_code === RELEASE_ERRORS.NO_SIGNATURE,
      `签名=${JSON.stringify(bad)}`,
    );
  }
});

test("签名本身不是合法 base64/长度不对 → 报 BAD_SIGNATURE,不抛未捕获异常", () => {
  const m = buildManifest({ version: "1.0.0", files: [] });
  assert.throws(
    () => verifyManifest(m, "AAAA", pubPem),
    (e) => e.error_code === RELEASE_ERRORS.BAD_SIGNATURE,
  );
});

test("清单里的 signature 字段不参与签名(否则自我指涉)", () => {
  const m = buildManifest({ version: "1.0.0", files: [] });
  const sig = signManifest(m, privPem);
  assert.equal(verifyManifest({ ...m, signature: "随便什么" }, sig, pubPem), true);
});

// ---- 3. 版本与计划 --------------------------------------------------------

test("compareVersions:按数字段比,不是字符串比", () => {
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
  assert.equal(compareVersions("1.2.9", "1.2.10"), -1);
  assert.equal(compareVersions("2.0", "2.0.0"), 0);
});

test("★ planUpdate:降级一律拒绝(不许回放到旧版)", () => {
  assert.throws(
    () =>
      planUpdate({
        currentManifest: buildManifest({ version: "2.0.0", files: [] }),
        nextManifest: buildManifest({ version: "1.0.0", files: [] }),
      }),
    (e) => e.error_code === RELEASE_ERRORS.DOWNGRADE,
  );
});

test("planUpdate:算出 changed / added / removed", () => {
  const cur = buildManifest({
    version: "1.0.0",
    files: [fileRec("same.txt", "s"), fileRec("changed.txt", "old"), fileRec("gone.txt", "g")],
  });
  const next = buildManifest({
    version: "1.1.0",
    files: [fileRec("same.txt", "s"), fileRec("changed.txt", "new"), fileRec("added.txt", "a")],
  });
  const p = planUpdate({ currentManifest: cur, nextManifest: next });
  assert.deepEqual(p.changed.map((c) => [c.path, c.reason]), [
    ["added.txt", "added"],
    ["changed.txt", "changed"],
  ]);
  assert.deepEqual(p.removed.map((r) => r.path), ["gone.txt"]);
  assert.equal(p.noop, false);
});

test("planUpdate:完全一样时 noop = true", () => {
  const m = buildManifest({ version: "1.0.0", files: [fileRec("a.txt", "a")] });
  assert.equal(planUpdate({ currentManifest: m, nextManifest: m }).noop, true);
});

// ---- 4. 原子应用 ----------------------------------------------------------

async function makeInstall(files) {
  const dir = await tmpDir();
  for (const [p, content] of Object.entries(files)) {
    const full = path.join(dir, p);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

const blobs = (map) => async (f) => {
  if (!(f.path in map)) throw new Error(`没有 ${f.path} 的内容`);
  return Buffer.from(map[f.path]);
};

test("★ applyUpdate:成功时内容换新、旧文件被删、备份留着", async (t) => {
  const dir = await makeInstall({ "keep.txt": "keep", "old.txt": "old" });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const cur = buildManifest({
    version: "1.0.0",
    files: [fileRec("keep.txt", "keep"), fileRec("old.txt", "old")],
  });
  const next = buildManifest({ version: "1.1.0", files: [fileRec("keep.txt", "keep"), fileRec("new.txt", "NEW")] });
  const plan = planUpdate({ currentManifest: cur, nextManifest: next });

  const r = await applyUpdate({ dir, plan, fetchBlob: blobs({ "new.txt": "NEW" }) });
  assert.equal(r.applied, true);
  assert.equal(await readFile(path.join(dir, "new.txt"), "utf8"), "NEW");
  assert.equal(await readFile(path.join(dir, "keep.txt"), "utf8"), "keep", "没变的文件要还在");
  await assert.rejects(() => readFile(path.join(dir, "old.txt"), "utf8"), "旧文件应被删掉");
  assert.deepEqual((await readdir(r.backupDir)).sort(), ["keep.txt", "old.txt"], "备份要有旧内容");
});

test("★ applyUpdate:哈希不符 → **一个字节都不动**,且暂存区被清掉", async (t) => {
  const dir = await makeInstall({ "a.txt": "old-a" });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const next = buildManifest({ version: "1.1.0", files: [fileRec("a.txt", "new-a")] });
  const plan = planUpdate({ currentManifest: null, nextManifest: next });

  await assert.rejects(
    () => applyUpdate({ dir, plan, fetchBlob: async () => Buffer.from("TAMPERED") }),
    (e) => e.error_code === RELEASE_ERRORS.HASH_MISMATCH,
  );
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "old-a", "安装目录必须原样");
  const leftovers = (await readdir(path.dirname(dir))).filter((n) => n.startsWith(`${path.basename(dir)}.staging`));
  assert.deepEqual(leftovers, [], "暂存区要清干净");
});

test("★ applyUpdate:取文件失败 → 安装目录原样", async (t) => {
  const dir = await makeInstall({ "a.txt": "old-a" });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const next = buildManifest({ version: "1.1.0", files: [fileRec("a.txt", "new-a")] });
  const plan = planUpdate({ currentManifest: null, nextManifest: next });

  await assert.rejects(
    () =>
      applyUpdate({
        dir,
        plan,
        fetchBlob: async () => {
          throw new Error("网络断了");
        },
      }),
    (e) => e.error_code === RELEASE_ERRORS.APPLY_FAILED,
  );
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "old-a");
});

test("applyUpdate:noop 计划不动盘", async (t) => {
  const dir = await makeInstall({ "a.txt": "a" });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await applyUpdate({ dir, plan: { noop: true, changed: [], removed: [] } });
  assert.equal(r.applied, false);
});

// ---- 5. 回滚 --------------------------------------------------------------

test("★ rollbackUpdate:真的回到旧内容", async (t) => {
  const dir = await makeInstall({ "a.txt": "old-a" });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const next = buildManifest({ version: "1.1.0", files: [fileRec("a.txt", "new-a")] });
  const plan = planUpdate({ currentManifest: null, nextManifest: next });
  const r = await applyUpdate({ dir, plan, fetchBlob: blobs({ "a.txt": "new-a" }) });
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "new-a");

  await rollbackUpdate({ dir, backupDir: r.backupDir });
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "old-a");
});

test("★ rollbackUpdate:备份不存在 → 报错,不许假装成功", async () => {
  await assert.rejects(
    () => rollbackUpdate({ dir: "C:/nonexistent-dir", backupDir: "C:/nonexistent-backup" }),
    (e) => e.error_code === RELEASE_ERRORS.APPLY_FAILED,
  );
});

// ---- 6. 文件哈希 ----------------------------------------------------------

test("sha256File 与实际内容一致", async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = path.join(dir, "x.bin");
  await writeFile(f, "hello");
  assert.equal(await sha256File(f), sha(Buffer.from("hello")));
});
