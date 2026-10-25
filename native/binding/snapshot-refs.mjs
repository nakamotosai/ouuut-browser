// native/binding/snapshot-refs.mjs —— §4.2 跨 renderer 的 `ref` 分配
//
// 契约来源:`docs/原生层接口.md` §4.2。
//
//   > `refs` 里要给**跨 renderer**唯一的 `refId`,并带 `frameId`:
//   > ```js
//   > { refId: 901, backendNodeId: 21, frameId: "FRAME_OR_OOPIF_TARGET_ID",
//   >   role: "button", name: "Run iframe action" }
//   > ```
//   > - 同一份快照里 `refId` **跨进程唯一**(这是给 agent 看的编号)
//   > - `backendNodeId` 只在它的 renderer 内唯一
//   > - 拍快照**不得**激活 / focus / reload 任何 frame
//
// ## 两个"唯一性"必须分开想(这一点最容易出错)
//
// `backendNodeId` **只在它自己的 renderer 内唯一** —— 主 frame 的 `21` 和某个 OOPIF 的 `21`
// 完全可能是**两个不同的节点**。所以节点身份是**二元组** `(frameId, backendNodeId)`,
// 不是单独一个 `backendNodeId`。把它当一元组用,就会出现"同名的两个 iframe 按钮
// 被当成同一个节点"这种静默错。
//
// 而给 agent 看的 `refId` 是**全局单调**的 —— agent 只看到编号,不该关心它在哪个进程。
//
// ## 为什么分配必须是纯计算
//
// §4.2 最后一条:拍快照**不得激活 / focus / reload 任何 frame**。
// 所以分配过程**一次 CDP 都不发** —— 它只是遍历已经拿到的 AX 树 + frame 信息。
// `cdp-guard.mjs` 那边另有一道闸拦 `Target.activateTarget` 之类的命令(见 `SNAPSHOT_FORBIDDEN`)。
//
// ## 稳定性
//
// §4.1 的验收要求「同一 fixture 连拍两次,第二次输出**逐字节相同**」。
// 所以同一个 `(frameId, backendNodeId)` 在**同一个分配器实例**里必须拿到**同一个** `refId`
// —— 否则连拍两次 ref 就变了,agent 手上刚拿到的 ref 立刻作废。

/**
 * 会被分配 ref 的角色 —— 即"agent 可以对它做事"的节点。
 *
 * 注意 `text` **不在**这里:文本是给 agent **读**的,不是让它点的。
 * 给文本发 ref 只会把 `refs` 撑大,并让 `loc=` 那套唯一性判定更难成立。
 */
export const INTERACTIVE_ROLES = Object.freeze([
  "button",
  "anchor",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "option",
  "listbox",
  "spinbutton",
  "canvas",
  "image",
]);

const INTERACTIVE = new Set(INTERACTIVE_ROLES);

/**
 * 拍快照期间**禁止**发出的命令(§4.2 最后一条)。
 *
 * 单独列出来给 `cdp-guard.mjs` 用 —— 与"驱动层按住副作用命令"是两件事:
 * 那些命令平时也许有正当用途,但**拍快照期间**一条都不能发。
 */
export const SNAPSHOT_FORBIDDEN = Object.freeze([
  "Target.activateTarget",
  "Page.bringToFront",
  "Page.reload",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "DOM.focus",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Runtime.evaluate",
]);

/**
 * 建一个分配器。**跨 frame 共用一个实例**,这是 `refId` 跨进程唯一的实现方式:
 * 编号空间只有一个,谁先来谁拿小的。
 */
export function createRefAllocator({ startAt = 1 } = {}) {
  let next = startAt;
  /** key = `${frameId}\u0000${backendNodeId}` → refId */
  const assigned = new Map();
  /** refId → 记录(§4.2 要求的形状) */
  const byRefId = new Map();

  const key = (frameId, backendNodeId) => `${frameId ?? ""}\u0000${backendNodeId}`;

  return {
    /**
     * 给一个节点要一个 ref。同一 `(frameId, backendNodeId)` 反复调用**拿回同一个** refId。
     *
     * @returns {number|null} 拿不到(缺 backendNodeId)时返回 null
     */
    allocate(frameId, backendNodeId, { role, name, sessionId } = {}) {
      if (backendNodeId === null || backendNodeId === undefined) return null;
      const k = key(frameId, backendNodeId);
      const existing = assigned.get(k);
      if (existing !== undefined) {
        // 稳定性:同一个节点永远同一个编号
        return existing;
      }
      const refId = next;
      next += 1;
      assigned.set(k, refId);
      // ⚠️ **缺省字段一律「省略」,不许填 `null`** —— harness 的 `validatePageRefState()`
      //     (page-ref-registry.js)只接受 `string | undefined`,填 `null` 会让它判整个 ref 状态非法,
      //     于是 `page.snapshot()` 抛 `Invalid persisted Page refs; take a new snapshot`
      //     (2026-10-25 实证:`restore()` 用 null 抛、用 undefined 过)。见坑-42。
      const record = { refId, backendNodeId };
      if (frameId !== null && frameId !== undefined) record.frameId = frameId;
      if (role !== null && role !== undefined) record.role = role;
      if (name !== null && name !== undefined) record.name = name;
      // OOPIF 的节点在**另一个 target** 上,后续动作必须带这个 session 才路由得到。
      // 同进程 frame 这里没有这个键(走主 session 就行)。
      if (sessionId) record.sessionId = sessionId;
      byRefId.set(refId, record);
      return refId;
    },

    /** 已分配的编号里最大的那个 + 1 —— 给下一个 frame 续号用。 */
    nextRef() {
      return next;
    },

    /** §4.2 要求的 `refs` 映射:refId → 记录。 */
    snapshot() {
      return Object.fromEntries([...byRefId.entries()].sort((a, b) => a[0] - b[0]));
    },

    /** 诊断:某帧用了几个 ref。 */
    countInFrame(frameId) {
      let n = 0;
      for (const [, k] of assigned) {
        if (k.startsWith(`${frameId ?? ""}\u0000`)) n += 1;
      }
      return n;
    },
  };
}

/**
 * 遍历一棵规范形状的树,给可交互节点分配 ref。
 *
 * **纯函数式的副作用**:只往 `allocator` 里写,不发任何 CDP、不改 DOM、不动焦点。
 * 返回的 `tree` 是**新对象**(带 `refId`),不原地改入参 —— 这样"同一棵树喂两个分配器"
 * 能各自独立,便于测跨 frame 的编号空间。
 *
 * @param {object|null} node   规范形状(含 `role` / `name` / `backendNodeId` / `children`)
 * @param {object} o
 * @param {object} o.allocator `createRefAllocator()` 的返回值
 * @param {string|null} [o.frameId] 这棵树属于哪个 frame
 */
export function assignRefs(node, { allocator, frameId = null, sessionId = null } = {}) {
  if (!node) return null;
  if (!allocator || typeof allocator.allocate !== "function") {
    throw new TypeError("assignRefs 需要一个 createRefAllocator() 的返回值");
  }
  const kids = [];
  for (const c of node.children ?? []) {
    const a = assignRefs(c, { allocator, frameId, sessionId });
    if (a) kids.push(a);
  }

  const refId = INTERACTIVE.has(node.role)
    ? allocator.allocate(frameId, node.backendNodeId, {
        role: node.role,
        name: node.name,
        sessionId,
      })
    : null;

  const out = { ...node, children: kids };
  if (refId !== null) out.refId = refId;
  return out;
}

/**
 * 一个 iframe 边界:它自己那棵树 + 它的 frameId。
 * `frameId` 用 OOPIF 的 target id 或普通 frame id 都行,只要**同一份快照里唯一**。
 */
export function assignRefsForFrames(frames, { allocator } = {}) {
  const alloc = allocator ?? createRefAllocator();
  const trees = [];
  for (const f of frames ?? []) {
    if (!f || typeof f.frameId !== "string" || f.frameId === "") {
      throw new TypeError("每个 frame 都需要一个非空 frameId");
    }
    trees.push({
      frameId: f.frameId,
      sessionId: f.sessionId ?? null,
      tree: assignRefs(f.tree ?? null, {
        allocator: alloc,
        frameId: f.frameId,
        sessionId: f.sessionId ?? null,
      }),
    });
  }
  return { trees, allocator: alloc, refs: alloc.snapshot() };
}

/** `refs` 是不是**跨进程唯一**(值就是 refId,所以只要键数 == 记录数即可,但仍显式查一遍)。 */
export function assertRefIdsUnique(refs) {
  const seen = new Set();
  const dupes = [];
  for (const [k, v] of Object.entries(refs ?? {})) {
    const id = v?.refId ?? Number(k);
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  return { ok: dupes.length === 0, duplicates: dupes, count: seen.size };
}

/** 记录里有没有 `(frameId, backendNodeId)` 撞车 —— 那意味着两个不同节点共用了标识。 */
export function assertNodeIdentityUnique(refs) {
  const seen = new Map();
  const clashes = [];
  for (const v of Object.values(refs ?? {})) {
    const k = `${v?.frameId ?? ""}\u0000${v?.backendNodeId}`;
    if (seen.has(k)) clashes.push({ key: k, refIds: [seen.get(k), v?.refId] });
    else seen.set(k, v?.refId);
  }
  return { ok: clashes.length === 0, clashes };
}
