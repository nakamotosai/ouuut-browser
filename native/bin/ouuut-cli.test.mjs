// native/bin/ouuut-cli.test.mjs —— CLI 的验收(除"真浏览器说不说这套协议"之外的每一步)
//
// 运行:node --test native/bin/ouuut-cli.test.mjs
//
// 关键设计:`withRuntime` 的 `spawn` 是可注入的。测试把**假 CDP 对端**塞进去,
// 于是「参数怎么拼 / 全局名注入 / 收尾顺序 / 启动参数里不许出现什么」全都可验,
// 而不需要起真浏览器。

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { withRuntime, cli } from "./ouuut.mjs";
import { parseArgs, buildBrowserArgs, FORBIDDEN_ARGS, USAGE } from "./launch-args.mjs";
import { spawnCdpPipe } from "../binding/cdp-pipe.mjs";

const PEER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "binding", "fixtures", "fake-cdp-peer.mjs",
);

/** 注入用:起假对端当"浏览器"。 */
function fakeSpawn({ name, timeoutMs }) {
  return spawnCdpPipe({ exe: process.execPath, args: [PEER], name, timeoutMs });
}

// ---- 参数 ----------------------------------------------------------------

test("parseArgs:与上游同形的 `ouuut nodejs < script` 不吃掉脚本", () => {
  const o = parseArgs(["nodejs"]);
  assert.equal(o.error, null);
  assert.equal(o.script, null, "`nodejs` 是模式词,不是脚本路径");
  assert.equal(parseArgs(["nodejs"]).namespace, "ouuut");
});

test("parseArgs:缺值的选项给友好错误,不是堆栈", () => {
  assert.match(parseArgs(["--browser"]).error, /需要一个值/);
  assert.match(parseArgs(["--nope"]).error, /未知选项/);
});

// ---- 启动参数:那六项"不要"的守护 ------------------------------------------

test("★ cli() 要把 harness 的退出码传出去(此前写死 0,空脚本曾 rc=0)", async () => {
  const sink = { out: "", write(s) { this.out += s; } };
  // 数字 —— 原样传出
  const rc = await cli({ argv: [], runScript: async () => 2, spawn: fakeSpawn, stdout: sink });
  assert.equal(rc, 2, "数字返回码必须原样传出去");
  // 非数字(测试里 runScript 可能返回任意值)—— 不许被当成退出码
  const rc2 = await cli({ argv: [], runScript: async () => "ok", spawn: fakeSpawn, stdout: sink });
  assert.equal(rc2, 0, "非数字一律当 0");
});

test("★ --script 的关键行为:不碰 stdin、坏脚本不许起浏览器", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "ouuut-script-"));
  let spawned = 0;
  const countingSpawn = (...a) => {
    spawned += 1;
    return fakeSpawn(...a);
  };
  const sink = { out: "", write(s) { this.out += s; } };
  try {
    // 1) 文件不存在 —— 读文件就失败,而且**从来没起过浏览器**
    const rc1 = await cli({
      argv: ["nodejs", "--script", path.join(dir, "nope.mjs")],
      spawn: countingSpawn, stdout: sink, stdin: null,
    });
    assert.equal(rc1, 2, "读不到脚本文件:就地失败(2),不是把堆栈甩出来");
    assert.equal(spawned, 0, "脚本都没读到,不该起浏览器");

    // 2) 空文件 —— 同样不许起(此前会 rc=0 起一次浏览器,再让 harness 打它自己的 USAGE)
    const empty = path.join(dir, "empty.mjs");
    writeFileSync(empty, "\n  \n", "utf8");
    const rc2 = await cli({ argv: ["nodejs", "--script", empty], spawn: countingSpawn, stdout: sink, stdin: null });
    assert.equal(rc2, 2, "空白脚本应当就地拒绝");
    assert.equal(spawned, 0, "空白脚本不该起浏览器(见坑-23:硬杀的浏览器会锁住 chrome.dll)");

    // 3) 目录 —— 可读性错误,不许起
    const rc3 = await cli({ argv: ["nodejs", "--script", dir], spawn: countingSpawn, stdout: sink, stdin: null });
    assert.equal(rc3, 2, "传目录同样是就地失败(2)");
    assert.equal(spawned, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("启动参数:绝不含那几项指纹来源(断言,不是装饰)", () => {
  const { args } = buildBrowserArgs({}, {});
  for (const bad of FORBIDDEN_ARGS) {
    assert.ok(
      !args.some((a) => a === bad || a.startsWith(bad + "=")),
      `${bad} 不该出现在启动参数里(见 docs/补丁点位.md §三)`,
    );
  }
});

test("启动参数:通道是 pipe,不是 TCP 端口", () => {
  const { args } = buildBrowserArgs({}, {});
  assert.ok(args.includes("--remote-debugging-pipe"));
  assert.ok(!args.some((a) => a.startsWith("--remote-debugging-port")));
});

test("启动参数:disable-features 里不含 ThirdPartyStoragePartitioning", () => {
  const { args } = buildBrowserArgs({}, {});
  const f = args.find((a) => a.startsWith("--disable-features="));
  assert.ok(f, "应该有 --disable-features");
  assert.ok(!f.includes("ThirdPartyStoragePartitioning"), "这一项要保留(§三)");
  // ⚠️ 这里原来断言「f.includes("AutomationControlled")」并写着「navigator.webdriver 靠它」——
  // 那是**把 bug 钉住了**:AutomationControlled 是 Blink 特性,放进 `--disable-features` 不生效,
  // 真机检测站如实报 `navigator.webdriver = true`(2026-10-25,坑-35)。
  // 正确写法由 `launch-args.test.mjs` 里那条「navigator.webdriver 必须走 --disable-blink-features」守 ——
  // 本文件只负责「不许混进 --disable-features」这一半。
  assert.ok(!f.includes("AutomationControlled"), "它是 Blink 特性,不该出现在这份名单里");
});

test("启动参数:proxy 会带 bypass 列表(loopback 与 tailnet 不走代理)", () => {
  const { args } = buildBrowserArgs({ proxy: "socks5://127.0.0.1:1080" }, {});
  assert.ok(args.includes("--proxy-server=socks5://127.0.0.1:1080"));
  const bypass = args.find((a) => a.startsWith("--proxy-bypass-list="));
  assert.ok(bypass.includes("<-loopback>"));
  assert.ok(bypass.includes("*.ts.net"));
});

test("启动参数:**默认给一个本会话专用的档案目录**(不贴使用者的真实 Chrome)", () => {
  const { args } = buildBrowserArgs({}, {});
  // 实测结论(2026-10-25):不传 `--user-data-dir` 时,新实例会去用
  // `%LOCALAPPDATA%\Google\Chrome\User Data` —— 与使用者正在运行的真实 Chrome 同一个,
  // 于是交接给已运行实例后自己退出(code=0),表现为 listTabs 报「ouuut 退出」。
  const udd = args.find((a) => a.startsWith("--user-data-dir="));
  assert.ok(udd, "必须给 --user-data-dir,否则会去贴使用者的真实档案");
  const dir = udd.slice("--user-data-dir=".length);
  assert.ok(path.isAbsolute(dir), "必须是绝对路径");
  assert.ok(dir.includes("ouuut-session-"), `目录名该带会话标记,得到 ${dir}`);
  assert.ok(!/Google[\\/]Chrome[\\/]User Data/i.test(dir), "绝不能落在使用者的 Chrome 档案目录里");
});

test("默认档案目录带 pid,同机多会话互不干扰", () => {
  const a = buildBrowserArgs({ pid: 111 }, {}).args.find((x) => x.startsWith("--user-data-dir="));
  const b = buildBrowserArgs({ pid: 222 }, {}).args.find((x) => x.startsWith("--user-data-dir="));
  assert.notEqual(a, b, "两个会话抢同一个 user-data-dir 会造成同样的『交接后退出』");
});

test("★ 会话专用的临时档案目录**用完即删**(核验实测:%TEMP% 里曾累计 88 个)", async () => {
  // 这条守的是 ADR-007 那句话的落地:「disposable 用完即弃」。
  // 核验者 2026-10-25 实测:每跑一次 CLI 就留下一个 `ouuut-session-<pid>`,累计到 88 个。
  const { mkdir, writeFile, rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { defaultUserDataDir } = await import("./launch-args.mjs");
  const dir = defaultUserDataDir("ouuut", process.pid); // 与 withRuntime 内部那条默认路径一致
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "marker.txt"), "x");

  await withRuntime({ argv: [], run: async () => "ok", spawn: fakeSpawn });

  assert.equal(existsSync(dir), false, "会话结束后不该留下临时档案目录");
  await rm(dir, { recursive: true, force: true }); // 保险:万一断言失败也别留垃圾
});

test("★ 调用方显式给的档案目录**绝不删**(那是使用者的身份)", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const os = await import("node:os");
  const dir = path.join(os.tmpdir(), `ouuut-keep-${process.pid}`);
  await mkdir(dir, { recursive: true });

  const DIR_FLAG = ["--user-data", "dir"].join("-");
  await withRuntime({ argv: [DIR_FLAG, dir], run: async () => "ok", spawn: fakeSpawn });

  assert.equal(existsSync(dir), true, "显式给的档案目录必须原样留着 —— 那是使用者的真实身份");
  await rm(dir, { recursive: true, force: true });
});

test("★ 启动参数:launcher 要告诉调用方「档案目录是谁给的」(收尾清理靠它)", () => {
  const a = buildBrowserArgs({}, {});
  assert.ok(a.userDataDir, "要回传实际用的档案目录");
  assert.equal(a.ephemeralUserDataDir, true, "默认那条是**我们**造的 ⇒ 会话结束可以删");
  const b = buildBrowserArgs({ userDataDir: "D:/my-profile" }, {});
  assert.equal(b.userDataDir, "D:/my-profile");
  assert.equal(b.ephemeralUserDataDir, false, "调用方显式给的 ⇒ 绝不删");
});

test("启动参数:显式给了 user-data-dir 就用给的(留给 real 档案导入)", () => {
  const { args } = buildBrowserArgs({ userDataDir: "D:/my-profile" }, {});
  assert.ok(args.includes("--user-data-dir=D:/my-profile"));
  assert.equal(args.filter((a) => a.startsWith("--user-data-dir=")).length, 1, "不能出现两个");
});

// ---- 窗口位置:给"把 agent 浏览器放到副屏"用的 ------------------------------
//
// 起因:调试时浏览器弹在使用者**主屏**上,而他在主屏做别的事。
// 这不是调试便利,是产品该有的能力 —— agent 浏览器不该抢使用者的主屏。

test("窗口位置:默认**不给**位置,只给 --start-maximized", () => {
  const { args } = buildBrowserArgs({}, {});
  assert.ok(args.includes("--start-maximized"));
  assert.equal(args.filter((a) => a.startsWith("--window-position")).length, 0);
});

test("★ 窗口位置:给了位置就钉住,且**不再** --start-maximized(否则会跑到别的屏)", () => {
  const { args } = buildBrowserArgs({ windowPosition: "1707,0", windowSize: "1380,950" }, {});
  assert.ok(args.includes("--window-position=1707,0"));
  assert.ok(args.includes("--window-size=1380,950"));
  assert.ok(!args.includes("--start-maximized"), "最大化会无视指定位置");
});

test("窗口位置:环境变量也能给(便于整批运行时统一钉住)", () => {
  const { args } = buildBrowserArgs({}, { OUUUT_WINDOW_POSITION: "1707,0", OUUUT_WINDOW_SIZE: "1380,950" });
  assert.ok(args.includes("--window-position=1707,0"));
  assert.ok(args.includes("--window-size=1380,950"));
});

test("窗口位置:选项**优先于**环境变量", () => {
  const { args } = buildBrowserArgs({ windowPosition: "0,0" }, { OUUUT_WINDOW_POSITION: "1707,0" });
  assert.ok(args.includes("--window-position=0,0"));
  assert.ok(!args.includes("--window-position=1707,0"));
});

test("parseArgs 认 --window-position / --window-size,且缺值时报友好错误", () => {
  const o = parseArgs(["--window-position", "1707,0", "--window-size", "1380,950"]);
  assert.equal(o.windowPosition, "1707,0");
  assert.equal(o.windowSize, "1380,950");
  assert.match(parseArgs(["--window-position"]).error, /需要一个值/);
});

test("启动参数:浏览器路径优先 --browser,其次 OUUUT_BROWSER,最后本仓默认产物", () => {
  assert.equal(buildBrowserArgs({ browser: "X:\\a.exe" }, {}).exe, "X:\\a.exe");
  assert.equal(buildBrowserArgs({}, { OUUUT_BROWSER: "Y:\\b.exe" }).exe, "Y:\\b.exe");
  assert.match(buildBrowserArgs({}, {}).exe, /out[\\/]Release/);
});

// ---- 会话生命周期 --------------------------------------------------------

test("withRuntime:注入 globalThis.ouuut,跑完还原", async (t) => {
  const before = globalThis.ouuut;
  let seenDuring = null;
  await withRuntime({
    spawn: fakeSpawn,
    async run({ api }) {
      seenDuring = globalThis.ouuut;
      assert.equal(typeof api.sendCDPMessage, "function");
    },
  });
  assert.equal(seenDuring, globalThis.ouuut === undefined ? seenDuring : seenDuring, "运行期必须已注入");
  assert.notEqual(seenDuring, undefined, "运行期 globalThis.ouuut 要有东西");
  assert.equal(globalThis.ouuut, before, "跑完必须还原");
});

test("withRuntime:异常路径也收尾(不留活着的子进程)", async (t) => {
  let childRef = null;
  await assert.rejects(
    () =>
      withRuntime({
        spawn: (o) => {
          childRef = fakeSpawn(o);
          return childRef;
        },
        async run() {
          throw new Error("脚本炸了");
        },
      }),
    /脚本炸了/,
  );
  assert.ok(childRef, "应该起过进程");
  assert.equal(childRef.closed, true, "异常路径也必须把浏览器关掉(否则会锁住 chrome.dll —— 坑-23)");
});

test("withRuntime:能经我们的运行时跑到假对端,并拿到真实响应", async () => {
  const res = await withRuntime({
    spawn: fakeSpawn,
    async run({ api }) {
      // harness 的 CDP 通路走的是 sendCDPMessage/onCDPMessage —— 这里直接用最小子集验证
      const got = new Promise((resolve) => {
        api.onCDPMessage = (payload) => {
          const m = JSON.parse(payload);
          if (m.id === 42) resolve(m);
        };
      });
      api.sendCDPMessage(JSON.stringify({ id: 42, method: "Fake.echo", params: { hi: true } }));
      return got;
    },
  });
  assert.deepEqual(res.result, { echo: { hi: true } });
});

test("withRuntime:任务空间世界在会话内可用(listTaskSpaces 形状正确)", async () => {
  const res = await withRuntime({
    spawn: fakeSpawn,
    async run({ api }) {
      const s = await api.createTaskSpace("CLI 会话");
      return { created: s, listed: await api.listTaskSpaces() };
    },
  });
  assert.equal(typeof res.created.id, "number");
  assert.ok(Array.isArray(res.listed.taskSpaces));
  assert.equal(res.listed.taskSpaces.length, 1);
});

test("cli --help 打到 stdout 且返回 0(不抛)", async () => {
  let printed = "";
  const code = await cli({
    argv: ["--help"],
    stdout: { write: (s) => { printed += s; } },
  });
  assert.equal(code, 0);
  assert.ok(printed.includes("ouuut"), "帮助里要有用法");
  assert.equal(printed.trim().endsWith(USAGE.trim().split("\n").pop().trim()), true, "打到的是同一份 USAGE");
});

test("cli 参数错 → 返回 2(而不是抛出去砸栈)", async () => {
  const code = await cli({ argv: ["--bogus"], stdout: { write() {} } });
  assert.equal(code, 2);
});

test("★ real + --proxy:能起会话,且出口走浏览器级(档案层收不到 proxy)", async () => {
  // 这条**承重**:核验做过变异(把 CLI 的 filter 还原)→ 套件仍绿,但真实行为是"会话起不来"。
  const dir = path.join((await import("node:os")).tmpdir(), `ouuut-real-${process.pid}`);
  const { mkdir, rm } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const seen = [];
  let captured = null;
  const spySpawn = (o) => {
    captured = o;
    const cdp = fakeSpawn(o);
    const origSend = cdp.send;
    cdp.send = (method, params, opts) => {
      seen.push({ method, params });
      return origSend(method, params, opts);
    };
    return cdp;
  };
  const DIR_FLAG = ["--user-data", "dir"].join("-");
  try {
    // 免认证代理(带凭据的那种现在被**早拒**,见下一条用例)
    const rc = await cli({
      argv: ["nodejs", "--profile-kind", "real", DIR_FLAG, dir, "--proxy", "socks5://127.0.0.1:1080"],
      spawn: spySpawn,
      // 脚本直接返回,别真跑 harness:我们只关心"会话起得来 + 参数怎么分流"
      runScript: async () => 0,
      stdout: { write() {} },
    });
    assert.equal(rc, 0, "real + --proxy 必须能起会话(此前被库层抛死)");
    // 出口走浏览器级 —— 但现在浏览器级指向的是**出口闸**(本地 socks5),
    // 闸再把连接转发给用户给的 127.0.0.1:1080(所以这里断言"是 loopback 的 socks5 且不是 1080 本身")。
    const proxyArg = captured.args.find((a) => a.startsWith("--proxy-server="));
    assert.ok(proxyArg, `real 的出口必须走浏览器级:${captured.args.join(" ")}`);
    assert.match(proxyArg, /^--proxy-server=socks5:\/\/127\.0\.0\.1:\d+$/, `应当是本地闸:${proxyArg}`);
    assert.ok(!proxyArg.endsWith(":1080"), "浏览器不该直连用户的代理(那样回连名单那道闸就绕过去了)");
    assert.ok(
      !seen.some((c) => c.method === "Target.createBrowserContext"),
      "real 不建 context(也就不会碰 context 级代理)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("★ 带凭据的 --proxy:必须**早失败**,而不是起会话、导航时才炸(且不许多带凭据的串进日志)", async (t) => {
  const { mkdir, rm } = await import("node:fs/promises");
  const dir = path.join(os.tmpdir(), `ouuut-cli-cred-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const DIR_FLAG = ["--user-data", "dir"].join("-");
  const SECRET = "QzCredPw";
  // CLI 的早失败走 `process.stderr.write`(与"空脚本""读不到脚本"同一个风格),所以在进程级截它
  const printed = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    printed.push(String(chunk));
    return true;
  };
  try {
    const rc = await cli({
      argv: ["nodejs", DIR_FLAG, dir, "--proxy", `socks5://user:${SECRET}@h:1080`],
      spawn: () => {
        throw new Error("不该走到起浏览器这一步:带凭据的代理必须在校验处就被拒");
      },
      runScript: async () => 0,
      stdout: { write() {} },
    });
    assert.equal(rc, 2, "带凭据的代理要**早失败**(非零码),不许「照常跑」");
    const msg = printed.join("\n");
    assert.ok(/凭据/.test(msg), `要告诉用户原因(是参数问题,不是网络问题):${msg}`);
    assert.ok(!msg.includes(SECRET), `拒绝的理由里也不许带口令:${msg}`);
  } finally {
    process.stderr.write = realWrite;
    await rm(dir, { recursive: true, force: true });
  }
});
