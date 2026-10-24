// native/binding/archive.test.mjs —— 档案引擎的验收
//
//   node --test native/binding/archive.test.mjs
//
// 这一段测试的核心不是"调用不抛异常",而是:**隔离真的在拦**。
// 所以下面搭了一个**假浏览器**,它真的持有多个档案的 cookie 池 ——
// 于是"泄漏"是可观测的,而不是靠断言某个函数被调用过。

import test from "node:test";
import assert from "node:assert/strict";

import {
  createArchive,
  KINDS,
  ISOLATION_VIOLATION,
  PROFILE_NOT_FOUND,
  ArchiveError,
  COOKIE_CDP_METHODS,
} from "./archive.mjs";

// ---- 假浏览器:真的按档案分池存 cookie -------------------------------------
//
// 关键点:它**直到收到 browserContextId 才决定去哪个池**。
// 没给参数时,它落到 `default` 池 —— 这正是 Chrome 的行为,
// 也正是 ego #319 里那 1,105 个 cookie 的来源。
function fakeBrowser(seed = {}) {
  const pools = new Map(Object.entries(seed));
  const log = [];
  return {
    log,
    pools,
    send(method, params = {}) {
      const ctx = params.browserContextId ?? "default";
      log.push({ method, ctx });
      if (!pools.has(ctx)) pools.set(ctx, []);
      const pool = pools.get(ctx);
      if (method === "Storage.getCookies") {
        return { cookies: pool.slice() };
      }
      if (method === "Storage.setCookies") {
        pool.push(...(params.cookies ?? []));
        return {};
      }
      if (method === "Storage.clearCookies") {
        pools.set(ctx, []);
        return {};
      }
      return {};
    },
  };
}

const THREE = [
  { id: "real-1", name: "我的浏览器", kind: "real", browserContextId: "default" },
  { id: "p-alice", name: "Alice 画像", kind: "persona", browserContextId: "ctx-alice" },
  { id: "d-tmp1", name: "临时 1", kind: "disposable", browserContextId: "ctx-tmp1" },
];

function fresh() {
  const browser = fakeBrowser({
    default: [{ name: "sessid", value: "REAL_SECRET" }],
    "ctx-alice": [{ name: "sessid", value: "ALICE" }],
    "ctx-tmp1": [],
  });
  const archive = createArchive({ profiles: THREE });
  return { archive, browser };
}

// ---- 先证明"假浏览器 + 朴素写法"确实会泄漏 ---------------------------------
//
// 这一条是整组测试的**地基**:如果连朴素写法都不泄漏,那下面的"拦住了"就没有意义。
test("地基:绕过档案引擎的朴素写法**真的会泄漏**(所以隔离值得测)", () => {
  const { browser } = fresh();
  // 脚本以为自己绑在 alice 上,但发命令时忘了带 browserContextId
  const naive = browser.send("Storage.getCookies", {});
  assert.equal(naive.cookies.length, 1);
  assert.equal(naive.cookies[0].value, "REAL_SECRET", "没带参数就落到了默认(real)档案 —— 这就是 #319");
});

// ---- 三种 kind 落地 --------------------------------------------------------

test("三种 kind 都在,且 listProfiles 的对外形状满足 harness 的逐字段校验", () => {
  const { archive } = fresh();
  const { profiles } = archive.listProfiles();
  assert.equal(profiles.length, 3);
  for (const p of profiles) {
    assert.equal(typeof p.id, "string");
    assert.equal(typeof p.name, "string");
    assert.equal(typeof p.isDefault, "boolean");
    assert.ok(KINDS.includes(p.kind), `kind 必须是三种之一,得到 ${p.kind}`);
  }
  assert.deepEqual(
    profiles.map((p) => p.kind).sort(),
    ["disposable", "persona", "real"],
  );
});

test("real 恒为 isDefault(由 kind 推导,不接受调用方自己传)", () => {
  const { archive } = fresh();
  const real = archive.listProfiles().profiles.find((p) => p.kind === "real");
  assert.equal(real.isDefault, true);
  // 即便传了矛盾的 isDefault 也无效
  const a2 = createArchive({ profiles: [{ id: "r", name: "R", kind: "real", isDefault: false }] });
  assert.equal(a2.listProfiles().profiles[0].isDefault, true);
});

test("real 只能有一个(启动即查,不留到运行时)", () => {
  assert.throws(
    () =>
      createArchive({
        profiles: [
          { id: "a", name: "A", kind: "real" },
          { id: "b", name: "B", kind: "real" },
        ],
      }),
    /只能有一个 real/,
  );
});

test("kind 不合法 → 拒绝", () => {
  assert.throws(
    () => createArchive({ profiles: [{ id: "x", name: "X", kind: "tmp" }] }),
    /不合法/,
  );
});

// ---- real 的不可变性 -------------------------------------------------------

test("real 不许创建", () => {
  const { archive } = fresh();
  assert.throws(() => archive.createProfile({ id: "r2", name: "假的我", kind: "real" }), /不能由 agent 创建/);
});

test("real 不许销毁 —— 使用者的真实身份不能被 agent 抹掉", () => {
  const { archive } = fresh();
  assert.throws(() => archive.destroyProfile("real-1"), /禁止/);
  assert.equal(archive.listProfiles().profiles.length, 3, "real 还在");
});

test("persona / disposable 可创建可销毁;销毁后不可再用", () => {
  const { archive } = fresh();
  archive.createProfile({ id: "p-bob", name: "Bob", kind: "persona" });
  assert.equal(archive.listProfiles().profiles.length, 4);
  archive.destroyProfile("p-bob");
  assert.equal(archive.listProfiles().profiles.length, 3);
  assert.throws(() => archive.resolve("p-bob"), (e) => e.error_code === PROFILE_NOT_FOUND);

  // 销毁只是"这一条没了",同一个 id **可以**重新建(一次性档案用完即弃、再建新的)
  archive.createProfile({ id: "p-bob", name: "Bob 二世", kind: "persona" });
  assert.equal(archive.resolve("p-bob").name, "Bob 二世");
  assert.equal(archive.listProfiles().profiles.length, 4);
});

// ---- ★ 硬隔离:第一层,句柄 ------------------------------------------------

test("★ 句柄层:browserContextId 由句柄自动注入,所以只读到本档案的 cookie", () => {
  const { archive, browser } = fresh();
  const c = archive.cookiesFor("p-alice", (m, p) => browser.send(m, p));
  const got = c.getCookies();
  assert.equal(got.cookies.length, 1);
  assert.equal(got.cookies[0].value, "ALICE", "必须只看到 alice 自己的");
  assert.ok(
    !got.cookies.some((x) => x.value === "REAL_SECRET"),
    "绝不能看到 real 档案的 cookie",
  );
  assert.equal(browser.log.at(-1).ctx, "ctx-alice");
});

test("★ 句柄层:调用方硬塞 browserContextId 也无效(覆盖式注入)", () => {
  const { archive, browser } = fresh();
  const c = archive.cookiesFor("p-alice", (m, p) => browser.send(m, p));
  const got = c.getCookies({ browserContextId: "default" }); // 想偷看 real
  assert.equal(got.cookies[0].value, "ALICE", "被句柄改写回自己的档案");
});

test("★ 句柄层:跨档案写也进不去别人的池", () => {
  const { archive, browser } = fresh();
  const c = archive.cookiesFor("p-alice", (m, p) => browser.send(m, p));
  c.setCookies({ cookies: [{ name: "injected", value: "X" }], browserContextId: "default" });
  assert.ok(
    !browser.pools.get("default").some((x) => x.name === "injected"),
    "real 档案的池必须没被污染",
  );
  assert.ok(browser.pools.get("ctx-alice").some((x) => x.name === "injected"));
});

test("句柄的 API 面**恰好**是这几个 —— 没有能指向别处的入口", () => {
  const { archive, browser } = fresh();
  const c = archive.cookiesFor("p-alice", (m, p) => browser.send(m, p));
  assert.deepEqual(Object.keys(c).sort(), [
    "browserContextId",
    "clearCookies",
    "getCookies",
    "kind",
    "profileId",
    "setCookies",
  ]);
  // 句柄是冻结的:调用方无法给它换一个 browserContextId / 换一个 send
  assert.throws(() => { c.browserContextId = "default"; }, TypeError);
  assert.equal(c.browserContextId, "ctx-alice", "改不动");
});

// ---- ★ 硬隔离:第二层,发送侧闸 --------------------------------------------

test("★ 闸层:这是 #319 的原样重现 —— 省略 browserContextId 必须被拦", () => {
  const { archive } = fresh();
  archive.bindTaskSpace("ts-1", "p-alice");
  assert.throws(
    () => archive.checkCookieCommand({ sessionProfileId: "p-alice", method: "Storage.getCookies", params: {} }),
    (e) => {
      assert.ok(e instanceof ArchiveError);
      assert.equal(e.error_code, ISOLATION_VIOLATION, "代号必须精确等于 OUUUT_PROFILE_ISOLATION_VIOLATION");
      return true;
    },
  );
});

test("★ 闸层:指向别的档案被拦(读和写都要拦)", () => {
  const { archive } = fresh();
  for (const method of ["Storage.getCookies", "Storage.setCookies", "Network.getAllCookies"]) {
    assert.throws(
      () => archive.checkCookieCommand({ sessionProfileId: "p-alice", method, params: { browserContextId: "default" } }),
      (e) => e.error_code === ISOLATION_VIOLATION,
      `${method} 必须被拦`,
    );
  }
});

test("★ 闸层:指向自己的档案 → 放行(闸不能连正常用法一起挡)", () => {
  const { archive } = fresh();
  const r = archive.checkCookieCommand({
    sessionProfileId: "p-alice",
    method: "Storage.getCookies",
    params: { browserContextId: "ctx-alice" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.browserContextId, "ctx-alice");
});

test("闸层:非 cookie 方法不受影响(不误伤)", () => {
  const { archive } = fresh();
  for (const m of ["Page.navigate", "Runtime.evaluate", "Snapshot.captureSnapshot", "Target.getTargets"]) {
    const r = archive.checkCookieCommand({ sessionProfileId: "p-alice", method: m, params: {} });
    assert.equal(r.ok, true, `${m} 不该被 cookie 闸拦`);
  }
});

test("闸层:每一个登记在册的 cookie 方法都被真的挡过一遍(没有漏网名单)", () => {
  const { archive } = fresh();
  for (const method of COOKIE_CDP_METHODS) {
    assert.throws(
      () => archive.checkCookieCommand({ sessionProfileId: "p-alice", method, params: {} }),
      (e) => e.error_code === ISOLATION_VIOLATION,
      `${method} 没被拦 —— 隔离会静默失效`,
    );
  }
});

// ---- 绑定 ------------------------------------------------------------------

test("档案在建空间时绑定(上游如此)", () => {
  const { archive } = fresh();
  assert.throws(
    () => archive.boundProfileOf("ts-9"),
    (e) => e.error_code === ISOLATION_VIOLATION,
    "未绑定的空间绝不能读 cookie —— 那就落到默认档案了",
  );
  archive.bindTaskSpace("ts-9", "d-tmp1");
  assert.equal(archive.boundProfileOf("ts-9").id, "d-tmp1");
});

test("绑不存在的档案 → EGO_PROFILE_NOT_FOUND", () => {
  const { archive } = fresh();
  assert.throws(
    () => archive.bindTaskSpace("ts-1", "nope"),
    (e) => e.error_code === PROFILE_NOT_FOUND,
  );
});

test("销毁档案会清掉指向它的绑定(不留悬空绑定)", () => {
  const { archive } = fresh();
  archive.bindTaskSpace("ts-1", "d-tmp1");
  archive.destroyProfile("d-tmp1");
  assert.equal(archive.bindings().has("ts-1"), false);
  assert.throws(() => archive.boundProfileOf("ts-1"), (e) => e.error_code === ISOLATION_VIOLATION);
});

// ---- 端到端:两个档案互不串味 ----------------------------------------------

test("★ 端到端:两个 persona 并行跑,各自只看到自己的 cookie", () => {
  const { archive, browser } = fresh();
  archive.createProfile({ id: "p-bob", name: "Bob", kind: "persona", browserContextId: "ctx-bob" });
  browser.pools.set("ctx-bob", [{ name: "sessid", value: "BOB" }]);

  const send = (m, p) => browser.send(m, p);
  const alice = archive.cookiesFor("p-alice", send);
  const bob = archive.cookiesFor("p-bob", send);

  for (let i = 0; i < 20; i += 1) {
    assert.equal(alice.getCookies().cookies[0].value, "ALICE");
    assert.equal(bob.getCookies().cookies[0].value, "BOB");
  }
  // 两个池各自独立,谁也没写进谁
  assert.equal(browser.pools.get("ctx-alice").length, 1);
  assert.equal(browser.pools.get("ctx-bob").length, 1);
  assert.equal(browser.pools.get("default").length, 1, "real 池始终 1 条,没被污染");
});

test("★ 端到端:用闸 + 句柄两条路走同一个假浏览器,一次都不许落到 default", () => {
  const { archive, browser } = fresh();
  archive.bindTaskSpace("ts-1", "p-alice");
  const send = (m, p) => browser.send(m, p);

  // 正常路径 20 次
  const c = archive.cookiesFor("p-alice", send);
  for (let i = 0; i < 20; i += 1) c.getCookies();

  // 攻击路径 20 次,每次都必须被拦
  for (let i = 0; i < 20; i += 1) {
    assert.throws(() =>
      archive.checkCookieCommand({ sessionProfileId: "p-alice", method: "Storage.getCookies", params: {} }),
    );
  }

  assert.ok(
    browser.log.every((e) => e.ctx === "ctx-alice"),
    "整个日志里没有一条命令落到 default —— real 档案全程没被碰过",
  );
});
