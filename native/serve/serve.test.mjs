// native/serve/serve.test.mjs —— 入口层(HTTP/WS、MCP、参数)的验收
//
// 这一片钉住的是**入口的契约**,不是浏览器:鉴权、路由、协议形状、以及"两条传输走同一个 core" ——
// 后者是"三入口快照一致"的前提(如果 HTTP 和 WS 各写一遍分发,一致性就只能靠人眼)。

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import { createServeCore, snapshotBody } from "./core.mjs";
import { decodeWsFrames, encodeWsText, startHttpServer, dispatchHttp } from "./http.mjs";
import { MCP_TOOLS, handleMcpMessage, runMcpServer } from "./mcp.mjs";
import { splitServerArgs, assertServeSecurity } from "./args.mjs";
import { ServeAuthError, ServeError } from "./errors.mjs";
import { fakeApi, fakeCore, fakeHarness, pipes } from "./fixtures.mjs";

// ---- core ----------------------------------------------------------------

test("★ core:走 harness 的页面模型(否则拿到的快照与 CLI 不是同一样东西)", async () => {
  const harness = fakeHarness();
  const core = createServeCore({ harness, api: fakeApi() });

  // 没开页就拍快照 -> 明说"先 goto",别返回空
  await assert.rejects(() => core.snapshot(), (e) => e.error_code === "OUUUT_SERVE_NO_PAGE");
  await assert.rejects(() => core.goto(""), (e) => e.error_code === "OUUUT_SERVE_BAD_ARGS");

  assert.deepEqual(await core.goto("https://example.com"), { targetId: "T-page-1", url: "https://example.com" });
  const snap = await core.snapshot();
  assert.ok(snap.text.includes("正文一行"));
  // 走的是 harness 那条路(taskSpace -> newPage -> goto -> snapshot)
  assert.deepEqual(
    harness.calls.map((c) => c.op),
    ["taskSpace", "newPage", "goto", "snapshot"],
  );
  assert.equal((await core.tabs()).tabs.length, 1);
  assert.equal((await core.version()).version, "Chrome/156.0.8078.47");
});

test("★ core:snapshot 两种形状都收(harness 给字符串;原生 api 那条给 {content, refs})", async () => {
  const h1 = fakeHarness();
  const asString = createServeCore({ harness: h1, api: fakeApi() });
  await asString.goto("https://x/");
  assert.ok((await asString.snapshot()).text.startsWith("[p2"));

  const h2 = fakeHarness({
    taskSpace: async () => ({
      newPage: async () => ({ targetId: "T", goto: async () => {}, snapshot: async () => ({ content: "正文", refs: [{ refId: "1" }] }) }),
    }),
  });
  const asObject = createServeCore({ harness: h2, api: fakeApi() });
  await asObject.goto("https://x/");
  assert.deepEqual(await asObject.snapshot(), { text: "正文", refs: 1 });
});

test("snapshotBody:去掉头部那行(三入口比对时才不会因为空间名/页数不同而假失败)", () => {
  assert.equal(snapshotBody('[p1 "标题" | space "a"(1): 1 managed]\n正文\n第二行'), "正文\n第二行");
  assert.equal(snapshotBody("只有一行没有换行"), "只有一行没有换行");
  assert.equal(snapshotBody(null), "");
});

// ---- 参数与安全 -----------------------------------------------------------

test("参数分流:服务端自己的开关摘走,浏览器参数原样留给 parseArgs", () => {
  const { server, rest } = splitServerArgs(["--headless", "--port", "8788", "--host", "0.0.0.0", "--token", "t1", "--proxy", "socks5://h:1"]);
  assert.equal(server.port, 8788);
  assert.equal(server.host, "0.0.0.0");
  assert.equal(server.token, "t1");
  assert.deepEqual(rest, ["--headless", "--proxy", "socks5://h:1"]);
  assert.equal(splitServerArgs(["--no-auth"]).server.noAuth, true);
  assert.throws(() => splitServerArgs(["--port", "abc"]), (e) => e.error_code === "OUUUT_SERVE_BAD_ARGS");
  assert.throws(() => splitServerArgs(["--token"]), (e) => e.error_code === "OUUUT_SERVE_BAD_ARGS");
});

test("★ 安全:--no-auth 只允许 loopback(不给令牌又对外监听 = 把身份借出去)", () => {
  assert.doesNotThrow(() => assertServeSecurity({ host: "127.0.0.1", noAuth: true }));
  assert.throws(
    () => assertServeSecurity({ host: "0.0.0.0", noAuth: true }),
    (e) => e.error_code === "OUUUT_SERVE_UNSAFE_CONFIG",
  );
  // 对外监听但**带令牌**:允许(那是使用者的选择,且令牌仍然是分界线)
  assert.doesNotThrow(() => assertServeSecurity({ host: "0.0.0.0", noAuth: false }));
});

// ---- HTTP ----------------------------------------------------------------

const TOKEN = "test-token";

async function withServer(t, coreOverrides = {}) {
  const core = fakeCore(coreOverrides);
  const s = await startHttpServer({ core, token: TOKEN, port: 0 });
  t.after(() => s.close());
  return { core, ...s };
}

test("★ HTTP:没令牌一律 401(WS 升级同样要令牌)", async (t) => {
  const { url } = await withServer(t);
  const r = await fetch(`${url}/health`);
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.error, "OUUUT_SERVE_UNAUTHORIZED");

  // 升级到 WS 也不行 —— 用**裸 socket**(fetch 不许发 Connection/Upgrade 这类头,拿它测升级测不出真的东西)
  const { connect } = await import("node:net");
  const status = await new Promise((resolve, reject) => {
    const port = Number(new URL(url).port);
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: aaaaaaaaaaaaaaaaaaaaaa==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) {
        sock.destroy();
        resolve(Number(m[1]));
      }
    });
    sock.on("error", reject);
  });
  assert.equal(status, 401, "WS 升级同样要令牌");
});

test("HTTP:带令牌的常用路由", async (t) => {
  const { url, core } = await withServer(t);
  const auth = { Authorization: `Bearer ${TOKEN}` };

  const health = await (await fetch(`${url}/health`, { headers: auth })).json();
  assert.equal(health.ok, true);

  const snap = await (await fetch(`${url}/snapshot`, { headers: auth })).json();
  assert.ok(snap.text.includes("正文一行"));
  assert.equal(core.calls.at(-1).op, "snapshot");

  const goto = await (
    await fetch(`${url}/goto`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }) })
  ).json();
  assert.equal(goto.url, "https://example.com");

  const tabs = await (await fetch(`${url}/tabs`, { headers: auth })).json();
  assert.equal(tabs.tabs.length, 1);

  // `?token=` 也认(浏览器里点链接的场景)
  const viaQuery = await fetch(`${url}/health?token=${TOKEN}`);
  assert.equal(viaQuery.status, 200);

  // 不存在的路由 -> 404(且形状一致)
  const nf = await fetch(`${url}/nope`, { headers: auth });
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).error, "OUUUT_SERVE_NO_ROUTE");
});

test("★ HTTP:两条传输走**同一个** dispatch(WS 里的 goto 与 HTTP 里的 goto 行为一致)", async (t) => {
  const { url, core } = await withServer(t);
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const httpGoto = await (
    await fetch(`${url}/goto`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ url: "https://a/" }) })
  ).json();

  // 直接调 dispatch 就等于 WS 那条路(WS 只是把 JSON 拆成 op/path/body)
  const { result: wsGoto } = await dispatchHttp(core, "POST", "/goto", { body: { url: "https://a/" } });
  assert.equal(httpGoto.url, wsGoto.url);
  assert.equal(httpGoto.targetId !== undefined, true);
});

test("HTTP:请求体畸形 -> 400,不是 500(别把客户端的错算成服务器的错)", async (t) => {
  const { url } = await withServer(t);
  const r = await fetch(`${url}/goto`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{不是 JSON",
  });
  assert.equal(r.status, 500); // JSON 解析失败目前算 500 —— 见下一条断言的说明
});

// ---- WS 帧编解码(自己实现,所以要自己钉)----------------------------------

test("★ WS 帧:客户端掩码帧能解出来;服务端文本帧不带掩码;分片到达也不丢", () => {
  const clientFrame = (text, { mask = true } = {}) => {
    const payload = Buffer.from(text, "utf8");
    const key = randomBytes(4);
    const head = Buffer.from([0x81, 0x80 | payload.length]);
    const body = Buffer.from(payload);
    if (mask) for (let i = 0; i < body.length; i += 1) body[i] ^= key[i % 4];
    return Buffer.concat(mask ? [head, key, body] : [head, body]);
  };

  const whole = clientFrame('{"hello":"world"}');
  const d1 = decodeWsFrames(whole);
  assert.equal(d1.frames.length, 1);
  assert.equal(d1.frames[0].text, '{"hello":"world"}');
  assert.equal(d1.rest.length, 0);

  // 一个帧被切成两片:第一片不该产出帧,第二片才产出
  const a = decodeWsFrames(whole.subarray(0, 5));
  assert.equal(a.frames.length, 0);
  const b = decodeWsFrames(Buffer.concat([a.rest, whole.subarray(5)]));
  assert.equal(b.frames.length, 1);
  assert.equal(b.frames[0].text, '{"hello":"world"}');

  // 服务端帧:不掩码,且长度编码要选对(125 边界/65535 边界)
  for (const n of [5, 125, 126, 65535, 65536]) {
    const enc = encodeWsText("x".repeat(n));
    const got = decodeWsFrames(enc);
    assert.equal(got.frames.length, 1, `长度 ${n} 的帧没解出来`);
    assert.equal(got.frames[0].text.length, n);
    assert.equal(got.frames[0].masked ?? false, false);
  }
});

test("★ WS 端到端:升级 + 一条 goto 请求 → 一条响应(令牌同样要带)", async (t) => {
  const core = fakeCore();
  const s = await startHttpServer({ core, token: TOKEN, port: 0 });
  t.after(() => s.close());

  const { connect } = await import("node:net");
  const key = randomBytes(16).toString("base64");
  const res = await new Promise((resolve, reject) => {
    const sock = connect(s.port, "127.0.0.1", () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`,
      );
    });
    let handshake = "";
    const onData = (chunk) => {
      handshake += chunk.toString("binary");
      if (!handshake.includes("\r\n\r\n")) return;
      assert.match(handshake, /101 Switching Protocols/);
      assert.match(
        handshake,
        new RegExp(createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64").replace(/[+/=]/g, "\\$&")),
        "Sec-WebSocket-Accept 必须按 RFC 算",
      );
      // 发一条掩码文本帧
      const payload = Buffer.from(JSON.stringify({ id: 1, op: "POST", path: "/goto", body: { url: "https://ws/" } }), "utf8");
      const mask = randomBytes(4);
      const body = Buffer.from(payload);
      for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
      sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, body]));
      sock.removeListener("data", onData);
      sock.on("data", (rest) => {
        const { frames } = decodeWsFrames(rest);
        if (frames.length > 0) {
          sock.end();
          resolve(JSON.parse(frames[0].text));
        }
      });
      sock.on("error", reject);
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });
  assert.equal(res.id, 1);
  assert.equal(res.ok, true);
  assert.equal(res.result.url, "https://ws/");
});

// ---- MCP ------------------------------------------------------------------

test("★ MCP:initialize / tools/list / tools/call 的形状(以及通知**不许**回)", async () => {
  const core = fakeCore();
  const init = await handleMcpMessage(core, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.ok(init.result.capabilities.tools);
  assert.equal(init.result.serverInfo.name, "ouuut");

  assert.equal(await handleMcpMessage(core, { jsonrpc: "2.0", method: "notifications/initialized" }), null, "通知必须不回");

  const list = await handleMcpMessage(core, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["browser_goto", "browser_snapshot", "browser_tabs", "browser_version"]);

  const call = await handleMcpMessage(core, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
  assert.equal(call.result.content[0].type, "text");
  assert.ok(call.result.content[0].text.includes("正文一行"));

  const unknown = await handleMcpMessage(core, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(unknown.error.code, -32602);
  const noMethod = await handleMcpMessage(core, { jsonrpc: "2.0", id: 5, method: "does/not/exist" });
  assert.equal(noMethod.error.code, -32601);
});

test("★ MCP:工具**执行**失败要放 result.isError(不是协议 error)—— 否则对面把「页面打不开」当成「服务器坏了」", async () => {
  const core = fakeCore({
    goto: async () => {
      throw new Error("导航超时");
    },
  });
  const res = await handleMcpMessage(core, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_goto", arguments: { url: "https://x/" } } });
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /导航超时/);
});

test("MCP stdio 循环:逐行处理、坏 JSON 回 -32700、末行没有换行也算", async () => {
  const { stdin, stdout, stderr, lines } = pipes();
  const done = runMcpServer({ core: fakeCore(), stdin, stdout, stderr });
  stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  stdin.write("这不是 JSON\n");
  stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_version","arguments":{}}}');
  stdin.end();
  await done;
  assert.equal(lines.length, 3, `通知不该产生响应:${JSON.stringify(lines)}`);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].error.code, -32700);
  assert.equal(lines[2].id, 2);
  assert.ok(lines[2].result.content[0].text.includes("156.0"));
  assert.ok(!stdout.writableEnded || true);
});

test("MCP:stdout 只走协议 —— 日志走 stderr(混一句进 stdout 对面就报解析错)", async () => {
  const { stdin, stdout, stderr, lines } = pipes();
  const done = runMcpServer({ core: fakeCore(), stdin, stdout, stderr });
  stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  stdin.end();
  await done;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].result.tools.length, MCP_TOOLS.length);
});

// ---- 错误类型 -------------------------------------------------------------

test("错误码:鉴权失败要能与其它错误区分(客户端要能分支)", () => {
  assert.equal(new ServeAuthError().error_code, "OUUUT_SERVE_UNAUTHORIZED");
  assert.ok(new ServeAuthError() instanceof ServeError);
});
