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
  let nextId = 1;
  let closed = false;
  let exitInfo = null;

  const stderrChunks = [];
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

  child.on("error", (err) => {
    failAll(new CdpPipeError(`起 ${name} 失败:${err.message}`, { cause: err }));
  });
  child.on("exit", (code, signal) => {
    closed = true;
    exitInfo = { code, signal };
    failAll(
      new CdpPipeError(`${name} 退出(code=${code} signal=${signal})—— 未完成的 CDP 请求全部作废`, {
        code: "OUUUT_CDP_PIPE_CLOSED",
      }),
    );
  });

  function send(method, params = {}, { timeoutMs: t = timeoutMs } = {}) {
    if (closed) {
      return Promise.reject(
        new CdpPipeError(`${name} 已退出(code=${exitInfo?.code}),不能再发 ${method}`, {
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

  return {
    child,
    send,
    /** 订阅事件流(所有非响应消息)。返回退订函数。 */
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get closed() {
      return closed;
    },
    get stderrText() {
      return Buffer.concat(stderrChunks).toString("utf8");
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
