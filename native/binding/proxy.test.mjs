// native/binding/proxy.test.mjs —— 代理串的解析与脱敏(F13 的两半都靠它)
//
// 为什么单开一个文件:这两件事各有一个"看起来对、其实漏"的失败模式 ——
//   * 解析:形状不对的代理串如果放过去,会在**起浏览器之后**才炸(甚至静默不生效);
//   * 脱敏:只要有一个出口没抹干净,凭据就进了日志(实测过一条:`diagnoseExit()` 会打印启动参数)。

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseProxy,
  redactProxy,
  redactProxyValue,
  describeArgs,
  proxyRawValues,
  scrubKnownProxies,
  PROXY_BYPASS_LIST,
  ProxyError,
} from "./proxy.mjs";

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

test("★ describeArgs:`--proxy-server=` 走**结构化**脱敏(正则猜不动的形状也要抹净)", () => {
  // 2026-10-25 fuzz 核验:`redactProxy` 那条自由文本启发式对"口令含空格 / 口令含 `/` / 用户名含 `@`"
  // **整条不抹**(它面对任意文本,没法知道边界在哪)。而 `--proxy-server=<值>` 是我们自己拼的、
  // **已知就是一条代理串** —— 这种形状不该靠猜,交给 `parseProxy` 按 WHATWG 算。
  const cases = [
    ["socks5://u:p w@h:1", "socks5://***@h:1"],
    ["socks5://u:p/w@h:1", "socks5://***@h:1"],
    ["socks5://user@corp.example:9Z@127.0.0.1:30613", "socks5://***@127.0.0.1:30613"],
    ["u:\\Qzmkqv@h:1080", "***@h:1080"], // scheme 非法 -> 强制脱敏(前缀不是 scheme 就是凭据)
    ["socks5://u:p@ss@h:1", "socks5://***@h:1"],
  ];
  for (const [value, want] of cases) {
    const line = describeArgs([`--proxy-server=${value}`, "--headless=new"]);
    assert.equal(line, `--proxy-server=${want} --headless=new`, `没抹准:${value}`);
  }
  // 没凭据的别画蛇添足
  assert.equal(
    describeArgs(["--proxy-server=socks5://proxy.example:1080"]),
    "--proxy-server=socks5://proxy.example:1080",
  );
});

test("★ parseProxy 的报错文本也不许漏凭据", () => {
  // 解析失败时我们只能"整段前缀抹掉"——那时已知输入是代理串,不存在需要保护的路径语义。
  const cases = [
    ["u:\\Qzmkqv@h:1080", "Qzmkqv"], // scheme 非法
    ["socks5://u:p/w@h:1", "p/w"], // 带路径
    ["http://user:Qzpass@h", "Qzpass"], // 缺端口
    ["ftp://u:Qzpass@h:1", "Qzpass"], // scheme 不许
  ];
  for (const [bad, secret] of cases) {
    let msg = null;
    try {
      parseProxy(bad);
    } catch (e) {
      msg = e.message;
    }
    assert.ok(msg !== null, `这条本来该抛错:${bad}`);
    assert.ok(!msg.includes(secret), `报错文本漏了凭据片段 ${secret}:${msg}`);
  }
});

test("绕过列表只有一份(浏览器级与 context 级共用,防漂)", () => {
  assert.ok(PROXY_BYPASS_LIST.includes("<-loopback>"), "loopback 不走代理");
  assert.ok(PROXY_BYPASS_LIST.includes("*.ts.net"), "tailnet 不走代理");
});

test("★ redactProxy:无 scheme 的凭据串也要抹(F2 的兜底)—— 回退它会让凭据进诊断", () => {
  // 这条**承重**:核验做过变异(去掉兜底正则)→ 套件仍全绿 ⇒ 也就是说没人守它。
  // 而那种形状真的会出现在诊断里:`--proxy-server=user:pw@h:1080` 会同时进「启动参数」与 stderr 尾部。
  for (const c of [
    `--proxy-server=user:${SECRET}@h:1`,
    `--proxy user:${SECRET}@h:1`,
    `user:${SECRET}@h:1`,
    `=user:${SECRET}@h:1`,
    `--proxy-server=user:@h:1`, // 空口令也要抹(用户名本身也是凭据的一部分)
  ]) {
    const out = redactProxy(c);
    assert.ok(!out.includes(SECRET), `凭据没抹干净:${out}`);
    assert.ok(out.includes("***@"), out);
  }
});

test("★ redactProxy:口令里含 `@`/`\\` 也必须**整段**抹干净(2026-10-25 核验 P2/P3 的两条漏抹)", () => {
  // 这两条都是**真会出现在诊断里**的形状,不是语法外的怪例:
  //   - 口令含 `@`:`parseProxy("socks5://u:p@ss@h:1")` 返回 `hasCredentials:true`
  //     (WHATWG 以**最后**一个 `@` 为分隔)⇒ 用户把 `p@ssw0rd` 当口令打是**我们认可的**输入。
  //     修之前只抹到第一个 `@`,`ss` 会留在启动参数/stderr 里 ⇒ 口令尾巴漏出去。
  //   - 口令含 `\`:修之前尾段禁反斜杠,整条凭据**全漏**(连用户名带口令)。
  for (const [input, want] of [
    ["socks5://u:p@ss@h:1", "socks5://***@h:1"],
    ["u:p@ss@h:1", "***@h:1"],
    ["--proxy-server=user:p\\w@h:1080", "--proxy-server=***@h:1080"],
    ["DOMAIN\\user:p\\w@h:1080", "***@h:1080"],
    ["socks5://user:p\\w@h:1080", "socks5://***@h:1080"],
  ]) {
    assert.equal(redactProxy(input), want, `没抹干净:${input}`);
  }
});

test("redactProxy:别误伤 Windows 路径(盘符前瞻是有用的,不是装饰)", () => {
  // 核验做过变异:删掉前瞻 `(?![A-Za-z]:[\\/])` 时旧用例**全绿** ⇒ 前瞻是死代码。
  // 尾段放宽(允许 `\`,为了不漏口令)之后前瞻变成**唯一的路径挡板**,所以下面这几条现在守得住它。
  for (const pathish of [
    "at C:\\repo\\node_modules\\foo@1.0.0\\index.js",
    "C:\\x\\y:z@w",
    "C:\\a\\b@1.0\\c.js",
    "--flag=C:\\a@b\\c",
    "file:///C:/a@b/c",
    "\\\\srv\\share\\x",
    "C:\\tmp\\a:b@c",
  ]) {
    assert.equal(redactProxy(pathish), pathish, `诊断里的路径不该被搅:${pathish}`);
  }
  // 明知故犯的代价:既含**空格**又带 `x:y@z` 的路径会被多抹(`at C:\a b:c@d\e`)——
  // 那条路只能靠"宁可多抹"兜住(见 proxy.mjs 注释),所以不写成断言,免得后人以为是缺陷。
});

test("★ redactProxy:用户名带反斜杠的域账号凭据**也必须**抹(收窄误伤时曾漏掉这一头)", () => {
  // 2026-10-25 核验抓到的**漏抹**:把兜底的用户名字符类也对反斜杠设禁之后,
  // 域账号形状(`DOMAIN\user:pw@host`)整条漏过去 —— 漏抹 = 口令进日志,比误伤路径严重。
  // 所以两头的字符类是**故意不对称**的:用户名段允许反斜杠,口令段禁止。
  for (const c of [
    `--proxy-server=DOMAIN\\user:${SECRET}@h:1080`,
    `DOMAIN\\user:${SECRET}@h:1080`,
  ]) {
    const out = redactProxy(c);
    assert.ok(!out.includes(SECRET), `域账号凭据没抹干净:${out}`);
    assert.ok(out.includes("***@"), out);
  }
  assert.equal(
    redactProxy(`socks5://DOMAIN\\user:${SECRET}@h:1080`),
    "socks5://***@h:1080",
    "带 scheme 的那条规则(口令段不禁反斜杠)也要照样抹",
  );
});

test("★ scrubKnownProxies:字面替换 —— 启发式猜不动的形状也认得出来", () => {
  // 分工:调用方手里有**原文**时必须先做字面替换(见 cdp-pipe 的 diagnoseExit),
  // 因为自由文本启发式对"口令含空格/含 `/`"这种形状**整条不抹**(fuzz 核验)。
  const raw = "socks5://u:p QzPw@h:1080";
  const line = `[peer] argv: --proxy-server=${raw} --headless=new`;
  assert.ok(redactProxy(line).includes("QzPw"), "前提:启发式确实猜不动这条(否则这条用例没在守东西)");
  const out = redactProxy(scrubKnownProxies(line, [raw]));
  assert.ok(!out.includes("QzPw"), `字面替换后还残留口令:${out}`);
  assert.ok(out.includes("socks5://***@h:1080"), out);
  // 文本里没有原文时不许乱动
  assert.equal(scrubKnownProxies("无关文本", [raw]), "无关文本");
});

test("proxyRawValues:只认 `--proxy-server=<值>`,空值不收", () => {
  assert.deepEqual(
    proxyRawValues(["--headless=new", "--proxy-server=socks5://u:p@h:1", "--proxy-bypass-list=<-loopback>"]),
    ["socks5://u:p@h:1"],
  );
  assert.deepEqual(proxyRawValues(["--proxy-server=", "--proxy-server"]), []);
  assert.deepEqual(proxyRawValues([]), []);
});

test("★ redactProxyValue:`@` 出现在第一个 `://` **之前**时也必须抹干净(2026-10-25 核验抓到的漏抹)", () => {
  // 曾经的输出是 `user:pw@https://***@https://proxy:8080` —— 口令 `pw` 留着,还带着 `***@` 的假象,
  // 比"看得出没抹"更坏:你以为它抹过了。根因:`scheme://` 前缀是"第一个 `://` 之前"那段,
  // 而它自己可能含 `@`。现在只有"前缀不含 `@` 且在最后一个 `@` 之前"才保留前缀。
  for (const [input, want] of [
    ["user:pw@https://proxy:8080", "***@https://proxy:8080"],
    ["u:p@h:1://x", "***@h:1://x"],
    ["a@b://c@d:1", "***@d:1"],
  ]) {
    assert.equal(redactProxyValue(input), want, `没抹干净:${input}`);
    const line = describeArgs([`--proxy-server=${input}`]);
    assert.ok(!line.includes("pw@") && !line.includes(":p@h"), `诊断行里漏了:${line}`);
  }
});

test("★ describeArgs:解析成功时 query/fragment 会被丢掉(那里可能藏口令)—— 别把这条路删成 forceRedact", () => {
  // 核验(mut-e)发现:`redactProxyValue` 里"结构化优先"那条分支没有用例守着,删掉它档案全绿。
  // 但它**不是**死代码:parseProxy 成功时按 WHATWG 归一化并丢掉 query/fragment,
  // 而 forceRedact 在串里没有 `@` 时**原样返回** ⇒ 秘密会直接漏进诊断。
  assert.equal(
    describeArgs(["--proxy-server=socks5://h:1080?password=SENTINEL"]),
    "--proxy-server=socks5://h:1080",
  );
  assert.equal(describeArgs(["--proxy-server=socks5://h:1080#token=SENTINEL"]), "--proxy-server=socks5://h:1080");
});
