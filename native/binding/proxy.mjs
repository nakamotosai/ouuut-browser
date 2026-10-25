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
    throw new ProxyError(`代理串解析失败:${JSON.stringify(forceRedactProxyValue(url))}`);
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!SCHEMES.includes(scheme)) {
    throw new ProxyError(`代理 scheme 只允许 ${SCHEMES.join(" / ")},收到 ${JSON.stringify(scheme)}`);
  }
  if (!u.hostname || !u.port) {
    throw new ProxyError(`代理必须带 host 与 port:${JSON.stringify(forceRedactProxyValue(url))}`);
  }
  if (u.pathname !== "/" && u.pathname !== "") {
    throw new ProxyError(`代理不该带路径:${JSON.stringify(forceRedactProxyValue(url))}`);
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
  return (
    text
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1***@")
      // 兜底:没有 scheme 的 `user:pass@host:port` 同样会出现在诊断的启动参数与 stderr 里。
      // ⚠️ **别把它读成"这种代理能用"**:带凭据的代理串 Chromium **一律不收** —— 2026-10-25 实测(坑-41):
      //      `--proxy socks5://u:p@198.51.100.7:41105` => `net::ERR_NO_SUPPORTED_PROXIES`
      //      (浏览器级「无 --profile-kind」与 context 级「--profile-kind persona」两条路都一样);
      //      对照组 `--proxy socks5://198.51.100.7:41105` => 出口 129.225.148.47(可用)。
      //    抹除的理由**不是**"这种代理能用",而是它会被原样拼进 `--proxy-server=...`
      //    (`native/bin/launch-args.mjs` 的按 kind 分流那几行)并进诊断/错误消息
      //    (两条出口:本模块头注释与 `native/binding/cdp-pipe.mjs` 里 stderr / 启动参数那两处)。
      //    ⚠️ 我们自己拼的那个 `--proxy-server=<值>` **不走这里**,走 `redactProxyValue()` 的结构化脱敏。
      // ⚠️ 两个字符类都是**踩出来的**,别顺手"收窄":
      //    - 尾段允许 `@`(要的是**最后**一个 `@`):口令含 `@` 是**我们认可的**形状 ——
      //      实测 `parseProxy("socks5://u:p@ss@h:1")` 返回 `hasCredentials:true`(WHATWG 以最后一个 `@` 为分隔),
      //      只抹到第一个 `@` 会把口令尾巴(`ss`)留在诊断里(2026-10-25 核验 P2);
      //    - 尾段允许 `\`:口令含反斜杠时若禁止,整条凭据**全漏**(同日核验 P3);
      //    - 路径误伤改由**盘符前瞻** `(?![A-Za-z]:[\\/])` 挡 —— 它**有用**,别删:
      //      `at C:\repo\node_modules\foo@1.0.0\index.js` 删掉前瞻就会被整段吞(有用例守着)。
      // ⚠️ **已知边界**(2026-10-25 fuzz 核验,5200 条生成式里 29.6% 抹不净;全部是**既有**问题,非某次改动引入)。
      //    这里只处理**自由文本**,所以刻意"宁可多抹,不可漏抹";能走结构化的一律别走这里:
      //    1. 抹不净(⇒ 口令可能进日志):口令含**空格**或 `/`、用户名含 `@`、单字符用户名 + `\` 开头口令
      //       (`u:\Qzmkqv@h:1080` 里 `u:\` 与盘符同形,被前瞻否掉)——这些交给 `redactProxyValue()`/`parseProxy().redacted`。
      //    2. 多抹(只是显示难看):既含空格又带 `x:y@z` 的路径(`at C:\a b:c@d\e`)、
      //       JSON 跨字段(`"data":"C:\a:b@c"`)、`\\?\C:\...` 扩展路径、`file:C:\a\b@2.json`
      //       —— 前瞻只在本行**匹配起点**处生效,这些起点不在盘符上。
      .replace(/(^|[\s=])(?![A-Za-z]:[\\/])([^\s/@:=]+:[^\s/]*@)/g, "$1***@")
  );
}

/**
 * **强制**脱敏一条**已知是代理串**的值:把**最后一个 `@`** 之前的整段前缀换成 `***`。
 *
 *
 * ⚠️ **它是"整段糊掉",不是"保留可读性"**:值里带路径时 `host:port` 会一起没
 *    (`socks5://u:p@h:1080/a@b` 报错文本会变成 `socks5://***@b`)。这是**故意**的:
 *    它只用于"已知是代理串"的值与代理串的报错文本,那里要的是"绝不漏",不是"好看"。
 * 与 `redactProxy` 的分工:那个面对的是**任意自由文本**(stderr、错误消息),只能靠正则猜,
 * 因此对"口令含空格 / 口令含 `/` / 用户名含 `@`"这类形状**猜不动**(见其注释里的已知边界);
 * 这里输入**已知就是一条代理串**,前缀只可能是 scheme 或凭据,不存在需要保护的路径语义,于是可以整段抹。
 */
function forceRedactProxyValue(value) {
  const at = value.lastIndexOf("@");
  if (at === -1) return value; // 没有凭据段,没什么可抹
  // `scheme://` 前缀只在**它自己不含 `@` 且确实在最后一个 `@` 之前**时才保留 ——
  // 否则会出现"看着像抹了、其实前段原样留着"的输出:`user:pw@https://proxy:8080` 曾经被抹成
  // `user:pw@https://***@https://proxy:8080`(口令留着,还带着 `***@` 的假象)。
  // 2026-10-25 核验抓到这一条。
  const sep = value.indexOf("://");
  const head =
    sep !== -1 && sep + 3 <= at && !value.slice(0, sep + 3).includes("@") ? value.slice(0, sep + 3) : "";
  return `${head}***${value.slice(at)}`;
}

/**
 * 脱敏一条代理串的**值**(结构化优先)。
 *
 * 先让 `parseProxy` 按 WHATWG 解析、用它算出来的 `redacted` —— 这样
 * `socks5://u:p w@h:1`(口令含空格)、`socks5://user@corp.example:9Z@h:1`(用户名含 `@`)、
 * `socks5://u:p@ss@h:1`(口令含 `@`)这些**正则猜不动**的形状都能抹准;
 * 解析不动的(如 `u:\Qzmkqv@h:1080` —— scheme 非法)退回 `forceRedactProxyValue`。
 *
 * ⚠️ 别拿它去处理**自由文本**:它假设整串就是一条代理串,会把串里的路径语义一起抹掉。
 */
export function redactProxyValue(value) {
  if (typeof value !== "string" || value === "") return value;
  try {
    const parsed = parseProxy(value);
    // 这条分支承重:`parseProxy().redacted` 会**丢掉 query/fragment**(那里可能藏着口令),
    // 并按 WHATWG 归一化;只用 forceRedact 的话 `--proxy-server=socks5://h:1080?password=X` 会原样漏出。
    if (parsed) return parsed.redacted;
  } catch {
    // ⚠️ 这里是**故意**宽catch:本函数只用于"打印给别人看",一条格式化错误不该让诊断路径本身炸掉。
    // 代价:将来 parseProxy 里出真 bug(不只是 ProxyError)会被静默降级成强制脱敏 —— 界面上看不出。
    // 所以改动 parseProxy 时,别指望这条分支会提醒你。
  }
  return forceRedactProxyValue(value);
}

/**
 * 从启动参数里捞出**可能带凭据的原始代理串**(给"字面替换"用)。
 *
 * 为什么需要它:`redactProxy()` 面对任意自由文本只能猜形状,而**对端很可能把我们自己的参数原文
 * 打进 stderr**(2026-10-25 抓到过)。调用方(如 `cdp-pipe.mjs` 的 `diagnoseExit`)手里**有**这些原文,
 * 于是可以先做**字面替换** —— 形状再怪(口令含空格/`/`/`@`)也认得出来,不靠猜。
 */
export function proxyRawValues(argv = []) {
  const out = [];
  for (const a of argv) {
    const m = /^--proxy-server=(.*)$/s.exec(String(a));
    if (m && m[1] !== "") out.push(m[1]);
  }
  return out;
}

/** 把文本里**已知的原始代理串**整条换成脱敏形式(字面匹配,不做任何形状猜测)。 */
export function scrubKnownProxies(text, raws = []) {
  let out = String(text);
  for (const raw of raws) {
    if (typeof raw === "string" && raw !== "" && out.includes(raw)) {
      out = out.split(raw).join(redactProxyValue(raw));
    }
  }
  return out;
}

/**
 * 校验一条**要交给浏览器用**的代理串:形状必须合法,**并且不许带凭据**。
 *
 * 为什么连凭据也拒(而不是"留着说不定以后支持"):2026-10-25 实测(见 `docs/坑与解法.md` 坑-41),
 * Chromium 156 对带凭据的串**两条路都不收** —— 浏览器级 `--proxy-server=` 与 context 级
 * `Target.createBrowserContext({proxyServer})` 都报 `net::ERR_NO_SUPPORTED_PROXIES`。
 * 放过去的代价是"会话起得来、导航时才炸",用户完全看不出是参数的错;
 * 而凭据本身**不会**因此变安全:它照样进诊断(stderr/启动参数),所以我们照样要抹它。
 * ⇒ 在这里早失败,并且把"该怎么办"说清楚。
 *
 * 抛错文本已脱敏(走 `forceRedactProxyValue`),不会把用户给的口令打进日志。
 * 这是**唯一**的判据入口:浏览器级、context 级、档案簿记三条路都调它,免得各写一份判断(会漂)。
 */
export function assertProxyUsable(url) {
  const parsed = parseProxy(url); // 形状不合法时这里就抛(文本已脱敏)
  if (parsed && parsed.hasCredentials) {
    throw new ProxyError(
      "浏览器不接受带凭据的代理串(2026-10-25 实测:浏览器级与 context 级都报 ERR_NO_SUPPORTED_PROXIES," +
        "见 docs/坑与解法.md 坑-41):请改用免认证出口(IP 白名单 / tailnet / 本机 socks)。" +
        "带凭据的串不会生效,只会进诊断 —— 所以这里直接拒绝。",
      "OUUUT_PROXY_CREDENTIALS_UNSUPPORTED",
    );
  }
  return parsed;
}

/**
 * 启动参数数组 → **可打印**的一行(代理凭据脱敏)。诊断/报错一律用这个。
 *
 * `--proxy-server=<值>` 走**结构化**脱敏(`redactProxyValue`):这个值是我们自己拼的、已知是代理串,
 * 不该依赖正则去猜(2026-10-25 fuzz 核验:自由文本那条启发式对"口令含空格/含 `/`"整条不抹)。
 * 其余参数走自由文本脱敏(它们可能是任何东西,包括日志行里的路径)。
 */
export function describeArgs(argv = []) {
  return argv
    .map((a) => {
      const s = String(a);
      const m = /^--proxy-server=(.*)$/s.exec(s);
      return m ? `--proxy-server=${redactProxyValue(m[1])}` : redactProxy(s);
    })
    .join(" ");
}
