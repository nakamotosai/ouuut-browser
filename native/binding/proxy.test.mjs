// native/binding/proxy.test.mjs —— 代理串的解析与脱敏(F13 的两半都靠它)
//
// 为什么单开一个文件:这两件事各有一个"看起来对、其实漏"的失败模式 ——
//   * 解析:形状不对的代理串如果放过去,会在**起浏览器之后**才炸(甚至静默不生效);
//   * 脱敏:只要有一个出口没抹干净,凭据就进了日志(实测过一条:`diagnoseExit()` 会打印启动参数)。

import test from "node:test";
import assert from "node:assert/strict";

import { parseProxy, redactProxy, describeArgs, PROXY_BYPASS_LIST, ProxyError } from "./proxy.mjs";

const SECRET = "s3cr3t-pass";

// ---- 解析 -----------------------------------------------------------------

test("parseProxy:只认那几种 scheme,且必须带 host:port", () => {
  for (const ok of [
    "socks5://127.0.0.1:1080",
    "socks5h://proxy.example:41105",
    "http://proxy:8080",
    "https://proxy:8443",
  ]) {
    const p = parseProxy(ok);
    assert.equal(p.raw, ok, `${ok} 应原样保留`);
    assert.ok(p.port > 0, `${ok} 应解析出 port`);
  }
});

test("parseProxy:坏形状一律抛 ProxyError(带代号,不吞)", () => {
  const bad = [
    "ftp://proxy:21", // scheme 不在名单
    "socks5://proxy", // 缺 port
    "socks5://proxy:1080/some/path", // 带路径
    "not a url",
    12345, // 非字符串
  ];
  for (const b of bad) {
    assert.throws(
      () => parseProxy(b),
      (e) => e instanceof ProxyError && e.error_code === "OUUUT_PROXY_INVALID",
      `${JSON.stringify(b)} 必须被拦下`,
    );
  }
  assert.equal(parseProxy(null), null, "没给代理 = null,不是错误");
  assert.equal(parseProxy(""), null);
});

// ---- 脱敏(这是 F13「凭据不落日志」的核心)--------------------------------

test("★ parseProxy:凭据**只准**出现在 raw 里,redacted 必须抹掉", () => {
  const p = parseProxy(`socks5://user:${SECRET}@proxy.example:1080`);
  assert.equal(p.hasCredentials, true);
  assert.ok(p.raw.includes(SECRET), "原文里当然有(要交给浏览器)");
  assert.ok(!p.redacted.includes(SECRET), `redacted 里不许有凭据:${p.redacted}`);
  assert.ok(!p.redacted.includes("user"), "用户名也算凭据的一部分,一起抹");
  assert.equal(p.redacted, "socks5://***@proxy.example:1080");
});

test("★ redactProxy:任意文本里的 `scheme://user:pass@host` 都要抹(包括启动参数形态)", () => {
  const cases = [
    `--proxy-server=socks5://user:${SECRET}@proxy.example:1080`,
    `启动参数:--remote-debugging-pipe --proxy-server=http://u:${SECRET}@p:8080 --headless=new`,
    `[ouuut] 连接 socks5://u:${SECRET}@p:1080 失败`,
  ];
  for (const c of cases) {
    const out = redactProxy(c);
    assert.ok(!out.includes(SECRET), `凭据没抹干净:${out}`);
    assert.ok(out.includes("***@"), `应当留下 ***@ 的痕迹便于判断"这里本来有凭据":${out}`);
  }
  // 没凭据的原样:不要画蛇添足
  assert.equal(redactProxy("socks5://proxy.example:1080"), "socks5://proxy.example:1080");
  assert.equal(redactProxy(""), "");
});

test("describeArgs:启动参数快照必须脱敏(诊断/报错都走它)", () => {
  const argv = ["--remote-debugging-pipe", `--proxy-server=socks5://u:${SECRET}@p:1`, "--headless=new"];
  const line = describeArgs(argv);
  assert.ok(!line.includes(SECRET), line);
  assert.ok(line.includes("--headless=new"), "其余参数要留着(诊断才有用)");
});

test("绕过列表只有一份(浏览器级与 context 级共用,防漂)", () => {
  assert.ok(PROXY_BYPASS_LIST.includes("<-loopback>"), "loopback 不走代理");
  assert.ok(PROXY_BYPASS_LIST.includes("*.ts.net"), "tailnet 不走代理");
});
