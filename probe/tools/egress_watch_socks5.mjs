// probe/tools/egress_watch_socks5.mjs —— 「记录式出口」:一个**只记不转发**的 SOCKS5 服务
//
// 用途(P9 的零遥测):把浏览器指到这里当代理 ——
//   * 它**全部拒绝**(回 SOCKS5 的 "connection refused"),所以**没有任何字节离开本机**;
//   * 但每一次 `CONNECT host:port` 都记下来 ⇒ "这一趟到底想连谁"变成一份可读的清单。
//
// 为什么不用 pktmon:抓包要管理员权限、还要解 TLS 才能知道"连的是谁"(SNI/证书)。
// 而 SOCKS 这一层**在加密之前**就能看到目标主机名,而且**天然只在我们指的路由里** ——
// 对"有没有第三方上报"这个问题,它是更合适的仪器(局限:只看得见走代理的流量;
// 直连的那部分它看不见,所以探针必须**同时**确认"代理确实生效了")。

import { createServer } from "node:net";

/**
 * @param {object} o
 * @param {number} [o.port] 0 = 让系统挑
 * @param {string} [o.host]
 * @returns {Promise<{port: number, seen: Array<{host: string, port: number}>, close: Function}>}
 */
export async function startEgressWatcher({ port = 0, host = "127.0.0.1" } = {}) {
  const seen = [];
  const server = createServer((socket) => {
    let stage = "greeting";
    let buf = Buffer.alloc(0);
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.subarray(2 + n);
        socket.write(Buffer.from([0x05, 0x00])); // 不需要认证
        stage = "request";
      }
      if (stage === "request") {
        if (buf.length < 4) return;
        const atyp = buf[3];
        let host = null;
        let off = 4;
        if (atyp === 0x01) {
          if (buf.length < off + 4 + 2) return;
          host = [...buf.subarray(off, off + 4)].join(".");
          off += 4;
        } else if (atyp === 0x03) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString("utf8");
          off = 5 + len;
        } else if (atyp === 0x04) {
          if (buf.length < off + 16 + 2) return;
          host = "[" + [...buf.subarray(off, off + 16)].map((b) => b.toString(16).padStart(2, "0")).join(":") + "]";
          off += 16;
        } else {
          socket.destroy();
          return;
        }
        const dstPort = buf.readUInt16BE(off);
        seen.push({ host, port: dstPort });
        // 拒绝(0x05 = connection refused):**不转发**,所以本机零出网
        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.end();
        stage = "done";
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  return {
    port: addr.port,
    seen,
    /** 目标主机去重后的清单(便于断言)。 */
    hosts: () => [...new Set(seen.map((s) => s.host))].sort(),
    close: () => new Promise((resolve) => {
      server.close(() => resolve(true));
      server.closeAllConnections?.();
    }),
  };
}
