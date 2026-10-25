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

  // ⚠️ 服务端**不做**多档案:它要先起服务、再按请求开页,而 harness 建空间要求"恰好一个标签页";
  // 预建多个空间还会把它的快照目标带偏(实测 `Page changed during snapshot`)。
  // 与其做成半可用,不如明说:双档案双出口请走 CLI / 脚本那条路(已实测,见 tools/verify-dual-profile.mjs)。
  if (Array.isArray(opts.extraProfiles) && opts.extraProfiles.length > 0) {
    throw new ServeError(
      "服务端目前只服务**一个**档案:harness 的任务空间要求「建空间时恰好一个标签页」," +
        "按请求开页这条路做不到;预建多个空间又会把快照目标带偏。要双档案双出口请用 CLI:" +
        "`node native/bin/ouuut.mjs nodejs --profiles '<json>' --script <脚本>`(见 docs/坑与解法.md 坑-47)。",
      "OUUUT_SERVE_NO_MULTI_PROFILE",
    );
  }

  const session = await openSession({
    opts: { ...opts, namespace },
    env,
    spawn,
    installGlobal: true, // harness 的 SDK 要能从 globalThis 拿到我们的 api
    buildArgs: (o) => buildBrowserArgs(o, env),
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
      // 档案层是**会话级**的:会话给了 kind 才有 archive(否则只有硬编码的默认档案)。
      // 这里原样交出去,`core.profile()` 才能如实回答"当前档案是谁、引擎可不可达"。
      profile: {
        sessionProfileId: session.session?.sessionProfileId ?? null,
        profiles: session.session?.profiles ?? null,
        archive: session.session?.archive ?? null,
      },
    });

    return { server, opts, session, core, namespace };
  } catch (err) {
    await session.close();
    throw err;
  }
}
