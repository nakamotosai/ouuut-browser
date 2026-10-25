// native/serve/args.mjs —— 服务端自己的参数,与浏览器参数**分开**
//
// 为什么分开:`parseArgs()` 是 CLI 的参数解析(它认识 `nodejs`、`--script`、`--headless`…)。
// 服务端要用同一批浏览器参数,但有自己的几个(`--port`/`--host`/`--token`/`--no-auth`)。
// 把这些塞进 CLI 的解析器会污染它的 `--help`,而复制一份浏览器参数解析又是必然漂移的东西 ——
// 所以这里只做**分流**:把自己的摘走,剩下原样交给 `parseArgs()`。

import { ServeError } from "./errors.mjs";

/** 服务端自己的开关(带值 / 不带值各一组)。 */
const WITH_VALUE = new Set(["--port", "--host", "--token"]);
const FLAGS = new Set(["--no-auth", "--ws-only"]);

/**
 * @param {string[]} argv
 * @returns {{ server: {port: number, host: string, token: string|null, noAuth: boolean, wsOnly: boolean}, rest: string[] }}
 */
export function splitServerArgs(argv = []) {
  const server = { port: 0, host: "127.0.0.1", token: null, noAuth: false, wsOnly: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (FLAGS.has(a)) {
      if (a === "--no-auth") server.noAuth = true;
      if (a === "--ws-only") server.wsOnly = true;
      continue;
    }
    if (WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new ServeError(`${a} 需要一个值`, "OUUUT_SERVE_BAD_ARGS");
      i += 1;
      if (a === "--port") {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new ServeError(`--port 不合法:${v}`, "OUUUT_SERVE_BAD_ARGS");
        server.port = n;
      } else if (a === "--host") server.host = v;
      else server.token = v;
      continue;
    }
    rest.push(a); // 浏览器参数(以及 CLI 自己的参数)原样留给 parseArgs()
  }
  return { server, rest };
}

/**
 * 收紧那两条例外:**只听 loopback** 且**必须显式 `--no-auth`**,缺一不可。
 * 这个服务驱动的是带身份的真浏览器,放开鉴权等于把它借给任何本地进程。
 */
export function assertServeSecurity({ host, noAuth }) {
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (noAuth && !isLoopback) {
    throw new ServeError(
      `--no-auth 只允许配合 loopback(收到 --host ${host})。` +
        "这个服务带着使用者的档案与出口,不能既不给令牌又对外监听。",
      "OUUUT_SERVE_UNSAFE_CONFIG",
    );
  }
  return { isLoopback, noAuth: Boolean(noAuth) };
}
