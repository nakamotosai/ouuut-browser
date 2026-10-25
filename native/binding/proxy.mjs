// native/binding/proxy.mjs —— 代理串的**解析**与**脱敏**
//
// 为什么单独一个文件:`F13` 的两半都要它 ——
//   1. **按档案绑代理**:每个 browser context 带走自己的 `proxyServer`(见 `session-profiles.mjs`);
//   2. **凭据不落日志**:凡是可能被打印/记录/回给 agent 的地方,都必须先过 `redactProxy()`。
//
// ⚠️ 第二半不是洁癖。2026-10-25 在**通道层**抓到两条已经存在的泄漏路径(都是写用例时撞出来的):
//   1. `diagnoseExit()` 会把**启动参数原样**拼进错误消息(`启动参数:...`),
//      而 `--proxy-server=socks5://user:pass@host:1080` 就在那串里;
//   2. 同一段诊断里的 **stderr 尾部**也没抹 —— 对端把自己的参数打进 stderr 时,凭据照样漏出来。
//   所以脱敏要在**通道层**也做一遍,不能只在入口做。

/** 认这些 scheme(与 Chrome 的 `--proxy-server` 同一族;`socks5h` = 远端解析 DNS)。 */
const SCHEMES = Object.freeze(["socks5", "socks5h", "socks4", "http", "https"]);

/** 代理绕过列表 —— 浏览器级 `--proxy-server` 与 context 级 `proxyServer` **共用这一份**。 */
export const PROXY_BYPASS_LIST = "<-loopback>;localhost;127.0.0.1;*.ts.net";

export class ProxyError extends Error {
  constructor(message, errorCode = "OUUUT_PROXY_INVALID") {
    super(message);
    this.name = "ProxyError";
    this.error_code = errorCode;
  }
}

/**
 * 解析一条代理串。**只认能真正交给 Chrome 的形状**:
 *   `scheme://[user:pass@]host:port`
 *
 * 凭据允许出现在这里(它们本来就要传给浏览器),但**只允许**出现在 `raw` 字段 ——
 * 对外一律用 `redacted`。
 */
export function parseProxy(url) {
  if (url === null || url === undefined || url === "") return null;
  if (typeof url !== "string") {
    throw new ProxyError(`代理必须是字符串,收到 ${typeof url}`);
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ProxyError(`代理串解析失败:${JSON.stringify(redactProxy(url))}`);
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!SCHEMES.includes(scheme)) {
    throw new ProxyError(`代理 scheme 只允许 ${SCHEMES.join(" / ")},收到 ${JSON.stringify(scheme)}`);
  }
  if (!u.hostname || !u.port) {
    throw new ProxyError(`代理必须带 host 与 port:${JSON.stringify(redactProxy(url))}`);
  }
  if (u.pathname !== "/" && u.pathname !== "") {
    throw new ProxyError(`代理不该带路径:${JSON.stringify(redactProxy(url))}`);
  }
  const hasCredentials = Boolean(u.username || u.password);
  return {
    scheme,
    host: u.hostname,
    port: Number(u.port),
    hasCredentials,
    /** **可以打印**的形式:凭据被换成 `***`。 */
    redacted: `${scheme}://${hasCredentials ? "***@" : ""}${u.hostname}:${u.port}`,
    /** **只给浏览器**的原文(含凭据)。除了丢给 Chrome,别处一律别用。 */
    raw: url,
    /** 给 Chrome 的 `--proxy-server` / `proxyServer` 用的串(带凭据,不带 scheme 之外的修饰)。 */
    chromeValue: url,
  };
}

/**
 * 把任何**可能含代理凭据**的字符串脱敏。用于日志、错误消息、启动参数快照、对 agent 的回显。
 *
 * 两步:① 认出 `scheme://user:pass@host` 形态并把凭据段换掉;
 * ② 兜底:任何 `scheme://…@host` 形态(哪怕是别的 scheme)也把 `@` 之前那段换掉 ——
 *    宁可多抹,不可漏。
 */
export function redactProxy(text) {
  if (typeof text !== "string" || text === "") return text;
  return text
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi,
      "$1***@",
    );
}

/** 启动参数数组 → **可打印**的一行(代理凭据脱敏)。诊断/报错一律用这个。 */
export function describeArgs(argv = []) {
  return argv.map((a) => redactProxy(String(a))).join(" ");
}
