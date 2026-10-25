// native/binding/orchestrator.mjs —— 多机编排(F11 的"多机编排")
//
// 这里**只做调度**,不做网络。理由:调度是纯函数,能脱离网络被穷举验证;
// 一旦把"发 HTTP"混进来,失败原因就永远分不清是调度错了还是机器挂了。
//
// 三条硬要求:
//   1. **容量是硬的** —— 超过 `maxPerHost` 一律不放
//   2. **放不下就报出来** —— 绝不静默丢弃。少跑一个任务的代价远大于多一条错误
//   3. **确定性** —— 同样的输入永远给同样的分配(否则重放、对比、复现全失效)

/**
 * 把任务分到各台机器上。
 *
 * 策略:**最空的先来**。同一负载时按 `hosts` 的给定顺序 —— 这就是确定性的来源
 * (不依赖 Map 迭代序或随机数)。
 *
 * @param {object} o
 * @param {Array<{id: string, max?: number, healthy?: boolean}>} o.hosts
 * @param {Array<{id: string, host?: string}>} o.jobs  `host` 是**亲和性**:指定了就只放那台
 * @param {number} [o.maxPerHost] 默认每台 1(一个档案一个浏览器进程)
 * @returns {{assignments: Array<{jobId, host}>, unassigned: Array<{jobId, reason}>, load: object}}
 */
export function planAssignments({ hosts = [], jobs = [], maxPerHost = 1 } = {}) {
  const pool = (hosts ?? [])
    .filter((h) => h && typeof h.id === "string" && h.id !== "")
    // 不健康的机器**不参与**调度,但仍保留在 hosts 里由调用方报告
    .filter((h) => h.healthy !== false)
    .map((h) => ({
      id: h.id,
      cap: Number.isFinite(h.max) && h.max >= 0 ? h.max : maxPerHost,
      used: 0,
      order: 0,
    }));
  pool.forEach((h, i) => {
    h.order = i;
  });

  const assignments = [];
  const unassigned = [];

  for (const job of jobs ?? []) {
    if (!job || typeof job.id !== "string" || job.id === "") {
      unassigned.push({ jobId: null, reason: "OUUUT_JOB_INVALID", detail: "任务缺 id" });
      continue;
    }

    // 亲和性:指定了机器就只放那台
    const candidates = job.host ? pool.filter((h) => h.id === job.host) : pool;
    if (job.host && candidates.length === 0) {
      unassigned.push({
        jobId: job.id,
        reason: "OUUUT_HOST_UNAVAILABLE",
        detail: `指定了 ${job.host},但它不在可用机器里`,
      });
      continue;
    }

    // 最空的先来。**平局按 `pool` 的迭代顺序**(即 `hosts` 的给定顺序)——
    // 因为 `best` 只在严格更空时才被替换,所以先到的赢。
    // 这既是确定性来源,也省掉一个永远为假的比较。
    let best = null;
    for (const h of candidates) {
      if (h.used >= h.cap) continue;
      if (best === null || h.used < best.used) best = h;
    }

    if (!best) {
      unassigned.push({
        jobId: job.id,
        reason: "OUUUT_NO_CAPACITY",
        detail: job.host ? `${job.host} 已满` : "所有机器的容量都用完了",
      });
      continue;
    }

    best.used += 1;
    assignments.push({ jobId: job.id, host: best.id });
  }

  const load = {};
  for (const h of pool) load[h.id] = { used: h.used, cap: h.cap };
  // 不健康的机器也要出现在负载表里 —— 否则调用方看不见"它被跳过了"
  for (const h of hosts ?? []) {
    if (h && typeof h.id === "string" && h.healthy === false) {
      load[h.id] = { used: 0, cap: 0, skipped: "unhealthy" };
    }
  }

  return { assignments, unassigned, load };
}

/**
 * 某台机器挂了之后重新编排。
 *
 * **已经跑完的任务不重排**(传 `done` 进来),只把没跑完的重新分配 ——
 * 否则会把已完成的工作再跑一遍。
 *
 * @param {object} o
 * @param {Array<{jobId, host}>} o.assignments 原分配
 * @param {Set<string>|Array<string>} [o.done] 已完成的 jobId
 * @param {string} o.failedHost 挂掉的那台
 * @param {Array} o.hosts 机器列表(调用方应已把 failedHost 标记为 unhealthy)
 * @param {Array} o.jobs 全部任务
 * @returns {{assignments, unassigned, load, requeued: string[]}}
 */
export function replanAfterFailure({ assignments = [], done = [], failedHost, hosts = [], jobs = [], maxPerHost = 1 } = {}) {
  const doneSet = done instanceof Set ? done : new Set(done ?? []);
  const requeued = [];
  const keep = [];

  for (const a of assignments) {
    if (a.host !== failedHost) {
      keep.push(a);
      continue;
    }
    if (doneSet.has(a.jobId)) {
      // 已经完成的**保留记录** —— 它确实跑过了
      keep.push(a);
      continue;
    }
    requeued.push(a.jobId);
  }

  // 把重排的任务和从未分配的任务一起,放进**剩下的机器**里
  const hostIds = new Set(hosts.filter((h) => h?.healthy !== false).map((h) => h.id));
  const needIds = new Set([
    ...requeued,
    ...(jobs ?? []).map((j) => j?.id).filter((id) => typeof id === "string" && id !== ""),
  ]);
  const keptIds = new Set(keep.map((a) => a.jobId));
  const pending = [...needIds].filter((id) => !keptIds.has(id));

  // 已占用的名额要算进去,否则重排会把机器挤爆
  const reserved = {};
  for (const a of keep) reserved[a.host] = (reserved[a.host] ?? 0) + 1;

  const remaining = (jobs ?? []).filter((j) => pending.includes(j?.id));
  const replanned = planAssignments({
    hosts: hosts.filter((h) => hostIds.has(h.id)).map((h) => ({
      ...h,
      max: Number.isFinite(h.max) ? h.max - (reserved[h.id] ?? 0) : Math.max(0, maxPerHost - (reserved[h.id] ?? 0)),
    })),
    jobs: remaining,
    maxPerHost,
  });

  const result = { assignments: [...keep, ...replanned.assignments], unassigned: replanned.unassigned, requeued };

  // **负载必须是总量**,不是"重排了多少" —— 漏掉已占用名额的话,调用方会以为
  // 还有空位,下一次编排就会把机器挤爆。
  const load = {};
  for (const h of hosts) {
    if (!h || typeof h.id !== "string") continue;
    const fromPlan = replanned.load[h.id];
    const base = fromPlan ?? { used: 0, cap: 0 };
    const kept = reserved[h.id] ?? 0;
    load[h.id] = {
      used: base.used + kept,
      cap: (base.cap ?? 0) + kept,
      ...(base.skipped ? { skipped: base.skipped } : {}),
    };
  }
  return { ...result, load };
}
