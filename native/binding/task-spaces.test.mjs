// native/binding/task-spaces.test.mjs —— 任务空间状态机 + user-control 门 + 快照
//
// 运行:node --test native/binding/task-spaces.test.mjs
//
// 这些用例逐条对应 harness 源码里那张**所有权表**(`helpers.ts:123-140` 的注释)
// 与 `docs/原生层接口.md` §4.4 的实测契约。判据按**代号**,不按文案 ——
// 与 harness 自己的判据一致(`helpers.test.mjs:1334`)。

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { spawnCdpPipe } from "./cdp-pipe.mjs";
import { createOuUutRuntime } from "./ouuut-runtime.mjs";
import { createTaskSpaceRegistry, USER_IN_CONTROL, NAME_IN_USE } from "./task-spaces.mjs";
import { roleToToken } from "./snapshot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PEER = path.join(HERE, "fixtures", "fake-cdp-peer.mjs");
const HARNESS_DIST = path.resolve(
  HERE, "..", "..", "harness", "package", "ego-browser", "dist", "src", "helpers.js",
);

function boot(timeoutMs = 3_000, extraEnv = null) {
  const cdp = spawnCdpPipe({
    exe: process.execPath,
    args: [PEER],
    name: "fake-peer",
    timeoutMs,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  const registry = createTaskSpaceRegistry();
  const runtime = createOuUutRuntime({ cdp, registry });
  const previous = globalThis.ouuut;
  globalThis.ouuut = runtime.api;
  return {
    cdp, runtime, registry, api: runtime.api,
    async dispose() {
      if (previous === undefined) delete globalThis.ouuut; else globalThis.ouuut = previous;
      await cdp.close();
    },
  };
}

// ---- 形状:harness 会当场校验的那些 ----------------------------------------

test("listTaskSpaces() 必须包成 {taskSpaces},不是裸数组", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  const res = await env.api.listTaskSpaces();
  assert.ok(Array.isArray(res.taskSpaces), "harness 的 normalizeTaskSpaces 只认 {taskSpaces}");
});

test("空间记录的 id 必须是 number(harness 会抛 requires a numeric id)", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  const s = await env.api.createTaskSpace("结账流程");
  assert.equal(typeof s.id, "number");
  assert.equal(s.ownership, "agent");
});

test("listProfiles() 的每条必须是 {id:string,name:string,isDefault:boolean}", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  const res = await env.api.listProfiles();
  assert.ok(Array.isArray(res.profiles) && res.profiles.length > 0);
  for (const p of res.profiles) {
    assert.equal(typeof p.id, "string");
    assert.ok(p.id.length > 0);
    assert.equal(typeof p.name, "string");
    assert.equal(typeof p.isDefault, "boolean");
  }
});

// ---- 所有权表(逐条对应 helpers.ts:123-140)--------------------------------

test("按名字创建撞到 user 所有的空间 → NAME_IN_USE(harness 表第 1 行)", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  env.registry.select(7); // 未登记 → 自动登记为 user 所有
  assert.equal(env.registry.get(7).ownership, "user");
  env.registry.get(7).name = "用户的流程";
  await assert.rejects(
    () => env.api.createTaskSpace("用户的流程"),
    (e) => { assert.equal(e.error_code, NAME_IN_USE); return true; },
  );
});

test("claimTaskSpace 把所有权转成 agent 并选中(表第 3 行)", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  env.registry.select(7); // user 所有
  const claimed = await env.api.claimTaskSpace(7, "别人的流程");
  assert.equal(claimed.ownership, "agent");
  assert.equal(env.registry.selectedId, 7);
});

test("handOffTaskSpace 对 user 所有的空间跳过(表第 4 行)", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  env.registry.select(7); // user 所有
  const res = await env.api.handOffTaskSpace();
  assert.deepEqual(res, { done: false, skipped: "user-owned" });
});

test("completeTaskSpace {keep:true} 对 user 所有空间跳过(表第 5 行)", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  env.registry.select(7);
  const res = await env.api.completeTaskSpace({ keep: true });
  assert.deepEqual(res, { done: false, skipped: "user-owned" });
});

// ---- user-control 门(核心验收)--------------------------------------------

test("交给用户后,snapshot() **reject** 且 error_code 精确等于 EGO_TASK_SPACE_USER_IN_CONTROL", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  const s = await env.api.createTaskSpace("会被交出去的");
  assert.ok(s.id);
  await env.api.handOffTaskSpace();

  await assert.rejects(
    () => env.api.snapshot({ maxResultLength: 1 }),
    (e) => {
      assert.equal(e.error_code, USER_IN_CONTROL, "harness 的探针就是按这个代号判定的");
      assert.ok(e instanceof Error, "必须是 Error 实例(不能是个普通对象)");
      return true;
    },
  );
});

test("交给用户后,会改浏览器的 CDP 命令被拦(走 onSendCDPMessageError)", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  await env.api.createTaskSpace("x");
  await env.api.handOffTaskSpace();

  const errors = [];
  env.api.onSendCDPMessageError = (m, code) => errors.push([m?.method, code]);

  for (const method of ["Page.navigate", "Input.dispatchMouseEvent", "Runtime.evaluate", "Target.createTarget"]) {
    env.api.sendCDPMessage(JSON.stringify({ id: 100 + errors.length, method, params: {} }));
  }
  assert.equal(errors.length, 4, "四条 mutating 命令都要被拦");
  for (const [, code] of errors) assert.equal(code, USER_IN_CONTROL);
});

test("交给用户后,**只读**查询仍然放行(否则 agent 连看一眼都不行)", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  await env.api.createTaskSpace("x");
  await env.api.handOffTaskSpace();

  const errors = [];
  env.api.onSendCDPMessageError = (m, code) => errors.push([m?.method, code]);
  const seen = [];
  env.api.onCDPMessage = (payload) => seen.push(JSON.parse(payload));

  env.api.sendCDPMessage(JSON.stringify({ id: 1, method: "Target.getTargets", params: {} }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(errors.length, 0, "只读查询不该被拦");
  assert.equal(seen.length, 1, "而且真的要送到对端并拿回响应");
});

test("takeOverTaskSpace 之后门重新打开", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  await env.api.createTaskSpace("x");
  await env.api.handOffTaskSpace();
  await env.api.takeOverTaskSpace();

  const errors = [];
  env.api.onSendCDPMessageError = (m, code) => errors.push([m?.method, code]);
  env.api.sendCDPMessage(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "about:blank" } }));
  assert.equal(errors.length, 0, "拿回来之后命令要放行");
  assert.equal(env.registry.isUserInControl, false);
});

// ---- 快照 ----------------------------------------------------------------

test("snapshot() 返回 {content, refs} —— 对象,不是字符串", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  await env.api.createTaskSpace("快照用");
  const snap = await env.api.snapshot({});
  assert.equal(typeof snap, "object");
  assert.equal(typeof snap.content, "string");
  assert.equal(typeof snap.refs, "object");
});

test("快照格式:首行是空间/页面头,主体是角色树 + text \"原文\"", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  await env.api.createTaskSpace("ouuut-m2-smoke");
  const snap = await env.api.snapshot({});
  const lines = snap.content.split("\n");

  assert.match(lines[0], /^\[p\d+ ".*" \| space "ouuut-m2-smoke"\(\d+\):/, "首行要是空间/页面头");
  assert.deepEqual(lines.slice(1), [
    // **裸 `root`,不带名字** —— 这是 ego 的实测格式(`docs/原生层接口.md` §4.3),
    // 不是我们的选择:root 的 AX 名字就是文档标题,而标题已在首行头里,再打一次是重复。
    // (本行原先钉的是 `root "Example Domain"` —— 那是接线前我们自己渲染器的偶然行为,
    //  与实测格式不符,已按实测改正。)
    "root",
    "  paragraph",
    "    text \"该域名仅用于文档示例。\"",
    "  paragraph",
    "    text \"This domain is for use in documentation examples.\"",
  ]);
  // **页面文本必须原样保留** —— 上游的硬要求
  assert.match(snap.content, /该域名仅用于文档示例。/);
  assert.match(snap.content, /This domain is for use in documentation examples\./);
});

test("roleToToken:用**从 ego 采到的**词汇表映射,而不是驼峰转换", () => {
  // 采自 native/smoke/harvest-roles.mjs 的实测结果
  assert.equal(roleToToken("RootWebArea"), "root");
  assert.equal(roleToToken("StaticText"), "text");
  assert.equal(roleToToken("InlineTextBox"), "text");
  assert.equal(roleToToken("link"), "anchor");
  assert.equal(roleToToken("generic"), "container");
  assert.equal(roleToToken("listitem"), "list_item");
  assert.equal(roleToToken("row"), "table_row");
  assert.equal(roleToToken("cell"), "table_cell");
  // 不在表里的走兜底
  assert.equal(roleToToken("svgRoot"), "svg_root");
  assert.equal(roleToToken("SomeFutureRole"), "some_future_role");
});

test("maxResultLength=1 的廉价探针不去拉整棵 AX 树", async (t) => {
  const env = boot();
  t.after(() => env.dispose());
  await env.api.createTaskSpace("探针");
  const snap = await env.api.snapshot({ maxResultLength: 1 });
  assert.ok(snap.content.length <= 1, `探针结果要极小,实际 ${snap.content.length}`);
});


// ---- OOPIF:跨进程 iframe 必须真的被取到 -------------------------------------
//
// 主 frame 的 AX 树**看不到** OOPIF 的内容(站点隔离下是独立 target)。
// 这条守着「runtime 的 snapshot() 默认走多帧路径」—— 否则 agent 会以为那块是空的。

test("★ snapshot() 默认带上 OOPIF:跨进程按钮出现在快照里,且 ref 带 session", async (t) => {
  const env = boot(5_000, { FAKE_PEER_OOPIF: "1" });
  t.after(() => env.dispose());

  const snap = await env.api.snapshot({ maxResultLength: 20_000 });
  assert.match(snap.content, /\[frame T-oopif/, "必须标出帧边界");
  assert.match(snap.content, /跨进程按钮/, "OOPIF 里的按钮必须在快照里");

  const child = Object.values(snap.refs).find((r) => r.name === "跨进程按钮");
  assert.ok(child, "OOPIF 的按钮要拿到 ref");
  assert.equal(child.sessionId, "S-fake-T-oopif", "ref 必须带 session,否则点不到");
  assert.equal(child.frameId, "T-oopif");
});

test("★ snapshot({includeFrames:false}) 显式关掉多帧 → 只剩主 frame", async (t) => {
  const env = boot(5_000, { FAKE_PEER_OOPIF: "1" });
  t.after(() => env.dispose());

  const snap = await env.api.snapshot({ maxResultLength: 20_000, includeFrames: false });
  assert.ok(!/\[frame /.test(snap.content), "关掉之后不该有帧边界");
  assert.ok(!snap.content.includes("跨进程按钮"), "关掉之后不该出现 OOPIF 内容");
  assert.match(snap.content, /该域名仅用于文档示例/, "主 frame 内容照旧");
});
