// native/serve/batch.mjs —— `browser_batch` 的编排(薄薄一层,不含任何浏览器逻辑)
//
// 为什么放在服务层而不是 core:batch 不是"浏览器能做的第 5 件事",而是**已有操作的顺序组合**。
// 它只调 `core.goto/snapshot/tabs/version/wait` —— 新操作要进 core,batch 永远只是编排。
//
// 语义(与 MCP 工具描述逐字对应):
//   * 按数组顺序执行;
//   * **遇到第一个错误就停**(`stoppedAt` = 那一步的 index),除非 `continueOnError: true`;
//   * 每步都有一条结果(成功带 result,失败带 error),**失败的那步也返回** ——
//     否则调用方只能看到"batch 失败了",看不到"第几步、为什么"。

import { ServeError } from "./errors.mjs";

/** 允许的步骤。**逐个列出**而不是"core 上有什么就调什么" —— 白名单是这里的安全边界。 */
export const BATCH_OPS = Object.freeze(["goto", "snapshot", "tabs", "version", "wait"]);

const BAD_ARGS = "OUUUT_SERVE_BAD_ARGS";

async function runStep(core, step) {
  switch (step.op) {
    case "goto":
      return core.goto(step.url, step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs });
    case "snapshot":
      return core.snapshot(step.maxResultLength === undefined ? {} : { maxResultLength: step.maxResultLength });
    case "tabs":
      return core.tabs();
    case "version":
      return core.version();
    case "wait":
      return core.wait(step);
    default:
      // 上面的白名单已经拦过,这里只是"穷尽 switch"的兜底。
      throw new ServeError(`不认识的步骤:${JSON.stringify(step.op)}`, BAD_ARGS);
  }
}

/**
 * @param {object} core            `createServeCore()` 的返回值(或同形状的假对象)
 * @param {Array<object>} steps    有序步骤,每步 `{op, ...该 op 的参数}`
 * @param {{continueOnError?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, continueOnError: boolean, stoppedAt: number|null, steps: Array<object>}>}
 */
export async function runBatch(core, steps, { continueOnError = false } = {}) {
  if (!core || typeof core.goto !== "function") {
    throw new ServeError("runBatch 需要 core", "OUUUT_SERVE_ERROR");
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ServeError("browser_batch 需要非空的 steps 数组", BAD_ARGS);
  }

  const results = [];
  let stoppedAt = null;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const op = typeof step?.op === "string" ? step.op : null;
    const startedAt = Date.now();
    try {
      if (!op) throw new ServeError(`第 ${index} 步缺 op`, BAD_ARGS);
      if (!BATCH_OPS.includes(op)) {
        throw new ServeError(
          `第 ${index} 步的 op=${JSON.stringify(op)} 不认识;只允许 ${BATCH_OPS.join(" / ")}`,
          BAD_ARGS,
        );
      }
      const result = await runStep(core, step);
      results.push({ index, op, ok: true, durationMs: Date.now() - startedAt, result });
    } catch (err) {
      results.push({
        index,
        op,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: { message: String(err?.message ?? err), code: err?.error_code ?? null },
      });
      if (!continueOnError) {
        stoppedAt = index;
        break;
      }
    }
  }

  return {
    ok: results.every((r) => r.ok),
    continueOnError: Boolean(continueOnError),
    stoppedAt,
    steps: results,
  };
}
