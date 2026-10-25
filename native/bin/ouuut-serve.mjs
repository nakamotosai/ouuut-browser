#!/usr/bin/env node
// native/bin/ouuut-serve.mjs —— 入口二:HTTP + WebSocket(P5 / F14)
//
// 用法:
//   node native/bin/ouuut-serve.mjs --headless [--port 8788] [--host 127.0.0.1] [--token <t>]
//                                  [--browser <chrome.exe>] [--proxy <url>] [--profile-kind persona] …
//
// 起来后会打印**带令牌的 URL**(令牌没给就现生成),客户端用 `Authorization: Bearer <t>`
// (或 `?token=<t>`)访问。理由见 `native/serve/http.mjs` 顶部那两条安全决定。
//
// ⚠️ WebSocket 也接受同一条令牌 —— 别以为"升级到 WS 就绕过鉴权了"。

import { startHttpServer } from "../serve/http.mjs";
import { bootServeCore } from "../serve/boot.mjs";
import { assertServeSecurity } from "../serve/args.mjs";

const argv = process.argv.slice(2);
let booted;
try {
  booted = await bootServeCore({ argv });
} catch (err) {
  process.stderr.write(`[ouuut-serve] ${err?.message ?? err}\n`);
  process.exit(2);
}
const { server: serverArgs, session, core } = booted;

const security = assertServeSecurity({ host: serverArgs.host, noAuth: serverArgs.noAuth });
const http = await startHttpServer({
  core,
  host: serverArgs.host,
  port: serverArgs.port,
  token: security.noAuth ? "" : (serverArgs.token ?? undefined),
  onClose: async () => {
    await session.close();
  },
});

const sep = security.noAuth ? "?" : `?token=${http.token}`;
process.stdout.write(
  `[ouuut-serve] 监听 ${http.url}${sep}\n` +
    (security.noAuth
      ? "[ouuut-serve] ⚠️ **未开鉴权**(--no-auth):任何能连到这个地址的本地进程都能驱动这个浏览器\n"
      : "[ouuut-serve] 令牌在 URL 里(Authorization: Bearer 也行)\n") +
    "[ouuut-serve] 路由:GET /health · GET /version · GET /tabs · POST /goto {url} · GET|POST /snapshot · POST /close · WS 同源\n",
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await session.close();
  await http.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
