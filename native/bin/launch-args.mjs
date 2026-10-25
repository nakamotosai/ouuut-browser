// native/bin/launch-args.mjs —— 启动参数:CLI 的**可测部分**
//
// 单独一个文件是为了让"参数怎么拼"能被单测覆盖 —— 起不起得了浏览器是另一回事。
//
// ## 参数从哪来
//
// `docs/补丁点位.md` §三 明确:**以下六项在启动参数里解决,不写内核补丁**
// ("写进去反而难维护")。本文件就是那六项 + 通道开关的落点。
//
//   | 项 | 做法 |
//   |---|---|
//   | `navigator.webdriver` | `--disable-blink-features=AutomationControlled` |
//   | `ipcFloodingProtection` | **不加** `--disable-ipc-flooding-protection` |
//   | `popupBlocking` | **不加** `--disable-popup-blocking` |
//   | `storagePartitioning` | 用自己的 `--disable-features=`,**不含** `ThirdPartyStoragePartitioning` |
//   | `viewport` | **有头**用真实屏幕(不用 1280×720 默认);**无头**显式给 `--screen-info` + `--window-size`(坑-37) |
//   | WebRTC | 抑制非代理 UDP(ADR-014) |
//   | WebGL | **不加** `--enable-unsafe-swiftshader`(Playwright 无头时会自动加) |

import path from "node:path";

import { PROXY_BYPASS_LIST, assertProxyUsable } from "../binding/proxy.mjs";
import { resolveBrowserExe } from "../binding/paths.mjs";
import os from "node:os";

// 三种档案的**唯一来源**是档案引擎 —— 另抄一份迟早会漂(F3 的 kind 就是那三个)
import { KINDS as PROFILE_KINDS } from "../binding/archive.mjs";

export const USAGE = `ouuut —— 自带 Chromium 的 agent 浏览器

用法:
  ouuut nodejs <<'JS'
  const task = await taskSpace("结账流程");
  const page = await task.newPage();
  await page.goto("https://example.com");
  console.log(await page.snapshot());
  JS

选项:
  --browser <path>        自有 Chromium 的 chrome.exe 路径(默认取 OUUUT_BROWSER / 本项目 out/Release)
  --script <path>         从**文件**读脚本(替代 stdin)。给程序化调用方用:
                          「--script」时我们**完全不碰 stdin**,调用方可以拿它做自己的协议
  --timeout <seconds>     单条 CDP 消息的超时(默认 30)
  --namespace <name>      额外注入的全局名(默认 ouuut)。⚠️ 随包的 harness 只认 globalThis.ouuut,
                          所以我们两个名字都装:ouuut 给 harness,<name> 给脚本
  --headless              无头(默认有头 —— 与上游一致)
  --profile-kind <kind>   档案种类:real / persona / disposable(F11 的三种档案)。
                          real 必须显式给出档案目录 —— 那是使用者的真实身份,
                          我们**绝不替他造一个**
  --user-data-dir <path>  档案目录(**默认给一个临时目录**,不用你的真实档案)
  --window-position <x,y> 窗口位置(如 1920,0 —— 把浏览器放到副屏,不抢主屏)
  --window-size <w,h>     窗口尺寸(如 1380,960)
  --proxy <url>           代理(同时用 --proxy-bypass-list 放行 loopback/tailnet)
  --identity-country <cc> 画像的国家(如 jp / us)。给了它,启动时会**核对出口**(F6/P4)
  --egress-country <cc>   你**声明**的出口国家;与实测不符同样拒绝(声明不能与事实脱钩)
  --allow-egress-mismatch 明知不一致也放行(诊断里会标出来)
  --allow-phone-home       放开浏览器自己的回连域名(默认挡住:见坑-46)
  --profiles <json>       额外档案(双档案双出口),如
                          '[{"id":"a","kind":"persona","proxy":"socks5://h:1080"},{"id":"b","kind":"disposable"}]'
                          脚本里 taskSpace("x","a") 之后的页面就走 a 的档案与出口
                          (USAGE 是模板字符串,所以这里不能用反引号)
  -h, --help              本帮助

设计取舍(见 docs/补丁点位.md §三 与 ADR-005):
  * 通道用 **--remote-debugging-pipe**,不监听任何 TCP 端口
  * 上面那张表里的"不加"是**刻意的** —— 它们是常见的自动化指纹来源
`;

/** 会被我们**刻意排除**的参数(出现在上游/驱动的默认参数里,但我们不要)。 */
export const FORBIDDEN_ARGS = [
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--enable-unsafe-swiftshader",
  "--remote-debugging-port",
  "--headless=old",
];

/**
 * 无头模式下的默认屏幕尺寸;窗口尺寸由它派生(见 `headlessGeometry`)。
 *
 * ⚠️ **这是个固定常数,本身也可被指纹化** —— 1920×1080 + `dpr 1.0`(Chromium 默认)+ 24 位色深,
 * 每个实例都一样。它之所以还是比原来的 800×600 好,是因为 800×600 是**headless 的出厂默认值**、
 * 被检测站点名;而 1920×1080 至少是常见桌面分辨率。
 * **真正的"按画像给自洽尺寸"要等 F5 的 seed 画像接进启动参数**(那时屏/DPR/色彩深度一起由画像决定)。
 */
export const DEFAULT_HEADLESS_SCREEN = "1920,1080";

/** 解析 `W,H`。非法一律返回 `null` —— **绝不允许**它变成 `{1920xundefined}`(见坑-37 的新错)。 */
function parseSize(v) {
  const m = /^\s*(\d{1,5})\s*,\s*(\d{1,5})\s*$/.exec(String(v ?? ""));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/**
 * 无头下的"屏幕 + 窗口"这一对,必须**算术自洽**:
 *   * 窗口要比屏幕小(真桌面上普通窗口不会正好等于整屏),
 *     否则 `screenX + outerWidth > screen.availWidth`(窗口探出屏外);
 *   * 留出任务栏(`workAreaBottom`)—— 真桌面上 `availHeight < screen.height`。
 *
 * 2026-10-25:这两条都是核验者用 `p.evaluate` 直读 `window`/`screen` 抓出来的破绽
 * (第一版给的是"窗口 == 屏幕、没有任务栏")。
 */
function headlessGeometry(userSize) {
  const want = parseSize(userSize);
  const base = { w: 1920, h: 1080 };
  // 用户显式给的窗口必须装得下 ⇒ 屏幕按需要长大(默认屏通常已经够大)
  const screen = want
    ? { w: Math.max(base.w, want.w + 40), h: Math.max(base.h, want.h + 80) }
    : base;
  const window_ = want ?? { w: screen.w - 40, h: screen.h - 80 };
  return {
    windowSize: `${window_.w},${window_.h}`,
    // 只给窗口不够:screen 由 --screen-info 定义(它是 switch,不是 screen.* 的别名)
    screenInfo: `{${screen.w}x${screen.h} isInternal=false workAreaBottom=48}`,
  };
}

const DEFAULT_FEATURES_TO_DISABLE = [
  // 注意:**不含** ThirdPartyStoragePartitioning(docs/补丁点位.md §三 明确要求)
  // 也**不含** AutomationControlled —— 它是 **Blink** 特性,得走 `--disable-blink-features`,
  // 写进这份 `--disable-features` 名单是**无效**的(2026-10-25 真机实测:
  // 检测站如实报 `navigator.webdriver = true`,即这一项从来就没生效,见坑-35)。
  "CalculateNativeWinOcclusion", // 无头/后台窗口时的遮挡计算会拖慢渲染
  "Translate",
  "AcceptCHFrame",
  "OptimizationHints",
];

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 本次会话专用的临时档案目录。
 *
 * 带 pid 是为了**同一台机上多个会话互不干扰** —— 两个 agent 会话抢同一个
 * user-data-dir 会造成同样的"交接后退出"。不写进仓库、不落在用户档案下。
 */
export function defaultUserDataDir(namespace = "ouuut", pid = process.pid) {
  return path.join(os.tmpdir(), `${namespace}-session-${pid}`);
}

/**
 * 解析 argv。**不抛异常给用户看堆栈** —— 返回 `{error}` 让 CLI 打帮助。
 */
export function parseArgs(argv = []) {
  const out = {
    namespace: "ouuut",
    timeoutMs: 30_000,
    headless: false,
    profileKind: null,
    browser: null,
    userDataDir: null,
    windowPosition: null,
    windowSize: null,
    proxy: null,
    extraEnv: null,
    script: null,
    help: false,
    error: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        out.error = `${a} 需要一个值`;
        return null;
      }
      i++;
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--browser": {
        const v = next(); if (v === null) return out;
        out.browser = v;
        break;
      }
      case "--script": {
        const v = next(); if (v === null) return out;
        out.script = v;
        break;
      }
      case "--timeout": {
        const v = next(); if (v === null) return out;
        out.timeoutMs = num(v, 30) * 1000;
        break;
      }
      case "--namespace": {
        const v = next(); if (v === null) return out;
        out.namespace = v;
        break;
      }
      case "--user-data-dir": {
        const v = next(); if (v === null) return out;
        out.userDataDir = v;
        break;
      }
      case "--window-position": {
        const v = next(); if (v === null) return out;
        out.windowPosition = v;
        break;
      }
      case "--window-size": {
        const v = next(); if (v === null) return out;
        out.windowSize = v;
        break;
      }
      case "--proxy": {
        const v = next(); if (v === null) return out;
        out.proxy = v;
        break;
      }
      case "--identity-country": {
        const v = next(); if (v === null) return out;
        out.identityCountry = v;
        break;
      }
      case "--egress-country": {
        const v = next(); if (v === null) return out;
        out.egressCountry = v;
        break;
      }
      case "--allow-egress-mismatch":
        out.allowEgressMismatch = true;
        break;
      case "--allow-phone-home":
        // 默认把浏览器自己的回连挡在解析层;确实要访问那几个域名的人才给这个开关
        out.allowPhoneHome = true;
        break;
      case "--profiles": {
        // 双档案双出口:一个会话里开多个档案,各自绑自己的出口。
        // 用 **JSON** 而不是自定义分隔符:代理串里全是 `:` 和 `/`,自定义语法一定会歧义。
        const v = next();
        if (v === null) return out;
        let arr;
        try {
          arr = JSON.parse(v);
        } catch (err) {
          out.error = `--profiles 不是合法 JSON:${err?.message ?? err}`;
          return out;
        }
        if (!Array.isArray(arr)) {
          out.error = '--profiles 要是一个数组,例如 [{"id":"a","kind":"persona","proxy":"socks5://h:1080"}]';
          return out;
        }
        for (const e of arr) {
          if (!e || typeof e !== "object" || typeof e.kind !== "string") {
            out.error = '--profiles 的每一项都要是对象且带 "kind"';
            return out;
          }
        }
        out.extraProfiles = arr;
        break;
      }
      case "--profile-kind": {
        const v = next();
        if (v === null) return out;
        if (!PROFILE_KINDS.includes(v)) {
          out.error = `--profile-kind 只接受 ${PROFILE_KINDS.join(" / ")},收到 ${JSON.stringify(v)}`;
          return out;
        }
        out.profileKind = v;
        break;
      }
      case "--headless":
        out.headless = true;
        break;
      case "--headed":
        out.headless = false;
        break;
      case "--nodejs":
      case "nodejs":
        // 与上游同形:`ouuut nodejs < script`。脚本从 stdin 读,这里不消费值
        break;
      default:
        if (a.startsWith("--")) {
          out.error = `未知选项 ${a}`;
          return out;
        }
        out.script = a; // 位置参数:脚本文件路径(暂未实现,先记下来)
        break;
    }
  }
  // `real` 是**使用者的真实身份**。没有显式档案目录就无法确定"哪个是真的" ——
  // 猜一个等于替他造了个假的"真实档案",那比报错危险得多(F3 的硬约束)。
  if (out.profileKind === "real" && !out.userDataDir) {
    out.error = "--profile-kind real 必须同时给出档案目录 —— 那是使用者的真实档案,不能替他造";
    return out;
  }

  return out;
}

/**
 * 组装浏览器命令行。
 *
 * @param {object} opts `parseArgs()` 的结果
 * @param {object} env  环境变量(取 `OUUUT_BROWSER` / `OUUUT_WINDOW_POSITION` / `OUUUT_WINDOW_SIZE`)
 */
export function buildBrowserArgs(opts = {}, env = {}) {
  // 浏览器在哪只有**一处**判断(见 `binding/paths.mjs`):显式 > 环境变量 > 入口旁边(发布) > 仓库(开发)。
  // 以前这里是相对 **CWD** 的一行字符串,换个目录启动就找不到 —— 发布形态下更不可能对。
  const exe = resolveBrowserExe({ browser: opts.browser, env });

  // 窗口位置/尺寸:选项优先,其次环境变量,最后不给(让窗口管理器决定)。
  // **必须在拼数组之前算** —— 它被用在数组字面量里。
  const winPos = opts.windowPosition ?? env.OUUUT_WINDOW_POSITION ?? null;
  const winSize = opts.windowSize ?? env.OUUUT_WINDOW_SIZE ?? null;

  // 无头的"窗口尺寸 / 屏幕尺寸"是同一件事的两个开关:`--window-size=W,H` 与 `--screen-info={WxH}`
  // (后者才是 `screen.*` 看到的那个;格式用 `x` 不用 `,`)。
  // **两者都必须来自解析过的值** —— 畸形的 `--screen-info` 会被 Chrome 静默忽略、退回 800×600。
  const headless = headlessGeometry(winSize);

  const args = [
    // ---- 通道:不监听任何 TCP 端口 ----
    "--remote-debugging-pipe",

    // ---- 提权会话下的两个必需开关(2026-10-25 实测)----
    //
    // 症状:在管理员会话里起浏览器 → 进程 **退 0、零输出、连日志文件都不生成**。
    // 原因:chrome.exe 检测到自己被提权,会把自己**重新降权拉起**然后原进程退 0;
    // 若降权失败(无交互桌面/服务会话),浏览器就再也不出现。
    //   `--do-not-de-elevate` 直接掐掉这次重启。
    //
    // 第二个:提权下沙箱访问不到 exe(`Sandbox cannot access executable ... 拒绝访问 0x5`),
    // 所以还要 `--no-sandbox`。两者都不是指纹开关,不影响页面可观测面。
    "--do-not-de-elevate",
    "--no-sandbox",

    // ---- 那六项里的"要加的" ----
    // `navigator.webdriver` 走的是 **Blink 特性**开关:`--disable-blink-features=AutomationControlled`。
    // ⚠️ 2026-10-25 修:此前它被误放进下面的 `--disable-features` 名单里 —— 那份名单不认 Blink 特性,
    // 于是这条**从来没生效过**,真机检测站如实报 `navigator.webdriver = true`(坑-35)。
    "--disable-blink-features=AutomationControlled",
    `--disable-features=${DEFAULT_FEATURES_TO_DISABLE.join(",")}`,
    // ---- 视口 / 窗口位置 ----
    //
    // **无头下不给"窗口位置",但必须给"尺寸"** —— 2026-10-25 真机更正:
    // 原先这里写的是「无头下一条都不给,给了只是噪音」,**那是错的**:
    // headless 默认 `800×600`,而检测站会直接点名:
    //   `🟡 Screen is 800x600, the default screen size of headless Chrome`
    // 这不是噪音,是一个**可指纹化的常数**。所以:
    //   * 有显式 `--window-size` 就听它(此前无头会把用户显式给的尺寸**丢掉**,那是个 bug);
    //   * 没给就给一个**常见桌面尺寸**(真正的"按画像给"要等 F5 的 seed 画像接进来,见 P8 备注);
    //   * `--window-position` 仍不给:没有窗口可摆。
    ...(opts.headless
      ? [
          `--window-size=${headless.windowSize}`,
          // **只给 --window-size 不够**:它改的是窗口,`screen.width/height` 仍是 800×600
          // (2026-10-25 真机:加了 window-size 之后检测站**照样**报 800×600)。
          // headless 定义"屏幕"用的是 `--screen-info`(格式见 Chromium 自己的文档/用例:
          // `components/headless/screen_info/README.md`、`headless/test/data/protocol/sanity/`)。
          `--screen-info=${headless.screenInfo}`,
        ]
      : winPos || winSize
        ? [
            ...(winPos ? [`--window-position=${winPos}`] : []),
            ...(winSize ? [`--window-size=${winSize}`] : []),
          ]
        : ["--start-maximized"]),
    // 抑制非代理 UDP(ADR-014);配合 --proxy 用
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",

    // ---- 工程便利(不影响指纹,但省事) ----
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    // ---- 把浏览器自己的回连挡在**解析层**(默认开;`--allow-phone-home` 关掉)----
    // 依据(P9):记录式出口(`probe/tools/zero_telemetry_via_ouuut.mjs`,全部拒绝转发)实测 ——
    // 光有上面那些开关时,启动仍会去连 update.googleapis.com(组件更新)、clients2.google.com(变体种子)、
    // accounts.google.com / www.google.com(登录与首页服务);逐项试过 5 个开关,**一台主机都没少**。
    // 解析层是唯一干净、且不需要管理员权限的杠杆:映射成 NOTFOUND ⇒ 连 DNS 都不查,更谈不上出网
    // (实测:`probe/tools/phone_home_blocked_via_ouuut.mjs`,四个域名全部 ERR_NAME_NOT_RESOLVED)。
    // ⚠️ 只对**浏览器侧解析**有效:走 `socks5://` / `socks5h://` 时代理自己解域名(Chrome 的 socks5 就是远端解析),
    //     那时拦截点应该在**代理侧的拒绝清单**(见坑-46)。
    // ⚠️ 代价:显式导航到这四个域名也会失败(它们是"回连",不是产品要访问的目标);确实需要就走 `--allow-phone-home`。
    ...(opts.allowPhoneHome
      ? []
      : [
          "--host-resolver-rules=MAP update.googleapis.com ~NOTFOUND, MAP clients2.google.com ~NOTFOUND, MAP accounts.google.com ~NOTFOUND, MAP www.google.com ~NOTFOUND",
        ]),
  ];

  if (opts.headless) args.push("--headless=new");

  // ---- 档案目录:**必须给**,否则会去贴使用者的真实 Chrome ----
  //
  // 实测(2026-10-25,真跑出来的):不传 `--user-data-dir` 时,我们编的 chrome.exe
  // 会去用 `%LOCALAPPDATA%\Google\Chrome\User Data` —— 与**使用者正在运行的真实
  // Chrome 是同一个**。于是新实例把命令行交接给已运行的实例、自己退出(code=0),
  // 现象是 `listTabs` 报「ouuut 退出(code=0 signal=null)」。
  //
  // 所以默认给一个**本次会话专用的临时目录**:
  //   * **不碰**使用者的真实档案 —— 比"不给"更安全,不是更不安全
  //     (原先的注释写的是"不给就别编一个,免得动到真实档案" —— 理由写反了)
  //   * 不会与已运行的 Chrome 撞车
  //
  // 显式传 `--user-data-dir` 时用传的(测试与后续的 `real` 档案导入都靠它)。
  const userDataDir = opts.userDataDir || defaultUserDataDir(opts.namespace, opts.pid ?? process.pid);
  args.push(`--user-data-dir=${userDataDir}`);

  // 代理的两条路(F13,别混):
  //  * `persona` / `disposable` —— 出口是 **context 级**的(`session-profiles.mjs` 里给
  //    `Target.createBrowserContext` 传 `proxyServer`)。这里**不能**再给浏览器级 `--proxy-server`,
  //    否则连默认 context(real)一起被套上那个出口。
  //  * `real` / 没选 kind —— 默认 context 挂不了 context 级代理,只能走浏览器级。
  const proxyPerContext = opts.profileKind === "persona" || opts.profileKind === "disposable";
  if (opts.proxy && !proxyPerContext) {
    // 形状非法 / 带凭据都在这里**早失败**(浏览器级这条路此前什么都不校验:
    // 非法串与带凭据串都能照常起会话,只在导航时以网络错暴露 —— 2026-10-25 实测)。
    assertProxyUsable(opts.proxy);
    args.push(`--proxy-server=${opts.proxy}`);
    args.push(`--proxy-bypass-list=${PROXY_BYPASS_LIST}`);
  }

  // ---- 自我检查:绝不把"指纹来源"混进来 ----
  // 这一条是**断言**,不是装饰:`docs/补丁点位.md` §三 里那几项"不要"的,
  // 一旦被谁顺手加回来(比如复制了某个驱动的默认参数),这里当场炸,而不是上线后被检测出来。
  for (const bad of FORBIDDEN_ARGS) {
    if (args.some((a) => a === bad || a.startsWith(bad + "="))) {
      throw new Error(`启动参数里混进了禁止项 ${bad}(见 docs/补丁点位.md §三)`);
    }
  }

  return {
    exe,
    args,
    /** 本次会话实际用的档案目录(调用方要用它做收尾清理)。 */
    userDataDir,
    /** true = 这个目录是**我们**为本次会话临时造的 ⇒ 会话结束可以删;false = 调用方显式给的 ⇒ 绝不删。 */
    ephemeralUserDataDir: !opts.userDataDir,
  };
}
