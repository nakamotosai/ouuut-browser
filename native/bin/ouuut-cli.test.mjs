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
  assert.ok(f.includes("AutomationControlled"), "navigator.webdriver 靠它");
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

test("启动参数:显式给了 user-data-dir 就用给的(留给 real 档案导入)", () => {
  const { args } = buildBrowserArgs({ userDataDir: "D:/my-profile" }, {});
  assert.ok(args.includes("--user-data-dir=D:/my-profile"));
  assert.equal(args.filter((a) => a.startsWith("--user-data-dir=")).length, 1, "不能出现两个");
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
