// native/binding/rotation.mjs —— 档案 ↔ 出口节点的**租约**(P3 的「轮换」)
//
// ## 轮换单位:**一个档案的一次会话**(= 一个 browser context 的生命周期)
//
// ADR-013 的理由对**生产**同样成立,而且更硬:一次访问会打开多个连接,若出口在访问中途变了,
// 一次访问就会暴露多个 IP —— 那不是「噪声」,那是**破绽**。所以本模块只做**租约**:
// 进会话时领一个节点、出会话时还。**没有任何**按请求/按连接换出口的代码路径 ——
// 不是「还没做」,是**不做**。
//
// ## 谁轮换、谁不轮换
//   - `persona`(长期身份):**不轮换**。身份与出口是绑一起的,同一个档案下次进来还领**同一个**节点
//     (记在租约表的 `pins` 里)。它挂了 ⇒ **响亮地失败**(见下「失败判定」)。
//   - 其余(含 `disposable` / `real`):每个**新会话**领一个**当前没被占**的节点;领不到 ⇒ 失败。
//     独占是硬要求:两个活着的档案共用一个出口 = 把两个身份**连起来**。
//
// ## 失败判定
//   - 分配时:节点被隔离(quarantine)或没有空闲节点 ⇒ 抛 `OUUUT_POOL_*`,**拒绝启动**。
//   - 运行中:出口量不到 —— 那一步由 **P4 的出口闸**负责拒绝跑(rc=2);这里只提供
//     `markDead()` 把那条节点**隔离**(带证据与时刻),下次分配自动跳过。
//     ⚠️ 绝不允许「量不到就当验过了」(P4 决定 3),也绝不允许静默直连(坑-40、坑-28)。
//
// ## ADR-013 的两条硬规矩,写在**代码里**而不只是文档里
//   1. `sticky: false`(每连接换 IP 的旋转端点,如 resin 的 `:2260`)⇒ **拒绝入池**。
//      它连"一次会话一个出口"都保证不了,生产里同样是破绽。
//   2. **带认证**的节点入池必须显式 `verifiedSticky: true` —— 对应 ADR-013 的
//      「新增出口必须先在 `probe/tools/scan_pinned_egress.py` 里验过 STICKY」。
//      (固定节点按 ADR-013 是**无需认证**的;所以"带认证"默认按"没验过"处理。)
//
// 依赖只往"下"走:本模块不认识 CLI,也不认识 CDP;调用方给 pid、给文件路径。

import fsp from "node:fs/promises";
import path from "node:path";

import { parseProxy } from "./proxy.mjs";

/** 轮换单位,给调用方与诊断共用的**唯一**说法。 */
export const ROTATION_UNIT = "一个档案的一次会话(context 生命周期)";

export class PoolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PoolError";
    this.code = code;
  }
}

const bad = (m) => new PoolError(m, "OUUUT_POOL_BAD_SPEC");

/**
 * 校验池规格。
 * @param {{nodes: Array<{id: string, url: string, sticky?: boolean, verifiedSticky?: boolean,
 *   egressIp?: string, country?: string, note?: string}>}|Array} spec
 * @returns {{nodes: Array<object>}}
 */
export function parsePool(spec) {
  const raw = Array.isArray(spec) ? { nodes: spec } : spec;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.nodes)) {
    throw bad("池规格要长成 {nodes: [...]}(或直接给数组)");
  }
  if (raw.nodes.length === 0) throw bad("池里一条节点都没有");
  const seen = new Set();
  const nodes = raw.nodes.map((n, i) => {
    if (!n || typeof n !== "object") throw bad(`第 ${i + 1} 条节点不是对象`);
    const id = String(n.id ?? "").trim();
    if (!id) throw bad(`第 ${i + 1} 条节点没有 id`);
    if (seen.has(id)) throw bad(`节点 id 重复:${id}`);
    seen.add(id);
    let url;
    try {
      url = parseProxy(String(n.url ?? ""));
    } catch (err) {
      throw bad(`节点 ${id} 的 url 不合法:${err.message}`);
    }
    if (url.scheme !== "socks5" && url.scheme !== "socks5h") {
      // 池只收 SOCKS5:出口闸的上游那一半只会说 SOCKS5(见 egress-guard.mjs),
      // 而"档案绑代理"那条路也一直是 socks5。
      throw bad(`节点 ${id} 只支持 socks5:${url.redacted}`);
    }
    if (n.sticky === false) {
      throw new PoolError(
        `节点 ${id} 标着 sticky:false(每连接换 IP 的旋转端点)⇒ 拒绝入池:` +
          `它连「一次会话一个出口」都保证不了,生产里同样是破绽(ADR-013)。`,
        "OUUUT_POOL_ROTATING_NOT_ALLOWED",
      );
    }
    if (url.hasCredentials && n.verifiedSticky !== true) {
      throw new PoolError(
        `节点 ${id} 带认证(${url.redacted})但没有 verifiedSticky:true ⇒ 拒绝入池:` +
          `ADR-013 要求新增出口必须先在 probe/tools/scan_pinned_egress.py 里验过 STICKY。`,
        "OUUUT_POOL_UNVERIFIED_STICKY",
      );
    }
    return Object.freeze({
      id,
      // 分工照 `proxy.mjs` 的老规矩:`proxy` 给进程用(含凭据),`redacted` 只给人看。
      // ⚠️ 别把 `redactProxy()` 的结果直接插进字符串 —— 它返回的是**对象**(还带 raw 原文),
      // 插进去会变成 [object Object],而对象一旦被整个存下来,凭据就跟着走了。
      proxy: url.chromeValue,
      redacted: url.redacted,
      sticky: true,
      verifiedSticky: n.verifiedSticky === true,
      egressIp: n.egressIp ? String(n.egressIp) : null,
      country: n.country ? String(n.country) : null,
      note: n.note ? String(n.note) : null,
      /** 万一有人 `JSON.stringify(node)` / `console.log(pool)` —— 凭据不许跟着出去(F13 的验收就是"grep 无凭据")。
       *  要能连的原值,请**显式**读 `node.proxy`。 */
      toJSON() {
        return {
          id: this.id,
          redacted: this.redacted,
          sticky: true,
          verifiedSticky: this.verifiedSticky,
          egressIp: this.egressIp,
          country: this.country,
          note: this.note,
        };
      },
    });
  });
  return { nodes };
}

/** 稳定的字符串散列(FNV-1a):按档案 id 选节点,同样的档案落在同样的候选上(不掷骰子)。 */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 进程还活着吗(Windows 上也认)。 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // 存在但没权限动它 —— 也算活着
  }
}

const emptyStore = () => ({ leases: {}, pins: {}, dead: {} });

/** 把**进程已经没了**的租约放掉(别人崩了不该把池子永久占死)。返回是否改动过。 */
export function reclaimStaleLeases(store, { isAlive = isProcessAlive } = {}) {
  let changed = false;
  for (const [nodeId, lease] of Object.entries(store.leases)) {
    if (!isAlive(lease.pid)) {
      delete store.leases[nodeId];
      changed = true;
    }
  }
  return changed;
}

/**
 * 纯函数:给某个档案选一条节点。挑不出来就抛 —— **不返回 null**,免得调用方默默直连。
 * @param {{pool: {nodes: Array<object>}, store: object, profileId: string, kind: string|null,
 *   pid: number, now: number, reuse: boolean}} o
 */
export function pickNode({ pool, store, profileId, kind = null, pid = process.pid, now = Date.now(), reuse = false }) {
  reclaimStaleLeases(store);
  const byId = new Map(pool.nodes.map((n) => [n.id, n]));
  const dead = (n) => Boolean(store.dead[n.id]);
  const heldBy = (n) => store.leases[n.id];

  if (kind === "persona") {
    const pinned = store.pins[profileId];
    if (pinned) {
      const node = byId.get(pinned);
      if (!node) {
        throw new PoolError(
          `档案 ${profileId} 钉在节点 ${pinned} 上,但池里没有这条节点了 ⇒ 拒绝启动。`,
          "OUUUT_POOL_NODE_GONE",
        );
      }
      // 钉子还在,但那条节点被隔离了 / 被别的会话占着 —— 都不许偷偷换一条(换了就是换 IP)。
      if (dead(node)) {
        throw new PoolError(
          `档案 ${profileId} 钉在节点 ${pinned} 上,但这条节点已被隔离(出口故障)⇒ 拒绝启动:` +
            `长期身份不许静默换出口。要么修好这条节点,要么显式改钉。`,
          "OUUUT_POOL_NODE_QUARANTINED",
        );
      }
      const lease = heldBy(node);
      if (lease && lease.profileId !== profileId) {
        throw new PoolError(
          `节点 ${pinned} 正被档案 ${lease.profileId}(pid ${lease.pid})占着,而档案 ${profileId} 也钉在它上面 ⇒ 拒绝启动。`,
          "OUUUT_POOL_PINNED_BUSY",
        );
      }
      return { node, pinned: true };
    }
  }

  const free = pool.nodes.filter((n) => !dead(n) && !heldBy(n));
  if (free.length === 0) {
    const usable = pool.nodes.filter((n) => !dead(n));
    if (reuse && usable.length > 0) {
      // 显式越权:复用最久没被动的节点(调用方必须在诊断里标出来 —— 这会打破"独占")。
      const lru = usable
        .slice()
        .sort((a, b) => (heldBy(a)?.startedAt ?? 0) - (heldBy(b)?.startedAt ?? 0))[0];
      return { node: lru, pinned: false, reused: true };
    }
    throw new PoolError(
      `池里没有空闲节点(${pool.nodes.length} 条,隔离 ${Object.keys(store.dead).length} 条,` +
        `占用 ${Object.keys(store.leases).length} 条)⇒ 拒绝启动:` +
        `两个活着的档案共用出口会把身份连起来,所以宁可不开。` +
        (usable.length > 0 ? "(要打破独占,显式给 --pool-reuse)" : "(所有节点都被隔离了)"),
      "OUUUT_POOL_EXHAUSTED",
    );
  }
  const node = free[hash(profileId) % free.length];
  return { node, pinned: false };
}

async function withLock(file, fn, { tries = 100, waitMs = 20 } = {}) {
  const lock = `${file}.lock`;
  for (let i = 0; i < tries; i++) {
    let fh;
    try {
      fh = await fsp.open(lock, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    try {
      return await fn();
    } finally {
      await fh.close();
      await fsp.rm(lock, { force: true });
    }
  }
  throw new PoolError(`租约表被别的进程锁着(${lock})⇒ 拒绝启动,免得两条档案撞到同一个出口。`, "OUUUT_POOL_BUSY");
}

/**
 * 打开一个池(带**文件**租约表):多个进程(也就多个档案)靠这张表互斥。
 * @param {{file: string, spec?: object, pid?: number, now?: () => number}} o
 */
export async function openPool({ file, spec = null, pid = process.pid, now = () => Date.now() } = {}) {
  if (!file && !spec) throw bad("openPool 至少要给 file(租约表)或 spec(池规格)");
  let pool;
  // ⚠️ 规格文件与租约表**必须分开**:第一版让两者共用同一个路径,
  //    于是"从文件读规格"这条路第一次 assign 就把**规格本身覆盖成租约**了。
  //    规矩:调用方给了 `spec` ⇒ 那个 `file` 就是租约表;规格是从 `file` 读的 ⇒ 租约表 = `file + .leases.json`。
  let storeFile;
  if (spec) {
    pool = parsePool(spec);
    storeFile = file ?? null;
  } else {
    pool = parsePool(JSON.parse(await fsp.readFile(file, "utf8")));
    storeFile = `${file}.leases.json`;
  }

  async function readStore() {
    if (!storeFile) return emptyStore();
    try {
      const txt = await fsp.readFile(storeFile, "utf8");
      const data = JSON.parse(txt);
      return { ...emptyStore(), ...data, leases: { ...(data.leases ?? {}) }, pins: { ...(data.pins ?? {}) }, dead: { ...(data.dead ?? {}) } };
    } catch (err) {
      if (err.code === "ENOENT") return emptyStore();
      throw new PoolError(`租约表读不动(${storeFile}):${err.message}`, "OUUUT_POOL_STORE");
    }
  }

  async function writeStore(store) {
    if (!storeFile) return;
    await fsp.mkdir(path.dirname(storeFile), { recursive: true });
    await fsp.writeFile(storeFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  /** 锁住 → 读 → 改 → 写 → 放锁。所有变更都走这一条路(跨进程也不会撞)。 */
  async function mutate(fn) {
    return withLock(storeFile ?? path.join(process.cwd(), ".ouuut-pool"), async () => {
      const store = await readStore();
      const out = await fn(store);
      await writeStore(store);
      return out;
    });
  }

  const handle = {
    pool,
    file: storeFile,
    /**
     * **一次给多个档案领**(同一把锁里做完):要么全领到,要么一条都不领 —— 不留"半场租约"。
     * 为什么必须一起领:两个档案的分配是**互相牵制**的(独占),分开领就会出现
     * "A 领到了、B 失败"的半场状态,而那半场还得靠进程死掉才回收。
     */
    async assignMany({ requests = [], reuse = false } = {}) {
      if (!Array.isArray(requests) || requests.length === 0) throw bad("assignMany 需要至少一个请求");
      for (const r of requests) if (!r?.profileId) throw bad("assignMany 的每项都需要 profileId");
      return mutate(async (store) => {
        const out = [];
        for (const r of requests) {
          const picked = pickNode({ pool, store, profileId: r.profileId, kind: r.kind ?? null, pid, now: now(), reuse });
          const prev = store.leases[picked.node.id];
          if (prev && prev.profileId !== r.profileId) {
            // 双保险:纯函数里查过一遍,真正落表前再查一遍(表可能刚被别人改过)。
            throw new PoolError(
              `节点 ${picked.node.id} 刚被档案 ${prev.profileId} 领走 ⇒ 拒绝启动。`,
              "OUUUT_POOL_RACE",
            );
          }
          const lease = { profileId: r.profileId, kind: r.kind ?? null, pid, startedAt: now() };
          store.leases[picked.node.id] = lease;
          if (r.kind === "persona" && !store.pins[r.profileId]) store.pins[r.profileId] = picked.node.id;
          out.push({ ...picked, lease });
        }
        return out;
        // ⚠️ 中途抛错时 `mutate` **不会写盘**(写盘在 fn 返回之后)⇒ 半场租约根本不会落盘。
      });
    },
    /** 领一条(单档案的常用形式)。 */
    async assign(request = {}) {
      const [one] = await handle.assignMany({ requests: [request], reuse: Boolean(request.reuse) });
      return one;
    },
    /** 还节点(只还自己领的那条)。 */
    async release({ profileId } = {}) {
      return mutate(async (store) => {
        const mine = Object.entries(store.leases).filter(([, l]) => l.profileId === profileId);
        for (const [nodeId] of mine) delete store.leases[nodeId];
        return mine.length;
      });
    },
    /** 隔离一条节点(出口挂了 / 量不到):带证据与时刻,下次分配自动跳过。 */
    async markDead({ nodeId, reason = "未说明", evidence = null } = {}) {
      return mutate(async (store) => {
        store.dead[nodeId] = { at: now(), reason: String(reason), evidence: evidence ? String(evidence) : null };
        delete store.leases[nodeId];
        return store.dead[nodeId];
      });
    },
    async snapshot() {
      if (!storeFile) return emptyStore();
      return readStore();
    },
  };
  return handle;
}