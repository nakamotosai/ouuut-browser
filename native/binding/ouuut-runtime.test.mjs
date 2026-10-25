// native/binding/ouuut-runtime.test.mjs —— 接线验收:**vendored harness 真的能跑在我们的运行时上**
//
// 运行:node --test native/binding/ouuut-runtime.test.mjs
//
// 前置:`harness/package/ego-browser` 已 `npm ci --ignore-scripts && npm run build`
// (harness 的 31/36 个测试 import 的是 dist/,本测试也走 dist —— 目的是验**真实的**harness 代码,
//  不是我们复刻的简化版。)
//
// 这个测试回答的问题是:「**把 globalThis.ouuut 换成我们的实现,harness 那条 CDP 通路还通不通**」。
// 对端仍是真 pipe 上的假 CDP peer,所以不需要起浏览器。

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { spawnCdpPipe } from "./cdp-pipe.mjs";
import { createOuUutRuntime } from "./ouuut-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PEER = path.join(HERE, "fixtures", "fake-cdp-peer.mjs");
const HARNESS_DIST = path.resolve(
  HERE,
  "..",
  "..",
  "harness",
  "package",
  "ego-browser",
  "dist",
  "src",
  "browser-runtime.js",
);

function harnessDistReady() {
  return fs.existsSync(HARNESS_DIST);
}

/** 起对端 + 运行时,并把运行时装到 globalThis.ouuut(harness 就认这个)。 */
function boot(timeoutMs = 3_000) {
  const cdp = spawnCdpPipe({ exe: process.execPath, args: [PEER], name: "fake-peer", timeoutMs });
  const runtime = createOuUutRuntime({ cdp });
  const previous = globalThis.ouuut;
  globalThis.ouuut = runtime.api;
  return {
    cdp,
    runtime,
    async dispose() {
      await runtime.disposeAsync?.();
      if (previous === undefined) delete globalThis.ouuut;
      else globalThis.ouuut = previous;
      await cdp.close();
    },
  };
}

test("harness 的 isBrowserRuntime() 认我们的运行时", async (t) => {
  if (!harnessDistReady()) {
    t.skip("harness dist 未构建 —— 先跑 npm ci --ignore-scripts && npm run build");
    return;
  }
  const env = boot();
  t.after(() => env.dispose());
  const mod = await import(pathToFileURL(HARNESS_DIST).href);
  assert.equal(mod.isBrowserRuntime(), true, "harness 应该认得出 globalThis.ouuut");
});

test("harness 的 browserCdp() 经我们的透传拿到响应", async (t) => {
  if (!harnessDistReady()) {
    t.skip("harness dist 未构建");
    return;
  }
  const env = boot();
  t.after(() => env.dispose());
  const mod = await import(pathToFileURL(HARNESS_DIST).href);
  const res = await mod.browserCdp("Fake.echo", { x: 1 });
  // 上游 resolve 的是**整条响应**(`entry.resolve(data)`),不是 data.result
  assert.deepEqual(res.result, { echo: { x: 1 } });
});

test("harness 的 CDP 错误路径能收到 error.message", async (t) => {
  if (!harnessDistReady()) {
    t.skip("harness dist 未构建");
    return;
  }
  const env = boot();
  t.after(() => env.dispose());
  const mod = await import(pathToFileURL(HARNESS_DIST).href);
  await assert.rejects(() => mod.browserCdp("Fake.error", {}), /故意失败/);
});

test("透传不丢「id 不在 pending 里」的消息(harness 与原生层共用一条流)", async (t) => {
  if (!harnessDistReady()) {
    t.skip("harness dist 未构建");
    return;
  }
  const env = boot();
  t.after(() => env.dispose());
  const mod = await import(pathToFileURL(HARNESS_DIST).href);

  // 原生层自己发的请求(harness 并不知道这个 id)与 harness 的请求**共用同一条流**。
  // 关键:原生层的响应不能把 harness 的配对搞乱,反之亦然。
  const ours = env.cdp.send("Fake.echo", { who: "native-layer" });
  const theirs = mod.browserCdp("Fake.echo", { who: "harness" });
  const [a, b] = await Promise.all([ours, theirs]);
  assert.deepEqual(a.echo, { who: "native-layer" }, "原生层的响应要归原生层");
  assert.deepEqual(b.result.echo, { who: "harness" }, "harness 的响应要归 harness");
});

test("getBrowserVersion() 的形状与 harness 的期望对得上", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  const v = await env.runtime.api.getBrowserVersion();
  assert.equal(typeof v.currentVersion, "string");
  assert.equal(typeof v.updateAvailable, "boolean");
});

test("发送失败走 onSendCDPMessageError,而不是静默丢弃", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  const seen = [];
  env.runtime.api.onSendCDPMessageError = (msg, code) => seen.push([msg, code]);

  env.runtime.api.sendCDPMessage("这不是 JSON");
  assert.equal(seen.length, 1, "非法 JSON 必须报出来");
  assert.equal(seen[0][1], "OUUUT_INVALID_ARGUMENT");

  env.runtime.api.sendCDPMessage(JSON.stringify({ id: 1 })); // 缺 method
  assert.equal(seen.length, 2);
  assert.equal(seen[1][1], "OUUUT_INVALID_ARGUMENT");

  // 通道关掉之后再发:应该是通道级代号
  await env.cdp.close();
  env.runtime.api.sendCDPMessage(JSON.stringify({ id: 3, method: "Fake.echo", params: {} }));
  assert.equal(seen.length, 3, "通道关闭后的发送也要报出来");
  assert.equal(seen[2][1], "OUUUT_CDP_PIPE_CLOSED");
});

test("harness 不订 onCDPMessage 时,入站消息被丢弃而不是报错", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  // 故意不设 onCDPMessage
  env.runtime.api.sendCDPMessage(JSON.stringify({ id: 9, method: "Fake.eventThenReply", params: {} }));
  await new Promise((r) => setTimeout(r, 200));
  // 能走到这里且进程没炸,就是通过;再确认通道还活着
  const res = await env.cdp.send("Fake.echo", { alive: true });
  assert.deepEqual(res.echo, { alive: true });
});

// ---- M4 驱动层守卫:证明它**接在链路上**,不只是单元测试里孤立活着 ------------
//
// (与 `cdp-guard.test.mjs` 的区别:那边验守卫自己的逻辑,这边验"它真的挡在
//  sendCDPMessage → 管道 之间"。少了这条,守卫可能是写好却没人调用的死代码。)

test("★ M4 接线:`Runtime.enable` 经 sendCDPMessage 进来时**到不了管道**", async (t) => {
  const env = boot();
  t.after(() => env.dispose());

  const errors = [];
  env.runtime.api.onSendCDPMessageError = (msg, code) => errors.push({ msg, code });

  const arrived = [];
  const offRaw = env.cdp.onRaw((m) => arrived.push(m));

  env.runtime.api.sendCDPMessage(JSON.stringify({ id: 1, method: "Runtime.enable", params: {} }));

  offRaw();
  assert.equal(arrived.length, 0, "被拦的命令绝不能出现在管道上");
  assert.equal(errors.length, 1, "必须走 onSendCDPMessageError 报出来,不能静默放过");
  assert.equal(errors[0].code, "OUUUT_CDP_COMMAND_HELD");
});

test("★ M4 接线:`Emulation.setUserAgentOverride` 缺 metadata → 同样到不了管道(fail-closed)", async (t) => {
  const env = boot();
  t.after(() => env.dispose());

  const errors = [];
  env.runtime.api.onSendCDPMessageError = (msg, code) => errors.push(code == null ? "" : code);

  env.runtime.api.sendCDPMessage(
    JSON.stringify({ id: 2, method: "Emulation.setUserAgentOverride", params: { userAgent: "X" } }),
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0], "OUUUT_UA_METADATA_REQUIRED", "补不齐就绝不能发 —— 发了就是 brands: [] 那个红");
});

test("放行名单里的命令**照常**走到管道(守卫不能把功能一起挡死)", async (t) => {
  const env = boot();
  t.after(() => env.dispose());

  const got = new Promise((resolve) => {
    env.runtime.api.onCDPMessage = (payload) => {
      const m = JSON.parse(payload);
      if (m.id === 777) resolve(m);
    };
  });
  env.runtime.api.sendCDPMessage(JSON.stringify({ id: 777, method: "Browser.getVersion", params: {} }));
  const res = await got;
  assert.ok(res, "合法命令必须能拿到响应");
});

// ---- 页面必须建在会话档案的 context 里(F13 的前提)------------------------

test("★ createTab:会话档案有 browserContextId 时,建页必须带它(否则那个 context 的出口/隔离全落空)", async () => {
  const { createOuUutRuntime } = await import("./ouuut-runtime.mjs");
  const { createArchive } = await import("./archive.mjs");
  const sent = [];
  const cdp = {
    onRaw: () => () => {},
    send: async (method, params) => {
      sent.push({ method, params });
      if (method === "Target.createTarget") return { targetId: "T-1" };
      return {};
    },
    sendRaw: () => {},
  };
  const archive = createArchive({
    profiles: [
      { id: "real", name: "真实档案", kind: "real" },
      { id: "persona", name: "画像", kind: "persona", browserContextId: "CTX-A" },
    ],
  });
  const rt = createOuUutRuntime({ cdp, archive, sessionProfileId: "persona" });
  await rt.api.createTab("https://example.com");
  const created = sent.find((c) => c.method === "Target.createTarget");
  assert.equal(created.params.browserContextId, "CTX-A", "页必须落在档案的 context 里");
  assert.equal(created.params.url, "https://example.com");

  // 对照:`real` = 默认 context,**必须省略**该参数(Chrome 用省略寻址默认 context)
  const rt2 = createOuUutRuntime({ cdp, archive, sessionProfileId: "real" });
  await rt2.api.createTab("about:blank");
  const created2 = sent.filter((c) => c.method === "Target.createTarget").at(-1);
  assert.ok(!("browserContextId" in created2.params), "real 会话不许带 browserContextId(带了会被拒)");
});
