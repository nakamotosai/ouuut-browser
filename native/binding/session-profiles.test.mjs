// native/binding/session-profiles.test.mjs —— P2a 接线验收:**`--profile-kind` 真的改变行为**
//
// 运行:node --test native/binding/session-profiles.test.mjs
//
// 这一组测试跑在**真 pipe** 上的假 CDP 对端(`fixtures/fake-cdp-peer.mjs`),所以不需要起浏览器,
// 但**每一条命令都真过了通道** —— 于是下面这些断言证的是"接在链路上",不是"某个函数被调用过":
//
//   * `persona` 与 `disposable` 发出去的 `Target.createBrowserContext` 参数确实不同;
//   * 同一会话里两条档案的 cookie 池**互不可见**;
//   * 不带 `browserContextId` 的 `Storage.getCookies` 被隔离闸拦下,**且对端根本没收到**;
//   * `dispose()` 之后 disposable 的 context 真被销毁;
//   * `real` 不可创建不可销毁,`dispose()` 绝不在它上面动手。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawnCdpPipe } from "./cdp-pipe.mjs";
import { openSessionProfiles } from "./session-profiles.mjs";
import { createOuUutRuntime } from "./ouuut-runtime.mjs";
import { ISOLATION_VIOLATION, INVALID_ARGUMENT, ArchiveError } from "./archive.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PEER = path.join(HERE, "fixtures", "fake-cdp-peer.mjs");

/**
 * 起一个假对端,并把**它收到的每一条命令(含参数)**落到文件里 —— 这是"对端到底收到了什么"的
 * 唯一权威来源(靠"响应长什么样"反推是不可靠的)。
 *
 * 每跑一条测试一个独立日志文件,免得几条测试互相看到对方的命令。
 */
function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouuut-profiles-"));
  const logPath = path.join(dir, "peer.log");
  fs.writeFileSync(logPath, "");
  const cdp = spawnCdpPipe({
    exe: process.execPath,
    args: [PEER],
    name: "fake-peer",
    timeoutMs: 3_000,
    env: { ...process.env, FAKE_PEER_LOG: logPath },
  });
  t.after(() => cdp.close());

  /** 读回对端收到的命令流:`[{method, params}]`。 */
  const commands = () =>
    fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const sp = line.indexOf(" ");
        return sp === -1
          ? { method: line, params: {} }
          : { method: line.slice(0, sp), params: JSON.parse(line.slice(sp + 1)) };
      });

  return { cdp, commands, dir };
}

/** 档案引擎簿记里的 `browserContextId`(listProfiles 不暴露它,这里走内部记录)。 */
function contextIdOf(session, profileId) {
  return session.archive.resolve(profileId)._browserContextId;
}

/** 用 `Fake.echo` 做一次"排水":管道按序处理,能收到它的响应就说明**之前的命令已被处理**。 */
async function drain(cdp) {
  await cdp.send("Fake.echo", { ping: 1 });
}

test("persona 用 disposeOnDetach:false,disposable 用 true", async (t) => {
  for (const [kind, expected] of [
    ["persona", false],
    ["disposable", true],
  ]) {
    const { cdp, commands, dir } = boot(t);
    const session = await openSessionProfiles({ cdp, kind, userDataDir: path.join(dir, "profile") });

    const created = commands().find((c) => c.method === "Target.createBrowserContext");
    assert.ok(created, `${kind} 必须建一个 browser context`);
    assert.equal(
      created.params.disposeOnDetach,
      expected,
      `${kind} 的 disposeOnDetach 应为 ${expected}(persona 要留、disposable 不留痕)`,
    );
    assert.ok(contextIdOf(session, session.sessionProfileId), `${kind} 的档案要有 browserContextId`);
  }
});

test("★ 同一会话里两条档案的 cookie 池互不可见", async (t) => {
  const { cdp, dir } = boot(t);
  const session = await openSessionProfiles({
    cdp,
    kind: "persona",
    userDataDir: path.join(dir, "profile"),
  });
  const realId = session.profiles.find((p) => p.isDefault)?.id;
  const personaId = session.sessionProfileId;
  assert.ok(realId, "会话里应有 real(isDefault)档案");
  assert.notEqual(realId, personaId, "persona 不该和 real 是同一个档案");
  assert.equal(session.profiles.length, 2, "给了档案目录 ⇒ 会话里是 real + persona 两条");

  const { api } = createOuUutRuntime({
    cdp,
    archive: session.archive,
    sessionProfileId: session.sessionProfileId,
  });

  await api.cookiesFor(realId).setCookies({ cookies: [{ name: "who", value: "REAL" }] });
  await api.cookiesFor(personaId).setCookies({ cookies: [{ name: "who", value: "PERSONA" }] });

  const real = (await api.cookiesFor(realId).getCookies()).cookies.map((c) => c.value);
  const persona = (await api.cookiesFor(personaId).getCookies()).cookies.map((c) => c.value);
  assert.deepEqual(real, ["REAL"], "real 只能看到自己的 cookie");
  assert.deepEqual(persona, ["PERSONA"], "persona 只能看到自己的 cookie");

  // 直接发 CDP 也一样:各自带各自的 browserContextId 才读得到
  const direct = await cdp.send("Storage.getCookies", {
    browserContextId: contextIdOf(session, personaId),
  });
  assert.deepEqual(direct.cookies.map((c) => c.value), ["PERSONA"]);
});

test("★ 不带 browserContextId 的 Storage.getCookies 被拦,且对端没收到", async (t) => {
  const { cdp, commands, dir } = boot(t);
  const session = await openSessionProfiles({
    cdp,
    kind: "persona",
    userDataDir: path.join(dir, "profile"),
  });
  const { api } = createOuUutRuntime({
    cdp,
    archive: session.archive,
    sessionProfileId: session.sessionProfileId,
  });

  const errors = [];
  api.onSendCDPMessageError = (payload, code) => errors.push({ payload, code });

  // 这就是 #319 的原样重现:脚本忘了带 browserContextId
  api.sendCDPMessage(JSON.stringify({ id: 9001, method: "Storage.getCookies", params: {} }));
  assert.equal(errors.length, 1, "应收到一次 onSendCDPMessageError");
  assert.equal(errors[0].code, ISOLATION_VIOLATION, "代号必须是档案引擎给的那个");
  assert.equal(
    commands().filter((c) => c.method === "Storage.getCookies").length,
    0,
    "被拦下的命令绝不能到达对端",
  );

  // 对照:带上**正确**的 browserContextId 照常到达 —— 证明上面的"没收到"不是日志机制失灵,
  // 也不是闸把正常用法一起挡死了。
  api.sendCDPMessage(
    JSON.stringify({
      id: 9002,
      method: "Storage.getCookies",
      params: { browserContextId: contextIdOf(session, session.sessionProfileId) },
    }),
  );
  await drain(cdp); // 对端按序处理:能回 echo ⇒ 上一条已经处理并记了日志
  assert.equal(
    commands().filter((c) => c.method === "Storage.getCookies").length,
    1,
    "合规的 cookie 命令必须照常到达",
  );
});

test("★ disposable 的 context 在 dispose() 后真被销毁;重复调用不炸", async (t) => {
  const { cdp, commands, dir } = boot(t);
  const session = await openSessionProfiles({
    cdp,
    kind: "disposable",
    userDataDir: path.join(dir, "profile"),
  });
  const ctxId = contextIdOf(session, session.sessionProfileId);

  const before = await cdp.send("Target.getBrowserContexts");
  assert.ok(before.browserContextIds.includes(ctxId), "dispose 之前 context 应该还在");

  await session.dispose();

  const after = await cdp.send("Target.getBrowserContexts");
  assert.ok(!after.browserContextIds.includes(ctxId), "dispose 之后 context 必须真被销毁");
  const disposeLines = commands().filter((c) => c.method === "Target.disposeBrowserContext");
  assert.equal(disposeLines.length, 1, "只该发一条销毁命令");
  assert.equal(disposeLines[0].params.browserContextId, ctxId);

  await session.dispose(); // 幂等:再调一次不该抛,也不该再发命令
  assert.equal(
    commands().filter((c) => c.method === "Target.disposeBrowserContext").length,
    1,
    "第二次 dispose 不该再发命令",
  );
});

test("★ persona 不在 dispose() 里被销毁(长期画像要留下)", async (t) => {
  const { cdp, commands, dir } = boot(t);
  const session = await openSessionProfiles({
    cdp,
    kind: "persona",
    userDataDir: path.join(dir, "profile"),
  });
  await session.dispose();
  assert.equal(
    commands().filter((c) => c.method === "Target.disposeBrowserContext").length,
    0,
    "persona 不销毁 —— 下一次还要用它养号",
  );
});

test("★ real:不建 context、不可创建、不可销毁,dispose() 也不碰它", async (t) => {
  const { cdp, commands, dir } = boot(t);
  const session = await openSessionProfiles({
    cdp,
    kind: "real",
    userDataDir: path.join(dir, "profile"),
  });

  assert.equal(session.profiles.length, 1, "real 会话里只有它自己一条");
  assert.equal(session.profiles[0].kind, "real");
  assert.equal(session.profiles[0].isDefault, true, "real 恒为 isDefault");
  assert.equal(
    commands().filter((c) => c.method === "Target.createBrowserContext").length,
    0,
    "real 用启动时那个默认 context,不该新建",
  );

  assert.throws(
    () => session.archive.createProfile({ id: "real-2", name: "假的真实档案", kind: "real" }),
    (e) => e instanceof ArchiveError && e.error_code === INVALID_ARGUMENT,
    "real 不能由 agent 创建",
  );
  assert.throws(
    () => session.archive.destroyProfile(session.sessionProfileId),
    (e) => e instanceof ArchiveError && e.error_code === INVALID_ARGUMENT,
    "real 不能销毁 —— 那是使用者的真实身份",
  );

  await session.dispose();
  assert.equal(
    commands().filter((c) => c.method === "Target.disposeBrowserContext").length,
    0,
    "dispose() 绝不能在 real 上动手",
  );
});

test("没给 --profile-kind 时:不建 context,default 与今天逐字段一致", async (t) => {
  const { cdp, commands } = boot(t);
  const session = await openSessionProfiles({ cdp, kind: null, userDataDir: null });

  assert.equal(session.archive, null, "没选 kind 就没有档案引擎(也就没有 cookie 闸)");
  assert.deepEqual(session.profiles, [{ id: "default", name: "默认档案", isDefault: true }]);
  assert.equal(commands().length, 0, "不该向浏览器发任何命令");
  await session.dispose(); // 空收尾也必须可调用
});

// ---- 按档案绑代理(F13)----------------------------------------------------

test("★ persona 的出口绑在 context 上(proxyServer + 绕过列表)", async (t) => {
  const { cdp, commands, dir } = boot(t);
  const proxy = "socks5://127.0.0.1:41105";
  const session = await openSessionProfiles({
    cdp, kind: "persona", userDataDir: path.join(dir, "profile"), proxy,
  });
  const created = commands().find((c) => c.method === "Target.createBrowserContext");
  assert.equal(created.params.proxyServer, proxy, "出口必须交给 createBrowserContext(不是浏览器级)");
  assert.ok(created.params.proxyBypassList.includes("<-loopback>"), "绕过列表要一起给");
  // 对外只暴露脱敏形式(没凭据时与原串相同)
  const listed = session.profiles.find((p) => p.id === session.sessionProfileId);
  assert.equal(listed.proxy, proxy);
});

test("★ 带凭据的代理:档案层直接**拒绝**(而不是留着一份用不上的口令)", async (t) => {
  // 2026-10-25 实测:Chromium 两条路都不收带凭据的代理串(坑-41),所以"把凭据存进档案、只对外脱敏"
  // 这个设计前提不成立了 —— 存了也用不上,还多一处口令落点。改成**共用校验**直接拒。
  const { cdp, commands, dir } = boot(t);
  let err = null;
  try {
    await openSessionProfiles({
      cdp, kind: "persona", userDataDir: path.join(dir, "profile"),
      proxy: "socks5://user:SECRET@proxy.example:1080",
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "带凭据的代理必须被拒");
  assert.equal(err.error_code, "OUUUT_PROXY_CREDENTIALS_UNSUPPORTED", `错误码要能分辨原因:${err.message}`);
  assert.ok(!err.message.includes("SECRET"), `拒绝的理由里也不许带口令:${err.message}`);
  assert.ok(/凭据|免认证/.test(err.message), `要说清怎么办:${err.message}`);
  assert.ok(
    !commands().some((c) => c.method === "Target.createBrowserContext"),
    "被拒时要**先拒后动**:不该已经建了带代理的 context(那等于先把口令交给浏览器)",
  );
});

test("★ real + 代理:必须报错,不许静默忽略(默认 context 挂不了 context 级代理)", async (t) => {
  const { cdp, dir } = boot(t);
  await assert.rejects(
    () => openSessionProfiles({ cdp, kind: "real", userDataDir: path.join(dir, "profile"), proxy: "socks5://p:1080" }),
    (e) => /默认 browser context/.test(e.message),
    "静默忽略会让人以为绑上了",
  );
});
