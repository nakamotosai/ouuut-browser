// native/binding/egress-guard.mjs —— 出口闸:一个**本地 SOCKS5**,替浏览器把该拒的拒掉
//
// ## 为什么需要它(P9 的尾巴)
//
// 拦截浏览器自己的回连,解析层那条路(`--host-resolver-rules`)只对**直连**有效:
// Chrome 的 `socks5://` 是**远端解析**,域名直接交给代理 ⇒ 浏览器根本没查 DNS,规则管不着。
// 而产品常态就是走代理。⇒ 真正的位置在**出口层**:浏览器 → **我们** → 上游(用户的代理,或直连)。
//
// 它只做三件事,不掺别的:
//   1. 收 SOCKS5 握手(只支持无认证,与浏览器的用法一致);
//   2. `CONNECT host:port`:
//      * 命中拒绝清单 ⇒ 回"连接被拒"(浏览器得到一个干脆的失败,**不查 DNS、不出网**);
//      * 否则 ⇒ 连上游(上游可以是另一个 SOCKS5 代理,也可以直连)并双向转发;
//   3. 记一笔"谁被拒了"(给诊断/用例看)。
//
// ## 为什么一个上游配一个闸
//
// 会话里可以有多个档案,各自绑不同出口(见双档案双出口)。闸是**每上游一个实例**:
// 谁走哪个代理,就指到哪个闸。这样"拒绝清单"对所有出口一视同仁,而转发目标各自分明。
//
// ⚠️ 边界(写清楚):闸只处理 **TCP CONNECT**。UDP(含 QUIC/WebRTC)不经它 ——
//    我们本来就 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` 抑制了非代理 UDP(ADR-014)。

import { createServer, connect as netConnect } from "node:net";

/** 默认拒绝清单:浏览器自己的**回连**(不是产品要访问的目标)。逐条都有实测依据(坑-46)。 */
export const DEFAULT_DENY_HOSTS = Object.freeze([
  "update.googleapis.com",
  "clients2.google.com",
  "accounts.google.com",
  "www.google.com",
]);

const REP_OK = Buffer.from([0x05, 0x00]);
const REP_REFUSED = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
const REP_UPSTREAM_FAILED = Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

/** 主机名是否命中拒绝清单(`example.com` 命中自身与子域;`*.example.com` 同样覆盖裸域名)。 */
export function isDenied(host, denyHosts = DEFAULT_DENY_HOSTS) {
  const h = String(host ?? "").toLowerCase();
  if (h === "") return false;
  return denyHosts.some((d) => {
    const pattern = String(d).toLowerCase();
    // `*.example.com` 同时覆盖**裸域名**与子域:这是**拒绝清单**,宁可多拒(它是回连名单,不是白名单)
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      return h === base || h.endsWith(`.${base}`);
    }
    return h === pattern || h.endsWith(`.${pattern}`);
  });
}

/** 解析 SOCKS5 请求里的目标(支持 IPv4 / 域名 / IPv6)。返回 `null` 表示还没收全。 */
export function parseSocks5Request(buf) {
  if (buf.length < 4) return null;
  const atyp = buf[3];
  if (atyp === 0x01) {
    if (buf.length < 10) return null;
    return { atyp, host: [...buf.subarray(4, 8)].join("."), port: buf.readUInt16BE(8), used: 10 };
  }
  if (atyp === 0x03) {
    const len = buf[4];
    if (buf.length < 5 + len + 2) return null;
    return { atyp, host: buf.subarray(5, 5 + len).toString("utf8"), port: buf.readUInt16BE(5 + len), used: 5 + len + 2 };
  }
  if (atyp === 0x04) {
    if (buf.length < 4 + 16 + 2) return null;
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
    return { atyp, host: parts.join(":"), port: buf.readUInt16BE(4 + 16), used: 4 + 16 + 2 };
  }
  return { atyp, host: null, port: 0, used: 4, bad: true };
}

/** 建一个到**上游代理**的连接(SOCKS5 客户端那一半;无认证)。 */
function connectViaUpstreamSocks5(upstream, host, port) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(upstream.port, upstream.host);
    const fail = (e) => {
      sock.destroy();
      reject(e);
    };
    sock.once("error", fail);
    sock.once("connect", () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00])); // 只提"无认证"
    });
    let stage = "greet";
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("上游不接受无认证 SOCKS5"));
        buf = buf.subarray(2);
        stage = "reply";
        const req = [0x05, 0x01, 0x00];
        const hb = Buffer.from(host, "utf8");
        if (hb.length > 255) return fail(new Error("主机名太长"));
        req.push(0x03, hb.length, ...hb, port >> 8, port & 0xff);
        sock.write(Buffer.from(req));
      }
      if (stage === "reply") {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error(`上游拒绝(socks 应答 0x${buf[1].toString(16)})`));
        const skip = buf[3] === 0x01 ? 4 : buf[3] === 0x04 ? 16 : buf[4] + 1;
        if (buf.length < 4 + skip + 2) return;
        sock.removeListener("data", onData);
        sock.removeListener("error", fail);
        resolve(sock);
      }
    };
    sock.on("data", onData);
  });
}

/**
 * 起一个出口闸。
 *
 * @param {object} o
 * @param {string[]} [o.denyHosts]  拒绝清单(默认 `DEFAULT_DENY_HOSTS`)
 * @param {{host: string, port: number}} [o.upstream] 上游 SOCKS5;**不给就直连**
 * @param {string} [o.host]         默认只听 `127.0.0.1`(它是使用者出口的一部分,不是公共设施)
 * @returns {Promise<{host, port, url, denied: Array<{host, port}>, allowed: Array<{host, port}>, close: Function}>}
 */
export async function startEgressGuard({ denyHosts = DEFAULT_DENY_HOSTS, upstream = null, host = "127.0.0.1", port = 0 } = {}) {
  const denied = [];
  const allowed = [];
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let stage = "greeting";
    let buf = Buffer.alloc(0);
    let relay = null;

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.subarray(2 + n);
        socket.write(REP_OK);
        stage = "request";
      }
      if (stage !== "request") return;
      const req = parseSocks5Request(buf);
      if (!req) return;
      if (req.bad || req.host === null) {
        socket.end(REP_REFUSED);
        return;
      }
      stage = "relaying";
      const { host: dstHost, port: dstPort } = req;
      if (isDenied(dstHost, denyHosts)) {
        // **拒绝**:浏览器得到一个干脆的失败;我们连 DNS 都不查(不出网)
        denied.push({ host: dstHost, port: dstPort });
        socket.end(REP_REFUSED);
        return;
      }
      allowed.push({ host: dstHost, port: dstPort });
      const dial = upstream
        ? connectViaUpstreamSocks5(upstream, dstHost, dstPort)
        : new Promise((resolve, reject) => {
            const s = netConnect(dstPort, dstHost);
            s.once("connect", () => resolve(s));
            s.once("error", reject);
          });
      dial
        .then((up) => {
          relay = up;
          sockets.add(up);
          up.on("close", () => sockets.delete(up));
          up.on("error", () => up.destroy());
          // 成功应答:给一个占位 BND.ADDR(0.0.0.0:0)—— 浏览器不读它
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.pipe(up);
          up.pipe(socket);
        })
        .catch(() => {
          socket.end(REP_UPSTREAM_FAILED);
        });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  return {
    host,
    port: addr.port,
    url: `socks5://127.0.0.1:${addr.port}`,
    denied,
    allowed,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve(true));
        server.closeAllConnections?.();
      }),
  };
}
