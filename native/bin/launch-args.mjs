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
//   | `viewport` | 用真实屏幕,不用 1280×720 默认 |
//   | WebRTC | 抑制非代理 UDP(ADR-014) |
//   | WebGL | **不加** `--enable-unsafe-swiftshader`(Playwright 无头时会自动加) |

import path from "node:path";
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
  --timeout <seconds>     单条 CDP 消息的超时(默认 30)
  --namespace <name>      注入的全局名(默认 ouuut)
  --headless              无头(默认有头 —— 与上游一致)
  --profile-kind <kind>   档案种类:real / persona / disposable(F11 的三种档案)。
                          real 必须显式给出档案目录 —— 那是使用者的真实身份,
                          我们**绝不替他造一个**
  --user-data-dir <path>  档案目录(**默认给一个临时目录**,不用你的真实档案)
  --window-position <x,y> 窗口位置(如 1920,0 —— 把浏览器放到副屏,不抢主屏)
  --window-size <w,h>     窗口尺寸(如 1380,960)
  --proxy <url>           代理(同时用 --proxy-bypass-list 放行 loopback/tailnet)
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
 * @param {object} env  环境变量(取 `OUUUUT_BROWSER`)
 */
export function buildBrowserArgs(opts = {}, env = {}) {
  const exe =
    opts.browser ||
    env.OUUUT_BROWSER ||
    // 本项目的默认产物位置(开发机)
    "chromium\\src\\out\\Release\\chrome.exe";

  // 窗口位置/尺寸:选项优先,其次环境变量,最后不给(让窗口管理器决定)。
  // **必须在拼数组之前算** —— 它被用在数组字面量里。
  const winPos = opts.windowPosition ?? env.OUUUT_WINDOW_POSITION ?? null;
  const winSize = opts.windowSize ?? env.OUUUT_WINDOW_SIZE ?? null;

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
    // **无头下一条都不给** —— 没有窗口可摆,给了只是噪音,还会让
    // 「桌面与服务器同一套参数」这件事变得不成立(F11 的验收)。
    ...(opts.headless
      ? []
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

  if (opts.proxy) {
    args.push(`--proxy-server=${opts.proxy}`);
    args.push("--proxy-bypass-list=<-loopback>;localhost;127.0.0.1;*.ts.net");
  }

  // ---- 自我检查:绝不把"指纹来源"混进来 ----
  // 这一条是**断言**,不是装饰:`docs/补丁点位.md` §三 里那几项"不要"的,
  // 一旦被谁顺手加回来(比如复制了某个驱动的默认参数),这里当场炸,而不是上线后被检测出来。
  for (const bad of FORBIDDEN_ARGS) {
    if (args.some((a) => a === bad || a.startsWith(bad + "="))) {
      throw new Error(`启动参数里混进了禁止项 ${bad}(见 docs/补丁点位.md §三)`);
    }
  }

  return { exe, args };
}
