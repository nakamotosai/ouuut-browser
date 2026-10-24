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
