// native/serve/mcp.mjs —— 入口三:MCP stdio(P5 / F14)
//
// 协议:**JSON-RPC 2.0 + 换行分隔**(MCP 的 stdio 传输就是这么定的),不复用 HTTP 那套。
// 只实现真正要用的:`initialize` / `tools/list` / `tools/call` / `ping`,以及**通知**(没有 `id`,不回)。
//
// ⚠️ **stdout 是协议通道**:任何日志/警告都必须走 stderr。混一句进去,对面就报解析错,
//    而错误现象与你写的那句话毫无关系 —— 这类问题最难查。

import { ServeError } from "./errors.mjs";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "ouuut", version: "0.1.3" };

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
];

const text = (t) => ({ content: [{ type: "text", text: String(t) }] });

/** 一条 JSON-RPC 消息 → 一条响应(`null` 表示这是通知,不该回)。 */
export async function handleMcpMessage(core, msg) {
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
        if (name === "browser_goto") return reply(text(JSON.stringify(await core.goto(args.url, args))));
        if (name === "browser_snapshot") {
          const r = await core.snapshot(args ?? {});
          return reply(text(r.text));
        }
        if (name === "browser_tabs") return reply(text(JSON.stringify(await core.tabs())));
        if (name === "browser_version") return reply(text(JSON.stringify(await core.version())));
        return fail(-32602, `没有这个工具:${name}`);
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
 * @returns {Promise<number>} 退出码
 */
export async function runMcpServer({ core, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
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
      const res = await handleMcpMessage(core, msg);
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
