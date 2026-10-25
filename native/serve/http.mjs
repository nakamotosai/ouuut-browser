// native/serve/http.mjs —— 入口二:HTTP + WebSocket(P5 / F14)
//
// ## 两个安全决定(不是可选项)
//
//   1. **默认只听 `127.0.0.1`**。这个服务驱动的是**带身份的真浏览器**(档案、代理、cookie 都在里面),
//      把它挂到 `0.0.0.0` 等于把使用者的身份借给同网段的所有人。要给外面用得显式改 `--host`。
//   2. **必须有令牌**,没给就**自己生成一个并打出来**。localhost 上任何本地进程都能连,
//      而"任何本地进程"包括一堆来路不明的脚本 —— 令牌是唯一的分界线。
//      `--no-auth` 只在**同时**是 loopback 时才允许,并且会打一行显眼的警告。
//
// ## 为什么不引框架/依赖
//
// `node:http` 足够;WebSocket 也自己实现(握手 + 文本帧),因为**零依赖**是这个包的卖点之一
// (见 ADR-017:随包发的 JS 里只有 `acorn` 一个第三方)。

import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { ServeAuthError, ServeError } from "./errors.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY = 1 << 20; // 1 MiB:请求体是 url/参数,不可能这么大

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ServeError("请求体太大", "OUUUT_SERVE_BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(body) });
  res.end(body);
};

/** 恒定时间比较,别让"令牌对不对"从耗时上看得出来。 */
function tokenMatches(given, want) {
  if (typeof given !== "string" || typeof want !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(req, url, token) {
  const header = req.headers?.authorization ?? "";
  const bearer = /^Bearer (.+)$/i.exec(String(header))?.[1] ?? null;
  const given = bearer ?? url.searchParams.get("token");
  if (!tokenMatches(given, token)) throw new ServeAuthError();
}

/** 一次请求 → 一个操作。HTTP 与 WS 都走这里(所以两条传输的行为不会漂)。 */
export async function dispatchHttp(core, method, pathname, { query = new URLSearchParams(), body = null } = {}) {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (method === "GET" && p === "/health") return { status: 200, result: { ok: true, name: "ouuut", pid: process.pid } };
  if (method === "GET" && p === "/version") return { status: 200, result: await core.version() };
  if (method === "GET" && p === "/tabs") return { status: 200, result: await core.tabs() };
  if (method === "POST" && p === "/goto") {
    const url = body?.url;
    const r = await core.goto(url, { timeoutMs: body?.timeoutMs });
    return { status: 200, result: r };
  }
  if (method === "GET" && p === "/snapshot") {
    const maxRaw = query.get("maxResultLength");
    const r = await core.snapshot(maxRaw === null ? {} : { maxResultLength: Number(maxRaw) });
    return { status: 200, result: r };
  }
  if (method === "POST" && p === "/snapshot") {
    const r = await core.snapshot(body ?? {});
    return { status: 200, result: r };
  }
  throw new ServeError(`没有这条路由:${method} ${p}`, "OUUUT_SERVE_NO_ROUTE");
}

// ---- WebSocket(最小实现:握手 + 文本帧 + close/ping)------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsAccept = (key) => createHash("sha1").update(key + WS_GUID).digest("base64");

/** 收帧。返回 `{frames, rest}`:`frames` 是拿到的完整**文本**帧(已解掩码)。 */
export function decodeWsFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cur = off + 2;
    if (len === 126) {
      if (cur + 2 > buf.length) break;
      len = buf.readUInt16BE(cur);
      cur += 2;
    } else if (len === 127) {
      if (cur + 8 > buf.length) break;
      const big = buf.readBigUInt64BE(cur);
      if (big > BigInt(MAX_BODY)) throw new ServeError("WS 帧太大", "OUUUT_SERVE_BODY_TOO_LARGE");
      len = Number(big);
      cur += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (cur + maskLen + len > buf.length) break; // 还没收全,等下一片
    const mask = masked ? buf.subarray(cur, cur + 4) : null;
    cur += maskLen;
    const payload = Buffer.from(buf.subarray(cur, cur + len));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    cur += len;
    off = cur;
    frames.push({ fin, opcode, text: payload.toString("utf8") });
  }
  return { frames, rest: buf.subarray(off) };
}

/** 编一个**服务端→客户端**的文本帧(服务端不掩码,见 RFC6455 §5.1)。 */
export function encodeWsText(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
}

/**
 * 起服务。
 *
 * @param {object} o
 * @param {object} o.core         `createServeCore()` 的返回值
 * @param {string} [o.host]       默认 `127.0.0.1`(改动等于把身份借出去)
 * @param {number} [o.port]       默认 0 = 让系统给一个空闲端口
 * @param {string} [o.token]      默认生成一个(会通过返回值给出,由入口打印)
 * @param {Function} [o.onClose]  收到 `/close` 时调用(入口用它收掉会话)
 * @returns {Promise<{host: string, port: number, url: string, token: string, close: Function}>}
 */
export async function startHttpServer({ core, host = "127.0.0.1", port = 0, token, onClose = null } = {}) {
  if (!core) throw new ServeError("startHttpServer 需要 core");
  const useToken = token ?? randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      authorize(req, url, useToken);
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : null;
      const { status, result } = await dispatchHttp(core, req.method ?? "GET", url.pathname, {
        query: url.searchParams,
        body,
      });
      json(res, status, result);
      if (url.pathname.replace(/\/+$/, "") === "/close") {
        res.on("finish", () => void Promise.resolve(onClose?.()).finally(() => server.close()));
      }
    } catch (err) {
      if (err instanceof ServeAuthError) return json(res, 401, { error: err.error_code, message: err.message });
      const code = err?.error_code ?? "OUUUT_SERVE_ERROR";
      const status = code === "OUUUT_SERVE_NO_ROUTE" ? 404 : code === "OUUUT_SERVE_BAD_ARGS" ? 400 : 500;
      json(res, status, { error: code, message: String(err?.message ?? err) });
    }
  });

  // ---- WebSocket:同一条 core,只是换传输 ----
  // ⚠️ **升级过的 socket 要自己记账**:Node 的 `server.close()` 不跟踪它们,
  //    `closeAllConnections()` 也**不会**碰它们 —— 结果是"关服务"永远等不到回调(2026-10-25 实测:
  //    关服务卡死、进程不退出)。所以升级成功后收进集合,关服务时逐个 destroy。
  const upgraded = new Set();
  server.on("upgrade", (req, socket) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      authorize(req, url, useToken);
      const key = req.headers["sec-websocket-key"];
      if (!key) throw new ServeError("WS 握手缺 Sec-WebSocket-Key", "OUUUT_SERVE_BAD_WS_HANDSHAKE");
      upgraded.add(socket);
      socket.on("close", () => upgraded.delete(socket));
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${wsAccept(String(key))}\r\n\r\n`,
      );
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let decoded;
        try {
          decoded = decodeWsFrames(buf);
        } catch (err) {
          socket.destroy();
          return;
        }
        buf = decoded.rest;
        for (const f of decoded.frames) {
          if (f.opcode === 0x8) return socket.end();
          if (f.opcode === 0x9) {
            socket.write(Buffer.from([0x8a, 0x00])); // pong
            continue;
          }
          if (f.opcode !== 0x1) continue; // 只收文本帧(二进制帧留给以后)
          void (async () => {
            let id = null;
            try {
              const msg = JSON.parse(f.text);
              id = msg?.id ?? null;
              const { result } = await dispatchHttp(core, String(msg?.op ?? "").toUpperCase(), msg?.path ?? "/", {
                query: new URLSearchParams(msg?.query ?? {}),
                body: msg?.body ?? null,
              });
              socket.write(encodeWsText(JSON.stringify({ id, ok: true, result })));
            } catch (err) {
              socket.write(
                encodeWsText(
                  JSON.stringify({ id, ok: false, error: err?.error_code ?? "OUUUT_SERVE_ERROR", message: String(err?.message ?? err) }),
                ),
              );
            }
          })();
        }
      });
      socket.on("error", () => socket.destroy());
    } catch (err) {
      socket.write(`HTTP/1.1 ${err instanceof ServeAuthError ? 401 : 400} Bad Request\r\n\r\n`);
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  return {
    host: addr.address,
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    token: useToken,
    // ⚠️ **别只调 `server.close()`**:它要等所有连接自己结束,而 HTTP keep-alive 会让客户端
    // (包括 `fetch`) 一直占着连接 —— 于是"关服务"变成"等 keep-alive 超时"。
    // 先 close 再 closeAllConnections 才是"现在关掉"。
    close: () =>
      new Promise((resolve) => {
        for (const ws of upgraded) ws.destroy();
        upgraded.clear();
        server.close(() => resolve(true));
        server.closeAllConnections?.();
      }),
  };
}
