// native/binding/fingerprint.test.mjs —— seed → 自洽画像 的验收
//
//   node --test native/binding/fingerprint.test.mjs
//
// 三件事:
//   1. **M3 验收原文**:100 seed 零矛盾
//   2. 确定性(同 seed 恒等)—— 否则"画像"每启动一次就变一次
//   3. **逐条规则的可证伪性** —— 故意注入矛盾,每条规则都必须能报警
//
// 第 3 条最重要。一个从不报警的校验器,配上"100 seed 零矛盾"会给出
// 完全虚假的安全感。所以下面按规则逐条注入。

import test from "node:test";
import assert from "node:assert/strict";

import {
  profileFromSeed,
  checkConsistency,
  DEVICE_MEMORY_LADDER,
  CPU_LADDER,
  CHROME_MAJOR,
} from "./fingerprint.mjs";

// ---- 1. M3 验收:100 seed 零矛盾 -------------------------------------------

test("★ M3 验收:100 个 seed,零矛盾", () => {
  const rows = [];
  for (let i = 0; i < 100; i += 1) {
    const seed = `m3-verify-${i}`;
    const p = profileFromSeed(seed);
    const r = checkConsistency(p);
    if (!r.ok) {
      rows.push({ seed, bad: r.contradictions });
    }
  }
  if (rows.length) {
    const lines = rows.map(
      (r) => `  seed=${r.seed}\n` + r.bad.map((b) => `      [${b.rule}] ${b.detail}`).join("\n"),
    );
    assert.fail(`有 ${rows.length} 个 seed 出现矛盾:\n${lines.join("\n")}`);
  }
});

test("100 seed 也不该退化成同一个画像(否则'100 seed 零矛盾'是废话)", () => {
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) {
    const p = profileFromSeed(`m3-verify-${i}`);
    // 用真正区分画像的几个维度做指纹
    seen.add([p.os, p.language, p.timezone, p.screen.width, p.devicePixelRatio, p.hardwareConcurrency, p.deviceMemory, p.webgl.renderer].join("|"));
  }
  assert.ok(seen.size >= 20, `100 个 seed 只产生 ${seen.size} 种画像,样本太窄`);
});

test("覆盖到两个平台与多种地区(不然规则根本没被走过)", () => {
  const oses = new Set();
  const langs = new Set();
  for (let i = 0; i < 100; i += 1) {
    const p = profileFromSeed(`cov-${i}`);
    oses.add(p.os);
    langs.add(p.language);
  }
  assert.ok(oses.has("Windows") && oses.has("macOS"), `两个平台都要覆盖到,得到 ${[...oses]}`);
  assert.ok(langs.size >= 5, `地区覆盖太少:${langs.size}`);
});

// ---- 2. 确定性 -------------------------------------------------------------

test("同 seed → 逐字段恒等(含字段顺序)", () => {
  for (const seed of ["a", "m3-verify-0", "中文 seed", "0", ""]) {
    const x = profileFromSeed(seed);
    const y = profileFromSeed(seed);
    assert.equal(JSON.stringify(x), JSON.stringify(y), `seed=${seed} 两次结果不同`);
  }
});

test("不同 seed 一般不同(且 seed 原样记在画像里,便于回溯)", () => {
  const a = profileFromSeed("seed-a");
  const b = profileFromSeed("seed-b");
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.seed, "seed-a");
  assert.equal(b.seed, "seed-b");
});

test("纯函数:不改动输入,也不依赖调用顺序", () => {
  const first = JSON.stringify(profileFromSeed("顺序测试"));
  profileFromSeed("别的 seed");
  profileFromSeed("又一个");
  assert.equal(JSON.stringify(profileFromSeed("顺序测试")), first, "被中间调用影响 = 不是纯函数");
});

// ---- 3. 逐条规则的可证伪性 -------------------------------------------------
//
// 每条规则各注入一次,断言**正是那条**规则报警。
// 一个从不报警的校验器会让"100 seed 零矛盾"变成虚假安全感。

/** 拿一个已知合法的画像,克隆后交给注入器改。 */
function mutate(inject) {
  const p = JSON.parse(JSON.stringify(profileFromSeed("baseline-for-mutation")));
  inject(p);
  return checkConsistency(p);
}

function assertRuleFires(rule, inject, label) {
  const r = mutate(inject);
  assert.equal(r.ok, false, `[${rule}] 注入了矛盾却没报警(${label})`);
  assert.ok(
    r.contradictions.some((c) => c.rule === rule),
    `[${rule}] 报警了但不是我这条:${JSON.stringify(r.contradictions)}(${label})`,
  );
}

test("★ 规则 1:UA 说 Windows 而 os 说 macOS → 抓住", () => {
  assertRuleFires("ua-vs-os", (p) => { p.os = p.os === "Windows" ? "macOS" : "Windows"; }, "UA 与 os 不同源");
});

test("★ 规则 1:platform 与 os 不匹配 → 抓住", () => {
  assertRuleFires("platform-vs-os", (p) => { p.platform = p.os === "Windows" ? "MacIntel" : "Win32"; }, "navigator.platform 错");
});

test("★ 规则 1:UA 里认不出 OS 记号 → 抓住", () => {
  assertRuleFires("ua-os-token", (p) => { p.ua = "Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0.0.0"; }, "Linux UA");
});

test("★ 规则 2:platformVersion 落在该 OS 的合法段之外 → 抓住", () => {
  assertRuleFires("uach-platformversion", (p) => { p.uaMetadata.platformVersion = "6.1.7601"; }, "Windows 报了个不存在的段");
});

test("★ 规则 3:brands 为空 → 抓住(这条来自 M1 实测:检测站直接判红)", () => {
  assertRuleFires("brands-empty", (p) => { p.uaMetadata.brands = []; }, "harness 覆盖 UA 却不给 metadata");
});

test("★ 规则 3:brands 里没有 UA 的大版本 → 抓住", () => {
  assertRuleFires("brands-version-vs-ua", (p) => { p.uaMetadata.brands = [{ brand: "Chromium", version: "99" }]; }, "版本不同源");
});

test("★ 规则 4:fullVersion 与 UA 大版本不同源 → 抓住", () => {
  assertRuleFires("fullversion-vs-ua", (p) => { p.uaMetadata.fullVersion = "99.0.0.0"; }, "fullVersion 错");
});

test("★ 规则 5:桌面平台却报 mobile:true → 抓住", () => {
  assertRuleFires("mobile-vs-platform", (p) => { p.uaMetadata.mobile = true; }, "手机标识配桌面 platform");
});

test("★ 规则 6:语言与时区不同源 → 抓住", () => {
  assertRuleFires("timezone-vs-language", (p) => { p.language = "ja-JP"; p.languages = ["ja"]; p.timezone = "America/New_York"; }, "日语配纽约");
});

test("★ 规则 6:时区不在表内 → 抓住", () => {
  assertRuleFires("timezone-unknown", (p) => { p.timezone = "Mars/Olympus"; }, "未知时区");
});

test("★ 规则 7:expectedCountry 与 timezone 不同源 → 抓住(F6 的输入)", () => {
  assertRuleFires("country-vs-timezone", (p) => { p.expectedCountry = "DE"; p.timezone = "Asia/Tokyo"; }, "国家与出口地理对不上");
});

test("★ 规则 8:deviceMemory 不在 Chrome 阶梯里 → 抓住", () => {
  assertRuleFires("device-memory-ladder", (p) => { p.deviceMemory = 3; }, "3GB 不是 Chrome 会报的值");
});

test("★ 规则 9:hardwareConcurrency 不像真机 → 抓住", () => {
  assertRuleFires("cpu-ladder", (p) => { p.hardwareConcurrency = 7; }, "7 核");
});

test("★ 规则 10:屏幕不在任何平台的常见组合里 → 抓住", () => {
  assertRuleFires("screen-unknown", (p) => { p.screen.width = 999; p.screen.height = 333; }, "编造分辨率");
});

test("★ 规则 10:macOS 的 dpr 不是 2 → 抓住", () => {
  assertRuleFires("dpr-macos", (p) => { p.os = "macOS"; p.platform = "MacIntel"; p.uaMetadata.platform = "macOS"; p.uaMetadata.platformVersion = "14.5.0"; p.ua = p.ua.replace(/Windows NT 10\.0; Win64; x64/, "Macintosh; Intel Mac OS X 10_15_7"); p.devicePixelRatio = 1; }, "非 Retina");
});

test("★ 规则 11:Windows 上出现 Apple/Metal 渲染器 → 抓住", () => {
  assertRuleFires("webgl-vs-os", (p) => { p.os = "Windows"; p.webgl.renderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M2)"; }, "Windows 跑 M2");
});

test("★ 规则 11:macOS 上出现 D3D11 渲染器 → 抓住", () => {
  assertRuleFires("webgl-vs-os", (p) => { p.os = "macOS"; p.platform = "MacIntel"; p.uaMetadata.platform = "macOS"; p.uaMetadata.platformVersion = "14.5.0"; p.ua = p.ua.replace(/Windows NT 10\.0; Win64; x64/, "Macintosh; Intel Mac OS X 10_15_7"); p.devicePixelRatio = 2; p.webgl.renderer = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"; }, "Mac 跑 D3D11");
});

test("★ 规则 12:字体表为空 → 抓住", () => {
  assertRuleFires("fonts-empty", (p) => { p.fonts = []; }, "无字体环境");
});

test("★ 规则 12:字体跨平台串味 → 抓住", () => {
  assertRuleFires("fonts-vs-os", (p) => { p.fonts = ["Helvetica", "Menlo", "Monaco"]; }, "Windows 报 macOS 独有字体");
});

test("★ 规则 13:webdriver 不是 false → 抓住", () => {
  assertRuleFires("webdriver", (p) => { p.webdriver = true; }, "最基础的一项");
});

test("★ 合法画像必须判 ok(校验器不能逢事必报)", () => {
  for (let i = 0; i < 30; i += 1) {
    const r = checkConsistency(profileFromSeed(`baseline-${i}`));
    assert.equal(r.ok, true, `baseline-${i} 被判成矛盾:${JSON.stringify(r.contradictions)}`);
  }
});

test("★ 空/畸形输入不崩,而是报矛盾(启动前校验不能自己抛异常)", () => {
  for (const junk of [undefined, null, {}, { os: "Windows" }, { ua: 123, fonts: "x" }]) {
    const r = checkConsistency(junk);
    assert.equal(r.ok, false);
    assert.ok(r.contradictions.length > 0);
  }
});

// ---- 4. 固定量 ------------------------------------------------------------

test("几条常量本身是对的(拿 Chrome 的文档值核对)", () => {
  assert.deepEqual(DEVICE_MEMORY_LADDER, [0.25, 0.5, 1, 2, 4, 8]);
  assert.ok(CPU_LADDER.every((n) => Number.isInteger(n) && n >= 2 && n <= 32));
  assert.equal(CHROME_MAJOR, 156);
});
