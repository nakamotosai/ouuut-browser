// native/binding/fixtures/fake-cdp-peer.mjs —— **测试替身**,不是产品代码
//
// 它在**真 pipe** 上扮演一个 CDP 对端:从 fd 3 读、往 fd 4 写,帧格式与 Chrome 的
// `--remote-debugging-pipe` 一致(NUL 分隔的 JSON)。
//
// 存在的意义:`native/binding/cdp-pipe.mjs` 的正确性(分帧、超时、错误、退出)
// **不应该依赖「能不能起一个真的 Chromium」**。有了这个替身,通道层可以在任何机器上
// 被完整验证;真浏览器那一步只验证"协议一致",不验证"通道写对了没有"。
//
// 按方法名做出各种**故意难为对方**的行为(拆包、粘包、非法 JSON、不回应、直接退出)——
// 这些都是真实流量里会发生的。

import fs from "node:fs";

const NUL = 0x00;
const OUT = 4; // 子进程往 fd 4 写 = 父进程读
const IN = 3; // 父进程往 fd 3 写 = 子进程读

// ⚠️ 本对端**不能用 `process.exit()` 结束自己**(2026-10-24 实测,Node 22 / Windows):
//   只要 fd 3 上挂着一个待决的读(`createReadStream(...).on("data")` 或 `fs.read` 回调递归),
//   `process.exit(7)` 与 `process.reallyExit(7)` 都会**打印日志、然后不退**——
//   进程继续活着,父进程收不到 exit 事件。对照实验:
//     无读流 + exit → 退出 ✅ | 有读流 + 不 attach data → 退出 ✅ | 有读流 + attach data + exit → **不退出** ❌
//   能用的只有 OS 级强杀:`process.kill(process.pid, "SIGKILL")` 或 `process.abort()`。
//   记在 docs/坑与解法.md 坑-26 —— 真实产品侧 spawn 的是 Chrome(原生处理 fd3/fd4),不受影响;
//   但**任何用 Node 假对端测 pipe 通道的人都会撞上它**。
function hardExit(code) {
  process.kill(process.pid, "SIGKILL");
  // 万一下面这行还能跑到,说明上面没生效 —— 别静默留下活进程
  process.abort();
  void code;
}

function writeRaw(text) {
  fs.writeSync(OUT, Buffer.from(text + "\0", "utf8"));
}

function reply(id, result) {
  writeRaw(JSON.stringify({ id, result }));
}

function replyError(id, message, data) {
  writeRaw(JSON.stringify({ id, error: { code: -32000, message, ...(data ? { data } : {}) } }));
}

const handlers = {
  // 最朴素的一条:原样回显
  "Fake.echo": (id, params) => reply(id, { echo: params }),

  // ---- 真实 CDP 方法的最小替身(供 listTabs / createTab 走通)----
  "Target.getTargets": (id) =>
    reply(id, {
      targetInfos: [
        { targetId: "T-back", type: "page", url: "https://back.example/", title: "后台页", attached: false },
        { targetId: "T-front", type: "page", url: "https://front.example/", title: "前台页", attached: true },
      ],
    }),
  "Target.createTarget": (id, params) => reply(id, { targetId: "T-new-" + (params?.url ? "with-url" : "blank") }),
  // harness 靠这个拿到 sessionId,拿不到就抛「Target.attachToTarget returned no sessionId」
  "Target.attachToTarget": (id, params) => reply(id, { sessionId: "S-fake-" + (params?.targetId ?? "?") }),
  "Browser.getVersion": (id) =>
    reply(id, {
      protocolVersion: "1.3",
      product: "FakeBrowser/156.0.8078.47",
      revision: "@fake",
      userAgent: "Mozilla/5.0 (fake)",
      jsVersion: "15.6",
    }),

  // 显式要求:未知方法回一个**故意的错误**(用来测错误路径)
  "Fake.unknownMethod": (id) => replyError(id, "本替身不认识这个方法"),

  // 拆包 / 粘包 / 事件 / 超时 / 崩溃 —— 见下
  "Fake.split": (id) => {
    const text = JSON.stringify({ id, result: { split: true, whole: "a".repeat(300) } }) + "\0";
    const third = Math.ceil(text.length / 3);
    fs.writeSync(OUT, Buffer.from(text.slice(0, third), "utf8"));
    setTimeout(() => {
      fs.writeSync(OUT, Buffer.from(text.slice(third, third * 2), "utf8"));
      setTimeout(() => fs.writeSync(OUT, Buffer.from(text.slice(third * 2), "utf8")), 10);
    }, 10);
  },

  // **粘包**:两条响应挤在**一次 write** 里。
  // 任何"一次读取只解析一条"的实现都会丢消息。
  "Fake.glued": (id) => {
    const a = JSON.stringify({ id, result: { first: true } });
    const b = JSON.stringify({ method: "Fake.anEvent", params: { glued: 1 } });
    fs.writeSync(OUT, Buffer.from(a + "\0" + b + "\0", "utf8"));
  },

  // 先发一个事件,再回响应 —— 验证事件与响应能正确分流
  "Fake.eventThenReply": (id) => {
    writeRaw(JSON.stringify({ method: "Fake.anEvent", params: { seq: 1 } }));
    writeRaw(JSON.stringify({ method: "Fake.anEvent", params: { seq: 2 } }));
    reply(id, { ok: true });
  },

  // 非法 JSON —— 通道级故障,必须让调用方看见,不能静默吞
  "Fake.garbage": () => {
    writeRaw("{ this is not json");
  },

  // 永不回应 —— 验证超时兜底
  "Fake.silent": () => {},

  // 回一个 CDP 错误
  "Fake.error": (id) => replyError(id, "故意失败", { error_code: "OUUUT_TEST_FAILURE" }),

  // 写一半就退出 —— 验证"残留缓冲要报出来"
  "Fake.halfThenExit": (id) => {
    fs.writeSync(OUT, Buffer.from(`{"id":${id},"result":{"trunca`, "utf8"));
    setTimeout(() => hardExit(3), 20);
  },

  // 立刻退出
  "Fake.exit": () => {
    setTimeout(() => hardExit(7), 10);
  },
};

let buffer = Buffer.alloc(0);
fs.createReadStream(null, { fd: IN }).on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let start = 0;
  for (;;) {
    const idx = buffer.indexOf(NUL, start);
    if (idx === -1) break;
    const text = buffer.subarray(start, idx).toString("utf8");
    start = idx + 1;
    if (!text) continue;
    try {
      const msg = JSON.parse(text);
      // **记录 harness 实际发出的每一个方法** —— 这份清单才是"原生层必须支持什么"的权威答案
      // (人工 grep 会漏掉字符串派发,实测踩到过)。
      if (msg.method) {
        try {
          fs.writeSync(2, `peer-guard: ${msg.method}\n`);
          // 落文件:stderr 会被 node --test 吞掉,拿不到"harness 到底发了什么"这份清单
          const logPath = process.env.FAKE_PEER_LOG;
          if (logPath) fs.appendFileSync(logPath, msg.method + "\n");
        } catch {
          /* 日志本身失败不该影响对端 */
        }
      }
      const h = handlers[msg.method];
      if (h) h(msg.id, msg.params ?? {});
      else if (msg.id !== undefined) {
        // **未知方法回空响应**,不是错误 —— 本替身的目标是让 harness 的握手**跑完**,
        // 而不是复刻整套 CDP 协议。要测错误路径请显式用 `Fake.unknownMethod`。
        // (若这里回错误,harness 会在握手阶段就死,根本走不到我们要验的那一步。)
        reply(msg.id, {});
      }
    } catch {
      /* 对端发来的坏包:忽略 */
    }
  }
  buffer = buffer.subarray(start);
});

// 让父进程知道它起来了(走 stderr,不占用 CDP 通道)
process.stderr.write("fake-cdp-peer ready\n");
