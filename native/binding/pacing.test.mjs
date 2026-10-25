// native/binding/pacing.test.mjs —— 内容驱动的节奏(M6)
//
// 验收原文:**停留时间与内容长度相关性 > 0.8**。
//
// 但只验"大于 0.8"是不够的 —— 一个 `y = ax + b` 也能轻松过 0.99。
// 那等于把公式交给观察者:看一眼几个页面的停留时长就能反推出来。
// 所以这里同时守**上界**:相关性不许接近 1,分布必须是多峰的。

import test from "node:test";
import assert from "node:assert/strict";

import { dwellMsFor, planVisits, pearson, PACING_LIMITS } from "./pacing.mjs";

/** 真实页面长度分布(对数均匀,200 ~ 20000 字符)。 */
function realisticLengths(n = 200) {
  const lo = Math.log(200);
  const hi = Math.log(20_000);
  return Array.from({ length: n }, (_, i) => Math.round(Math.exp(lo + (i / (n - 1)) * (hi - lo))));
}

const visitsFor = (lens, seed) => planVisits(lens.map((contentLength) => ({ contentLength })), seed);

/** 剔掉被上限夹住的样本 —— 它们不再随长度变化,算进去会把相关性压低。 */
function keptPairs(lens, visits) {
  const xs = [];
  const ys = [];
  for (const v of visits) {
    if (v.capped) continue;
    xs.push(lens[v.index]);
    ys.push(v.ms);
  }
  return { xs, ys };
}

// ---- 1. pearson 本身 ------------------------------------------------------

test("pearson:完全正相关 = 1,完全负相关 = -1,无方差 = NaN", () => {
  assert.equal(pearson([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(pearson([1, 2, 3], [6, 4, 2]), -1);
  assert.ok(Number.isNaN(pearson([1, 1, 1], [1, 2, 3])), "零方差没有定义");
  assert.ok(Number.isNaN(pearson([1], [1])), "一个点也没有定义");
});

// ---- 2. 验收判据 ----------------------------------------------------------

test("★ 验收:停留时间与内容长度的相关性 **> 0.8**(多个 seed 都要成立)", () => {
  const lens = realisticLengths();
  for (const seed of ["corr", "a", "b", "c", "d", "e", "f", "g"]) {
    const { xs, ys } = keptPairs(lens, visitsFor(lens, seed));
    const r = pearson(xs, ys);
    assert.ok(r > 0.8, `seed=${seed} 相关性 ${r.toFixed(4)} 没到 0.8`);
  }
});

test("★ 反指纹:相关性不许**接近 1**(直线等于把公式交出去)", () => {
  const lens = realisticLengths();
  for (const seed of ["corr", "a", "b", "c", "d"]) {
    const { xs, ys } = keptPairs(lens, visitsFor(lens, seed));
    const r = pearson(xs, ys);
    assert.ok(r < 0.98, `seed=${seed} 相关性 ${r.toFixed(4)} 太高 —— 这是直线的味道`);
  }
});

test("★ 长内容平均停得更久(趋势方向必须对)", () => {
  const lens = realisticLengths();
  const visits = visitsFor(lens, "trend");
  const short = visits.filter((v) => lens[v.index] < 600).map((v) => v.ms);
  const long = visits.filter((v) => lens[v.index] > 12_000).map((v) => v.ms);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok(mean(long) > mean(short) * 5, `长内容应显著更久:${mean(long)} vs ${mean(short)}`);
});

// ---- 3. 分布形状 ----------------------------------------------------------

test("★ 三种阅读模式的占比接近 10% / 75% / 15%(单一模式是机器特征)", () => {
  const lens = realisticLengths(200);
  const counts = { skim: 0, normal: 0, deep: 0 };
  let total = 0;
  for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    for (const v of visitsFor(lens, seed)) {
      counts[v.mode] += 1;
      total += 1;
    }
  }
  const share = (k) => counts[k] / total;
  assert.ok(Math.abs(share("skim") - 0.1) < 0.04, `skim 占比 ${share("skim").toFixed(3)} 偏离 0.1 太多`);
  assert.ok(Math.abs(share("normal") - 0.75) < 0.05, `normal 占比 ${share("normal").toFixed(3)}`);
  assert.ok(Math.abs(share("deep") - 0.15) < 0.04, `deep 占比 ${share("deep").toFixed(3)}`);
});

test("★ 同一阅读模式内,「停留/长度」的比值也必须**有波动**(固定阅读速度是签名)", () => {
  // 为什么要单独验这条:相关性只由"模式"就能撑到 0.93,于是把阅读速度取成常数
  // (永远 15 字符/秒)**不会**让相关性掉下来 —— 但观察者只要多采几次样本,
  // 就能看出"这个 agent 在 normal 模式下恒定 15 字符/秒"。那是可被指纹化的常数。
  //
  // 长页面上思考时间可忽略,比值 ≈ 1/速度,于是比值本身的离散度直接反映速度波动。
  const lens = realisticLengths(300).filter((n) => n > 8_000);
  const byMode = { skim: [], normal: [], deep: [] };
  for (const seed of ["a", "b", "c", "d", "e", "f"]) {
    for (const v of visitsFor(lens, seed)) {
      if (v.capped) continue;
      byMode[v.mode].push(v.ms / lens[v.index]);
    }
  }
  for (const [mode, ratios] of Object.entries(byMode)) {
    if (ratios.length < 20) continue;
    const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    const sd = Math.sqrt(ratios.reduce((s, x) => s + (x - mean) ** 2, 0) / ratios.length);
    const cv = sd / mean;
    assert.ok(cv > 0.08, `${mode} 模式的比值变异系数只有 ${cv.toFixed(4)} —— 速度几乎是常数`);
  }
});

test("★ 停留时长必须**不是同一个数**(常数是最明显的机器特征)", () => {
  const lens = realisticLengths(50);
  const ms = visitsFor(lens, "same").map((v) => v.ms);
  assert.ok(new Set(ms).size > 40, `50 个页面只有 ${new Set(ms).size} 种停留时长`);
});

// ---- 4. 边界与钳制 --------------------------------------------------------

test("★ 极短内容也不许 0 停留 —— 至少到下限", () => {
  const v = dwellMsFor({ contentLength: 1, seed: "tiny" });
  assert.ok(v.ms >= PACING_LIMITS.minMs, `实际 ${v.ms} 低于下限`);
  // 但也不该长到离谱:1 个字符的页面没有"阅读时间"可言
  assert.ok(v.ms <= PACING_LIMITS.minMs * 4, `1 个字符停了 ${v.ms} ms,太长`);
});

test("★ 极长内容钳到上限,并且**明说被夹住了**", () => {
  const v = dwellMsFor({ contentLength: 10_000_000, seed: "huge" });
  assert.equal(v.ms, PACING_LIMITS.maxMs);
  assert.equal(v.capped, true, "夹住了要说出来,否则统计时没法剔除");
});

test("正常长度不会被夹住", () => {
  const v = dwellMsFor({ contentLength: 3_000, seed: "mid" });
  assert.equal(v.capped, false);
  assert.ok(v.ms > PACING_LIMITS.minMs && v.ms < PACING_LIMITS.maxMs);
});

test("contentLength 为 0 / 负数 / 非数字 → 退到下限,不抛", () => {
  for (const bad of [0, -5, Number.NaN, undefined, "abc"]) {
    const v = dwellMsFor({ contentLength: bad, seed: "x" });
    assert.ok(v.ms >= PACING_LIMITS.minMs, `contentLength=${bad} 得到 ${v.ms}`);
    assert.equal(v.readingMs, 0, `contentLength=${bad} 不该有阅读时间`);
  }
});

test("★ 下限是硬的:把 minMs 抬到很高时,短内容也照样被顶上去", () => {
  const v = dwellMsFor({ contentLength: 10, seed: "floor", minMs: 99_999, maxMs: 999_999 });
  assert.equal(v.ms, 99_999, "下限必须真的生效");
});

test("minMs / maxMs 可覆盖", () => {
  const v = dwellMsFor({ contentLength: 500, seed: "o", minMs: 5_000, maxMs: 6_000 });
  assert.ok(v.ms >= 5_000 && v.ms <= 6_000, `实际 ${v.ms}`);
});

// ---- 5. 确定性 ------------------------------------------------------------

test("★ 同一个 seed 永远同一个结果(可复现才能验)", () => {
  const one = dwellMsFor({ contentLength: 4_321, seed: "same-seed" });
  const two = dwellMsFor({ contentLength: 4_321, seed: "same-seed" });
  assert.deepEqual(one, two);
});

test("不同 seed 会给出不同节奏", () => {
  const a = dwellMsFor({ contentLength: 4_321, seed: "s1" });
  const b = dwellMsFor({ contentLength: 4_321, seed: "s2" });
  assert.notDeepEqual(a, b);
});

test("planVisits 给每个页面各自的 seed(不会整串一模一样)", () => {
  const visits = planVisits(
    Array.from({ length: 6 }, () => ({ contentLength: 3_000 })),
    "seq",
  );
  assert.equal(visits.length, 6);
  assert.ok(new Set(visits.map((v) => v.ms)).size > 3, "同样长度的页面也该有不同节奏");
  assert.deepEqual(
    visits.map((v) => v.index),
    [0, 1, 2, 3, 4, 5],
  );
});
