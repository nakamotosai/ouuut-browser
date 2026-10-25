// native/binding/egress-guard.test.mjs —— 出口闸的验收
//
// 这里全部用**真 socket**(本机 loopback 上的假上游/假目标),不 mock:
// 闸的活儿本来就是"字节转发",用假对象测等于没测。

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect as netConnect } from "node:net";

import { DEFAULT_DENY_HOSTS, isDenied, parseSocks5Request, startEgressGuard } from "./egress-guard.mjs";

/** 一个只会回一句 `pong:<名字>` 的 TCP 服务,冒充"目标站"。 */
function fakeTarget(reply = "pong") {
  return new Promise((resolve) => {
    const srv = createServer((sock) => {
      sock.on("data", () => sock.end(reply));
      sock.on("error", () => {});
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(() => r(true))) }),
    );
  });
}

/** 一个最小的 SOCKS5 上游(只支持 域名 CONNECT),把连接转发到真实目标。 */
function fakeUpstreamSocks5() {
  const seen = [];
  const srv = createServer((sock) => {
    let stage = "greet";
    let buf = Buffer.alloc(0);
    sock.on("error", () => sock.destroy());
    sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (stage === "greet") {
        if (buf.length < 3) return;
        buf = buf.subarray(3);
        sock.write(Buffer.from([0x05, 0x00]));
        stage = "req";
      }
      if (stage !== "req") return;
      const req = parseSocks5Request(buf);
      if (!req) return;
      if (req.bad) {
        sock.end(Buffer.from([0x05, 0x05, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      seen.push({ host: req.host, port: req.port });
      stage = "done";
      // 上游把连接转给"真实目标":这里直接连 req.host / req.port(loopback 上就是假目标)
      const up = netConnect(req.port, req.host === "localhost" ? "127.0.0.1" : req.host);
      up.once("connect", () => {
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        sock.pipe(up);
        up.pipe(sock);
      });
      up.once("error", () => sock.end(Buffer.from([0x05, 0x04, 0, 1, 0, 0, 0, 0, 0, 0])));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () =>
      resolve({ seen, port: srv.address().port, close: () => new Promise((r) => srv.close(() => r(true))) }),
    );
  });
}

/** 走 SOCKS5 连一次,拿回服务端的应答(成功=0x00)。 */
function socks5Fetch(guard, host, port, { send = "ping" } = {}) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(guard.port, guard.host);
    let stage = "greet";
    let buf = Buffer.alloc(0);
    sock.on("error", reject);
    sock.on("connect", () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (stage === "greet") {
        buf = buf.subarray(2);
        stage = "req";
        const hb = Buffer.from(host, "utf8");
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([port >> 8, port & 0xff])]));
      } else if (stage === "req") {
        if (buf.length < 4) return;
        const rep = buf[1];
        buf = buf.subarray(10);
        if (rep !== 0x00) {
          sock.destroy();
          resolve({ ok: false, rep, body: null });
          return;
        }
        stage = "body";
        sock.write(Buffer.from(send, "utf8"));
      } else {
        const body = buf.toString("utf8");
        if (body.length > 0) {
          sock.destroy();
          resolve({ ok: true, rep: 0x00, body });
        }
      }
    });
    setTimeout(() => {
      sock.destroy();
      reject(new Error("SOCKS5 交互超时"));
    }, 5000);
  });
}

test("isDenied:精确命中、子域命中、大小写不敏感;不误伤同名后缀", () => {
  assert.ok(isDenied("update.googleapis.com"));
  assert.ok(isDenied("UPDATE.googleapis.com"));
  assert.ok(isDenied("a.clients2.google.com"), "子域也算命中");
  assert.ok(!isDenied("google.com"), "清单里没有 google.com 本身 ⇒ 不该被拒(拒绝清单要精确)");
  assert.ok(!isDenied("notgoogle.com"), "notgoogle.com 不是 google.com 的子域");
  assert.ok(!isDenied("example.com"));
  assert.ok(!isDenied(""));
  assert.ok(!isDenied(null));
  assert.ok(isDenied("x.example.com", ["*.example.com"]), "通配写法要支持");
  assert.ok(isDenied("example.com", ["*.example.com"]), "通配写法也该覆盖裸域名");
  assert.equal(DEFAULT_DENY_HOSTS.length, 4);
});

test("parseSocks5Request:三种地址类型与「没收回全」", () => {
  assert.equal(parseSocks5Request(Buffer.from([5, 1, 0])), null, "不满 4 字节要返回 null");
  // 域名
  const dom = Buffer.concat([Buffer.from([5, 1, 0, 3, 11]), Buffer.from("example.com"), Buffer.from([0x1f, 0x90])]);
  assert.deepEqual(parseSocks5Request(dom), { atyp: 3, host: "example.com", port: 8080, used: dom.length });
  // IPv4
  const v4 = Buffer.from([5, 1, 0, 1, 1, 2, 3, 4, 0, 80]);
  assert.equal(parseSocks5Request(v4).host, "1.2.3.4");
  assert.equal(parseSocks5Request(v4).port, 80);
  // IPv6
  const v6 = Buffer.alloc(22);
  v6[0] = 5; v6[1] = 1; v6[3] = 4; v6.writeUInt16BE(0x2001, 4); v6.writeUInt16BE(0x1234, 20);
  assert.equal(parseSocks5Request(v6).host, "2001:0:0:0:0:0:0:0");
  // 不受支持的地址类型
  assert.equal(parseSocks5Request(Buffer.from([5, 1, 0, 9, 0, 0, 0, 0]))?.bad, true);
});

test("★ 直连上游:命中的拒掉(不建连)、没命中的照常转发", async (t) => {
  const target = await fakeTarget("pong-direct");
  t.after(() => target.close());
  const guard = await startEgressGuard();
  t.after(() => guard.close());

  const denied = await socks5Fetch(guard, "update.googleapis.com", 443);
  assert.equal(denied.rep, 0x05, "命中的要给「连接被拒」的应答");
  assert.equal(denied.body, null, "而且不该有任何转发");
  assert.deepEqual(guard.denied.map((d) => d.host), ["update.googleapis.com"]);

  const okRes = await socks5Fetch(guard, "127.0.0.1", target.port);
  assert.equal(okRes.body, "pong-direct", "没命中的要真的转发到目标");
  assert.equal(guard.allowed.length, 1);
  assert.equal(guard.allowed[0].host, "127.0.0.1");
});

test("★ 上游是 SOCKS5 代理:转发要走它(而不是绕过它直连)", async (t) => {
  const target = await fakeTarget("pong-via-upstream");
  t.after(() => target.close());
  const upstream = await fakeUpstreamSocks5();
  t.after(() => upstream.close());
  const guard = await startEgressGuard({ upstream: { host: "127.0.0.1", port: upstream.port } });
  t.after(() => guard.close());

  const okRes = await socks5Fetch(guard, "127.0.0.1", target.port);
  assert.equal(okRes.body, "pong-via-upstream");
  assert.equal(upstream.seen.length, 1, "上游必须收到那次 CONNECT");
  assert.equal(upstream.seen[0].port, target.port);

  // 命中的仍然拒掉,而且**不该打扰上游**
  const denied = await socks5Fetch(guard, "www.google.com", 443);
  assert.equal(denied.rep, 0x05);
  assert.equal(upstream.seen.length, 1, "被拒的请求不许转发给上游");
});

test("上游连不上 ⇒ 回「上游失败」(0x04),不许假装成功", async (t) => {
  const guard = await startEgressGuard({ upstream: { host: "127.0.0.1", port: 9 } }); // 死端口
  t.after(() => guard.close());
  const r = await socks5Fetch(guard, "example.com", 80);
  assert.equal(r.ok, false);
  assert.equal(r.rep, 0x04);
});
