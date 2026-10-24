// native/binding/cdp-pipe.mjs —— 原生层的**通道**:CDP over pipe
//
// 为什么用 pipe 而不是 `--remote-debugging-port`:
//   ADR-005 要求「**不暴露 TCP 调试端口**」。`--remote-debugging-pipe` 让 Chrome
//   从 **fd 3** 读 CDP 消息、往 **fd 4** 写,全程不监听任何端口 —— 这是 Chrome 自己的
//   官方机制(DevTools 前端与 `--headless` 自动化都用它)。
//
// 帧格式(NUL 分隔的 JSON):
//   每条消息 = JSON 文本 + 一个 `\0`。读写都是如此。
//   一个字节都不能改 —— 少个 `\0` 对方会永远等下去。
//
// 本文件**不**决定任何 chrome 参数或产品语义,只做三件事:
//   1) 起进程并把 fd3/fd4 接上
//   2) CDP 的请求/响应/事件分发(request id 配对)
//   3) 干净收尾(不留孤儿进程)
//
// 可独立验证:见 `native/binding/cdp-pipe.test.mjs` —— 它用一个**真 pipe**
// 上的假 CDP 对端跑通全链路(因此本文件的正确性不依赖"能不能起浏览器")。

import { spawn } from "node:child_process";

const NUL = 0x00;

/** 一条 CDP 消息超时(毫秒)。pipe 是不会"断线"的,所以必须有超时兜底。 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class CdpPipeError extends Error {
  constructor(message, { code = "OUUUT_CDP_PIPE", cause } = {}) {
    super(message, { cause });
    this.name = "CdpPipeError";
    this.error_code = code;
  }
}

/**
 * 把一个只写的流按 NUL 分帧解析成消息字符串。
 * 单独抽出来是因为**分帧是这一层最容易写错的地方**:一条 CDP 消息可能被拆成多个
 * chunk 到达,也可能一个 chunk 里塞了好几条。任何"假设一个 chunk = 一条消息"的写法
 * 都会在真实流量下随机炸。
 */
export function createMessageSplitter(onMessage) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const idx = buffer.indexOf(NUL, start);
        if (idx === -1) break;
        const text = buffer.subarray(start, idx).toString("utf8");
        start = idx + 1;
        if (text.length > 0) onMessage(text);
      }
      buffer = start === 0 ? buffer : buffer.subarray(start);
    },
    /** 流结束时调用:残留的非空缓冲说明对方写了一半就死了 —— 要报出来,不能静默丢 */
    end() {
      const rest = buffer.toString("utf8").trim();
      buffer = Buffer.alloc(0);
      return rest;
    },
  };
}

/**
 * 起一个走 pipe 的 Chrome(或任何支持 fd3/fd4 CDP 的进程),返回一个 CDP 客户端。
 *
 * `name` 只用于错误信息,不参与产品语义。
 */
export function spawnCdpPipe({ exe, args = [], env, cwd, name = "chrome", timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const child = spawn(exe, args, {
    cwd,
    env: env ?? process.env,
    // [0]=stdin [1]=stdout [2]=stderr [3]=**父写子读**(CDP 输入) [4]=**子写父读**(CDP 输出)
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const toChild = child.stdio[3];
  const fromChild = child.stdio[4];
  if (!toChild || !fromChild) {
    child.kill();
    throw new CdpPipeError(`起 ${name} 时拿不到 fd3/fd4 —— pipe 通道没接上`);
  }

  const pending = new Map(); // id -> {resolve, reject, timer, method}
  const listeners = new Set(); // (message) => void,用于事件与方法级回调
  const rawListeners = new Set(); // (message) => void,**每一条**解析出来的消息都送这里
  let nextId = 1;
  let closed = false;
  let exitInfo = null;
  /** 诊断用:起至今多久、当初用的是哪串参数(报错时原样带上,省得再回去翻) */
  const startedAt = Date.now();
  const spawnArgs = [exe, ...args];

  const stderrChunks = [];
  /** 子进程 stderr 的尾部 —— 报错时带上它对定位帮助极大(实测)。 */
  const stderrText = () => Buffer.concat(stderrChunks).toString("utf8");
  child.stderr?.on("data", (c) => {
    stderrChunks.push(c);
    if (stderrChunks.length > 200) stderrChunks.shift(); // 只留尾部,避免长期运行吃内存
  });

  const failAll = (err) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  const splitter = createMessageSplitter((text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      // 对端发了非法 JSON —— 这是通道级故障,必须让调用方看见
      failAll(new CdpPipeError(`从 ${name} 收到非法 JSON:${text.slice(0, 200)}`));
      return;
    }
    // **原始通道**:透传模式必须看到**每一条**消息,包括 id 不在 pending 里的响应。
    // (上游 harness 自己分配 CDP id 并发 `{id,method,params}`,我们的层只是管道 ——
    //  若把"未知 id 的响应"丢掉,harness 就永远等不到回应。)
    for (const fn of rawListeners) {
      try {
        fn(msg);
      } catch {
        // 单个订阅者抛错不该掀翻整条通道
      }
    }
    // CDP 的三类消息:响应(有 id)、事件(有 method 无 id)、(少数)带 id 的事件
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (!p) return; // 超时后迟到的响应,丢弃
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new CdpPipeError(`${p.method} 被拒绝:${msg.error.message ?? JSON.stringify(msg.error)}`, {
            code: msg.error.data?.error_code ?? "OUUUT_CDP_ERROR",
          }),
        );
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    for (const fn of listeners) {
      try {
        fn(msg);
      } catch {
        // 单个订阅者抛错不该掀翻整条通道
      }
    }
  });

  fromChild.on("data", (chunk) => splitter.push(chunk));
  fromChild.on("end", () => {
    const rest = splitter.end();
    if (rest) {
      failAll(new CdpPipeError(`${name} 在写完一条消息前就关闭了输出:${rest.slice(0, 200)}`));
    }
  });

  /**
   * 把"对端死了"翻译成**能直接读懂的诊断**。
   *
   * 起因(2026-10-25):`--remote-debugging-pipe` 让浏览器**启动阶段**就退 0 且
   * **一个字都不输出**,而当时的报错只说 `ouuut 退出(code=0)` —— 从这句话里
   * 推不出任何东西,白花了两小时才定位(见 `docs/坑与解法.md` 坑-29)。
   *
   * 现在把三种最容易误判的情形直接写进消息:
   *   * 起后极快退出 + **零输出** → 大概率是某个开关不被支持(不是功能 bug)
   *   * 极快退出 + 有输出 → 把输出带上(那通常就是原因)
   *   * 跑了一会儿才退 → 是运行期崩了,不是启动失败
   */
  function diagnoseExit() {
    if (!exitInfo) return `${name} 还没退出`;
    const ms = Date.now() - startedAt;
    const err = stderrText();
    const parts = [`${name} 退出(code=${exitInfo.code} signal=${exitInfo.signal},存活 ${ms} ms)`];
    if (ms < 2000 && err.trim() === "") {
      parts.push(
        "**在启动阶段就退出,且没有任何输出** —— 这通常意味着某个启动开关不被支持," +
          "而不是功能问题。先用同样的开关去掉可疑项逐个试(见 docs/坑与解法.md 坑-29);" +
          "也确认一下 --log-file 是否为空:空 = 没跑到 Chromium 的日志初始化",
      );
    } else if (err.trim() !== "") {
      parts.push(`stderr(尾部):${err.trim().slice(-800)}`);
    } else {
      parts.push("运行期退出(不是启动失败)");
    }
    parts.push(`启动参数:${spawnArgs.join(" ")}`);
    return parts.join("\n");
  }

  child.on("error", (err) => {
    failAll(new CdpPipeError(`起 ${name} 失败:${err.message}`, { cause: err }));
  });
  child.on("exit", (code, signal) => {
    closed = true;
    exitInfo = { code, signal };
    failAll(
      new CdpPipeError(`${diagnoseExit()} —— 未完成的 CDP 请求全部作废`, {
        code: "OUUUT_CDP_PIPE_CLOSED",
      }),
    );
  });

  function send(method, params = {}, { timeoutMs: t = timeoutMs } = {}) {
    if (closed) {
      return Promise.reject(
        new CdpPipeError(`${diagnoseExit()},不能再发 ${method}`, {
          code: "OUUUT_CDP_PIPE_CLOSED",
        }),
      );
    }
    const id = nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpPipeError(`${method} 超时(${t} ms)—— ${name} 没有回应`));
      }, t);
      // timer 不该拖住进程退出
      if (typeof timer.unref === "function") timer.unref();
      pending.set(id, { resolve, reject, timer, method });
      toChild.write(payload + "\0", (err) => {
        if (!err) return;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(new CdpPipeError(`${method} 写管道失败:${err.message}`, { cause: err }));
      });
    });
  }

  /** **透传写入**:不登记 pending、不分配 id —— 调用方(harness)自己管 id 与配对。
   *  这是 `--remote-debugging-pipe` 那条通路的本体。 */
  function sendRaw(obj) {
    if (closed) {
      throw new CdpPipeError(`${diagnoseExit()},不能再写`, {
        code: "OUUUT_CDP_PIPE_CLOSED",
      });
    }
    toChild.write(JSON.stringify(obj) + "\0");
  }

  return {
    child,
    send,
    sendRaw,
    /** 诊断:对端退出时**能直接读懂**的说明(含启动参数与 stderr 尾部) */
    diagnoseExit,
    stderrText,
    get exitInfo() {
      return exitInfo;
    },
    /** **原始订阅**:每一条解析出来的消息,包括 id 不在 pending 里的响应 */
    onRaw(fn) {
      rawListeners.add(fn);
      return () => rawListeners.delete(fn);
    },
    /** 订阅事件流(所有非响应消息)。返回退订函数。 */
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get closed() {
      return closed;
    },
    /** 干净收尾:先给一个**已 resolve 的拒绝理由**的窗口,再强杀。
     *  硬杀的进程会留下锁住的 chrome.dll —— 见 docs/坑与解法.md 坑-23。 */
    async close({ killAfterMs = 5_000 } = {}) {
      if (closed) return;
      failAll(new CdpPipeError(`${name} 正在关闭 —— 未完成的 CDP 请求作废`, { code: "OUUUT_CDP_PIPE_CLOSED" }));
      try {
        toChild.end();
      } catch {
        /* 已经关了就算了 */
      }
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      const timer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, killAfterMs);
      if (typeof timer.unref === "function") timer.unref();
      await exited;
      clearTimeout(timer);
      closed = true;
    },
  };
}
