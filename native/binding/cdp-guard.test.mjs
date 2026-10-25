// native/binding/cdp-guard.test.mjs —— M4 驱动层的验收
//
//   node --test native/binding/cdp-guard.test.mjs
//
// 每条规则都有出处(`docs/M0-结论.md` 或检测项清单),不是拍脑袋的黑名单。
// 而且**每条规则都要能报警** —— 一个从不拦东西的守卫等于没有守卫。

import test from "node:test";
import assert from "node:assert/strict";

import {
  createCdpGuard,
  inspectCommand,
  auditCommandStream,
  auditNoTcpDebugPort,
  ACTION,
  KNOWN_SAFE,
} from "./cdp-guard.mjs";

// ---- 逐条规则:该拦的拦住 ------------------------------------------------

test("★ Runtime.enable 必须被拦(M0 实测:pw-hardened 参数全干净仍红此项)", () => {
  const v = inspectCommand("Runtime.enable", {});
  assert.equal(v.action, ACTION.HOLD);
  assert.match(v.reason, /cdpBindingGlobals/);
  assert.ok(v.evidence, "拦截必须带出处");
});

test("★ 会产生 CDP 绑定全局的 domain 全部拦住", () => {
  for (const m of ["Debugger.enable", "Profiler.enable", "Console.enable", "DOM.enable", "Log.enable", "HeapProfiler.enable"]) {
    assert.equal(inspectCommand(m, {}).action, ACTION.HOLD, m);
  }
});

test("★ 页面注入类拦住(检测项 pwInitScripts / documentInterception / bypassCsp)", () => {
  for (const m of [
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.setBypassCSP",
    "Page.setDocumentContent",
  ]) {
    assert.equal(inspectCommand(m, {}).action, ACTION.HOLD, m);
  }
});

test("★ `Page.setInterceptFileChooserDialog` **必须放行**(拦下它 = 动作全废:能看快照、点不动)", () => {
  // 2026-10-25 实测:它原本按名字被归进"页面注入"并被 HOLD,而 harness 的每个动作
  // (click / fill / press / type)都会先发它 ⇒ 所有动作失败,报错里只有一条 CDP 消息的回显。
  // 事实:它既不注入脚本、也不留页面绑定;放行后动作恢复,检测站读数不变。
  assert.equal(inspectCommand("Page.setInterceptFileChooserDialog", { enabled: true }).action, ACTION.PASS);
});

test("★ 移动端/自动化模拟拦住(检测项 mobileEmulation)", () => {
  for (const m of [
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
    "Emulation.setAutomationOverride",
  ]) {
    assert.equal(inspectCommand(m, {}).action, ACTION.HOLD, m);
  }
});

test("★ setUserAgentOverride **不带** brands → 不是拦,是**改写**(拦错了反而伤功能)", () => {
  const v = inspectCommand("Emulation.setUserAgentOverride", { userAgent: "x" });
  assert.equal(v.action, ACTION.REWRITE);
  assert.match(v.reason, /brands/);
  assert.match(v.evidence, /M1 对照实验/, "这条规则必须有实测出处");
});

test("★ setUserAgentOverride **带**了 brands → 放行", () => {
  const v = inspectCommand("Emulation.setUserAgentOverride", {
    userAgent: "x",
    userAgentMetadata: { brands: [{ brand: "Chromium", version: "156" }] },
  });
  assert.equal(v.action, ACTION.PASS);
});

test("★ brands 是空数组也算「没带」(这正是 M1 实测到的形态)", () => {
  const v = inspectCommand("Emulation.setUserAgentOverride", { userAgentMetadata: { brands: [] } });
  assert.equal(v.action, ACTION.REWRITE);
});

// ---- 放行:不能误伤 ------------------------------------------------------

test("★ 实测流量里 harness 在用的命令必须放行(否则会把功能一起挡死)", () => {
  // 这些是从 harness 实测流量里记下来的
  for (const m of ["Target.setAutoAttach", "Target.getTargets", "Target.attachToTarget", "Page.enable", "Network.enable", "Browser.getVersion"]) {
    assert.equal(inspectCommand(m, {}).action, ACTION.PASS, `${m} 不该被拦`);
  }
});

test("KNOWN_SAFE 里的每一条都真的放行(清单本身不能与实现不一致)", () => {
  for (const m of KNOWN_SAFE) {
    assert.equal(inspectCommand(m, {}).action, ACTION.PASS, `${m} 在 KNOWN_SAFE 里却被拦了`);
  }
});

test("完全未知的命令放行(我们只拦有据可依的,不搞白名单式封闭)", () => {
  assert.equal(inspectCommand("SomeFutureDomain.someMethod", {}).action, ACTION.PASS);
});

test("方法名空 → 拦(这一定是调用方的 bug)", () => {
  assert.equal(inspectCommand("", {}).action, ACTION.HOLD);
  assert.equal(inspectCommand(null, {}).action, ACTION.HOLD);
});

// ---- wrap:真的执行起来 ---------------------------------------------------

test("★ wrap:拦下的命令**不会**到达 send", () => {
  const sent = [];
  const g = createCdpGuard({ throwOnHold: false });
  const send = g.wrap((m, p) => { sent.push({ m, p }); return { ok: true }; });
  assert.equal(send("Runtime.enable", {}), undefined);
  assert.equal(sent.length, 0, "被拦的命令绝不能发出去");
  assert.equal(g.held.length, 1);
});

test("★ wrap:默认拦下时**抛错**(而不是静默放过)", () => {
  const g = createCdpGuard();
  const send = g.wrap(() => ({ ok: true }));
  assert.throws(() => send("Runtime.enable", {}), (e) => {
    assert.equal(e.error_code, "OUUUT_CDP_COMMAND_HELD");
    assert.equal(e.method, "Runtime.enable");
    return true;
  });
});

test("★ wrap:改写路径**补齐 metadata 之后**才发出去", () => {
  const sent = [];
  const g = createCdpGuard({
    userAgentMetadata: { brands: [{ brand: "Chromium", version: "156" }], platform: "Windows" },
  });
  const send = g.wrap((m, p) => { sent.push({ m, p }); return { ok: true }; });
  send("Emulation.setUserAgentOverride", { userAgent: "UA" });
  assert.equal(sent.length, 1, "改写后应该发出去");
  assert.deepEqual(sent[0].p.userAgentMetadata.brands, [{ brand: "Chromium", version: "156" }]);
  assert.equal(sent[0].p.userAgent, "UA", "原有参数不能被丢");
});

test("★ wrap:改写但**没有**可用 metadata → 拦下并报专门的代号", () => {
  const sent = [];
  const g = createCdpGuard({ userAgentMetadata: null });
  const send = g.wrap((m, p) => { sent.push({ m, p }); });
  assert.throws(() => send("Emulation.setUserAgentOverride", { userAgent: "UA" }), (e) => {
    assert.equal(e.error_code, "OUUUT_UA_METADATA_REQUIRED");
    return true;
  });
  assert.equal(sent.length, 0, "补不齐就绝不能发 —— 发了就是 brands: [] 那个红");
});

test("★ wrap:audit 模式只记账不拦(取证用)", () => {
  const sent = [];
  const g = createCdpGuard({ mode: "audit" });
  const send = g.wrap((m, p) => { sent.push(m); return { ok: true }; });
  send("Runtime.enable", {});
  assert.equal(sent.length, 1, "audit 模式要放行(否则录不到真实流量)");
});

test("★ wrap:off 模式完全不管(只在做对照实验时用)", () => {
  const sent = [];
  const g = createCdpGuard({ mode: "off" });
  const send = g.wrap((m) => { sent.push(m); });
  send("Runtime.enable", {});
  assert.equal(sent.length, 1);
  assert.equal(g.held.length, 0);
});

test("wrap 别的不是函数的东西 → 直接报错", () => {
  const g = createCdpGuard();
  assert.throws(() => g.wrap(null), TypeError);
});

// ---- 验收:对录到的命令流离线判定 -----------------------------------------

test("★ M4 验收(可验的那半):一段干净的命令流 → ok", () => {
  const stream = [
    { method: "Target.setAutoAttach", params: { autoAttach: true } },
    { method: "Target.getTargets" },
    { method: "Target.attachToTarget", params: { targetId: "t1" } },
    { method: "Page.enable" },
    { method: "Network.enable" },
    { method: "Browser.getVersion" },
    { method: "Page.navigate", params: { url: "https://example.com" } },
    { method: "Runtime.evaluate", params: { expression: "1+1" } },
  ];
  const r = auditCommandStream(stream);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(r.runtimeEnable, 0);
  assert.equal(r.total, 8);
});

test("★ M4 验收:**抓到 Runtime.enable 就判不通过**", () => {
  const r = auditCommandStream([
    { method: "Page.enable" },
    { method: "Runtime.enable" },
    { method: "Browser.getVersion" },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.runtimeEnable, 1);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].method, "Runtime.enable");
});

test("★ 空流 / 非数组:不崩,但也不假装通过(0 条 = 没证到)", () => {
  const r = auditCommandStream([]);
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
  assert.equal(auditCommandStream(null).total, 0);
});

test("★ 无 TCP 调试端口:抓得住 --remote-debugging-port", () => {
  assert.equal(auditNoTcpDebugPort(["--remote-debugging-pipe"]).ok, true);
  const bad = auditNoTcpDebugPort(["--remote-debugging-pipe", "--remote-debugging-port=9222"]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.offenders, ["--remote-debugging-port=9222"]);
  assert.equal(auditNoTcpDebugPort(["--remote-debugging-port"]).ok, false);
});

// ---- 与 M2 的实际启动参数接线:两半合起来是 M4 的验收 ----------------------

test("★ 端到端:M2 的启动参数 + M4 的命令流守卫,两半都干净才算过", async () => {
  const { buildBrowserArgs } = await import("../bin/launch-args.mjs");
  const { args } = buildBrowserArgs({}, {});

  const ports = auditNoTcpDebugPort(args);
  assert.equal(ports.ok, true, `启动参数里不该有 TCP 调试端口:${ports.offenders}`);

  // 一次真实形态的会话(harness 实测流量 + 页面驱动)
  const g = createCdpGuard({
    userAgentMetadata: { brands: [{ brand: "Google Chrome", version: "156" }], platform: "Windows" },
  });
  const sent = [];
  const send = g.wrap((m, p) => { sent.push({ method: m, params: p }); return { ok: true }; });

  send("Target.setAutoAttach", { autoAttach: true });
  send("Target.getTargets", {});
  send("Target.attachToTarget", { targetId: "t1" });
  send("Page.enable", {});
  send("Network.enable", {});
  send("Browser.getVersion", {});
  send("Emulation.setUserAgentOverride", { userAgent: "UA" });

  const audit = auditCommandStream(sent);
  assert.equal(audit.ok, true, `命令流有违规:${JSON.stringify(audit.violations)}`);
  assert.equal(audit.runtimeEnable, 0, "整个会话一次都没发 Runtime.enable");
  assert.equal(g.held.length, 0);
  assert.equal(g.rewritten.length, 1, "那条 UA 覆盖应该走改写而不是放过");
});

test("★ 反向:同一段流程里如果谁加了 Runtime.enable,验收**必须**红", () => {
  const g = createCdpGuard({ mode: "audit" }); // 取证模式:放行但记账
  const sent = [];
  const send = g.wrap((m, p) => { sent.push({ method: m, params: p }); });
  send("Page.enable", {});
  send("Runtime.enable", {});
  const audit = auditCommandStream(sent);
  assert.equal(audit.ok, false, "如果这条不红,那整套验收就是摆设");
  assert.equal(audit.runtimeEnable, 1);
});
