// native/serve/boot.mjs —— 两个服务端入口共用的"起法"(P5)
//
// CLI 那条路是 `withRuntime()`:起会话 → 跑脚本 → 收尾。服务端不是"跑一段脚本"就完,而是
// **长期持有**一个会话,所以起法单独一份:分流参数 → 起会话 → **装 harness SDK** → 出口一致性闸 → 造 core。
//
// 出口一致性闸**三个入口都要有** —— 否则"用 MCP 起会话"就成了绕过它的后门。

import { buildBrowserArgs, parseArgs } from "../bin/launch-args.mjs";
import { checkEgress, measureEgressIp } from "../binding/egress.mjs";
import { resolveHarnessEntry } from "../binding/paths.mjs";
import { openSession } from "../binding/session.mjs";
import { splitServerArgs } from "./args.mjs";
import { createServeCore } from "./core.mjs";
import { ServeError } from "./errors.mjs";

/** 服务端用的任务空间名(CLI 那条路由脚本自己起名,所以只比"快照正文")。 */
export const SERVE_SPACE_NAME = "serve";

/**
 * @returns {Promise<{server: object, opts: object, session: object, core: object, namespace: string}>}
 */
export async function bootServeCore({ argv = [], env = process.env, spawn } = {}) {
  const { server, rest } = splitServerArgs(argv);
  const opts = parseArgs(rest);
  if (opts.help) throw new ServeError("服务器入口没有 --help;浏览器参数见 `ouuut --help`", "OUUUT_SERVE_HELP");
  if (opts.error) throw new ServeError(opts.error, "OUUUT_SERVE_BAD_ARGS");

  // harness 的 helpers **硬编码**读 `globalThis.ouuut`(`dist/src/helpers.js`),
  // 所以服务端不能改注入名 —— 改了就会出现"参数合法、SDK 找不到 api"的自相矛盾。
  const namespace = opts.namespace ?? "ouuut";
  if (namespace !== "ouuut") {
    throw new ServeError(
      `服务端不支持 --namespace ${namespace}:随包的 harness 只认 globalThis.ouuut(它的 helpers 里写死了)。`,
      "OUUUT_SERVE_BAD_ARGS",
    );
  }

  const session = await openSession({
    opts: { ...opts, namespace },
    env,
    spawn,
    installGlobal: true, // harness 的 SDK 要能从 globalThis 拿到我们的 api
    browser: buildBrowserArgs(opts, env),
  });

  try {
    const harnessMod = await import(resolveHarnessEntry("index.js", { env }));
    if (typeof harnessMod.installEgoSdk !== "function") {
      throw new ServeError("harness 里没有 installEgoSdk,装不了它的页面模型", "OUUUT_SERVE_NO_HARNESS");
    }
    harnessMod.installEgoSdk(globalThis, {});

    if (opts.identityCountry || opts.egressCountry) {
      const measuredIp = await measureEgressIp(session.api);
      const verdict = checkEgress({
        measuredIp,
        identityCountry: opts.identityCountry,
        declaredEgressCountry: opts.egressCountry,
        allowMismatch: Boolean(opts.allowEgressMismatch),
      });
      for (const note of verdict.notes) process.stderr.write(`[ouuut-serve] 出口核对:${note}\n`);
    }

    const core = createServeCore({
      harness: { taskSpace: globalThis.taskSpace, getBrowserVersion: globalThis.getBrowserVersion },
      api: session.api,
      spaceName: SERVE_SPACE_NAME,
    });
    return { server, opts, session, core, namespace };
  } catch (err) {
    await session.close();
    throw err;
  }
}
