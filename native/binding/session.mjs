// native/binding/session.mjs —— **一次会话**的起与收(三入口共用)
//
// 为什么单独一个文件(P5):入口要有三个(CLI / HTTP+WS / MCP stdio),而"起一次会话"这件事
// 只有一种正确顺序(起浏览器 → 建档案 → 造运行时 → 装全局 → 用完按序收尾 → 删临时目录)。
// 三份拷贝必然漂,所以只留这一份,CLI 与两个服务端都调它。
//
// 收尾顺序**不是风格问题**(见 `docs/坑与解法.md` 与 ADR-007):
//   beforeClose(摘 harness 回调)→ runtime.dispose → session.dispose(销毁 disposable 档案)
//   → 还原 globalThis → cdp.close → 删本会话的临时档案目录(必须在关进程**之后**)
// 反过来的话:浏览器关了 harness 还在发命令(一堆通道关闭错误);或者档案还没销毁进程就没了,
// 那个 disposable 档案就留在磁盘上 —— 与 ADR-007「用完即弃」自相矛盾。

import { spawnCdpPipe } from "./cdp-pipe.mjs";
import { createTaskSpaceRegistry } from "./task-spaces.mjs";
import { openSessionProfiles } from "./session-profiles.mjs";
import { createOuUutRuntime } from "./ouuut-runtime.mjs";

/**
 * 起一次会话,返回**可驱动的句柄**。调用方负责调 `close()`(或用 `withSession`)。
 *
 * @param {object} o
 * @param {object} o.opts        `parseArgs()` 的结果(或等价对象)
 * @param {object} [o.env]       环境变量
 * @param {Function} [o.spawn]   默认 `spawnCdpPipe`;测试可注入假对端
 * @param {Function} [o.beforeClose] 收尾**第一步**(CLI 用它摘 harness 回调)
 * @param {boolean} [o.installGlobal] 是否把 api 装到 `globalThis.<namespace>`(CLI 需要,服务端不需要)
 * @param {{ exe: string, args: string[], userDataDir: string, ephemeralUserDataDir: boolean } } o.browser
 *        `buildBrowserArgs()` 的结果 —— 由调用方算好,免得本模块又去认一遍 CLI 参数
 * @returns {Promise<{api: object, registry: object, cdp: object, session: object, close: Function}>}
 */
export async function openSession({
  opts = {},
  env = process.env,
  spawn = spawnCdpPipe,
  beforeClose = null,
  installGlobal = true,
  browser,
} = {}) {
  if (!browser || !browser.exe || !Array.isArray(browser.args)) {
    throw new TypeError("openSession 需要 browser = buildBrowserArgs(opts, env) 的结果");
  }
  const { exe, args, userDataDir, ephemeralUserDataDir } = browser;

  const cdp = spawn({
    exe,
    args,
    name: opts.namespace,
    timeoutMs: opts.timeoutMs,
    env: opts.extraEnv ? { ...env, ...opts.extraEnv } : env,
  });

  // 档案是**会话级**的:浏览器起来了才建得了 browser context(`persona`/`disposable`),
  // 所以这一步必须在 `spawn` 之后 —— 也是 `--profile-kind` 真正落到浏览器侧的唯一时刻。
  // 建档案失败时浏览器已经起了,不能就这么扔下 —— 先关掉它再抛(不留孤儿进程)。
  let session;
  try {
    session = await openSessionProfiles({
      cdp,
      kind: opts.profileKind,
      userDataDir: opts.userDataDir,
      // 出口绑在**会话档案**上(F13):只有 persona/disposable 会由 `createBrowserContext` 带 `proxyServer`。
      // ⚠️ `real` **不能**传进来 —— 它用默认 context,挂不了 context 级代理,而它的出口已经由
      // 浏览器级 `--proxy-server` 承担(见 launch-args 的按 kind 分流);传进来只会被档案层抛死,
      // 于是出现"参数合法、会话起不来"的自相矛盾(2026-10-25 核验指出的 F3)。
      proxy: opts.profileKind === "persona" || opts.profileKind === "disposable" ? opts.proxy : null,
    });
  } catch (err) {
    await cdp.close();
    throw err;
  }

  const registry = createTaskSpaceRegistry();
  const runtime = createOuUutRuntime({
    cdp,
    registry,
    namespace: opts.namespace,
    archive: session.archive,
    profiles: session.profiles,
    sessionProfileId: session.sessionProfileId,
  });
  // ⚠️ 随包的 harness **硬编码**读 `globalThis.ouuut`(`dist/src/helpers.js`),它不认识别的名字。
  // 所以 `--namespace foo` 不能只装 `foo`:那样脚本里 `taskSpace()` 会拿到 harness 自己的替补,
  // 报一句 `listTaskSpaces requires ego.listTaskSpaces`(2026-10-25 实测),而错误信息完全指不到自定义命名空间。
  // ⇒ **两个名字都装**:`ouuut` 是给 harness 的,`<namespace>` 是给脚本的。
  const globalNames = installGlobal ? [...new Set([opts.namespace ?? "ouuut", "ouuut"])] : [];
  const previous = new Map(globalNames.map((n) => [n, globalThis[n]]));
  for (const n of globalNames) globalThis[n] = runtime.api;

  let closed = false;
  const close = async () => {
    if (closed) return true;
    closed = true;
    try {
      if (typeof beforeClose === "function") await beforeClose();
    } finally {
      try {
        await runtime.dispose?.();
      } finally {
        // **成败都要走**:disposable 用完即弃(ADR-007),异常退出也不能把它留在磁盘里。
        await session.dispose?.();
        for (const n of globalNames) {
          const before = previous.get(n);
          if (before === undefined) delete globalThis[n];
          else globalThis[n] = before;
        }
        await cdp.close();
        // **用完即弃**:会话专用的临时档案目录不该留在磁盘上。
        // 顺序:必须在 `cdp.close()` **之后** —— 浏览器还在跑时删它的档案目录是白删/半删。
        if (ephemeralUserDataDir) await removeSessionUserDataDir(userDataDir, opts.namespace);
      }
    }
    return true;
  };

  return { api: runtime.api, registry, cdp, session, close };
}

/** `openSession()` 的 try/finally 形式 —— 想要"跑一段就用完收掉"时用这个。 */
export async function withSession(args, fn) {
  const s = await openSession(args);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

/**
 * 删掉**本会话专用的**临时档案目录。
 *
 * **尽力而为,而且只报不抛**:浏览器刚退出时它的孙子进程可能还占着文件(坑-27),
 * 为了一次清理失败把一场正常会话判成失败,不值得。
 *
 * ⚠️ 已知后果(2026-10-25 核验实测):**可能只删成"空壳"** —— 能删的文件删掉、
 * 被占住的那个子目录留下(`EBUSY`)。所以失败消息里明说这一点,别让人以为目录一定干净了。
 * ⚠️ 调用方显式给的档案目录**绝不删** —— 那是使用者的身份,由 `ephemeralUserDataDir` 把关。
 */
export async function removeSessionUserDataDir(dir, namespace = "ouuut") {
  const { rm } = await import("node:fs/promises");
  // 两次尝试、每次只留一点余量:失败路径**不该拖慢收尾**。
  // (第一版 3 次 × 内建重试给失败路径加了约 6 秒 —— 核验实测 6219 ms。)
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      return true;
    } catch (err) {
      if (attempt === 2) {
        process.stderr.write(
          `[${namespace}] 会话临时档案目录没清干净(${dir}):${err?.message ?? err}\n` +
            `  可能有孙子进程还占着文件(坑-27);目录可能只删成空壳,不影响本次会话\n`,
        );
        return false;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}
