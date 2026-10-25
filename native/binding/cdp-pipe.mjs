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
import { randomBytes } from "node:crypto";
import net from "node:net";

// 诊断里的启动参数要脱敏(代理凭据不落日志,见 proxy.mjs)
import { describeArgs, redactProxy } from "./proxy.mjs";

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
export function spawnCdpPipe({
  exe,
  args = [],
  env,
  cwd,
  name = "chrome",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  // Windows 上默认走**命名管道**。原因见下面那段注释。
  useNamedPipes = process.platform === "win32",
}) {
  // ---- 传输:命名管道(Windows) 或 fd3/fd4(POSIX) -------------------------
  //
  // 为什么 Windows 必须换一套:
  //   POSIX 上 `--remote-debugging-pipe` 用 **fd 3 读、fd 4 写**,Node 的 stdio
  //   能直接给出这两个 fd,一切正常。
  //   但 **CRT 文件描述符是每个进程自己的表** —— 父进程在 CreateProcess 时能继承
  //   HANDLE,却**无法给子进程装出 fd 3/4**。所以这条路从 Node 出发在 Windows 上
  //   **永远走不通**(实测:浏览器启动阶段就退 0、零输出,见 docs/坑与解法.md 坑-29)。
  //
  //   而 Windows 专用的 `--remote-debugging-io-pipes` 本来只收句柄的整数值;
  //   打了 `chromium/patches/0004-cdp-named-pipe.patch` 之后它**也接受命名管道路径**,
  //   于是父进程侧可以纯 JS 实现,**依然不开任何端口**(ADR-005 要求)。
  //
  // 方向:`in` 是浏览器**读**的(我们写命令),`out` 是浏览器**写**的(我们读响应)。
  let pipePaths = null;
  const servers = [];
  if (useNamedPipes) {
    const token = randomBytes(8).toString("hex");
    pipePaths = {
      in: `\\\\.\\pipe\\ouuut-${token}-in`,
      out: `\\\\.\\pipe\\ouuut-${token}-out`,
    };
    // 必须在起进程**之前**把管道建好 —— 浏览器一起来就会去连,连不上就直接放弃
    for (const path of [pipePaths.in, pipePaths.out]) {
      const srv = net.createServer();
      srv.on("error", (e) => {
        failAll(new CdpPipeError(`命名管道 ${path} 出错:${e.message}`, { cause: e }));
      });
      srv.listen(path);
      servers.push(srv);
    }
  }

  const effectiveArgs = pipePaths
    ? [...args, `--remote-debugging-io-pipes=${pipePaths.in},${pipePaths.out}`]
    : args;

  const child = spawn(exe, effectiveArgs, {
    cwd,
    env: env ?? process.env,
    // [0]=stdin [1]=stdout [2]=stderr [3]=**父写子读**(CDP 输入) [4]=**子写父读**(CDP 输出)
    // 命名管道模式下 3/4 用不上(浏览器自己连管道),就不必再分配
    stdio: pipePaths
      ? ["ignore", "ignore", "pipe"]
      : ["ignore", "ignore", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let toChild = pipePaths ? null : child.stdio[3];
  let fromChild = pipePaths ? null : child.stdio[4];
  if (!pipePaths && (!toChild || !fromChild)) {
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
  const spawnArgs = [exe, ...effectiveArgs];

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

  /**
   * 传输层流的 `error` —— **两端都必须挂**,而且**只记不拒**。
   *
   * 为什么只记不拒:对端一死,pipe / socketpair 的对端会先抛 `ECONNRESET`
   * (2026-10-25 Linux 实测:`stdio[3] error: ECONNRESET read`),而这时 stderr
   * 往往还没派发完。若在这里抢先 `failAll`,调用方拿到的就是一句**裸
   * `read ECONNRESET`** —— 退出码、stderr、启动参数这些诊断全丢(坑-29 花了
   * 两小时才算出来的东西,不能就这么扔回给调用方)。
   *
   * 拒付交给 exit/close 那条路径(`failWithExit`),它才握有完整信息;
   * 记下来的行会被 `diagnoseExit()` 带出去,所以不会白记。
   */
  const transportErrors = [];
  function noteTransportError(prefix) {
    return (e) => {
      const line = `${prefix}出错:${e.code ?? e.message}`;
      if (!transportErrors.includes(line)) transportErrors.push(line);
      // 已经知道对端退了 ⇒ 不用再等那 2 秒兜底,当场把诊断交出去
      if (exitInfo && !closed) failWithExit();
    };
  }

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

  /** 把读端接上分帧器。命名管道模式下要等浏览器连上来才有流,所以抽成函数。 */
  function attachFromChild(stream) {
    fromChild = stream;
    stream.on("data", (chunk) => splitter.push(chunk));
    stream.on("end", () => {
      const rest = splitter.end();
      if (rest) {
        failAll(new CdpPipeError(`${name} 在写完一条消息前就关闭了输出:${rest.slice(0, 200)}`));
      }
    });
    stream.on("error", noteTransportError(`${name} 的读管道`));
  }

  // 命名管道模式下两个连接是**异步**到达的,所以写入要先排队、连上再按序放出去。
  // 这样 `sendRaw()` 依然可以同步调用(harness 的透传路径依赖这一点)。
  const writeQueue = [];
  function writeToChild(data, cb) {
    if (toChild) {
      toChild.write(data, cb);
      return;
    }
    writeQueue.push({ data, cb });
  }

  if (pipePaths) {
    servers[0].once("connection", (sock) => {
      toChild = sock;
      // 与 POSIX 侧**同一套语义**(只记不拒):命名管道的写端出错同样是"对端没了"的信号,
      // 就地 failAll 会把 exit 那条路径才能拼出的诊断(退出码 / stderr / 启动参数)冲掉。
      sock.on("error", noteTransportError(`${name} 的写管道`));
      for (const item of writeQueue) toChild.write(item.data, item.cb);
      writeQueue.length = 0;
    });
    servers[1].once("connection", (sock) => attachFromChild(sock));
  } else {
    attachFromChild(fromChild);
    // 写端(stdio[3],socketpair 的一端)**也必须挂 `error`**:对端一死它会抛
    // `ECONNRESET`,没有处理就是**未捕获异常** —— 整个进程被掀翻,而且报错会归到
    // 当时恰好在跑的那个用例上。2026-10-25 Linux 实测:那两条红都是这么来的
    // (`cdp-pipe.test.mjs:186` 与 `task-spaces.test.mjs:167` 报的是**同一个**根因)。
    toChild.on("error", noteTransportError(`${name} 的写管道`));
  }

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
    // ⚠️ **stderr 也要脱敏**:对端可能把自己的启动参数(含 `--proxy-server=socks5://u:p@h`)打进 stderr,
    // 而那一段会被原样拼进诊断 —— 2026-10-25 写这条用例时真抓到的第二条泄漏路径。
    const err = redactProxy(stderrText());
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
    if (transportErrors.length > 0) parts.push(`传输层:${transportErrors.join(" / ")}`);
    // ⚠️ **启动参数要脱敏再打**:`--proxy-server=socks5://user:pass@host` 就在这串里,
    // 原样拼出去等于"出错一次就把凭据写进日志"(F13 要求凭据不落日志)。
    parts.push(`启动参数:${describeArgs(spawnArgs)}`);
    return parts.join("\n");
  }

  child.on("error", (err) => {
    failAll(new CdpPipeError(`起 ${name} 失败:${err.message}`, { cause: err }));
  });

  // **不要在 `exit` 上直接判定** —— 见 docs/坑与解法.md 坑-29 的补充:
  // `exit` 触发时 stderr 的最后一段 `data` 可能**还没派发**,于是诊断会说
  // 「没有任何输出」,而浏览器其实打印了原因(2026-10-25 实测:那条
  // `Remote debugging pipe file descriptors are not open.` 就是这么被吞掉的)。
  //
  // 正确做法:等 `close`(stdio 全部收完)再组消息。但 `close` 也可能因为
  // 某个孙子进程还占着句柄而永远不来,所以给一个兜底定时器,不让人白等。
  let exitTimer = null;
  const failWithExit = () => {
    if (closed) return; // `close` 与兜底定时器都会走到这,只认第一次
    closed = true;
    failAll(
      new CdpPipeError(`${diagnoseExit()} —— 未完成的 CDP 请求全部作废`, {
        code: "OUUUT_CDP_PIPE_CLOSED",
      }),
    );
  };

  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
    // 传输层已经报过错 ⇒ 两端都断了,再等那 2 秒兜底只是白等(还会让调用方多等一轮)
    if (transportErrors.length > 0) {
      failWithExit();
      return;
    }
    exitTimer = setTimeout(failWithExit, 2000);
    exitTimer.unref?.();
  });
  child.on("close", () => {
    clearTimeout(exitTimer);
    failWithExit();
  });

  function send(method, params = {}, { timeoutMs: t = timeoutMs, sessionId } = {}) {
    if (closed) {
      return Promise.reject(
        new CdpPipeError(`${diagnoseExit()},不能再发 ${method}`, {
          code: "OUUUT_CDP_PIPE_CLOSED",
        }),
      );
    }
    const id = nextId++;
    // `sessionId` 是 OOPIF 的关键:跨进程 iframe 是**独立的 target**,
    // 命令必须带上它的 session 才会路由过去(flatten 模式下就是这么写的)。
    const payload = JSON.stringify({
      id,
      method,
      params,
      ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}),
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpPipeError(`${method} 超时(${t} ms)—— ${name} 没有回应`));
      }, t);
      // timer 不该拖住进程退出
      if (typeof timer.unref === "function") timer.unref();
      pending.set(id, { resolve, reject, timer, method });
      writeToChild(payload + "\0", (err) => {
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
    writeToChild(JSON.stringify(obj) + "\0");
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
      // 命名管道是我们建的:**即使对端已经退了也必须关掉**,否则监听句柄会挂住进程
      // (2026-10-25 实测:对端启动即退时 close() 会走到下面的 early return,漏掉这一步)
      for (const srv of servers) {
        try {
          srv.close();
        } catch {
          /* 没在监听就算了 */
        }
      }
      if (closed) return;
      failAll(new CdpPipeError(`${name} 正在关闭 —— 未完成的 CDP 请求作废`, { code: "OUUUT_CDP_PIPE_CLOSED" }));
      try {
        toChild?.end();
      } catch {
        /* 已经关了就算了 */
      }
      // 子进程**已经退出**时 `once("exit")` 不会再触发 —— 直接等会挂死。
      // (2026-10-25 实测:对端启动即退的用例里 close() 会永远挂住。)
      const exited =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((r) => child.once("exit", r));
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
