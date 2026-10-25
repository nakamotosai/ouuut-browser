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
import net from "node:net";

const NUL = 0x00;
/** 置 1 时本替身会演一个**跨进程 iframe**:`Target.getTargets` 多给一个 iframe target,
 *  并且**按 sessionId** 返回不同的 AX 树 —— 用来验证 OOPIF 真取树那条路。 */
const WITH_OOPIF = process.env.FAKE_PEER_OOPIF === "1";
/** `leak` = 复刻 ADR-014 那组泄漏;`clean` = 0 个候选(CloakBrowser 那种)。 */
const WEBRTC_MODE = process.env.FAKE_PEER_WEBRTC ?? "";
const OUT = 4; // 子进程往 fd 4 写 = 父进程读
const IN = 3; // 父进程往 fd 3 写 = 子进程读

// ---- 两种传输都要支持 ------------------------------------------------------
//
// POSIX:`--remote-debugging-pipe`,fd 3 读 / fd 4 写。
// Windows:**CRT fd 是每个进程自己的表**,父进程装不出 fd 3/4,所以真 Chrome 走的是
//         `--remote-debugging-io-pipes=<in>,<out>`。打了 0004 补丁后它接受**命名管道路径**,
//         于是本替身也能连 —— 这样 Windows 那条路不用起真浏览器就能验。
const ioPipesArg = process.argv.find((a) => a.startsWith("--remote-debugging-io-pipes="));
let writeSocket = null;
let readStream = null;
if (ioPipesArg) {
  const [inPath, outPath] = ioPipesArg.slice("--remote-debugging-io-pipes=".length).split(",");
  // 对端扮演的是**浏览器**:in 是它读的(父进程写命令),out 是它写的(父进程读响应)。
  readStream = net.connect(inPath);
  writeSocket = net.connect(outPath);
} else {
  readStream = fs.createReadStream(null, { fd: IN });
}

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
  writePartial(text + "\0");
}

/** 不带分帧分隔符的裸写 —— 只给"故意写一半"那条用例用。 */
function writePartial(text) {
  const buf = Buffer.from(text, "utf8");
  if (writeSocket) {
    writeSocket.write(buf);
    return;
  }
  fs.writeSync(OUT, buf);
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
        ...(WITH_OOPIF
          ? [{ targetId: "T-oopif", type: "iframe", url: "https://oopif.example/", title: "" }]
          : []),
      ],
    }),
  "Target.createTarget": (id, params) => reply(id, { targetId: "T-new-" + (params?.url ? "with-url" : "blank") }),
  // harness 靠这个拿到 sessionId,拿不到就抛「Target.attachToTarget returned no sessionId」
  "Target.attachToTarget": (id, params) => reply(id, { sessionId: "S-fake-" + (params?.targetId ?? "?") }),
  // 供 snapshot 走通的最小 AX 树(角色名与结构对齐 example.com 的实测输出)
  "Accessibility.getFullAXTree": (id, _params, msg) => {
    // 带 sessionId = 那个 OOPIF 自己的树。**主 frame 的树里看不到它** —— 这正是
    // 为什么要单独 attach 再取。
    if (msg?.sessionId) {
      reply(id, {
        nodes: [
          { nodeId: "o1", role: { value: "RootWebArea" }, name: { value: "OOPIF" }, childIds: ["o2"] },
          {
            nodeId: "o2",
            role: { value: "button" },
            name: { value: "跨进程按钮" },
            backendDOMNodeId: 7777,
          },
        ],
      });
      return;
    }
    reply(id, {
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Example Domain" }, childIds: ["2", "3"] },
        { nodeId: "2", role: { value: "paragraph" }, childIds: ["4"] },
        { nodeId: "4", role: { value: "StaticText" }, name: { value: "该域名仅用于文档示例。" } },
        { nodeId: "3", role: { value: "paragraph" }, childIds: ["5"] },
        { nodeId: "5", role: { value: "StaticText" }, name: { value: "This domain is for use in documentation examples." } },
      ],
    });
  },
  // WebRTC 自检探针的替身(ADR-014)
  "Runtime.evaluate": (id) => {
    if (WEBRTC_MODE === "leak") {
      reply(id, {
        result: {
          value: {
            error: null,
            candidates: [
              "candidate:1 1 udp 2122260223 7d3f-9a2b.local 54321 typ host generation 0",
              "candidate:2 1 udp 2122260223 240f:77:160:1:abcd:ef01:2345:6789 54322 typ host generation 0",
              "candidate:3 1 udp 1677729535 124.211.130.95 54323 typ srflx generation 0",
            ],
          },
        },
      });
      return;
    }
    if (WEBRTC_MODE === "clean") {
      reply(id, { result: { value: { error: null, candidates: [] } } });
      return;
    }
    reply(id, { result: { value: null } });
  },
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
    writePartial(text.slice(0, third));
    setTimeout(() => {
      writePartial(text.slice(third, third * 2));
      setTimeout(() => writePartial(text.slice(third * 2)), 10);
    }, 10);
  },

  // **粘包**:两条响应挤在**一次 write** 里。
  // 任何"一次读取只解析一条"的实现都会丢消息。
  "Fake.glued": (id) => {
    const a = JSON.stringify({ id, result: { first: true } });
    const b = JSON.stringify({ method: "Fake.anEvent", params: { glued: 1 } });
    writePartial(a + "\0" + b + "\0");
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
    writePartial(`{"id":${id},"result":{"trunca`);
    setTimeout(() => hardExit(3), 20);
  },

  // 立刻退出
  "Fake.exit": () => {
    setTimeout(() => hardExit(7), 10);
  },
};

let buffer = Buffer.alloc(0);
readStream.on("data", (chunk) => {
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
      if (h) h(msg.id, msg.params ?? {}, msg);
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
