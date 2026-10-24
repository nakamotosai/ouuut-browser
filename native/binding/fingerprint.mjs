// native/binding/fingerprint.mjs —— seed → 自洽画像(M3 验收的第三项:100 seed 零矛盾)
//
// ## 这一片在解决什么
//
// `docs/原生层接口.md` §六 写着:上游在 bot-detector 上 16/16 全绿,靠的是
// **品牌 + 无头标识补丁**,不是完整指纹引擎 —— 二进制级确认过。而我们的判据是:
//
//   > 一致性引擎:seed → 自洽画像;**启动前校验,矛盾即拒绝启动**(F5)
//
// 「矛盾即拒绝启动」意味着:**画像必须能被独立校验**,而不是"生成器说什么就是什么"。
// 所以本文件有两个**互相独立**的东西:
//
//   1. `profileFromSeed(seed)` —— 生成器。它从**一张自洽的底座表**里选一组
//      (OS + 地区 + GPU + 分辨率),再由此**派生**其余每一项。
//      这样矛盾**在构造上就不可能产生** —— 不是"记得别写矛盾"。
//   2. `checkConsistency(profile)` —— 校验器。它**不读生成器的意图**,只看画像本身,
//      逐条判断各项是否互相自洽。矛盾回报**具体哪两条对不上**。
//
// 两个独立实现互为对照:生成器保证不产生矛盾,校验器负责**证明**这一点。
// 若它们是同一个函数的两半,那条"100 seed 零矛盾"就毫无信息量。
//
// ## 校验器必须能失败
//
// `fingerprint.test.mjs` 里专门有"注入矛盾 → 必须被抓住"的用例,
// 而且**逐条规则各注入一次** —— 一条从不报警的校验等于没有校验。

// ---- 确定性 PRNG(不能用 Math.random:同 seed 必须同画像)-------------------

/** FNV-1a 32 位 —— 把字符串 seed 变成数字。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 —— 小、快、确定。 */
function rngFrom(seedNum) {
  let a = seedNum >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

// ---- 自洽底座表 ------------------------------------------------------------
//
// 每一行都是**一个真实存在的组合**。生成器只在行内派生,不在行间拼接 ——
// 这就是"矛盾不可能产生"的结构保证。
//
// `uaPlatformVersion` 是 UA-CH 里 `navigator.userAgentData.platformVersion` 的值。
// Windows 10 报 10.x 段、Windows 11 报 13–15 段;macOS 报 10.15.7 / 13.x / 14.x。

const WINDOWS_GPU = [
  ["Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"],
  ["Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)"],
  ["Google Inc. (AMD)", "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)"],
  ["Google Inc. (Intel)", "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)"],
  ["Google Inc. (Intel)", "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)"],
];

const MAC_GPU = [
  ["Google Inc. (Apple)", "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)"],
  ["Google Inc. (Apple)", "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"],
  ["Google Inc. (Apple)", "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)"],
];

/** Windows 字体(真机上前若干项的顺序相当稳定)+ 各语言补充。 */
const WIN_FONTS_BASE = ["Arial", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New", "Ebrima", "Franklin Gothic Medium", "Gabriola", "Gadugi", "Georgia", "HoloLens MDL2 Assets", "Impact"];
const MAC_FONTS_BASE = ["Arial", "Helvetica", "Helvetica Neue", "Menlo", "Monaco", "Geneva", "Lucida Grande", "Optima", "Palatino", "Times New Roman", "Verdana", "Apple Color Emoji", "Apple SD Gothic Neo", "SF Pro Text"];

/**
 * 地区:每行是**一个真实自洽的套餐** —— 语言 / 时区 / 国家 / 该语言特有的字体与候选城市。
 * 时区与国家**必须**同源,否则 F6(出口 IP 地理 vs 画像)当场矛盾。
 */
const LOCALES = [
  { lang: "zh-CN", languages: ["zh-CN", "zh", "en"], timezone: "Asia/Shanghai", country: "CN", winFonts: ["Microsoft YaHei", "Microsoft JhengHei", "SimSun", "SimHei"], macFonts: ["PingFang SC", "Hiragino Sans GB", "Songti SC"] },
  { lang: "zh-TW", languages: ["zh-TW", "zh", "en"], timezone: "Asia/Taipei", country: "TW", winFonts: ["Microsoft JhengHei", "MingLiU"], macFonts: ["PingFang TC", "Heiti TC"] },
  { lang: "ja-JP", languages: ["ja", "en-US", "en"], timezone: "Asia/Tokyo", country: "JP", winFonts: ["Yu Gothic", "MS Gothic", "Meiryo", "MS PGothic"], macFonts: ["Hiragino Kaku Gothic ProN", "Hiragino Sans", "YuGothic"] },
  { lang: "ko-KR", languages: ["ko-KR", "ko", "en"], timezone: "Asia/Seoul", country: "KR", winFonts: ["Malgun Gothic", "Gulim", "Batang"], macFonts: ["Apple SD Gothic Neo", "Nanum Gothic"] },
  { lang: "en-US", languages: ["en-US", "en"], timezone: "America/New_York", country: "US", winFonts: [], macFonts: [] },
  { lang: "en-US", languages: ["en-US", "en"], timezone: "America/Los_Angeles", country: "US", winFonts: [], macFonts: [] },
  { lang: "en-US", languages: ["en-US", "en"], timezone: "America/Chicago", country: "US", winFonts: [], macFonts: [] },
  { lang: "en-GB", languages: ["en-GB", "en"], timezone: "Europe/London", country: "GB", winFonts: [], macFonts: [] },
  { lang: "de-DE", languages: ["de-DE", "de", "en"], timezone: "Europe/Berlin", country: "DE", winFonts: [], macFonts: [] },
  { lang: "fr-FR", languages: ["fr-FR", "fr", "en"], timezone: "Europe/Paris", country: "FR", winFonts: [], macFonts: [] },
  { lang: "es-ES", languages: ["es-ES", "es", "en"], timezone: "Europe/Madrid", country: "ES", winFonts: [], macFonts: [] },
  { lang: "it-IT", languages: ["it-IT", "it", "en"], timezone: "Europe/Rome", country: "IT", winFonts: [], macFonts: [] },
  { lang: "nl-NL", languages: ["nl-NL", "nl", "en"], timezone: "Europe/Amsterdam", country: "NL", winFonts: [], macFonts: [] },
  { lang: "pl-PL", languages: ["pl-PL", "pl", "en"], timezone: "Europe/Warsaw", country: "PL", winFonts: [], macFonts: [] },
  { lang: "pt-BR", languages: ["pt-BR", "pt", "en"], timezone: "America/Sao_Paulo", country: "BR", winFonts: [], macFonts: [] },
  { lang: "ru-RU", languages: ["ru-RU", "ru", "en"], timezone: "Europe/Moscow", country: "RU", winFonts: [], macFonts: [] },
  { lang: "tr-TR", languages: ["tr-TR", "tr", "en"], timezone: "Europe/Istanbul", country: "TR", winFonts: [], macFonts: [] },
  { lang: "vi-VN", languages: ["vi-VN", "vi", "en"], timezone: "Asia/Ho_Chi_Minh", country: "VN", winFonts: [], macFonts: [] },
  { lang: "th-TH", languages: ["th-TH", "th", "en"], timezone: "Asia/Bangkok", country: "TH", winFonts: [], macFonts: [] },
];

const LOCALE_BY_LANG = Object.freeze(Object.fromEntries(LOCALES.map((l) => [l.lang, l])));

const OSES = [
  { os: "Windows", navPlatform: "Win32", uaPlatform: "Windows", uaPlatformVersions: ["10.0.0", "13.0.0", "14.0.0", "15.0.0"], uaOsToken: "Windows NT 10.0; Win64; x64", gpus: WINDOWS_GPU, fontsBase: WIN_FONTS_BASE },
  { os: "macOS", navPlatform: "MacIntel", uaPlatform: "macOS", uaPlatformVersions: ["10.15.7", "13.6.0", "14.5.0", "15.1.0"], uaOsToken: "Macintosh; Intel Mac OS X 10_15_7", gpus: MAC_GPU, fontsBase: MAC_FONTS_BASE },
];

/** 屏幕:与 OS 的常见分辨率组合(不跨平台乱配)。 */
const SCREENS = {
  Windows: [
    { width: 1920, height: 1080, dpr: [1, 1.25, 1.5] },
    { width: 2560, height: 1440, dpr: [1, 1.25] },
    { width: 1536, height: 864, dpr: [1.25, 1.5] },
    { width: 1366, height: 768, dpr: [1] },
    { width: 3840, height: 2160, dpr: [1.5, 2] },
  ],
  macOS: [
    { width: 1440, height: 900, dpr: [2] },
    { width: 1512, height: 982, dpr: [2] },
    { width: 1728, height: 1117, dpr: [2] },
    { width: 2560, height: 1440, dpr: [2] },
    { width: 1800, height: 1169, dpr: [2] },
  ],
};

/** Chrome 的 `navigator.deviceMemory` 是固定阶梯,不是任意数。 */
export const DEVICE_MEMORY_LADDER = Object.freeze([0.25, 0.5, 1, 2, 4, 8]);
/** 真机上的 `hardwareConcurrency` 取值(非任意)。 */
export const CPU_LADDER = Object.freeze([2, 4, 6, 8, 12, 16, 20, 24, 32]);

/** 我们要仿的 Chrome 大版本(`docs/` 定的版本锚)。 */
export const CHROME_MAJOR = 156;
const CHROME_FULL = "156.0.0.0";

/**
 * seed → 自洽画像。
 *
 * 确定性:同 seed 恒等(含字段顺序)。
 */
export function profileFromSeed(seed) {
  const rng = rngFrom(fnv1a(String(seed)));

  const osDef = pick(rng, OSES);
  const loc = pick(rng, LOCALES);
  const uaPlatformVersion = pick(rng, osDef.uaPlatformVersions);
  const [gpuVendor, gpuRenderer] = pick(rng, osDef.gpus);
  const screen = pick(rng, SCREENS[osDef.os]);
  const dpr = pick(rng, screen.dpr);
  const hardwareConcurrency = pick(rng, CPU_LADDER);
  const deviceMemory = pick(rng, DEVICE_MEMORY_LADDER);
  const webdriver = false;

  // 字体:底座 + 该语言补充(语言是这条画像的语言,字体必须对得上)
  const extraFonts = osDef.os === "Windows" ? loc.winFonts : loc.macFonts;
  const fonts = [...osDef.fontsBase.slice(0, 8), ...extraFonts, ...osDef.fontsBase.slice(8)];

  // UA 与 brands 必须**同一个大版本**(检测站会交叉核对,见 M1 实测)
  const ua = `Mozilla/5.0 (${osDef.uaOsToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;
  const brands = [
    { brand: "Chromium", version: String(CHROME_MAJOR) },
    { brand: "Google Chrome", version: String(CHROME_MAJOR) },
    { brand: "Not_A Brand", version: "24" },
  ];

  return {
    seed: String(seed),
    // —— OS 家族 ——
    os: osDef.os,
    platform: osDef.navPlatform,
    // —— 导航器 ——
    ua,
    uaMetadata: {
      brands,
      fullVersionList: [
        { brand: "Chromium", version: CHROME_FULL },
        { brand: "Google Chrome", version: CHROME_FULL },
        { brand: "Not_A Brand", version: "24.0.0.0" },
      ],
      fullVersion: CHROME_FULL,
      platform: osDef.uaPlatform,
      platformVersion: uaPlatformVersion,
      architecture: "x86",
      bitness: "64",
      model: "",
      mobile: false,
      wow64: false,
    },
    webdriver,
    // —— 硬件 ——
    hardwareConcurrency,
    deviceMemory,
    // —— 屏幕 ——
    screen: { width: screen.width, height: screen.height, availWidth: screen.width, availHeight: screen.height - (osDef.os === "Windows" ? 40 : 25), colorDepth: 24, pixelDepth: 24 },
    devicePixelRatio: dpr,
    // —— 地区 ——
    language: loc.lang,
    languages: loc.languages,
    timezone: loc.timezone,
    expectedCountry: loc.country,
    // —— GPU / 字体 ——
    webgl: { vendor: gpuVendor, renderer: gpuRenderer, unmaskedVendor: gpuVendor.replace(/^Google Inc\. \(/, "").replace(/\)$/, ""), unmaskedRenderer: gpuRenderer },
    fonts,
  };
}

// ---- 校验器(独立于生成器:只看画像本身)---------------------------------

/** 时区 → 它所属的国家。校验 F6 用。 */
const TZ_COUNTRY = Object.freeze(
  Object.fromEntries(LOCALES.map((l) => [l.timezone, l.country])),
);

/**
 * 逐条判断画像是否自洽。
 *
 * @returns {{ok:boolean, contradictions:Array<{rule:string,detail:string}>}}
 */
export function checkConsistency(profile) {
  const bad = [];
  const add = (rule, detail) => bad.push({ rule, detail });
  const p = profile ?? {};

  // 规则 1:UA 里的 OS 记号必须与 platform / uaMetadata.platform 同源
  const ua = String(p.ua ?? "");
  const uaIsWindows = /Windows NT 10\.0/.test(ua);
  const uaIsMac = /Macintosh; Intel Mac OS X/.test(ua);
  if (!uaIsWindows && !uaIsMac) add("ua-os-token", `UA 里认不出 OS 记号:${ua.slice(0, 70)}…`);
  if (uaIsWindows && p.os !== "Windows") add("ua-vs-os", `UA 说 Windows,os 却是 ${p.os}`);
  if (uaIsMac && p.os !== "macOS") add("ua-vs-os", `UA 说 macOS,os 却是 ${p.os}`);
  const wantPlatform = p.os === "Windows" ? "Win32" : p.os === "macOS" ? "MacIntel" : null;
  if (wantPlatform && p.platform !== wantPlatform) {
    add("platform-vs-os", `${p.os} 的 navigator.platform 该是 ${wantPlatform},得到 ${p.platform}`);
  }
  const wantUaPlatform = p.os === "Windows" ? "Windows" : p.os === "macOS" ? "macOS" : null;
  if (wantUaPlatform && p.uaMetadata?.platform !== wantUaPlatform) {
    add("uach-platform-vs-os", `uaMetadata.platform 该是 ${wantUaPlatform},得到 ${p.uaMetadata?.platform}`);
  }

  // 规则 2:uaMetadata.platformVersion 必须落在该 OS 的合法段
  {
    const osDef = OSES.find((o) => o.os === p.os);
    const pv = p.uaMetadata?.platformVersion;
    if (osDef && !osDef.uaPlatformVersions.includes(pv)) {
      add("uach-platformversion", `${p.os} 不该报 platformVersion=${pv}(合法段:${osDef.uaPlatformVersions.join(" / ")})`);
    }
  }

  // 规则 3:brands **非空**,且 UA 里的大版本必须出现在 brands 里
  //   —— 这条来自 M1 的实测:harness 覆盖 UA 却没给 userAgentMetadata 时,
  //      brands 变成 `[]`,检测站直接判红(platformMismatch / useragent)
  {
    const brands = p.uaMetadata?.brands;
    if (!Array.isArray(brands) || brands.length === 0) {
      add("brands-empty", "uaMetadata.brands 为空 —— 检测站会直接判红(M1 实测)");
    } else {
      const uaMajor = ua.match(/Chrome\/(\d+)\./)?.[1];
      if (uaMajor && !brands.some((b) => b.version === uaMajor)) {
        add("brands-version-vs-ua", `UA 说 Chrome/${uaMajor},brands 里却没有这个版本`);
      }
    }
  }

  // 规则 4:fullVersion 的大版本必须与 brands / UA 一致
  {
    const fv = p.uaMetadata?.fullVersion;
    const uaMajor = ua.match(/Chrome\/(\d+)\./)?.[1];
    if (fv && uaMajor && String(fv).split(".")[0] !== uaMajor) {
      add("fullversion-vs-ua", `fullVersion=${fv} 与 UA 的 ${uaMajor} 不同源`);
    }
  }

  // 规则 5:mobile 与 platform 矛盾(桌面平台不可能 mobile:true)
  if (p.uaMetadata?.mobile === true && (p.platform === "Win32" || p.platform === "MacIntel")) {
    add("mobile-vs-platform", `platform=${p.platform} 却报 mobile:true`);
  }

  // 规则 6:时区必须与语言/国家同源(否则 F6 出口校验必然矛盾)
  {
    const owner = TZ_COUNTRY[p.timezone];
    if (owner === undefined) {
      add("timezone-unknown", `时区 ${p.timezone} 不在表内,无法与语言核对`);
    }
    const langCountry = String(p.language ?? "").split("-")[1];
    if (owner && langCountry && owner !== langCountry && !(owner === "US" && ["en","en-US"].includes(p.language))) {
      // 只对"语言自带国家码"的情况严格;en 之类允许多国
      if (p.language !== "en-US" && p.language !== "en-GB") {
        add("timezone-vs-language", `语言 ${p.language} 却在时区 ${p.timezone}(${owner})`);
      }
    }
  }

  // 规则 7:expectedCountry 必须与 timezone 推导出的国家一致(F6 的输入)
  {
    const owner = TZ_COUNTRY[p.timezone];
    if (owner && p.expectedCountry !== owner) {
      add("country-vs-timezone", `expectedCountry=${p.expectedCountry} 与 timezone ${p.timezone} 推导出的 ${owner} 不一致`);
    }
  }

  // 规则 8:deviceMemory 必须是 Chrome 的固定阶梯
  if (!DEVICE_MEMORY_LADDER.includes(p.deviceMemory)) {
    add("device-memory-ladder", `deviceMemory=${p.deviceMemory} 不在 Chrome 的阶梯 ${DEVICE_MEMORY_LADDER.join(",")} 里`);
  }

  // 规则 9:hardwareConcurrency 必须是真实存在的核数
  if (!CPU_LADDER.includes(p.hardwareConcurrency)) {
    add("cpu-ladder", `hardwareConcurrency=${p.hardwareConcurrency} 不像真机(合法:${CPU_LADDER.join(",")})`);
  }

  // 规则 10:屏幕与 OS 同源,且 dpr 合理
  {
    const ok = Object.values(SCREENS).some((screens) =>
      screens.some((s) => s.width === p.screen?.width && s.height === p.screen?.height),
    );
    if (p.screen && !ok) {
      add("screen-unknown", `屏幕 ${p.screen.width}x${p.screen.height} 不在任何平台的常见组合里`);
    }
    if (typeof p.devicePixelRatio === "number" && (p.devicePixelRatio < 1 || p.devicePixelRatio > 3)) {
      add("dpr-range", `devicePixelRatio=${p.devicePixelRatio} 超出常见范围 [1,3]`);
    }
    if (p.os === "macOS" && p.devicePixelRatio !== 2) {
      add("dpr-macos", `macOS 的 Retina 缩放该是 2,得到 ${p.devicePixelRatio}`);
    }
  }

  // 规则 11:WebGL 渲染器必须与 OS 家族同源(不能 Windows 上冒出 Apple M2)
  {
    const r = String(p.webgl?.renderer ?? "");
    if (p.os === "macOS" && !/Apple|Metal/i.test(r)) {
      add("webgl-vs-os", `macOS 的渲染器该是 Apple/Metal 系,得到 ${r}`);
    }
    if (p.os === "Windows" && /Apple|Metal/i.test(r)) {
      add("webgl-vs-os", `Windows 上不该出现 Apple/Metal 渲染器:${r}`);
    }
    if (p.os === "Windows" && !/Direct3D11|D3D11/i.test(r)) {
      add("webgl-vs-os", `Windows 的渲染器该走 D3D11,得到 ${r}`);
    }
  }

  // 规则 12:字体必须与 OS 同源(Windows 字体表 vs macOS 字体表)
  {
    const fonts = p.fonts;
    if (!Array.isArray(fonts) || fonts.length === 0) {
      add("fonts-empty", "字体表为空 —— 检测站会当作异常环境");
    } else {
      const osDef = OSES.find((o) => o.os === p.os);
      const other = OSES.find((o) => o.os !== p.os);
      if (osDef) {
        const hasOwn = fonts.some((f) => osDef.fontsBase.includes(f));
        if (!hasOwn) add("fonts-vs-os", `${p.os} 的字体表里没有一个本平台基础字体`);
        // 跨平台字体:另一平台**独有**的基础字体不该出现在这里
        const foreign = other && fonts.filter((f) => other.fontsBase.includes(f) && !osDef.fontsBase.includes(f));
        if (foreign && foreign.length > 0) {
          add("fonts-vs-os", `${p.os} 上出现了别平台独有字体:${foreign.join(", ")}`);
        }
      }
    }
  }

  // 规则 13:webdriver 必须为 false(否则前面所有活都白干)
  if (p.webdriver !== false) {
    add("webdriver", `webdriver=${p.webdriver},必须为 false`);
  }

  return { ok: bad.length === 0, contradictions: bad };
}
