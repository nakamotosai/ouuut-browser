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
import { assertProxyUsable } from "../binding/proxy.mjs";
import { resolveHarnessEntry } from "../binding/paths.mjs";
import { openSession } from "../binding/session.mjs";
import { checkEgress, measureEgressIp } from "../binding/egress.mjs";
import { parseArgs, buildBrowserArgs, USAGE } from "./launch-args.mjs";

/**
 * 起一次会话:装好 `globalThis.<ns>`,执行 `run`,然后**无论成败都收尾**。
 *
 * 会话的起与收在 `binding/session.mjs` —— **三入口共用一份**(P5)。一份而不是三份,是因为
 * 收尾顺序(摘回调 → 销毁档案 → 还原全局 → 关进程 → 删临时目录)只有一种是对的,拷贝必然漂。
 *
 * ⚠️ 这里**不再**给 `run` 传 `disposeHarness`:那个钩子从加进来就没被调用过(harness 自己会摘
 * 它的回调,见 `ouuut-runtime.mjs` 里 `dispose()` 的注释),是死代码 —— 2026-10-25 随 P5 清掉。
 *
 * @param {object} o
 * @param {(o: object) => Promise<T>} o.run
 * @param {Function} [o.spawn]        默认 `spawnCdpPipe`;测试可注入假对端
 * @param {string[]} [o.argv]         默认 `process.argv.slice(2)`
 * @returns {Promise<T>}
 */
export async function withRuntime({ run, spawn = spawnCdpPipe, argv = process.argv.slice(2), env = process.env } = {}) {
  const opts = parseArgs(argv);
  const session = await openSession({ opts, env, spawn, buildArgs: (o) => buildBrowserArgs(o, env) });
  try {
    return await run({ api: session.api, registry: session.registry, cdp: session.cdp, options: opts });
  } finally {
    await session.close();
  }
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
