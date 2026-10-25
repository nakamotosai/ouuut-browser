// native/binding/paths.test.mjs —— 「东西在哪」的验收
//
// 这一片要钉住的是**顺序与布局**,不是字符串:
//   * 发布布局(入口一个文件 + `js/` 实现 + 浏览器在旁边)必须能被找到;
//   * 开发布局(仓库里的 `chromium/...` 与 `harness/...`)也必须在;
//   * 而且**不许依赖 CWD** —— 以前那句 `chromium\src\out\Release\chrome.exe` 是相对 CWD 的,
//     换个目录启动就"找不到浏览器",这是真踩过的坑。
// 所以下面的用例故意把 CWD 换到一个**什么都没有**的目录里再解析。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  browserExeCandidates,
  resolveBrowserExe,
  harnessEntryCandidates,
  resolveHarnessEntry,
} from "./paths.mjs";

/** 造一棵树:`files` 是相对路径列表,内容随便。 */
function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "ouuut-paths-"));
  for (const f of files) {
    const abs = path.join(root, ...f.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "x");
  }
  return root;
}

const CHROME = "chrome.exe";
const HARNESS = "package/ego-browser";

test("★ 发布布局:入口在 <payload>/js/native/bin/ 时,浏览器与 harness 都在旁边找得到", (t) => {
  const root = tree([
    CHROME,
    "ouuut.mjs",
    "js/native/bin/ouuut.mjs",
    "js/native/binding/cdp-pipe.mjs",
    `js/harness/${HARNESS}/dist/src/index.js`,
    `js/harness/${HARNESS}/dist/src/run.js`,
    `js/harness/${HARNESS}/node_modules/acorn/package.json`,
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cliFileUrl = pathToFileURL(path.join(root, "js", "native", "bin", "ouuut.mjs")).href;

  // CWD 故意放在一个空目录:发布布局跟 CWD 无关
  const empty = tree([]);
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const cwd = process.cwd();
  process.chdir(empty);
  try {
    assert.equal(resolveBrowserExe({ cliFileUrl }), path.join(root, CHROME));
    assert.equal(
      resolveHarnessEntry("index.js", { cliFileUrl }),
      pathToFileURL(path.join(root, "js", "harness", HARNESS, "dist", "src", "index.js")).href,
    );
    assert.equal(
      resolveHarnessEntry("run.js", { cliFileUrl }),
      pathToFileURL(path.join(root, "js", "harness", HARNESS, "dist", "src", "run.js")).href,
    );
  } finally {
    process.chdir(cwd);
  }
});

test("★ 开发布局:入口在 <repo>/native/bin/ 时,认仓库里的构建产物与 vendored harness", (t) => {
  const root = tree([
    "native/bin/ouuut.mjs",
    "chromium/src/out/Release/chrome.exe",
    `harness/${HARNESS}/dist/src/index.js`,
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cliFileUrl = pathToFileURL(path.join(root, "native", "bin", "ouuut.mjs")).href;

  const empty = tree([]);
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const cwd = process.cwd();
  process.chdir(empty);
  try {
    assert.equal(resolveBrowserExe({ cliFileUrl }), path.join(root, "chromium", "src", "out", "Release", CHROME));
    assert.equal(
      resolveHarnessEntry("index.js", { cliFileUrl }),
      pathToFileURL(path.join(root, "harness", HARNESS, "dist", "src", "index.js")).href,
    );
  } finally {
    process.chdir(cwd);
  }
});

test("解析顺序:显式入参 > 环境变量 > 自动找(发布 > 开发)", (t) => {
  const root = tree([CHROME, "js/native/bin/ouuut.mjs", "chromium/src/out/Release/chrome.exe"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cliFileUrl = pathToFileURL(path.join(root, "js", "native", "bin", "ouuut.mjs")).href;

  assert.equal(resolveBrowserExe({ browser: "D:/b.exe", env: { OUUUT_BROWSER: "D:/c.exe" }, cliFileUrl }), "D:/b.exe");
  assert.equal(resolveBrowserExe({ env: { OUUUT_BROWSER: "D:/c.exe" }, cliFileUrl }), "D:/c.exe");
  // 两个布局都在时,**发布布局优先**(入口旁边那个)
  assert.equal(resolveBrowserExe({ cliFileUrl }), path.join(root, CHROME));

  const harnessRoot = tree(["x/package/ego-browser/dist/src/index.js"]);
  t.after(() => rmSync(harnessRoot, { recursive: true, force: true }));
  assert.equal(
    resolveHarnessEntry("index.js", {
      env: { OUUUT_HARNESS_DIR: path.join(harnessRoot, "x", HARNESS) },
      cliFileUrl,
    }),
    pathToFileURL(path.join(harnessRoot, "x", HARNESS, "dist", "src", "index.js")).href,
  );
});

test("都找不到时:报**试过哪些**,别只说找不到(发布形态用错时这是唯一线索)", (t) => {
  const root = tree(["js/native/bin/ouuut.mjs"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cliFileUrl = pathToFileURL(path.join(root, "js", "native", "bin", "ouuut.mjs")).href;

  const empty = tree([]);
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const cwd = process.cwd();
  process.chdir(empty);
  try {
    assert.throws(() => resolveBrowserExe({ cliFileUrl }), (e) => {
      assert.match(e.message, /找不到浏览器/);
      for (const p of browserExeCandidates({ cliFileUrl, cwd: empty })) assert.ok(e.message.includes(p), p);
      return true;
    });
    assert.throws(() => resolveHarnessEntry("index.js", { cliFileUrl }), (e) => {
      assert.match(e.message, /找不到 harness 入口 index\.js/);
      for (const p of harnessEntryCandidates("index.js", { cliFileUrl })) assert.ok(e.message.includes(p), p);
      return true;
    });
  } finally {
    process.chdir(cwd);
  }
});
