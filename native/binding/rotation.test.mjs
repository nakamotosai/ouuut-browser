// native/binding/rotation.test.mjs —— 租约的验收
//
// 规矩:每条都打**真**行为,不打"函数被调用了"。所以这里没有 mock,
// 文件租约表用真的临时目录,跨进程互斥用"两张真 handle 读同一个文件"来验。

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PoolError,
  ROTATION_UNIT,
  isProcessAlive,
  openPool,
  parsePool,
  pickNode,
  reclaimStaleLeases,
} from "./rotation.mjs";

const NODE_A = { id: "jp-a", url: "socks5://198.51.100.7:41105", egressIp: "161.33.5.222", country: "JP" };
const NODE_B = { id: "jp-b", url: "socks5://198.51.100.7:41106", egressIp: "161.33.5.223", country: "JP" };
const ROTATOR = { id: "resin", url: "socks5://saaaai:hunter2@198.51.100.7:2260", sticky: false };

async function tmpStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ouuut-pool-"));
  return path.join(dir, "leases.json");
}

const codeOf = (err) => (err instanceof PoolError ? err.code : `不是 PoolError:${err.message}`);
const throws = (fn, code) => {
  try {
    fn();
  } catch (err) {
    assert.equal(codeOf(err), code);
    return err;
  }
  throw new Error(`本该抛 ${code},却没事`);
};

test("★ 旋转端点(每连接换 IP)拒绝入池 —— ADR-013 的第一条规矩在代码里", () => {
  const err = throws(() => parsePool({ nodes: [NODE_A, ROTATOR] }), "OUUUT_POOL_ROTATING_NOT_ALLOWED");
  assert.match(err.message, /ADR-013/, "错误里要指明依据,别让人去猜");
  assert.match(err.message, /一次会话一个出口/);
});

test("★ 带认证的节点必须显式 verifiedSticky:true(ADR-013:先验过 STICKY 再入池)", () => {
  const auth = { id: "x", url: "socks5://user:pw@10.0.0.1:1080" };
  const err = throws(() => parsePool({ nodes: [auth] }), "OUUUT_POOL_UNVERIFIED_STICKY");
  assert.match(err.message, /scan_pinned_egress\.py/);
  assert.ok(!err.message.includes("pw"), "错误信息里**不许**出现密码");
  assert.ok(!err.message.includes("user"), "用户名也一并藏掉(redactProxy 的已定行为)");
  assert.ok(err.message.includes("socks5://***@10.0.0.1:1080"), "只留 host:port,好在日志里认得出是哪条节点");
  const ok = parsePool({ nodes: [{ ...auth, verifiedSticky: true }] });
  assert.equal(ok.nodes[0].verifiedSticky, true);
  // ★ 脱敏要管**整个节点对象**,不只是错误信息:凭据进了对象,
  //   总有一天会被某个 console.log(pool) 带出去。
  const dump = JSON.stringify(ok);
  assert.ok(!dump.includes("pw"), `序列化之后不该有密码:${dump}`);
  assert.ok(!dump.includes("user"), `序列化之后不该有用户名:${dump}`);
  assert.ok(dump.includes("socks5://***@10.0.0.1:1080"), "打印出来的是脱敏形式(F13 的验收:grep 无凭据)");
  assert.equal(ok.nodes[0].proxy, "socks5://user:pw@10.0.0.1:1080", "给进程用的那份必须是能连的原值");
  assert.equal(ok.nodes[0].redacted, "socks5://***@10.0.0.1:1080", "给人看的那份必须脱敏");
});

test("池规格的其它坏形状:空池 / 重 id / 非 socks5 / 无法解析", () => {
  throws(() => parsePool({ nodes: [] }), "OUUUT_POOL_BAD_SPEC");
  throws(() => parsePool({ nodes: [NODE_A, NODE_A] }), "OUUUT_POOL_BAD_SPEC");
  throws(() => parsePool({ nodes: [{ id: "h", url: "http://10.0.0.1:3128" }] }), "OUUUT_POOL_BAD_SPEC");
  throws(() => parsePool({ nodes: [{ id: "" }] }), "OUUUT_POOL_BAD_SPEC");
  throws(() => parsePool({ nodes: [NODE_A, ROTATOR] }), "OUUUT_POOL_ROTATING_NOT_ALLOWED");
});

test("★ 独占:两个档案不发同一个出口(共用出口=把两个身份连起来)", () => {
  const pool = parsePool({ nodes: [NODE_A, NODE_B] });
  const store = { leases: {}, pins: {}, dead: {} };
  const one = pickNode({ pool, store, profileId: "p1", kind: "disposable", pid: process.pid });
  store.leases[one.node.id] = { profileId: "p1", kind: "disposable", pid: process.pid, startedAt: 1 };
  const two = pickNode({ pool, store, profileId: "p2", kind: "disposable", pid: process.pid });
  assert.notEqual(one.node.id, two.node.id, "两条档案必须落在不同节点上");
});

test("★ 挑不出来就**抛**,不返回 null(免得调用方默默直连)", () => {
  const pool = parsePool({ nodes: [NODE_A] });
  const store = { leases: {}, pins: {}, dead: {} };
  store.leases[NODE_A.id] = { profileId: "p1", pid: process.pid, startedAt: 1 };
  const err = throws(() => pickNode({ pool, store, profileId: "p2", pid: process.pid }), "OUUUT_POOL_EXHAUSTED");
  assert.match(err.message, /宁可不开/);
  assert.match(err.message, /--pool-reuse/, "要告诉人怎么打破独占");
});

test("显式 --pool-reuse 才复用(而且标出 reused,好在诊断里标红)", () => {
  const pool = parsePool({ nodes: [NODE_A] });
  const store = { leases: { [NODE_A.id]: { profileId: "p1", pid: process.pid, startedAt: 1 } }, pins: {}, dead: {} };
  const picked = pickNode({ pool, store, profileId: "p2", pid: process.pid, reuse: true });
  assert.equal(picked.node.id, NODE_A.id);
  assert.equal(picked.reused, true);
});

test("全部节点被隔离 ⇒ 也抛(且说清是「都被隔离了」)", () => {
  const pool = parsePool({ nodes: [NODE_A] });
  const store = { leases: {}, pins: {}, dead: { [NODE_A.id]: { at: 1, reason: "出口量不到" } } };
  const err = throws(() => pickNode({ pool, store, profileId: "p2", pid: process.pid }), "OUUUT_POOL_EXHAUSTED");
  assert.match(err.message, /所有节点都被隔离了/);
});

test("★ persona 钉住出口:同一个档案下次进来还领**同一条**节点", () => {
  const pool = parsePool({ nodes: [NODE_A, NODE_B] });
  const store = { leases: {}, pins: {}, dead: {} };
  const first = pickNode({ pool, store, profileId: "老张", kind: "persona", pid: process.pid });
  store.leases[first.node.id] = { profileId: "老张", pid: process.pid, startedAt: 1 };
  store.pins["老张"] = first.node.id;
  delete store.leases[first.node.id]; // 会话结束,还了
  const second = pickNode({ pool, store, profileId: "老张", kind: "persona", pid: process.pid });
  assert.equal(second.node.id, first.node.id, "长期身份不许换出口");
  assert.equal(second.pinned, true);
});

test("★ persona 钉住的节点坏了 ⇒ 拒绝启动,绝不偷偷换一条", () => {
  const pool = parsePool({ nodes: [NODE_A, NODE_B] });
  const store = { leases: {}, pins: { "老张": NODE_A.id }, dead: { [NODE_A.id]: { at: 1, reason: "出口挂了" } } };
  const err = throws(() => pickNode({ pool, store, profileId: "老张", kind: "persona", pid: process.pid }), "OUUUT_POOL_NODE_QUARANTINED");
  assert.match(err.message, /不许静默换出口/);
  const gone = throws(
    () => pickNode({ pool, store: { leases: {}, pins: { "老张": "jp-zzz" }, dead: {} }, profileId: "老张", kind: "persona", pid: process.pid }),
    "OUUUT_POOL_NODE_GONE",
  );
  assert.match(gone.message, /jp-zzz/);
});

test("persona 钉的节点被别的会话占着 ⇒ 也拒绝(不共享出口)", () => {
  const pool = parsePool({ nodes: [NODE_A] });
  const store = { leases: { [NODE_A.id]: { profileId: "别人", pid: process.pid, startedAt: 1 } }, pins: { "老张": NODE_A.id }, dead: {} };
  throws(() => pickNode({ pool, store, profileId: "老张", kind: "persona", pid: process.pid }), "OUUUT_POOL_PINNED_BUSY");
});

test("别的进程崩了 ⇒ 它的租约可回收(不能把池子永久占死)", () => {
  const pool = parsePool({ nodes: [NODE_A] });
  const store = { leases: { [NODE_A.id]: { profileId: "p1", pid: 0, startedAt: 1 } }, pins: {}, dead: {} };
  assert.equal(isProcessAlive(0), false, "0 不是活进程");
  assert.equal(reclaimStaleLeases(store), true);
  assert.deepEqual(store.leases, {});
  const picked = pickNode({ pool, store, profileId: "p2", pid: process.pid });
  assert.equal(picked.node.id, NODE_A.id, "回收之后该节点又要能用");
  // 活着的进程不许被回收
  store.leases[NODE_A.id] = { profileId: "p9", pid: process.pid, startedAt: 2 };
  assert.equal(reclaimStaleLeases(store), false);
  assert.equal(store.leases[NODE_A.id].profileId, "p9");
});

test("同一个档案 id 反复挑 ⇒ 落同一条节点(不掷骰子)", () => {
  const pool = parsePool({ nodes: [NODE_A, NODE_B] });
  const pick = () => pickNode({ pool, store: { leases: {}, pins: {}, dead: {} }, profileId: "p-stable", pid: process.pid }).node.id;
  assert.equal(pick(), pick());
});

test("★ 租约表落盘:两个进程(=两张 handle)读同一个文件,出口也不会撞", async (t) => {
  const file = await tmpStore();
  t.after(() => fsp.rm(path.dirname(file), { recursive: true, force: true }));
  const spec = { nodes: [NODE_A] };

  const a = await openPool({ file, spec });
  const b = await openPool({ file, spec });
  const got = await a.assign({ profileId: "p1", kind: "disposable" });
  assert.equal(got.node.id, NODE_A.id);

  // b 是"另一个进程":它必须**看得见** a 的租约
  const seen = await b.snapshot();
  assert.equal(seen.leases[NODE_A.id].profileId, "p1");
  await assert.rejects(() => b.assign({ profileId: "p2", kind: "disposable" }), (err) => codeOf(err) === "OUUUT_POOL_EXHAUSTED");

  // 还了之后另一个进程就能领
  assert.equal(await a.release({ profileId: "p1" }), 1);
  const got2 = await b.assign({ profileId: "p2", kind: "disposable" });
  assert.equal(got2.node.id, NODE_A.id);

  // 隔离:下次分配跳过它
  await b.markDead({ nodeId: NODE_A.id, reason: "出口量不到", evidence: "measureEgressIp 超时" });
  await assert.rejects(() => a.assign({ profileId: "p3", kind: "disposable" }), (err) => codeOf(err) === "OUUUT_POOL_EXHAUSTED");
  const snap = await a.snapshot();
  assert.equal(snap.dead[NODE_A.id].reason, "出口量不到");
  assert.equal(snap.dead[NODE_A.id].evidence, "measureEgressIp 超时");
  assert.deepEqual(snap.leases, {}, "隔离时顺手把租约放掉(那条节点已经不干净了)");
});

test("persona 的钉子也落盘:重启后还是同一条节点", async (t) => {
  const file = await tmpStore();
  t.after(() => fsp.rm(path.dirname(file), { recursive: true, force: true }));
  const spec = { nodes: [NODE_A, NODE_B] };
  const a = await openPool({ file, spec });
  const first = await a.assign({ profileId: "老张", kind: "persona" });
  await a.release({ profileId: "老张" });
  const reopened = await openPool({ file, spec }); // 模拟"下次进程"
  const again = await reopened.assign({ profileId: "老张", kind: "persona" });
  assert.equal(again.node.id, first.node.id, "跨进程也要钉住同一个出口");
  assert.equal((await reopened.snapshot()).pins["老张"], first.node.id);
});

test("池文件本身也是合法规格来源(与 spec 二选一)", async (t) => {
  const file = await tmpStore();
  t.after(() => fsp.rm(path.dirname(file), { recursive: true, force: true }));
  await fsp.writeFile(file, JSON.stringify({ nodes: [NODE_A, ROTATOR] }), "utf8");
  await assert.rejects(() => openPool({ file }), (err) => codeOf(err) === "OUUUT_POOL_ROTATING_NOT_ALLOWED");
  await fsp.writeFile(file, JSON.stringify({ nodes: [NODE_A] }), "utf8");
  const h = await openPool({ file });
  assert.equal(h.pool.nodes.length, 1);
});

test("★ 规格文件不许被租约表覆盖(曾经的真 bug:第一次 assign 就把规格写成了租约)", async (t) => {
  const file = await tmpStore();
  t.after(() => fsp.rm(path.dirname(file), { recursive: true, force: true }));
  const specText = JSON.stringify({ nodes: [NODE_A, NODE_B] }, null, 2);
  await fsp.writeFile(file, specText, "utf8");
  const h = await openPool({ file });
  await h.assign({ profileId: "p1", kind: "disposable" });
  assert.equal(await fsp.readFile(file, "utf8"), specText, "规格文件必须**原样不动**");
  assert.ok((await fsp.readFile(`${file}.leases.json`, "utf8")).includes("p1"), "租约要落在旁边那个文件里");
});

test("轮换单位只有一种说法(免得文档和代码各说各的)", () => {
  assert.match(ROTATION_UNIT, /一个档案的一次会话/);
});