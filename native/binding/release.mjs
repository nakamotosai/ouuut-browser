// native/binding/release.mjs —— 签名发布 + 自动更新(M7)
//
// 一条原则贯穿全文件:**验不过就不动**。
// 自动更新是这个产品里唯一"会被远程内容驱动去改本地文件"的地方 ——
// 一旦这里 fail-open(验签失败但照装),就等于把更新通道变成远程代码执行入口。
//
// 所以:
//   * 缺签名 / 签名不匹配 / manifest 被改过 → **一律拒绝**,且错误里说清是哪一条
//   * 更新是**原子**的:先全部写到暂存区,校验通过再一次性换名;
//     任何一步失败都回到原状,不留半更新的目录
//   * 旧版本保留一份,失败可回滚

import { createHash, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, rename, rm, cp, stat } from "node:fs/promises";
import path from "node:path";

export const RELEASE_ERRORS = Object.freeze({
  NO_SIGNATURE: "OUUUT_RELEASE_NO_SIGNATURE",
  BAD_SIGNATURE: "OUUUT_RELEASE_BAD_SIGNATURE",
  MANIFEST_TAMPERED: "OUUUT_RELEASE_MANIFEST_TAMPERED",
  HASH_MISMATCH: "OUUUT_RELEASE_HASH_MISMATCH",
  DOWNGRADE: "OUUUT_RELEASE_DOWNGRADE",
  APPLY_FAILED: "OUUUT_RELEASE_APPLY_FAILED",
  UNSAFE_PATH: "OUUUT_RELEASE_UNSAFE_PATH",
  TARGET_EXISTS: "OUUUT_RELEASE_TARGET_EXISTS",
});

export class ReleaseError extends Error {
  constructor(message, { code = RELEASE_ERRORS.APPLY_FAILED, cause } = {}) {
    super(message, { cause });
    this.name = "ReleaseError";
    this.error_code = code;
  }
}

/** 计算文件的 sha256(**真**流式 —— 332 MB 的 chrome.dll 也不会整个进内存)。 */
export async function sha256File(filePath) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) h.update(chunk);
  return h.digest("hex");
}

/**
 * 生成发布清单。
 *
 * `files` 里的路径一律**相对路径 + 正斜杠** —— 绝对路径进清单会把构建机的目录结构
 * 泄露出去,而且换台机器就对不上(与 M1 的"路径无关性"同一条原则)。
 *
 * @param {{version: string, files: Array<{path: string, sha256: string, size?: number}>, meta?: object}} o
 */
export function buildManifest({ version, files = [], meta = {} } = {}) {
  if (typeof version !== "string" || version === "") {
    throw new ReleaseError("manifest 需要 version", { code: RELEASE_ERRORS.MANIFEST_TAMPERED });
  }
  const normalized = files
    .map((f) => ({
      path: String(f.path ?? "").replace(/\\/g, "/").replace(/^\.\//, ""),
      sha256: String(f.sha256 ?? "").toLowerCase(),
      ...(Number.isFinite(f.size) ? { size: f.size } : {}),
    }))
    .filter((f) => f.path !== "" && /^[0-9a-f]{64}$/.test(f.sha256))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    schema: 1,
    version,
    generatedAt: meta.generatedAt ?? null,
    ...meta,
    files: normalized,
  };
}

/** 清单的**规范化字节** —— 签名和验签必须对同一串字节,否则顺序/空格一变就验不过。 */
export function manifestBytes(manifest) {
  const { signature: _ignored, ...rest } = manifest ?? {};
  return Buffer.from(JSON.stringify(rest), "utf8");
}

/** 用 Ed25519 私钥签清单,返回 base64 签名。 */
export function signManifest(manifest, privateKeyPem) {
  return sign(null, manifestBytes(manifest), privateKeyPem).toString("base64");
}

/**
 * 验签。**fail-closed** —— 任何一条不满足都抛,不返回 false 让人忘记检查。
 */
export function verifyManifest(manifest, signatureBase64, publicKeyPem) {
  if (typeof signatureBase64 !== "string" || signatureBase64.trim() === "") {
    throw new ReleaseError("清单没有签名", { code: RELEASE_ERRORS.NO_SIGNATURE });
  }
  let ok = false;
  try {
    ok = verify(null, manifestBytes(manifest), publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch (err) {
    throw new ReleaseError(`验签过程出错:${err?.message ?? err}`, {
      code: RELEASE_ERRORS.BAD_SIGNATURE,
      cause: err,
    });
  }
  if (!ok) {
    throw new ReleaseError("清单签名不匹配 —— 拒绝使用", { code: RELEASE_ERRORS.BAD_SIGNATURE });
  }
  return true;
}

/** 比较两个版本号(`1.2.10` > `1.2.9`)。只支持数字段,够用且不引依赖。 */
export function compareVersions(a, b) {
  const pa = String(a ?? "")
    .split(".")
    .map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b ?? "")
    .split(".")
    .map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 算出从 `currentManifest` 到 `nextManifest` 要动哪些文件。
 *
 * **降级一律拒绝** —— 允许降级等于给攻击者一条"回放到有漏洞的旧版"的路。
 */
export function planUpdate({ currentManifest = null, nextManifest } = {}) {
  if (!nextManifest || typeof nextManifest.version !== "string") {
    throw new ReleaseError("缺少目标清单", { code: RELEASE_ERRORS.MANIFEST_TAMPERED });
  }
  if (currentManifest?.version) {
    if (compareVersions(nextManifest.version, currentManifest.version) < 0) {
      throw new ReleaseError(
        `拒绝降级:${nextManifest.version} < ${currentManifest.version}`,
        { code: RELEASE_ERRORS.DOWNGRADE },
      );
    }
  }

  const before = new Map((currentManifest?.files ?? []).map((f) => [f.path, f.sha256]));
  const after = new Map((nextManifest.files ?? []).map((f) => [f.path, f.sha256]));

  const changed = [];
  for (const [p, h] of after) {
    if (before.get(p) !== h) changed.push({ path: p, sha256: h, reason: before.has(p) ? "changed" : "added" });
  }
  const removed = [...before.keys()].filter((p) => !after.has(p)).map((p) => ({ path: p, reason: "removed" }));

  return {
    from: currentManifest?.version ?? null,
    to: nextManifest.version,
    changed,
    removed,
    // 一个都没变就不用动盘 —— 免得白写一遍还留下改动痕迹
    noop: changed.length === 0 && removed.length === 0,
  };
}

/**
 * 应用更新。**原子**:全部写进暂存区并校验,再一次性换名。
 *
 * @param {object} o
 * @param {string} o.dir        安装目录
 * @param {object} o.plan       `planUpdate()` 的结果
 * @param {(file: {path, sha256}) => Promise<Buffer>} o.fetchBlob 取新文件内容
 */
export async function applyUpdate({ dir, plan, fetchBlob } = {}) {
  if (!plan || plan.noop) return { applied: false, backupDir: null };
  if (typeof fetchBlob !== "function") {
    throw new ReleaseError("applyUpdate 需要 fetchBlob", { code: RELEASE_ERRORS.APPLY_FAILED });
  }

  const staging = `${dir}.staging-${process.pid}`;
  const backup = `${dir}.backup-${process.pid}`;

  try {
    // 1) 把当前内容整份复制到暂存区(而不是只写变化的文件)——
    //    这样换名之后目录是**完整**的,不存在"一半新一半旧"的中间态。
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await cp(dir, staging, { recursive: true });

    // 2) 写入新文件,边写边校验
    for (const f of plan.changed) {
      const buf = await fetchBlob(f);
      const got = createHash("sha256").update(buf).digest("hex");
      if (got !== f.sha256) {
        throw new ReleaseError(`文件 ${f.path} 哈希不符(期望 ${f.sha256},实际 ${got})`, {
          code: RELEASE_ERRORS.HASH_MISMATCH,
        });
      }
      const target = path.join(staging, f.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buf);
    }

    // 3) 删掉新版里已不存在的文件
    for (const f of plan.removed) {
      await rm(path.join(staging, f.path), { recursive: true, force: true });
    }

    // 4) 一次性换名 —— 到这一步之前,安装目录**一个字节都没动**
    await rm(backup, { recursive: true, force: true });
    await rename(dir, backup);
    try {
      await rename(staging, dir);
    } catch (err) {
      // 换名失败 → 立刻把旧的换回去,不留空目录
      await rename(backup, dir).catch(() => {});
      throw err;
    }
    return { applied: true, backupDir: backup };
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (err instanceof ReleaseError) throw err;
    throw new ReleaseError(`应用更新失败:${err?.message ?? err}`, {
      code: RELEASE_ERRORS.APPLY_FAILED,
      cause: err,
    });
  }
}

/**
 * 清单里的路径必须是**相对、不含 `..`、不带盘符**。
 *
 * 这条不是洁癖:安装时按 `path.join(dir, f.path)` 落盘,一个 `../../` 就能写到
 * 安装目录外面去 —— 和压缩包里的 zip-slip 是同一类问题。清单本身是签过名的,
 * 但**签名只证明"是我们发的",不证明"内容是安全的"**(发版脚本也可能出错)。
 */
function assertSafeRelPath(p) {
  const s = String(p ?? "").replace(/\\/g, "/");
  const bad =
    s === "" ||
    s.startsWith("/") ||
    /^[A-Za-z]:/.test(s) ||
    s.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  if (bad) {
    throw new ReleaseError(`清单里有不安全的路径:${JSON.stringify(p)}`, {
      code: RELEASE_ERRORS.UNSAFE_PATH,
    });
  }
  return s;
}

/**
 * **首次安装**。第三方拿到的就是这个流程 —— 目标目录还不存在,没有"当前清单"可比。
 *
 * 与 `applyUpdate` 的区别只在起点:那条路是"已有安装 → 换掉变化的文件",
 * 这条路是"空地 → 铺满"。**纪律完全相同**:验签 → 暂存 → 逐文件校验 → 一次性换名。
 *
 * @param {object} o
 * @param {string} o.dir 安装到哪(必须**不存在**)
 * @param {object} o.manifest 已签名的清单
 * @param {string} o.signatureBase64
 * @param {string} o.publicKeyPem
 * @param {(file: {path, sha256}) => Promise<Buffer>} o.fetchBlob
 */
export async function installRelease({
  dir,
  manifest,
  signatureBase64,
  publicKeyPem,
  fetchBlob,
} = {}) {
  if (typeof dir !== "string" || dir === "") {
    throw new ReleaseError("installRelease 需要 dir", { code: RELEASE_ERRORS.APPLY_FAILED });
  }
  if (typeof fetchBlob !== "function") {
    throw new ReleaseError("installRelease 需要 fetchBlob", { code: RELEASE_ERRORS.APPLY_FAILED });
  }

  // 1) 先验签 —— 验不过连暂存区都不建
  verifyManifest(manifest, signatureBase64, publicKeyPem);

  const files = manifest?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new ReleaseError("清单里没有文件", { code: RELEASE_ERRORS.MANIFEST_TAMPERED });
  }
  for (const f of files) assertSafeRelPath(f.path);

  // 2) 目标已存在就不装 —— 覆盖已有安装是**更新**的职责,别混在一起
  try {
    await stat(dir);
    throw new ReleaseError(`目标目录已存在,首次安装不覆盖:${dir}`, {
      code: RELEASE_ERRORS.TARGET_EXISTS,
    });
  } catch (err) {
    if (err instanceof ReleaseError) throw err;
    // 不存在 → 正是要的情况
  }

  const staging = `${dir}.staging-${process.pid}`;
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    // 3) 边写边校验;任何一个不符就整体放弃
    for (const f of files) {
      const buf = await fetchBlob(f);
      const got = createHash("sha256").update(buf).digest("hex");
      if (got !== f.sha256) {
        throw new ReleaseError(`文件 ${f.path} 哈希不符(期望 ${f.sha256},实际 ${got})`, {
          code: RELEASE_ERRORS.HASH_MISMATCH,
        });
      }
      const target = path.join(staging, f.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buf);
    }

    // 4) **把清单与签名留在安装目录里** —— 安装目录必须能回答"我是哪个版本"。
    //    没有这一步,更新就无从计算(拿不到 when-current),而"我装的是 0.1.3 还是 0.1.4"
    //    只能靠人记 —— 那正是更新链路最容易出错的地方。
    await mkdir(path.join(staging, ".ouuut-release"), { recursive: true });
    await writeFile(path.join(staging, ".ouuut-release", "manifest.json"), manifestBytes(manifest));
    await writeFile(path.join(staging, ".ouuut-release", "manifest.sig"), signatureBase64 + "\n");

    // 5) 一次性换名 —— 到这一步之前,目标位置什么都不存在
    await mkdir(path.dirname(dir), { recursive: true });
    await rename(staging, dir);
    return { installed: true, version: manifest.version, files: files.length };
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (err instanceof ReleaseError) throw err;
    throw new ReleaseError(`安装失败:${err?.message ?? err}`, {
      code: RELEASE_ERRORS.APPLY_FAILED,
      cause: err,
    });
  }
}

/** 回滚到备份目录。备份不在就报错 —— 不许"假装回滚成功"。 */
export async function rollbackUpdate({ dir, backupDir } = {}) {
  if (typeof backupDir !== "string" || backupDir === "") {
    throw new ReleaseError("没有备份可回滚", { code: RELEASE_ERRORS.APPLY_FAILED });
  }
  try {
    await stat(backupDir);
  } catch {
    throw new ReleaseError(`备份目录不存在:${backupDir}`, { code: RELEASE_ERRORS.APPLY_FAILED });
  }
  await rm(dir, { recursive: true, force: true });
  await rename(backupDir, dir);
  return { rolledBack: true };
}
