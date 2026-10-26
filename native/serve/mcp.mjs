// native/serve/mcp.mjs —— 入口三:MCP stdio(P5 / F14)
//
// 协议:**JSON-RPC 2.0 + 换行分隔**(MCP 的 stdio 传输就是这么定的),不复用 HTTP 那套。
// 只实现真正要用的:`initialize` / `tools/list` / `tools/call` / `ping`,以及**通知**(没有 `id`,不回)。
//
// ⚠️ **stdout 是协议通道**:任何日志/警告都必须走 stderr。混一句进去,对面就报解析错,
//    而错误现象与你写的那句话毫无关系 —— 这类问题最难查。

import { BATCH_OPS, runBatch } from "./batch.mjs";
import { WAIT_LOAD_STATES, WAIT_SELECTOR_STATES } from "./core.mjs";
import { ServeError } from "./errors.mjs";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "ouuut", version: "0.1.4" };

/**
 * 工具表。**形状要薄**:每个工具就是 `core` 上一个操作,别在这里塞业务逻辑。
 * `inputSchema` 用最小 JSON Schema(`type: object` + `required`)。
 */
export const MCP_TOOLS = [
  {
    name: "browser_goto",
    description: "打开一个 URL,返回它的 targetId。后续操作都按这个 id 指代该页面。",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "browser_snapshot",
    description: "对当前页面拍快照(化简后的可读文本 + 可点击 ref)。",
    inputSchema: { type: "object", properties: { maxResultLength: { type: "number" } } },
  },
  {
    name: "browser_tabs",
    description: "列出当前打开的页面。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_version",
    description: "浏览器版本(最便宜的一次存活探针)。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_batch",
    description:
      "按顺序执行一组步骤(goto / snapshot / tabs / version / wait),返回每一步的结果;" +
      "默认遇到第一个错误就停(stoppedAt 指到那一步),continueOnError:true 则继续跑完。",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "有序步骤;每步一个 op,加上该 op 自己的参数",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: [...BATCH_OPS] },
              url: { type: "string", description: "goto 的目标" },
              timeoutMs: { type: "number", description: "goto / wait 的超时(毫秒)" },
              maxResultLength: { type: "number", description: "snapshot 的截断长度" },
              selector: { type: "string", description: "wait:等选择器出现/可见" },
              state: { type: "string", enum: [...WAIT_SELECTOR_STATES], description: "wait:选择器状态(默认 visible)" },
              text: { type: "string", description: "wait:等页面可见文本包含它" },
              loadState: { type: "string", enum: [...WAIT_LOAD_STATES], description: "wait:等加载状态" },
            },
            required: ["op"],
          },
        },
        continueOnError: { type: "boolean", description: "true = 某步失败后继续执行后面的步骤" },
      },
      required: ["steps"],
    },
  },
  {
    name: "browser_wait",
    description:
      "等页面进入某种状态:加载状态(loadState)/ CSS 选择器(selector,可带 state)/ 可见文本(text);" +
      "三者只能给一个,都不给等于等 load。走 harness 的页面等待 API,不轮询快照。",
    inputSchema: {
      type: "object",
      properties: {
        loadState: { type: "string", enum: [...WAIT_LOAD_STATES] },
        selector: { type: "string" },
        state: { type: "string", enum: [...WAIT_SELECTOR_STATES], description: "只对 selector 有意义(默认 visible)" },
        text: { type: "string" },
        timeoutMs: { type: "number", description: "默认 30000" },
      },
    },
  },
  {
    name: "browser_profile",
    description:
      "当前档案(profileId / kind)+ 本次会话可见的档案列表;档案引擎不可达时如实标 archiveReachable:false。" +
      "经 MCP 建/关档案未开放(capabilities.create/close 恒为 false)。",
    inputSchema: { type: "object", properties: {} },
  },
];

const text = (t) => ({ content: [{ type: "text", text: String(t) }] });

/**
 * 工具名 → 处理函数。**这里只做"调 core + 包成 MCP 结果"**,不放业务逻辑
 * (batch 的编排在 `batch.mjs`,等待语义在 `core.wait`)。
 */
const TOOL_HANDLERS = {
  browser_goto: async (core, args) => text(JSON.stringify(await core.goto(args.url, args))),
  browser_snapshot: async (core, args) => text((await core.snapshot(args ?? {})).text),
  browser_tabs: async (core) => text(JSON.stringify(await core.tabs())),
  browser_version: async (core) => text(JSON.stringify(await core.version())),
  browser_wait: async (core, args) => text(JSON.stringify(await core.wait(args ?? {}))),
  browser_batch: async (core, args) => {
    const r = await runBatch(core, args?.steps, { continueOnError: Boolean(args?.continueOnError) });
    const out = text(JSON.stringify(r));
    // 有步骤失败 = 这次工具调用**没有完全成功**;per-step 结果仍然在 content 里。
    if (!r.ok) out.isError = true;
    return out;
  },
  browser_profile: async (core) => text(JSON.stringify(await core.profile())),
};

/** 一条 JSON-RPC 消息 → 一条响应(`null` 表示这是通知,不该回)。 */
export async function handleMcpMessage(core, msg, { recorder = null } = {}) {
  if (!msg || typeof msg !== "object") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "不是 JSON-RPC 消息" } };
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null; // 通知:不回
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: MCP_TOOLS });
      case "tools/call": {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        const handler = Object.hasOwn(TOOL_HANDLERS, name) ? TOOL_HANDLERS[name] : null;
        if (!handler) return fail(-32602, `没有这个工具:${name}`);
        const startedAt = Date.now();
        try {
          const result = await handler(core, args);
          // 轨迹是**旁路**:记录器自己保证不抛(写不进去最多在 stderr 说一句)。
          await recorder?.recordToolCall({
            tool: name,
            args,
            ok: result?.isError !== true,
            result,
            durationMs: Date.now() - startedAt,
          });
          return reply(result);
        } catch (err) {
          await recorder?.recordToolCall({
            tool: name,
            args,
            ok: false,
            error: err,
            durationMs: Date.now() - startedAt,
          });
          throw err;
        }
      }
      default:
        return fail(-32601, `不认识的方法:${msg.method}`);
    }
  } catch (err) {
    // 工具**执行**失败按 MCP 的约定放在 result 里(`isError`),协议错误才用 `error` ——
    // 否则对面把"页面打不开"当成"服务器坏了"。
    if (msg.method === "tools/call") {
      return reply({ content: [{ type: "text", text: String(err?.message ?? err) }], isError: true });
    }
    const code = err instanceof ServeError ? -32000 : -32603;
    return fail(code, String(err?.message ?? err));
  }
}

/**
 * 跑 stdio 循环。
 *
 * @param {object} o
 * @param {object} o.core
 * @param {NodeJS.ReadableStream} [o.stdin]
 * @param {NodeJS.WritableStream} [o.stdout]
 * @param {NodeJS.WritableStream} [o.stderr] 日志走这里(**绝不走 stdout**)
 * @param {object} [o.recorder] 轨迹记录器(`trajectory.mjs`);不给就不记
 * @returns {Promise<number>} 退出码
 */
export async function runMcpServer({ core, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, recorder = null } = {}) {
  if (!core) throw new ServeError("runMcpServer 需要 core");
  let buf = "";
  let pending = Promise.resolve();
  const write = (obj) => stdout.write(JSON.stringify(obj) + "\n");

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    // **串行处理**:同一个浏览器上并发跑命令的语义没定,先按到达顺序排队(顺序是确定的)。
    // ⚠️ **解析失败也必须进这条队列** —— 第一版把 JSON.parse 放在队列外、错误立刻同步写出,
    //    于是坏行会**插到**前面那条请求的响应之前(响应顺序 ≠ 到达顺序)。顺序本身是协议的一部分,
    //    这种写法以后一定会咬人(2026-10-25 写用例时抓到)。
    pending = pending.then(async () => {
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
        return;
      }
      const res = await handleMcpMessage(core, msg, { recorder });
      if (res !== null) write(res);
    });
  };

  await new Promise((resolve, reject) => {
    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
    stdin.on("end", resolve);
    stdin.on("error", reject);
  });
  if (buf.trim() !== "") handleLine(buf); // 最后一行没有换行也要处理
  await pending;
  return 0;
}
