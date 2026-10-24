// native/binding/cdp-pipe.test.mjs —— 通道层的验收(跑在**真 pipe** 上)
//
// 运行:node --test native/binding/cdp-pipe.test.mjs
//
// 这一层最容易错的是**分帧**与**收尾**,所以用例专挑:
//   * 一条消息被拆成多个 chunk
//   * 多条消息挤在一次 write 里
//   * 事件与响应混在一条流上
//   * 对端不回应(超时)、发非法 JSON、写一半就死、直接退出
// 这些都是真实流量里会出现的情况,不是为测试造的假设。

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { spawnCdpPipe, createMessageSplitter, CdpPipeError } from "./cdp-pipe.mjs";

const PEER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cdp-peer.mjs");

function start(timeoutMs = 3_000) {
  return spawnCdpPipe({
    exe: process.execPath,
    args: [PEER],
    name: "fake-peer",
    timeoutMs,
  });
}

test("朴素往返:请求能拿到对应响应", async (t) => {
  const cdp = start();
  t.after(() => cdp.close());
  const res = await cdp.send("Fake.echo", { a: 1, b: "二" });
  assert.deepEqual(res, { echo: { a: 1, b: "二" } });
});

test("一条响应被拆成多个 chunk 也要能拼回来", async (t) => {
  const cdp = start();
  t.after(() => cdp.close());
  const res = await cdp.send("Fake.split");
  assert.equal(res.split, true);
  assert.equal(res.whole.length, 300, "被拆开的那条消息内容必须完整");
});

test("一次写入里的多条消息不能互相吞掉", async (t) => {
  const cdp = start();
  t.after(() => cdp.close());
  const seen = [];
  const off = cdp.onMessage((m) => seen.push(m.method));
  const res = await cdp.send("Fake.glued");
  off();
  assert.deepEqual(res, { first: true }, "响应要解析出来");
  assert.deepEqual(seen, ["Fake.anEvent"], "同一次写入里的那条事件也要解析出来");
});

test("事件不会把待处理请求解错", async (t) => {
  const cdp = start();
  t.after(() => cdp.close());
  const events = [];
  cdp.onMessage((m) => events.push(m.params?.seq));
  const res = await cdp.send("Fake.eventThenReply");
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(events, [1, 2]);
});

test("CDP 错误 → reject,且 error_code 透传", async (t) => {
  const cdp = start();
  t.after(() => cdp.close());
  await assert.rejects(
    () => cdp.send("Fake.error"),
    (err) => {
      assert.ok(err instanceof CdpPipeError);
      assert.equal(err.error_code, "OUUUT_TEST_FAILURE", "上游给的 error_code 不能被吃掉");
      assert.match(err.message, /故意失败/);
      return true;
    },
  );
});

test("对端不回应 → 超时 reject(而且不会挂着不放)", async (t) => {
  const cdp = start(300);
  t.after(() => cdp.close());
  await assert.rejects(() => cdp.send("Fake.silent"), /超时/);
  // 超时之后通道**仍然可用** —— 一条请求超时不等于通道坏了
  const res = await cdp.send("Fake.echo", { after: "timeout" });
  assert.deepEqual(res, { echo: { after: "timeout" } });
});

test("非法 JSON → 未完成请求全部作废,并给出通道级错误", async (t) => {
  const cdp = start(2_000);
  t.after(() => cdp.close());
  const doomed = cdp.send("Fake.garbage");
  await assert.rejects(() => doomed, /非法 JSON/);
});

test("对端写一半就死 → 未完成请求被拒,并报出残留", async (t) => {
  const cdp = start(2_000);
  t.after(() => cdp.close());
  await assert.rejects(() => cdp.send("Fake.halfThenExit"), /退出|写完一条消息前/);
});

test("对端退出后:再发请求立刻拒绝,且带 CLOSED 代号", async (t) => {
  const cdp = start(2_000);
  t.after(() => cdp.close());
  await assert.rejects(() => cdp.send("Fake.exit"), /退出/);
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(
    () => cdp.send("Fake.echo", {}),
    (err) => {
      assert.equal(err.error_code, "OUUUT_CDP_PIPE_CLOSED");
      return true;
    },
  );
});

test("close() 之后不留活着的子进程", async (t) => {
  const cdp = start();
  const child = cdp.child;
  await cdp.send("Fake.echo", {});
  await cdp.close();
  assert.ok(child.exitCode !== null || child.signalCode !== null, "子进程必须已经结束");
  assert.equal(cdp.closed, true);
});

test("分帧器:边界用例(空消息、连续分隔符、跨 chunk 的 UTF-8)", () => {
  const got = [];
  const s = createMessageSplitter((m) => got.push(m));
  const gb = Buffer.from("汉字", "utf8");

  s.push(Buffer.from("{\"a\":1}\0", "utf8"));
  s.push(Buffer.from("\0\0", "utf8")); // 连续分隔符 → 只有空消息,应被跳过
  // 把一个多字节字符**切开**跨两个 chunk
  s.push(Buffer.concat([Buffer.from("{\"b\":\"", "utf8"), gb.subarray(0, 2)]));
  s.push(Buffer.concat([gb.subarray(2), Buffer.from("\"}\0", "utf8")]));

  assert.deepEqual(got, ['{"a":1}', '{"b":"汉字"}']);
  assert.equal(s.end(), "");
});

// ---- 诊断:对端死了要能**直接读懂**(坑-29 的产物)---------------------------
//
// 起因:`--remote-debugging-pipe` 让浏览器启动阶段退 0 且零输出,
// 而当时的报错只有 `退出(code=0)` —— 从这句话里推不出任何东西,白花两小时。
// 下面两条就是守着"以后不用再花那两小时"。

test("★ 诊断:对端**启动阶段**退 0 且零输出 → 报错要明说这一点", async (t) => {
  const cdp = spawnCdpPipe({
    exe: process.execPath,
    args: ["-e", "process.exit(0)"],
    name: "佯死对端",
    timeoutMs: 2_000,
  });
  t.after(() => cdp.close().catch(() => {}));

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(cdp.closed, true, "对端应该已经退了");
  assert.deepEqual(cdp.exitInfo, { code: 0, signal: null });

  const d = cdp.diagnoseExit();
  assert.match(d, /存活 \d+ ms/, "要带上活了多久 —— 这是区分『启动失败』与『运行期崩』的关键");
  assert.match(d, /启动阶段/, "必须点明是启动阶段");
  assert.match(d, /没有任何输出/, "必须点明零输出 —— 这正是『开关不被支持』的特征");
  assert.match(d, /启动参数/, "要带上启动参数,省得再去翻代码");
});

test("★ 诊断:对端有 stderr → 把 stderr 带上(那通常就是原因)", async (t) => {
  const cdp = spawnCdpPipe({
    exe: process.execPath,
    args: ["-e", "process.stderr.write('BOOM-原因在此\\n'); process.exit(3)"],
    name: "带输出的对端",
    timeoutMs: 2_000,
  });
  t.after(() => cdp.close().catch(() => {}));

  await new Promise((r) => setTimeout(r, 500));
  const d = cdp.diagnoseExit();
  assert.match(d, /code=3/, "退出码要在");
  assert.match(d, /BOOM-原因在此/, "stderr 必须在报错里 —— 否则还得自己去接");
  assert.ok(!/没有任何输出/.test(d), "有输出时不该说『没有任何输出』");
});

test("★ 诊断:对端死了之后再发命令,报错也带诊断(而不是光一句『已退出』)", async (t) => {
  const cdp = spawnCdpPipe({
    exe: process.execPath,
    args: ["-e", "process.exit(0)"],
    name: "佯死对端",
    timeoutMs: 2_000,
  });
  t.after(() => cdp.close().catch(() => {}));
  await new Promise((r) => setTimeout(r, 500));

  await assert.rejects(
    () => cdp.send("Page.enable", {}),
    (e) => {
      assert.equal(e.error_code, "OUUUT_CDP_PIPE_CLOSED");
      assert.match(e.message, /启动阶段/, "send 的报错也要能读懂");
      return true;
    },
  );
  assert.throws(
    () => cdp.sendRaw({ id: 1, method: "Page.enable" }),
    (e) => /启动阶段/.test(e.message),
  );
});
