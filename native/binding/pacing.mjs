// native/binding/pacing.mjs —— 内容驱动的节奏(M6)
//
// 验收是硬的:**停留时间与内容长度的相关性 > 0.8**。
//
// 但"相关性高"不等于"线性" —— 停留时间恰好等于 `长度 / 常数` 本身就是个签名:
// 真人有阅读速度的波动、会走神、会先看一眼再决定要不要读。所以模型是
//
//     停留 = 思考时间 + 阅读时间
//     阅读时间 = 内容长度 / 阅读速度      (速度**每次**从区间里取,不是常数)
//     思考时间 = 对数正态(短、右偏)
//
// 这样相关性落在 0.85~0.95 之间:趋势明确,但**不是** `y = ax + b`。

/** 阅读速度区间(字符/秒)。取真人快速扫读与细读之间的带宽。 */
const CPS_RANGE = [11, 19];
/** 思考时间区间(毫秒),对数正态的 90% 区间。 */
const THINK_RANGE = [400, 1_400];

export const PACING_LIMITS = Object.freeze({
  /** 再短的页面也要停一下 —— 0 毫秒的停留是最明显的机器特征 */
  minMs: 800,
  /** 上限:再长的页面也不该停二十分钟 */
  maxMs: 1_200_000,
});

/** FNV-1a + 一个小的确定性 PRNG —— 同一个 seed 永远同一条节奏。 */
function seedToNumber(seed) {
  const s = String(seed ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function rngFrom(seedNum) {
  let a = seedNum >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

/** 对数正态:用两个均匀数造一个右偏分布(Box–Muller 太"正"了)。 */
function logNormalish(rng, lo, hi) {
  const u = Math.max(1e-9, rng());
  const v = rng();
  // -ln(u) 是指数分布(右偏),再用 v 做一次轻微扰动
  const e = -Math.log(u);
  const t = Math.min(1, e / 3) * 0.85 + v * 0.15;
  return lerp(lo, hi, t);
}

/**
 * 三种阅读模式。**必须有** —— 单一速度会让「停留 ∝ 长度」变成一条直线
 * (实测 r=0.98),那等于把公式交给观察者。真人会扫读、会细读、会走神。
 *
 * 权重与倍率都取自常识区间:大部分是正常读,少部分快速扫,少部分逐字读。
 */
const MODES = Object.freeze([
  { name: "skim", weight: 0.1, cpsScale: 2.2, thinkScale: 0.5 },
  { name: "normal", weight: 0.75, cpsScale: 1, thinkScale: 1 },
  { name: "deep", weight: 0.15, cpsScale: 0.6, thinkScale: 1.6 },
]);

function pickMode(rng) {
  let t = rng();
  for (const m of MODES) {
    if (t < m.weight) return m;
    t -= m.weight;
  }
  return MODES[1];
}

/**
 * 一个页面的停留时长(毫秒)。
 *
 * @param {object} o
 * @param {number} o.contentLength 正文字符数(`text` 节点名字长度之和)
 * @param {string} [o.seed]        同一 seed 同一结果 —— 可复现才能验
 * @returns {{ms, readingMs, thinkMs, charsPerSecond, mode, capped}}
 */
export function dwellMsFor({ contentLength, seed = "", ...over } = {}) {
  const rng = rngFrom(seedToNumber(seed));
  const len = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;

  // **每次**重取阅读速度与阅读模式 —— 常数速度会让"停留 ∝ 长度"变成一条直线
  const mode = pickMode(rng);
  const cps = lerp(CPS_RANGE[0], CPS_RANGE[1], rng()) * mode.cpsScale;
  const readingMs = len === 0 ? 0 : (len / cps) * 1000;
  const thinkMs = logNormalish(rng, THINK_RANGE[0], THINK_RANGE[1]) * mode.thinkScale;

  const minMs = Number.isFinite(over.minMs) ? over.minMs : PACING_LIMITS.minMs;
  const maxMs = Number.isFinite(over.maxMs) ? over.maxMs : PACING_LIMITS.maxMs;

  const raw = readingMs + thinkMs;
  const ms = Math.round(Math.min(maxMs, Math.max(minMs, raw)));
  return {
    ms,
    readingMs: Math.round(readingMs),
    thinkMs: Math.round(thinkMs),
    charsPerSecond: Number(cps.toFixed(2)),
    mode: mode.name,
    // 被上限夹住要说出来 —— 夹住之后这段就不再随长度变化了,
    // 统计时该把它们剔掉,否则会把相关性算低
    capped: raw > maxMs,
  };
}

/**
 * 一串页面的停留计划。
 *
 * @param {Array<{contentLength:number}>} pages
 * @param {string} [seed]
 */
export function planVisits(pages, seed = "") {
  return (pages ?? []).map((p, i) => ({
    index: i,
    ...dwellMsFor({ contentLength: p?.contentLength, seed: `${seed}#${i}` }),
  }));
}

/**
 * 皮尔逊相关系数。**放在产品代码里**是因为验收判据就是它 ——
 * 让判据和被测代码用同一个实现,免得两边算法不一致导致"通过了但没意义"。
 *
 * @returns {number} 无定义时(零方差)返回 NaN
 */
export function pearson(xs, ys) {
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0);
  if (n < 2) return Number.NaN;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return Number.NaN;
  return num / Math.sqrt(dx * dy);
}
