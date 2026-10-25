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
import { readFile } from "node:fs/promises";
import { createOuUutRuntime } from "../binding/ouuut-runtime.mjs";
import { createTaskSpaceRegistry } from "../binding/task-spaces.mjs";
import { openSessionProfiles } from "../binding/session-profiles.mjs";
import { assertProxyUsable } from "../binding/proxy.mjs";
import { resolveHarnessEntry } from "../binding/paths.mjs";
import { checkEgress, measureEgressIp } from "../binding/egress.mjs";
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
      // 出口绑在**会话档案**上(F13):只有 persona/disposable 会由 `createBrowserContext` 带 `proxyServer`。
      // ⚠️ `real` **不能**传进来 —— 它用默认 context,挂不了 context 级代理,而它的出口已经由
      // 浏览器级 `--proxy-server` 承担(见 launch-args 的按 kind 分流);传进来只会被档案层抛死,
      // 于是出现"参数合法、会话起不来"的自相矛盾(2026-10-25 核验指出的 F3)。
      proxy:
        opts.profileKind === "persona" || opts.profileKind === "disposable" ? opts.proxy : null,
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
          const mod = await import(resolveHarnessEntry("index.js", { env }));
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
  // 代理在**起浏览器之前**校验:形状非法与带凭据都要在这里就被挡住 ——
  // 此前浏览器级这条路什么都不校验,非法串/带凭据串都能照常起会话,直到导航时才以网络错暴露
  // (2026-10-25 实测);而带凭据的串 Chromium **两条路都不收**(坑-41),留着只会让用户困惑。
  if (opts.proxy) {
    try {
      assertProxyUsable(opts.proxy);
    } catch (err) {
      process.stderr.write(`[ouuut] ${err?.message ?? err}\n`);
      return 2;
    }
  }
  // 脚本从 stdin 读(`ouuut nodejs < script`)。**在读之前不要起浏览器** ——
  // 免得因为脚本为空白起一次浏览器(而硬杀的浏览器会锁住 chrome.dll,见坑-23)。
  //
  // `--script <path>` 时改从**文件**读,并且**完全不碰 stdin** ——
  // 程序化调用方要自己支配 stdin(`probe/targets/ouuut.py` 给的是 DEVNULL + 文件型协议),
  let stdinText = null;
  if (typeof runScript !== "function") {
    if (opts.script) {
      // 读不到就**就地失败**:给一句人话 + 非零码,而不是把 ENOENT 堆栈甩给调用方
      // (核验实测过:此前是一条 `Error: ENOENT … at async cli`,虽然也可读,但不是我们的风格)
      try {
        stdinText = await readFile(opts.script, "utf8");
      } catch (err) {
        process.stderr.write(
          `[ouuut] 读不到 --script 指向的脚本(${opts.script}):${err?.message ?? err}\n`,
        );
        return 2;
      }
    } else {
      stdinText = await readStdin(stdin);
    }
  }

  // **空白脚本就地拒绝**。上面那句注释本来就是这个意思,但此前只是"说了"没"做":
  // 核验实测空文件会 rc=0 起一次浏览器、然后由 harness 打出它自己的 USAGE(2026-10-25)。
  if (typeof runScript !== "function" && (!stdinText || stdinText.trim() === "")) {
    process.stderr.write(
      opts.script
        ? `[ouuut] --script 指向的文件是空的(${opts.script});没有可执行的脚本\n`
        : "[ouuut] 没有从 stdin 读到脚本\n",
    );
    return 2;
  }
  const code = await withRuntime({
    argv,
    spawn,
    env,
    async run({ api, registry, options }) {
      if (typeof runScript === "function") return runScript({ api, registry, options });

      // ---- 出口一致性闸(F6 / P4):**在脚本跑之前** ----
      // 为什么在这里而不是起浏览器之前:量出口要过一个真实的网络出口(我们只有浏览器这条现成通道),
      // 而"拒绝启动"的效果一样 —— 脚本一行都还没跑,目标站一次都没碰。
      if (opts.identityCountry || opts.egressCountry) {
        let measuredIp;
        try {
          measuredIp = await measureEgressIp(api);
        } catch (err) {
          // 量不到就**不许当成"验过了"**(否则这道闸会静默失效)——但也不拒:可能是网络/端点的问题,
          // 那属于另一类故障,不该冒充身份不一致。
          process.stderr.write(
            `[ouuut] 出口核对未完成(${err?.error_code ?? "?"}):${err?.message ?? err}\n` +
              "        这一趟**没验过出口**;要严格禁止这种情况,请修好出口端点后重试。\n",
          );
          return 2;
        }
        let verdict;
        try {
          verdict = checkEgress({
            measuredIp,
            identityCountry: opts.identityCountry,
            declaredEgressCountry: opts.egressCountry,
            allowMismatch: Boolean(opts.allowEgressMismatch),
          });
        } catch (err) {
          process.stderr.write(`[ouuut] ${err?.message ?? err}\n`);
          return 2;
        }
        for (const note of verdict.notes) process.stderr.write(`[ouuut] 出口核对:${note}\n`);
      }

      // 交给 harness 的 runMain,并把脚本**显式**传进去
      const mod = await import(resolveHarnessEntry("run.js", { env }));
      // 交给 harness 的 runMain,并把脚本**显式**传进去。
      // `argv` 给空数组:`ouuut` 自己的选项已经被 `parseArgs` 消费掉了,
      // 把 `["nodejs"]` 原样转给脚本只会让脚本看到无意义的参数。
      return mod.runMain({ argv: [], stdinText });
    },
  });
  // **把退出码传出去**。此前这里写死 `return 0`,于是 harness 那条 `runMain` 的返回码(它对空脚本
  // 与非法 argv 都会 `return 2`)被丢掉 —— 核验实测过一次:空脚本会 rc=0、只留一句 harness 的 USAGE。
  // 现在那两条路已被上面的前置守卫挡住(不可达),但这个洞没必要留着:
  // 将来一旦把 `argv` 透传下去,它就会复发。
  // 只透传**数字**(测试里 `runScript` 可以返回任意值,不该被当成退出码)。
  return typeof code === "number" ? code : 0;
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
