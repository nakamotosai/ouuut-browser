// native/serve/mcp-retrofit.test.mjs —— MCP 会话层改造的验收(batch / wait / profile / 轨迹)
//
// 这一片钉住的是**新工具与旁路**的契约:
//   * batch 是薄编排(只调 core 上已有的操作),错误语义"首错即停 / continueOnError";
//   * wait 走 harness 的页面等待 API,不轮询快照;
//   * profile 如实报告档案引擎可达性与"建/关未开放";
//   * 轨迹每次 tools/call 一行、快照另存、敏感值脱敏、写失败不拖垮协议。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BATCH_OPS, runBatch } from "./batch.mjs";
import { createServeCore } from "./core.mjs";
import { handleMcpMessage, runMcpServer } from "./mcp.mjs";
import {
  createTrajectoryRecorder,
  newSessionId,
  redactForRecord,
  resolveRunsDir,
} from "./trajectory.mjs";
import { fakeApi, fakeCore, fakeHarness, pipes } from "./fixtures.mjs";

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function tmpDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ouuut-mcp-retrofit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 一个有页面的真 core(harness 是假的,等待调用会被记下来)。 */
async function coreWithPage() {
  const harness = fakeHarness();
  const core = createServeCore({ harness, api: fakeApi() });
  await core.goto("https://example.com/");
  return { core, harness };
}

// ---- batch ---------------------------------------------------------------

test("★ batch:按顺序执行,每步一条结果;调的全是 core 上已有的操作(薄编排)", async () => {
  const core = fakeCore();
  const r = await runBatch(core, [
    { op: "goto", url: "https://a/" },
    { op: "snapshot" },
    { op: "tabs" },
    { op: "version" },
    { op: "wait", selector: "#ready", timeoutMs: 1000 },
  ]);

  assert.equal(r.ok, true);
  assert.equal(r.stoppedAt, null);
  assert.deepEqual(r.steps.map((s) => s.op), ["goto", "snapshot", "tabs", "version", "wait"]);
  assert.deepEqual(core.calls.map((c) => c.op), ["goto", "snapshot", "tabs", "version", "wait"]);
  assert.equal(r.steps[0].result.targetId, "T-1");
  assert.equal(r.steps[1].result.text.includes("正文一行"), true);
  assert.equal(r.steps[4].result.waitedFor, "loadState");
});

test("★ batch:首错即停(stoppedAt 指到那一步),失败的那步也要有结果", async () => {
  const core = fakeCore();
  core.goto = async () => {
    core.calls.push({ op: "goto" });
    throw new Error("导航超时");
  };
  const r = await runBatch(core, [
    { op: "goto", url: "https://a/" },
    { op: "version" },
  ]);

  assert.equal(r.ok, false);
  assert.equal(r.stoppedAt, 0);
  assert.equal(r.steps.length, 1, "首错之后不该再跑第二步");
  assert.equal(r.steps[0].ok, false);
  assert.match(r.steps[0].error.message, /导航超时/);
  assert.deepEqual(core.calls.map((c) => c.op), ["goto"]);
});

test("★ batch:continueOnError=true 时跑完,后面的步骤仍然执行", async () => {
  const core = fakeCore();
  core.goto = async () => {
    core.calls.push({ op: "goto" });
    throw new Error("打不开");
  };
  const r = await runBatch(
    core,
    [
      { op: "goto", url: "https://a/" },
      { op: "version" },
      { op: "tabs" },
    ],
    { continueOnError: true },
  );

  assert.equal(r.ok, false);
  assert.equal(r.stoppedAt, null);
  assert.deepEqual(r.steps.map((s) => s.ok), [false, true, true]);
  assert.deepEqual(core.calls.map((c) => c.op), ["goto", "version", "tabs"]);
});

test("batch 错误路径:空 steps 直接拒;不认识的 op 进该步的 error(不是静默跳过)", async () => {
  await assert.rejects(() => runBatch(fakeCore(), []), (e) => e.error_code === "OUUUT_SERVE_BAD_ARGS");

  const r = await runBatch(fakeCore(), [{ op: "click", selector: "#x" }]);
  assert.equal(r.ok, false);
  assert.equal(r.stoppedAt, 0);
  assert.match(r.steps[0].error.message, /不认识/);
  assert.ok(BATCH_OPS.includes("goto"));
});

test("★ MCP browser_batch:逐步骤结果在 content 里;有失败时 isError=true", async () => {
  const core = fakeCore({
    snapshot: async () => {
      throw new Error("没有页");
    },
  });
  const res = await handleMcpMessage(
    core,
    call(1, "browser_batch", {
      steps: [{ op: "goto", url: "https://a/" }, { op: "snapshot" }, { op: "version" }],
      continueOnError: true,
    }),
  );
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true, "有步骤失败 = 这次调用没有完全成功");
  const body = JSON.parse(res.result.content[0].text);
  assert.equal(body.steps.length, 3);
  assert.deepEqual(body.steps.map((s) => s.ok), [true, false, true]);
  assert.match(body.steps[1].error.message, /没有页/);
});

test("MCP browser_batch 错误路径:缺 steps 是工具执行失败(result.isError),不是协议错误", async () => {
  const res = await handleMcpMessage(fakeCore(), call(1, "browser_batch", {}));
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /非空/);
});

// ---- wait ----------------------------------------------------------------

test("★ wait:selector 走 page.waitForSelector(默认 state=visible),不轮询快照", async () => {
  const { core, harness } = await coreWithPage();
  const r = await core.wait({ selector: "#ready", timeoutMs: 1234 });

  assert.equal(r.waitedFor, "selector");
  assert.equal(r.selector, "#ready");
  assert.equal(r.state, "visible");
  const c = harness.calls.find((x) => x.op === "waitForSelector");
  assert.deepEqual(c, { op: "waitForSelector", selector: "#ready", options: { timeout: 1234, state: "visible" } });
  assert.equal(harness.calls.some((x) => x.op === "snapshot"), false, "等待不该靠拍快照");
});

test("★ wait:text 走 page.waitForFunction,文本经 JSON 编码(引号/反斜杠不会破表达式)", async () => {
  const { core, harness } = await coreWithPage();
  const text = '引号 " 与反斜杠 \\ 还有换行\n第二行';
  const r = await core.wait({ text, timeoutMs: 500 });

  assert.equal(r.waitedFor, "text");
  const c = harness.calls.find((x) => x.op === "waitForFunction");
  assert.ok(c.expression.includes("innerText"));
  assert.ok(c.expression.includes(JSON.stringify(text)), "文本必须按 JSON 编码进表达式");
  assert.equal(c.argument, undefined);
  assert.deepEqual(c.options, { timeout: 500 });
});

test("★ wait:loadState 走 page.waitForLoadState;什么都不给时等 load", async () => {
  const { core, harness } = await coreWithPage();
  const r = await core.wait();
  assert.equal(r.waitedFor, "loadState");
  assert.equal(r.loadState, "load");
  const c = harness.calls.find((x) => x.op === "waitForLoadState");
  assert.equal(c.state, "load");
  assert.equal(c.options.timeout, 30000);

  await core.wait({ loadState: "networkidle", timeoutMs: 100 });
  assert.equal(harness.calls.filter((x) => x.op === "waitForLoadState").at(-1).state, "networkidle");
});

test("wait 错误路径:没页 / 目标互斥 / 参数不合法 —— 全部明确报错", async () => {
  const bare = createServeCore({ harness: fakeHarness(), api: fakeApi() });
  await assert.rejects(() => bare.wait({ selector: "#x" }), (e) => e.error_code === "OUUUT_SERVE_NO_PAGE");

  const { core } = await coreWithPage();
  await assert.rejects(() => core.wait({ selector: "#x", text: "y" }), (e) => e.error_code === "OUUUT_SERVE_BAD_ARGS");
  await assert.rejects(
    () => core.wait({ loadState: "load", selector: "#x" }),
    (e) => e.error_code === "OUUUT_SERVE_BAD_ARGS",
  );
  await assert.rejects(() => core.wait({ state: "visible" }), (e) => e.error_code === "OUUUT_SERVE_BAD_ARGS");
  await assert.rejects(
    () => core.wait({ loadState: "nope" }),
    (e) => e.error_code === "OUUUT_SERVE_BAD_ARGS",
  );
  await assert.rejects(
    () => core.wait({ selector: "#x", state: "nope" }),
    (e) => e.error_code === "OUUUT_SERVE_BAD_ARGS",
  );
});

test("MCP browser_wait:结果原样透出 waitedFor(工具执行失败走 result.isError)", async () => {
  const core = fakeCore();
  const ok = await handleMcpMessage(core, call(1, "browser_wait", { selector: "#ready" }));
  assert.equal(JSON.parse(ok.result.content[0].text).waitedFor, "loadState");

  const bad = await handleMcpMessage(
    fakeCore({
      wait: async () => {
        throw new Error("等待超时");
      },
    }),
    call(2, "browser_wait", { text: "never" }),
  );
  assert.equal(bad.error, undefined);
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /等待超时/);
});

// ---- profile -------------------------------------------------------------

test("★ profile:当前档案 id/kind + 档案列表;建/关如实标 false", async () => {
  const profiles = [{ id: "persona-1", name: "长期画像", kind: "persona", isDefault: false, proxy: null }];
  const archive = { listProfiles: () => ({ profiles }) };
  const core = createServeCore({
    harness: fakeHarness(),
    api: fakeApi(),
    profile: { sessionProfileId: "persona-1", profiles, archive },
  });

  const p = await core.profile();
  assert.equal(p.profileId, "persona-1");
  assert.equal(p.kind, "persona");
  assert.equal(p.isDefault, false);
  assert.equal(p.archiveReachable, true);
  assert.deepEqual(p.profiles.map((x) => x.id), ["persona-1"]);
  assert.equal(p.capabilities.create, false);
  assert.equal(p.capabilities.close, false);
  assert.match(p.capabilities.reason, /会话层/);
});

test("profile:没给 --profile-kind 时如实返回默认档案,且 archiveReachable=false", async () => {
  const core = createServeCore({ harness: fakeHarness(), api: fakeApi() });
  const p = await core.profile();
  assert.equal(p.profileId, "default");
  assert.equal(p.kind, null);
  assert.equal(p.archiveReachable, false);
  assert.deepEqual(p.profiles, []);

  // boot 的真实形状:会话层交出硬编码的默认档案(session-profiles 的 FALLBACK_PROFILE)
  const bootLike = createServeCore({
    harness: fakeHarness(),
    api: fakeApi(),
    profile: { sessionProfileId: null, profiles: [{ id: "default", name: "默认档案", isDefault: true }], archive: null },
  });
  const q = await bootLike.profile();
  assert.equal(q.profileId, "default");
  assert.equal(q.kind, null);
  assert.equal(q.isDefault, true);
  assert.equal(q.archiveReachable, false);
});

test("MCP browser_profile:JSON 结果可解析", async () => {
  const res = await handleMcpMessage(fakeCore(), call(1, "browser_profile", {}));
  const body = JSON.parse(res.result.content[0].text);
  assert.equal(body.profileId, "default");
  assert.equal(body.capabilities.create, false);
});

// ---- trajectory ----------------------------------------------------------

test("★ 轨迹:每次 tools/call 一行(含失败);快照正文另存;字段齐全", async (t) => {
  const dir = await tmpDir(t);
  const recorder = createTrajectoryRecorder({ runsDir: dir, sessionId: "s-test", stderr: { write() {} } });
  const core = fakeCore();

  await handleMcpMessage(core, call(1, "browser_goto", { url: "https://example.com/" }), { recorder });
  await handleMcpMessage(core, call(2, "browser_snapshot", {}), { recorder });
  await handleMcpMessage(
    fakeCore({
      tabs: async () => {
        throw new Error("列页失败");
      },
    }),
    call(3, "browser_tabs", {}),
    { recorder },
  );

  const lines = (await readFile(recorder.trajectoryPath, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.tool), ["browser_goto", "browser_snapshot", "browser_tabs"]);
  assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3]);
  for (const l of lines) {
    assert.match(l.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof l.durationMs, "number");
    assert.equal(l.sessionId, "s-test");
  }

  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].result.result.url, "https://example.com/");

  // 快照:轨迹里只有字符数 + 路径,正文在单独文件里
  assert.equal(lines[1].result.textChars, "[p1 标题 | space x]\n正文一行".length);
  assert.match(lines[1].result.file, /^snapshots\/0002-browser_snapshot\.txt$/);
  const saved = await readFile(path.join(recorder.dir, lines[1].result.file), "utf8");
  assert.ok(saved.includes("正文一行"));

  // 失败也要留证据
  assert.equal(lines[2].ok, false);
  assert.match(lines[2].error.message, /列页失败/);
});

test("★ 轨迹:batch 里的快照也单独存(不在 JSONL 里塞正文)", async (t) => {
  const dir = await tmpDir(t);
  const recorder = createTrajectoryRecorder({ runsDir: dir, sessionId: "s-batch", stderr: { write() {} } });
  await handleMcpMessage(
    fakeCore(),
    call(1, "browser_batch", { steps: [{ op: "goto", url: "https://a/" }, { op: "snapshot" }] }),
    { recorder },
  );

  const line = JSON.parse((await readFile(recorder.trajectoryPath, "utf8")).trim());
  const snapStep = line.result.steps[1];
  assert.equal(snapStep.op, "snapshot");
  assert.match(snapStep.result.file, /^snapshots\/0001-batch-1-snapshot\.txt$/);
  assert.ok((await readFile(path.join(recorder.dir, snapStep.result.file), "utf8")).includes("正文一行"));
  assert.equal(JSON.stringify(line).includes("正文一行"), false, "轨迹行里不该有快照正文");

  // 失败的 batch:仍然记 result(每步的错误都在里面),而不是把整段 JSON 塞进 error.message
  const failing = fakeCore({
    version: async () => {
      throw new Error("版本失败");
    },
  });
  await handleMcpMessage(
    failing,
    call(2, "browser_batch", { steps: [{ op: "version" }] }),
    { recorder },
  );
  const all = (await readFile(recorder.trajectoryPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const failed = all.at(-1);
  assert.equal(failed.ok, false);
  assert.equal(failed.result.ok, false);
  assert.match(failed.result.steps[0].error.message, /版本失败/);
  assert.equal(failed.error, undefined, "batch 的失败在 result.steps 里,不重复记 error");
});

test("★ 轨迹:敏感值脱敏(cookie / authorization / token / 代理凭据)", async (t) => {
  const dir = await tmpDir(t);
  const recorder = createTrajectoryRecorder({ runsDir: dir, sessionId: "s-redact", stderr: { write() {} } });
  await handleMcpMessage(
    fakeCore(),
    call(1, "browser_goto", {
      url: "https://user:pass@example.com/x",
      cookie: "sid=abc",
      authorization: "Bearer topsecret",
      token: "tk-123",
      proxy: "socks5://u:p@127.0.0.1:1080",
    }),
    { recorder },
  );

  const raw = await readFile(recorder.trajectoryPath, "utf8");
  assert.equal(raw.includes("pass@"), false);
  assert.equal(raw.includes("sid=abc"), false);
  assert.equal(raw.includes("Bearer topsecret"), false);
  assert.equal(raw.includes("u:p@"), false);

  const line = JSON.parse(raw.trim());
  assert.equal(line.args.cookie, "[redacted]");
  assert.equal(line.args.authorization, "[redacted]");
  assert.equal(line.args.token, "[redacted]");
  // 代理串:凭据被抹掉,host:port 保留(排查需要它,且它本身不是秘密)
  assert.equal(line.args.proxy, "socks5://***@127.0.0.1:1080");
  assert.equal(line.args.url, "https://***@example.com/x");
});

test("redactForRecord:深层对象也过一遍;超长字符串截断;URL 里的秘密查询参数也抹掉", () => {
  const out = redactForRecord({
    outer: { password: "p", nested: [{ secret: "s", ok: 1 }] },
    long: "x".repeat(30),
  }, { maxString: 10 });
  assert.equal(out.outer.password, "[redacted]");
  assert.equal(out.outer.nested[0].secret, "[redacted]");
  assert.equal(out.outer.nested[0].ok, 1);
  assert.match(out.long, /^x{10}…\(\+20\)$/);

  const urls = redactForRecord({
    url: "https://x/?token=abc&q=1&api_key=kk",
  });
  assert.equal(urls.url, "https://x/?token=[redacted]&q=1&api_key=[redacted]");
});

test("轨迹目录:默认在系统临时目录;OUUUT_MCP_RUNS_DIR 可改;sessionId 可指定", () => {
  const def = resolveRunsDir({});
  assert.ok(def.startsWith(path.resolve(os.tmpdir())), `默认目录必须在临时目录下:${def}`);
  assert.equal(resolveRunsDir({ OUUUT_MCP_RUNS_DIR: "./runs-x" }), path.resolve("./runs-x"));

  assert.equal(
    newSessionId({ now: new Date("2026-10-26T01:02:03Z"), pid: 7, random: () => "deadbeef" }),
    "20261026-010203-7-deadbeef",
  );
});

test("★ 轨迹写不进去也不拖垮协议(旁路):stderr 提示一次,响应照常", async (t) => {
  const dir = await tmpDir(t);
  const blocked = path.join(dir, "blocked");
  await writeFile(blocked, "不是目录", "utf8");

  const errs = [];
  const recorder = createTrajectoryRecorder({
    runsDir: blocked,
    sessionId: "s",
    stderr: { write: (s) => errs.push(String(s)) },
  });

  const res = await handleMcpMessage(fakeCore(), call(1, "browser_version", {}), { recorder });
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, undefined);
  assert.ok(res.result.content[0].text.includes("156.0"));
  assert.match(errs.join(""), /轨迹写入失败/);
});

test("★ stdio:开了轨迹之后 stdout 仍然只有协议行", async (t) => {
  const dir = await tmpDir(t);
  const recorder = createTrajectoryRecorder({ runsDir: dir, sessionId: "s-stdio", stderr: { write() {} } });
  const { stdin, stdout, stderr, lines } = pipes();
  const done = runMcpServer({ core: fakeCore(), stdin, stdout, stderr, recorder });

  stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  stdin.write(JSON.stringify(call(2, "browser_goto", { url: "https://a/" })) + "\n");
  stdin.end();
  await done;

  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.jsonrpc === "2.0"));
  const traj = (await readFile(recorder.trajectoryPath, "utf8")).trim().split("\n");
  assert.equal(traj.length, 1, "只有 tools/call 进轨迹,initialize 不进");
  assert.equal(JSON.parse(traj[0]).tool, "browser_goto");
});
