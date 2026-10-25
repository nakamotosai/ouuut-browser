// native/bin/ouuut.mjs —— CLI 入口(对应上游 `ego-browser nodejs <script`)
//
// `docs/原生层接口.md` §一 的第一层就是它:**注入 `globalThis.<ns>`,然后把控制权交给 harness**。
//
// 用法(与上游同形):
//   ouuut nodejs <<'JS'
//   const task = await taskSpace("结账流程");
//   ...
//   JS
//
// ## 这里做的四件事
//
//   1. 按 `docs/补丁点位.md` §三 组装启动参数(**六项在启动参数里解决,不写内核补丁**)
//   2. 用 `--remote-debugging-pipe` 起浏览器(不暴露 TCP 调试端口,见 ADR-005)
//   3. 造运行时并装到 `globalThis.ouuut`
//   4. 调 harness 的 `runMain()` 跑 heredoc 脚本
//
// ## 收尾是认真的
//
// 退出前必须 `disposeEgoSdk()` + 关掉浏览器进程。**硬杀的浏览器会锁住 `chrome.dll`**
// (见 `docs/坑与解法.md` 坑-23:下一次构建会在链接阶段 `permission denied`,白烧一整轮)。
//
// ## 可测性
//
// `spawn` 是可注入的 —— 测试传假 CDP 对端进来,于是**除「真浏览器说不说这套协议」之外的
// 每一步都能验**。真浏览器那一步是 Chrome 的公开机制本身,不是我们的逻辑。

import { spawnCdpPipe } from "../binding/cdp-pipe.mjs";
import { createOuUutRuntime } from "../binding/ouuut-runtime.mjs";
import { createTaskSpaceRegistry } from "../binding/task-spaces.mjs";
import { openSessionProfiles } from "../binding/session-profiles.mjs";
import { parseArgs, buildBrowserArgs, USAGE } from "./launch-args.mjs";

/**
 * 起一次会话:装好 `globalThis.ouuut`,执行 `fn`,然后**无论成败都收尾**。
 *
 * @param {object} o
 * @param {(o: object) => Promise<T>} o.run
 * @param {Function} [o.spawn]        默认 `spawnCdpPipe`;测试可注入假对端
 * @param {string[]} [o.argv]         默认 `process.argv.slice(2)`
 * @returns {Promise<T>}
 */
export async function withRuntime({ run, spawn = spawnCdpPipe, argv = process.argv.slice(2), env = process.env } = {}) {
  const opts = parseArgs(argv);
  const { exe, args, userDataDir, ephemeralUserDataDir } = buildBrowserArgs(opts, env);

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
  const previous = globalThis.ouuut;
  globalThis.ouuut = runtime.api;

  let result;
  try {
    result = await run({
      api: runtime.api,
      registry,
      cdp,
      options: opts,
      /** 脚本跑完后要把 harness 的回调摘掉,交给它 */
      async disposeHarness() {
        try {
          const mod = await import(
            new URL("../../harness/package/ego-browser/dist/src/index.js", import.meta.url).href
          );
          if (typeof mod.disposeEgoSdk === "function") await mod.disposeEgoSdk();
        } catch {
          // harness 没构建 / 没这个导出:不影响收尾
        }
      },
    });
  } finally {
    // **收尾顺序**:先摘回调 → 再销毁 disposable 档案 → 还原 globalThis → 最后关进程。
    // 反过来的话,浏览器关掉后 harness 还可能在回调里发命令,会拿到一堆通道关闭错误;
    // 而档案的销毁**必须在关进程之前**(要往还活着的管道上发 `Target.disposeBrowserContext`)。
    try {
      await runtime.dispose?.();
    } finally {
      // **成败都要走**:disposable 用完即弃(ADR-007),异常退出也不能把它留在磁盘里。
      await session.dispose?.();
      if (previous === undefined) delete globalThis.ouuut;
      else globalThis.ouuut = previous;
      await cdp.close();
      // **用完即弃**:会话专用的临时档案目录不该留在磁盘上。
      // (2026-10-25 核验实测:每跑一次 CLI 就留一个,`%TEMP%` 里累计到 88 个 —— 与 ADR-007 里
      //  「disposable 用完即弃」的说法矛盾。)
      // 顺序:必须在 `cdp.close()` **之后** —— 浏览器还在跑时删它的档案目录是白删/半删。
      if (ephemeralUserDataDir) await removeSessionUserDataDir(userDataDir, opts.namespace);
    }
  }
  return result;
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

/**
 * 把 stdin 读干。**必须由我们读,不能让它自己去读** ——
 * 实测:直接 `runMain()` 让它读 `process.stdin` 会读到空,于是它打出自己的 USAGE 退出。
 * 自己读还有一个好处:可以在**起浏览器之前**就拿到脚本,便于校验与测试。
 */
export async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

/** CLI 主入口。`opts.runScript` 由调用方给(测试里可以换成直接跑函数)。 */
export async function cli({
  argv = process.argv.slice(2),
  spawn,
  runScript,
  stdout = process.stdout,
  env = process.env,
  stdin = process.stdin,
} = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    stdout.write(USAGE + "\n");
    return 0;
  }
  if (opts.error) {
    process.stderr.write(`[ouuut] ${opts.error}\n\n${USAGE}\n`);
    return 2;
  }
  // 脚本从 stdin 读(`ouuut nodejs < script`)。**在读之前不要起浏览器** ——
  // 免得因为脚本为空白起一次浏览器(而硬杀的浏览器会锁住 chrome.dll,见坑-23)。
  const stdinText = typeof runScript === "function" ? null : await readStdin(stdin);
  await withRuntime({
    argv,
    spawn,
    env,
    async run({ api, registry, options }) {
      if (typeof runScript === "function") return runScript({ api, registry, options });
      // 交给 harness 的 runMain,并把脚本**显式**传进去
      const mod = await import(
        new URL("../../harness/package/ego-browser/dist/src/run.js", import.meta.url).href
      );
      // 交给 harness 的 runMain,并把脚本**显式**传进去。
      // `argv` 给空数组:`ouuut` 自己的选项已经被 `parseArgs` 消费掉了,
      // 把 `["nodejs"]` 原样转给脚本只会让脚本看到无意义的参数。
      return mod.runMain({ argv: [], stdinText });
    },
  });
  return 0;
}

// 直接执行时跑 CLI
const isDirect = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  } catch {
    return false;
  }
})();

if (isDirect) {
  cli()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[ouuut] ${err?.stack ?? err}\n`);
      process.exit(1);
    });
}
