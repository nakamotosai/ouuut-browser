// native/bin/launch-args.test.mjs —— 启动参数:三种档案 + 无头/桌面同一套
//
// 对应 F11(M5)的验收:「同一套 API 在桌面与服务器可用」。
// 这里把"同一套"落成一条**可断言的性质**:同一种档案,有头与无头的计划
// **只允许在窗口参数和 --headless 上有差别**,别的必须逐项相同。

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  buildBrowserArgs,
  FORBIDDEN_ARGS,
  USAGE,
  DEFAULT_HEADLESS_SCREEN,
} from "./launch-args.mjs";
import { KINDS } from "../binding/archive.mjs";

/** 档案目录参数(拆开写只是为了让这条字符串不在别处被误当成"起浏览器")。 */
const DIR_FLAG = ["--user-data", "dir"].join("-");
const DIR_VALUE = "C:/tmp/ouuut-test-profile";

// 「窗口/显示几何」类参数 —— 桌面与无头的计划允许在这类参数上不同(F11 的「同一套」)
const WINDOW_ARGS = /^--(window-position|window-size|screen-info|start-maximized)/;

const plan = (argv) => {
  const opts = parseArgs(argv);
  assert.equal(opts.error, null, `解析应成功,却报:${opts.error}`);
  return { opts, ...buildBrowserArgs(opts) };
};

// ---- 1. 三种档案 ----------------------------------------------------------

test("三种档案的 kind 都能解析(real 需要显式档案目录)", () => {
  for (const kind of KINDS) {
    const argv = ["--profile-kind", kind];
    if (kind === "real") argv.push(DIR_FLAG, DIR_VALUE);
    const opts = parseArgs(argv);
    assert.equal(opts.error, null, `${kind} 应能解析:${opts.error}`);
    assert.equal(opts.profileKind, kind);
  }
});

test("★ real 不给档案目录 → **报错**,不许替他造一个", () => {
  const opts = parseArgs(["--profile-kind", "real"]);
  assert.ok(opts.error, "必须报错");
  assert.match(opts.error, /不能替他造/, "错误信息要说清为什么不给默认值");
});

test("非法 kind → 报错,并列出合法值", () => {
  const opts = parseArgs(["--profile-kind", "superuser"]);
  assert.ok(opts.error);
  for (const k of KINDS) assert.ok(opts.error.includes(k), `错误信息要提到 ${k}`);
});

// ---- 2. 无头 vs 桌面 ------------------------------------------------------

test("★ 无头下只给尺寸、不给位置(原断言「一条窗口参数都不给」已被真机证伪)", () => {
  // 这条**原先**断言无头下 `win` 必须为空、理由是"没有窗口可摆,给了只是噪音"。
  // 2026-10-25 真机把它证伪了:headless 默认 800×600,检测站直接点名,
  // 所以"什么都不给"本身就是一个可指纹化的常数(见坑-37)。
  const SCREEN = `--screen-info={${DEFAULT_HEADLESS_SCREEN.replace(",", "x")} isInternal=false workAreaBottom=48}`;
  {
    const { args } = plan(["--headless"]);
    assert.deepEqual(
      args.filter((a) => WINDOW_ARGS.test(a)),
      ["--window-size=1880,1000", SCREEN],
      "无头:给窗口尺寸(比屏小一圈)+ 屏幕尺寸,但不给位置",
    );
  }
  {
    const { args } = plan(["--headless", "--window-position", "1920,0"]);
    const win = args.filter((a) => WINDOW_ARGS.test(a));
    assert.ok(!win.some((a) => a.startsWith("--window-position")), "无头下位置仍然不给(没有窗口可摆)");
    assert.ok(win.some((a) => a.startsWith("--window-size")), "但尺寸要给");
    assert.ok(win.some((a) => a.startsWith("--screen-info")), "屏幕尺寸也要给");
  }
  {
    // 显式给的尺寸必须听 —— 此前无头会把它静默丢掉
    const { args } = plan(["--headless", "--window-size", "1380,960"]);
    const win = args.filter((a) => WINDOW_ARGS.test(a));
    assert.deepEqual(win, ["--window-size=1380,960", SCREEN], "窗口听调用方的;屏幕仍装得下它");
  }
});

test("★ 有头**不许**带 --screen-info/--window-size(否则几何这一维就没约束了)", () => {
  // 核验者用突变实验指出:`WINDOW_ARGS` 正则放宽后,有头分支若混进 `--screen-info` / `--window-size`
  // 不会被任何断言抓到("同一档案"那条会把两边一起剥掉)。这里对**三条分支**各断定 ——
  // 只守 `plan([])`(走 --start-maximized 那条)是不够的:给位置/给尺寸那两个分支同样是"有头"。
  // (2026-10-25 第二次补:原先 `--window-size` 只对默认分支断言,给位置那条分支塞进去仍全绿。)
  for (const argv of [[], ["--window-position", "1920,0"], ["--window-size", "1380,960"]]) {
    const { args } = plan(argv);
    const tag = argv.join(" ") || "(默认)";
    assert.ok(!args.some((a) => a.startsWith("--screen-info")), `${tag}:有头走真实屏幕,不该给 --screen-info`);
    if (argv[0] !== "--window-size") {
      // 只有"调用方明确给了尺寸"时才允许出现 --window-size
      assert.ok(!args.some((a) => a.startsWith("--window-size")), `${tag}:没给尺寸就不该替它加 --window-size`);
    }
  }
  assert.ok(plan([]).args.includes("--start-maximized"), "默认那条走最大化");
  assert.ok(plan(["--window-position", "1920,0"]).args.includes("--window-position=1920,0"), "给了位置就钉住");
});

test("★ 畸形的 --window-size 不许造出畸形 --screen-info(会静默退回 800×600)", () => {
  // 第一版用 `String(size).split(",")` 取两段 —— `1920`、`1920x1080`、`"1920, "` 都会拼出
  // `{1920xundefined}`,而 Chrome **不报错**、悄悄用回 800×600,正好把修好的 1 黄带回来。
  for (const bad of ["1920", "1920x1080", "1920, ", "", "  ,  ", "-1,-1", "1.5,2", "99999999,1"]) {
    const { args } = plan(["--headless", "--window-size", bad]);
    const si = args.find((a) => a.startsWith("--screen-info="));
    assert.ok(si, `${JSON.stringify(bad)}:仍然要给 screen-info`);
    assert.ok(!/undefined|NaN/.test(si), `${JSON.stringify(bad)} 造出了 ${si}`);
    assert.match(si, /^\-\-screen-info=\{\d+x\d+ /, `${JSON.stringify(bad)} 的 screen-info 形状不对:${si}`);
  }
});

// (原先这里还有一条 `★ 无头下用户显式给的尺寸要听` —— 它的断言(`--window-size=1380,960` 在、
//  默认那条不在)已被上面 `无头下只给尺寸、不给位置` 那条的 `deepEqual(win, ["--window-size=1380,960", SCREEN])`
//  完全覆盖。2026-10-25 核验指出:上一轮只改了它的消息、用例本身还在 —— 现在**真删掉**(用一条覆盖即可)。

test("有头:给了位置就钉住,没给就最大化", () => {
  assert.ok(plan(["--window-position", "1920,0"]).args.includes("--window-position=1920,0"));
  assert.ok(plan(["--window-size", "1380,960"]).args.includes("--window-size=1380,960"));
  assert.ok(plan([]).args.includes("--start-maximized"));
});

test("★ navigator.webdriver 必须走 --disable-blink-features,不能混进 --disable-features", () => {
  // 2026-10-25 真机暴露的 bug:AutomationControlled 是 **Blink** 特性,
  // 放进 `--disable-features` 那份名单是**无效**的 —— 检测站照样报 `navigator.webdriver = true`(坑-35)。
  const args = plan([]).args;
  assert.ok(
    args.includes("--disable-blink-features=AutomationControlled"),
    "必须显式给 --disable-blink-features=AutomationControlled",
  );
  const features = args.find((a) => a.startsWith("--disable-features="));
  assert.ok(features, "还应有 --disable-features 那份名单");
  assert.ok(
    !features.includes("AutomationControlled"),
    "AutomationControlled 不该出现在 --disable-features 里(那是无效写法,会给人一种'已经关了'的错觉)",
  );
});

test("★ 同一档案:桌面与无头的计划**只在窗口参数与 --headless 上不同**", () => {
  for (const kind of KINDS) {
    const base = ["--profile-kind", kind, DIR_FLAG, DIR_VALUE];
    const desktop = plan(base).args;
    const server = plan([...base, "--headless"]).args;

    const strip = (arr) =>
      arr.filter((a) => !WINDOW_ARGS.test(a) && a !== "--headless=new").sort();

    assert.deepEqual(
      strip(server),
      strip(desktop),
      `${kind}:去掉窗口参数与 --headless 之后必须逐项相同(F11 的「同一套」)`,
    );
    assert.ok(server.includes("--headless=new"), "无头要真的加上 --headless=new");
  }
});

// ---- 3. 不该出现的参数 ----------------------------------------------------

test("★ 三种档案、有头无头,都**不许**出现任何被禁参数", () => {
  for (const kind of KINDS) {
    for (const headless of [[], ["--headless"]]) {
      const { args } = plan(["--profile-kind", kind, DIR_FLAG, DIR_VALUE, ...headless]);
      for (const bad of FORBIDDEN_ARGS) {
        assert.ok(
          !args.some((a) => a === bad || a.startsWith(`${bad}=`)),
          `${kind}${headless.length ? "+无头" : ""} 出现了被禁参数 ${bad}`,
        );
      }
    }
  }
});

test("ADR-005:通道用 pipe,且没有任何 TCP 调试端口", () => {
  const { args } = plan([]);
  assert.ok(args.includes("--remote-debugging-pipe"), "必须走 pipe");
  assert.ok(!args.some((a) => /remote-debugging-port/.test(a)), "不许开调试端口");
});

test("ADR-014:WebRTC 抑制参数必须在(三种档案都一样)", () => {
  for (const kind of KINDS) {
    const { args } = plan(["--profile-kind", kind, DIR_FLAG, DIR_VALUE]);
    assert.ok(
      args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
      `${kind} 少了 WebRTC 抑制`,
    );
  }
});

// ---- 4. 帮助文本 ----------------------------------------------------------

test("USAGE 提到三种档案与无头", () => {
  assert.match(USAGE, /--profile-kind/);
  assert.match(USAGE, /--headless/);
  for (const k of KINDS) assert.ok(USAGE.includes(k), `帮助里要提到 ${k}`);
});

// ---- 5. 提权会话:两个开关必须**永远**在 --------------------------------------
//
// 2026-10-25 实测:在管理员会话里起浏览器,进程**退 0、零输出、连日志都不生成**。
// 原因不是"开关不被支持",而是 exe 检测到自己被提权 → 把自己**重新降权拉起**
// → 原进程退 0;降权失败时浏览器就再也不出现。`--do-not-de-elevate` 掐掉这次重启。
// 提权下沙箱还会 `拒绝访问 0x5`,所以 `--no-sandbox` 也必须给。
//
// 这两个**不是**指纹开关(页面看不到),所以无条件带上,不做"是否提权"的判断 ——
// Windows 上没有可靠的纯 JS 提权检测,判断错了反而更糟。

test("★ 提权会话的两个必需开关必须无条件出现", () => {
  const { args } = buildBrowserArgs({}, {});
  assert.ok(args.includes("--do-not-de-elevate"), "缺了它,提权下浏览器会退 0 且零输出");
  assert.ok(args.includes("--no-sandbox"), "缺了它,提权下沙箱访问不到 exe(0x5)");
});

test("★ 这两个开关在有头与无头下都要在(不是只在某一种模式里)", () => {
  for (const argv of [[], ["--headless"]]) {
    const { args } = buildBrowserArgs(parseArgs(argv), {});
    assert.ok(args.includes("--do-not-de-elevate"), `argv=${JSON.stringify(argv)} 缺 --do-not-de-elevate`);
    assert.ok(args.includes("--no-sandbox"), `argv=${JSON.stringify(argv)} 缺 --no-sandbox`);
  }
});

test("它们不该被误列进禁止项", () => {
  for (const bad of FORBIDDEN_ARGS) {
    assert.notEqual(bad, "--do-not-de-elevate");
    assert.notEqual(bad, "--no-sandbox");
  }
});
