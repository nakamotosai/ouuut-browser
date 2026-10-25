// native/binding/paths.mjs —— 「东西在哪」的**一处**判断(F13/F6 之后的 P6:分发形态)
//
// 为什么值得单开一个文件:以前这两件事都是**写死的一行**——
//   * 浏览器:`"chromium\\src\\out\\Release\\chrome.exe"`(相对 **CWD** ⇒ 换个目录启动就找不到)
//   * harness:`new URL("../../harness/package/ego-browser/dist/src/index.js", import.meta.url)`
//     (只认**本仓库**的目录形状 ⇒ 发布出去以后没有 `harness/` 这一层)
// 发布布局一旦要和开发布局共存,"在哪"这件事就必须**只有一处**判断,而且能被用例直接钉住。
//
// 发布布局(见 ADR-017):
//   <payload>/ouuut.mjs                      ← 入口(一个文件)
//   <payload>/js/native/bin|binding/*.mjs    ← 原生层
//   <payload>/js/harness/package/ego-browser/ ← 随包携带的 harness(dist + acorn)
//   <payload>/chrome.exe                     ← 浏览器(标准 Chrome 布局)
//
// 解析顺序一律是:**显式入参 > 环境变量 > 入口文件旁边(发布) > 入口文件旁边的仓库形状(开发) > CWD(兜底)**。
// 开发机上的路径**相对入口文件**解析,不相对 CWD —— 这样从任何目录启动都能跑。

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dirOf = (fileUrl) => path.dirname(fileURLToPath(fileUrl));

/** 从入口文件出发,**依次尝试**的浏览器路径(绝对路径)。导出是为了让用例直接钉住顺序。 */
export function browserExeCandidates({ cliFileUrl = import.meta.url, cwd = process.cwd() } = {}) {
  const dir = dirOf(cliFileUrl);
  return [
    // 发布布局:`<payload>/js/native/bin/` 往上三层 = `<payload>/chrome.exe`
    path.resolve(dir, "..", "..", "..", "chrome.exe"),
    // 开发机:本仓库的构建产物(相对**入口文件**)
    path.resolve(dir, "..", "..", "chromium", "src", "out", "Release", "chrome.exe"),
    // 开发机老习惯(相对 CWD,保留兜底)
    path.resolve(cwd, "chromium", "src", "out", "Release", "chrome.exe"),
  ];
}

/**
 * 找浏览器可执行文件。
 *
 * 显式入参与环境变量**不做存在性检查**(可能是还没生成的路径,提早判死只会更难用);
 * 自动找的那些必须是**真的存在**的,否则继续往下试,并在都失败时报出**试过哪些**(不要只报"找不到")。
 */
export function resolveBrowserExe({ browser = null, env = {}, ...rest } = {}) {
  if (browser) return browser;
  if (env.OUUUT_BROWSER) return env.OUUUT_BROWSER;
  const tried = browserExeCandidates(rest);
  const found = tried.find((p) => existsSync(p));
  if (found) return found;
  throw new Error(
    `找不到浏览器可执行文件。试过:\n${tried.map((p) => `  ${p}`).join("\n")}\n` +
      "用 --browser <path> 或 OUUUT_BROWSER 指定。",
  );
}

/** 从入口文件出发,**依次尝试**的 harness 入口(dist/src/<name>)。导出是为了让用例直接钉住顺序。 */
export function harnessEntryCandidates(name, { cliFileUrl = import.meta.url } = {}) {
  const dir = dirOf(cliFileUrl);
  return [
    // 发布布局:`<payload>/js/harness/package/ego-browser/dist/src/<name>`
    path.resolve(dir, "..", "..", "..", "js", "harness", "package", "ego-browser", "dist", "src", name),
    // 开发机:仓库里那个 vendored 包
    path.resolve(dir, "..", "..", "harness", "package", "ego-browser", "dist", "src", name),
  ];
}

/**
 * 找 harness 的入口文件(`index.js` / `run.js`)。
 *
 * @returns {string} 给 `import()` 用的 `file://` URL
 */
export function resolveHarnessEntry(name, { env = {}, ...rest } = {}) {
  const fromEnv = env.OUUUT_HARNESS_DIR;
  const candidates = [
    // 环境变量指向**包目录**(`.../ego-browser`)时,dist 与"直接给文件"两种写法都收
    ...(fromEnv ? [path.join(fromEnv, "dist", "src", name), path.join(fromEnv, name)] : []),
    ...harnessEntryCandidates(name, rest),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `找不到 harness 入口 ${name}。试过:\n${candidates.map((p) => `  ${p}`).join("\n")}\n` +
        "用 OUUUT_HARNESS_DIR=<ego-browser 包目录> 指定。",
    );
  }
  return pathToFileURL(found).href;
}
