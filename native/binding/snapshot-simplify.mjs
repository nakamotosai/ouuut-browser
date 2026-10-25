// native/binding/snapshot-simplify.mjs —— §4.1 文本化简 + §4.4 stable locator 校验
//
// 契约来源:`docs/原生层接口.md` §4.1 / §4.4(上游
// `harness/docs/native-snapshot-ref-requirement.md`)。
//
// ## 为什么化简必须是**内核侧**的纯函数
//
// > **为什么这是内核的活**:在 JS 侧过滤完整快照**不会减少内核工作量,也不会减少传输量**。
//
// 所以它是内核侧的活,而"内核侧的活"在本仓目前由 JS 实现(M4 才动 C++)。
// 关键是它必须**纯粹**:同输入恒同输出,不依赖任何全局状态 ——
// 这样 §4.1 的验收「同一 fixture 连拍两次,第二次输出**逐字节相同**」才有保证。
//
// ## §4.1 的规则(逐条实现,不夹带"聪明"的额外省略)
//
// 1. 丢掉空 / 纯空白(含 NBSP)/ 只含零宽格式字符的**文本节点**
// 2. 丢掉「没有名字且没有子节点」的 `container`
// 3. 「没有名字的 container 只剩一个子节点」→ 用那个子节点**替换**它
// 4. **保留**:有名字的、带 ref 的 container;`image` / `svg_root` / `canvas` /
//    `iframe` / `root` / list item / table cell
// 5. 化简**不得**改变剩余节点的顺序、ref、stable locator、URL、iframe 边界
// 6. **绝不**因为「不可交互」或「父容器被化简」而删掉**非空的**页面文本
//
// 规则 6 是最容易违反的一条:一旦"顺手"把看起来没用的文本删掉,
// 就会撞上上游「绝不删非空页面文本」的红线。所以下面的实现里,
// **非空 text 节点没有任何一条路径可以丢掉**。

/** 空白:含 NBSP(`\u00A0`)与各种 Unicode 空格。 */
const WHITESPACE = /^[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]*$/;

/**
 * 零宽格式字符:零宽空格 / 非连接符 / 连接符 / 词连接符 / BOM / 软连字符。
 * 这些字符**看起来是空的**,检测站会把它们当作"有文本"从而影响可比性。
 */
const ZERO_WIDTH = /^[\u200B\u200C\u200D\u2060\uFEFF\u00AD]*$/;

/** 文本是否"等于没有"。 */
export function isBlankText(s) {
  if (typeof s !== "string") return true;
  return s.length === 0 || WHITESPACE.test(s) || ZERO_WIDTH.test(s);
}

/**
 * 按 §4.1 规则 4 必须保留的角色 —— 即便没有名字、只有一个子节点,
 * 也**不许**被替换/丢掉。理由:它们是结构标记,少了 agent 就看不出边界。
 */
const STRUCTURAL_ROLES = new Set([
  "root",
  "image",
  "svg_root",
  "canvas",
  "iframe",
  "list_item",
  "table_cell",
  "table_row",
  "table",
]);

/** 只有这个角色会被规则 2 / 3 化简。 */
const SIMPLIFIABLE_ROLE = "container";

/**
 * CDP `Accessibility.getFullAXTree` 的扁平行 → 规范形状的树。
 *
 * 规范形状(后面所有函数都基于它):
 * `{ role, name, backendNodeId, children: [] }`
 *
 * - `role` 用 `roleToToken` 的结果(与渲染层同一套词汇)
 * - `backendNodeId` 是 ref 的来源,用于"同一性"校验
 * - **以 `childIds` 为准重建父子关系**,不用数组顺序(顺序可能变)
 * - `ignored: true` 且无子节点的节点直接不进树
 *
 * @param {Array} nodes
 * @param {(role:string, node:object)=>string} roleToToken
 */
export function normalizeAxNodes(nodes, roleToToken) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { root: null, byBackendNodeId: new Map() };
  }
  const raw = new Map();
  for (const n of nodes) {
    if (n?.nodeId !== undefined) raw.set(n.nodeId, n);
  }
  const childIdsOf = (n) => (Array.isArray(n?.childIds) ? n.childIds : []);

  // 根:没有任何节点把它当子节点的那个
  const isChild = new Set();
  for (const n of raw.values()) for (const c of childIdsOf(n)) isChild.add(c);
  const rootRaw = [...raw.values()].find((n) => !isChild.has(n.nodeId)) ?? nodes[0];

  const seen = new Set();
  const byBackendNodeId = new Map();

  function build(n) {
    const kids = childIdsOf(n);
    const name = typeof n.name?.value === "string" ? n.name.value : "";
    const role = roleToToken(n.role?.value, n);
    const backendNodeId = Number.isFinite(n.backendDOMNodeId) ? n.backendDOMNodeId : null;

    // `ignored` 且没有子节点 → 不进树(§4.1 规则 1 的近亲:AX 树里的噪声)
    if (n.ignored && kids.length === 0) return null;

    seen.add(n.nodeId);
    // `refId` 是**快照自己分配的** ref(§4.2 那一步),不是 `backendDOMNodeId`。
    // 二者不能混:每个 DOM 节点都有 backendDOMNodeId,而 ref 只给可寻址节点 ——
    // 混了的话 §4.1 规则 3("无名且单子节点的 container 用子节点替换")**永不触发**。
    const refId = Number.isFinite(n.refId) ? n.refId : null;
    const node = { role, name, backendNodeId, refId, children: [] };
    if (backendNodeId !== null && !byBackendNodeId.has(backendNodeId)) {
      byBackendNodeId.set(backendNodeId, node);
    }
    for (const cid of kids) {
      const cn = raw.get(cid);
      if (!cn || seen.has(cid)) continue;
      const child = build(cn);
      if (child) node.children.push(child);
    }
    return node;
  }

  const root = build(rootRaw);
  return { root, byBackendNodeId };
}

/**
 * §4.1 文本化简。**纯粹、幂等、不丢非空文本。**
 *
 * @param {object|null} node 规范形状的节点
 * @returns {object|null} 化简后的节点(可能是**子节点本身**,见规则 3)
 */
export function simplifyTree(node) {
  if (!node) return null;

  const kids = [];
  for (const c of node.children ?? []) {
    const s = simplifyTree(c);
    if (s) kids.push(s); // 规则 5:顺序 = 原顺序(kids 是顺序遍历出来的)
  }

  // 规则 1:丢掉"等于没有"的**文本**节点
  if (node.role === "text" && isBlankText(node.name)) return null;

  if (node.role !== SIMPLIFIABLE_ROLE) {
    // 规则 4:结构性角色即使空也留下(setAutoAttach 之外:它们标记边界)
    return { ...node, children: kids };
  }

  // —— 以下是 container 专属 ——
  const named = typeof node.name === "string" && node.name.length > 0;
  // 规则 4 的「带 ref」= 快照分配的 `refId`,**不是** `backendDOMNodeId`(后者人人都有)
  const hasRef = node.refId !== null && node.refId !== undefined;

  // 规则 4:有名字 / 带 ref 的 container 一律保留
  if (named || hasRef) return { ...node, children: kids };

  // 规则 2:没有名字且没有子节点 → 丢掉
  if (kids.length === 0) return null;

  // 规则 3:没有名字且只剩一个子节点 → 用那个子节点**替换**它
  //   注意:替换的是"这一个 container"本身,它的子节点**没有**被丢;
  //   子树里的 backendNodeId 全部原样带着 → ref 仍解析到同一节点
  if (kids.length === 1) return kids[0];

  return { ...node, children: kids };
}

/**
 * 渲染成**结构化行**:每行带上它来自哪个节点、多深、父行是哪一行。
 *
 * 为什么需要:超预算时要「按重要性挑行保留」,而挑行必须知道每行的身份和祖先链 ——
 * 只拿到拼好的字符串就只能一刀切。
 */
export function renderSimplifiedLines(root, { indent = 2, maxDepth = 64 } = {}) {
  const out = [];
  const walk = (n, depth, parent) => {
    if (!n) return;
    const pad = " ".repeat(indent * depth);
    // `root` 的 AX 名字就是文档标题,而标题已经在**首行头**里了 ——
    // ego 的实测输出是裸 `root`(见 §4.3)。再打一次就是重复信息。
    const showName = n.role !== "root" && typeof n.name === "string" && n.name.length > 0;
    const idx = out.length;
    out.push({
      text: showName ? `${pad}${n.role} ${JSON.stringify(n.name)}` : `${pad}${n.role}`,
      depth,
      role: n.role,
      name: typeof n.name === "string" ? n.name : "",
      hasRef: Number.isFinite(n.refId),
      refId: Number.isFinite(n.refId) ? n.refId : null,
      parent, // 父行下标;-1 = 无父
    });
    // 深度上限:某些页面的 AX 树极深,防御性截断(与旧实现一致)
    if (depth + 1 >= maxDepth) return;
    for (const c of n.children ?? []) walk(c, depth + 1, idx);
  };
  walk(root, 0, -1);
  return out;
}

export function renderSimplified(root, opts) {
  return renderSimplifiedLines(root, opts)
    .map((l) => l.text)
    .join("\n");
}

/** 树里全部 (role, name, backendNodeId) 三元组,按**先根序**。验收对账用。 */
export function flattenTree(root) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    out.push({ role: n.role, name: n.name, backendNodeId: n.backendNodeId });
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/**
 * 全部"非空页面文本"及其所在节点 —— 用于证明规则 6 没被违反。
 * 只看**文本节点**(`text` / `heading` 等带名字的),空的不算。
 */
export function collectNonEmptyText(root) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (typeof n.name === "string" && n.name.length > 0 && !isBlankText(n.name)) {
      out.push({ role: n.role, name: n.name, backendNodeId: n.backendNodeId });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

// ---- §4.4 stable locator 的唯一性与同一性 -----------------------------------

/**
 * §4.4:
 *   * 匹配 0 个 → 无效
 *   * 匹配多个 → 无效
 *   * 唯一匹配到**不同** `backendNodeId` → 无效
 *   * 建立不了唯一性和同一性时**省略 locator**;`content` 里**不许**出现
 *     `loc=unstable` / `loc=ambiguous` 这类状态串
 *
 * @param {{matches:Array<{backendNodeId:number}>, expectBackendNodeId:number}} o
 * @returns {{ok:true, backendNodeId:number} | {ok:false, reason:string}}
 */
export function validateLocator({ matches, expectBackendNodeId } = {}) {
  const ms = Array.isArray(matches) ? matches : [];
  if (ms.length === 0) return { ok: false, reason: "no-match" };
  if (ms.length > 1) return { ok: false, reason: "ambiguous" };
  const got = ms[0]?.backendNodeId;
  if (got !== expectBackendNodeId) {
    return { ok: false, reason: "different-node" };
  }
  return { ok: true, backendNodeId: got };
}

/**
 * 把 locator 结果渲染成 `content` 里该出现的样子。
 *
 * @returns {string} 有效 → `loc=<backendNodeId>`;无效 → **空串**
 *   (空串而不是 `loc=unstable`:§4.4 明令 content 里不许出现状态串)
 */
export function renderLocator(verdict) {
  return verdict?.ok ? `loc=${verdict.backendNodeId}` : "";
}

/** 违禁状态串 —— 有专门测试守着,防止有人"顺手"打出来。 */
export const FORBIDDEN_LOCATOR_STRINGS = Object.freeze(["loc=unstable", "loc=ambiguous", "loc=unknown"]);
