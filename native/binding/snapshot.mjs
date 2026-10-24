// native/binding/snapshot.mjs —— 语义快照:内核侧生成,**不注入页面 JS**
//
// 对应 `docs/原生层接口.md` §四。这是产品里「最值钱的部分」,本片是**第一刀**:
// 用 CDP 的 `Accessibility.getFullAXTree`(内核已经算好的 a11y 树)拼成纯文本,
// 格式对齐 ego 的**实测输出**(见 `docs/原生层接口.md` §4.3):
//
//   [p2 "Example Domain" | space "ouuut-m2-smoke"(43): 2 managed, 0 untracked — p1 "新标签页", p2* "Example Domain"]
//   root
//     svg_root
//     paragraph
//       text "该域名仅用于文档示例..."
//
// 要点(逐条对得上实测):
//   * 首行是**任务空间/页面头** —— agent 一眼看到「我在哪个空间、开了哪些页」,当前页带 `*`
//   * 主体是**两空格缩进**的角色树,角色名小写、空格换下划线(`svgRoot` → `svg_root`)
//   * 叶子形如 `text "<页面原文>"` —— **页面文本原样保留**,不做总结
//
// ## 为什么用 `Accessibility.getFullAXTree` 而不是 `Runtime.evaluate` 注入 JS
//
// 上游明确要求「**不注入页面 JS**」(ADR-005 的靶心之一)。a11y 树是内核自己算的,
// 拿它不需要往页面里塞任何东西 —— 这也是 ego 那条路线的关键。
//
// ## 这一刀**没做**的(不掩饰)
//
//   * `ref` / `loc=` 选择器编号:需要跨 frame 唯一编号与"同一性"校验(§4.5),
//     属 is 独立一片
//   * 文本化简的完整规则(§4.1 说在内核侧做)
//   * `maxResultLength` 目前的实现是**截断**,不是"按重要性选择要保留哪些节点"

const MAX_DEFAULT = 20_000;

/**
 * CDP 的 a11y 角色名 → ego 快照里实际用的 token。
 *
 * **这张表是采出来的,不是猜的**:跑 `native/smoke/harvest-roles.mjs` 在 ego 上
 * 采了 3 个页面(example.com / iana.org / MDN button),得到 16 个实际出现过的 token:
 *
 *   root  svg_root  paragraph  text  anchor  container  image  unordered_list
 *   list_item  ordered_list  heading  table  table_row  table_cell  button  textbox
 *
 * 要点:这不是驼峰转换。CDP 说 `RootWebArea`/`StaticText`,ego 说 `root`/`text`;
 * CDP 说 `link`,ego 说 `anchor`;CDP 说 `generic`,ego 说 `container`。
 */
const ROLE_ALIASES = new Map([
  ["RootWebArea", "root"],
  ["rootwebarea", "root"],
  ["StaticText", "text"],
  ["InlineTextBox", "text"],
  ["link", "anchor"],
  ["generic", "container"],
  ["GenericContainer", "container"],
  ["image", "image"],
  ["img", "image"],
  ["Image", "image"],
  ["listitem", "list_item"],
  ["ListItem", "list_item"],
  ["row", "table_row"],
  ["cell", "table_cell"],
  ["textbox", "textbox"],
  ["searchbox", "searchbox"],
  ["combobox", "combobox"],
]);

/** CDP 的 role 值 → ego 风格的角色 token。 */
export function roleToToken(role) {
  if (typeof role !== "string" || role.length === 0) return "unknown";
  const alias = ROLE_ALIASES.get(role);
  if (alias) return alias;
  // 兜底:驼峰/空格 → 下划线小写(`svgRoot` → `svg_root`)
  return role
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * 首页那一行。形状取自实测输出。
 * @param {object} o
 * @param {string} o.label      当前页的 label(如 `p2`)
 * @param {string} o.title      页面标题
 * @param {object} o.space      任务空间(可空)
 * @param {Array}  o.tabs       `[{label, title, active}]`
 */
export function buildHeader({ label, title, space, tabs = [] }) {
  const spacePart = space ? `space "${space.name}"(${space.id}):` : "space <none>:";
  const managed = tabs.length;
  const tabList = tabs
    .map((t) => `${t.label}${t.active ? "*" : ""} "${t.title ?? ""}"`)
    .join(", ");
  const head = `[${label ?? "p?"} "${
    title ?? ""
  }" | ${spacePart} ${managed} managed, 0 untracked${tabList ? ` — ${tabList}` : ""}]`;
  return head;
}

/**
 * 把 CDP 的 AX 树渲染成缩进文本。
 *
 * @param {Array} nodes `Accessibility.getFullAXTree` 的 `nodes`
 * @param {object} [opts]
 * @param {number} [opts.maxLength] 结果上限(超过就截断,并明说截断了)
 * @param {number} [opts.maxDepth]  深度上限(防御性:某些页面 AX 树极深)
 */
export function renderAxTree(nodes, { maxLength = MAX_DEFAULT, maxDepth = 64 } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";

  const byId = new Map();
  for (const n of nodes) if (n?.nodeId) byId.set(n.nodeId, n);

  // `getFullAXTree` 一般是先根后子的扁平序;但仍以 childIds 为准重新走一遍,
  // 这样即使顺序变了也不受影响。
  const childIdsOf = (n) => (Array.isArray(n?.childIds) ? n.childIds : []);
  const root = nodes.find((n) => !nodes.some((m) => childIdsOf(m).includes(n.nodeId))) ?? nodes[0];

  const lines = [];
  const seen = new Set();
  let truncated = false;

  const walk = (node, depth) => {
    if (truncated || !node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);

    const role = roleToToken(node.role?.value);
    // AX 树里有大量无意义的中间节点,但对齐格式比"聪明地省略"更重要 ——
    // 上游要求**绝不删非空页面文本**,所以这里只跳过完全空且无子节点的叶子。
    const name = typeof node.name?.value === "string" ? node.name.value : "";
    const kids = childIdsOf(node);
    if (node.ignored && kids.length === 0) return;
    if (!name && kids.length === 0 && role !== "root") return;

    const indent = "  ".repeat(depth + 1);
    // `text` 角色是页面原文的载体 —— 原样带引号输出
    const line = name ? `${indent}${role} ${JSON.stringify(name)}` : `${indent}${role}`;
    lines.push(line);

    if (lines.join("\n").length > maxLength) {
      truncated = true;
      return;
    }
    if (depth + 1 < maxDepth) {
      for (const cid of kids) walk(byId.get(cid), depth + 1);
    }
  };

  walk(root, -1); // root 本身在 depth -1 → 它渲染成 0 缩进
  let text = lines.join("\n");
  if (truncated || text.length > maxLength) {
    // **明说被截断了** —— 静默截断会让 agent 以为自己看到了全貌
    text = text.slice(0, maxLength) + "\n…(快照被 maxResultLength 截断)";
  }
  return text;
}

/**
 * 完整快照:`{content, refs}`。**对象,不是字符串** ——
 * 压缩是 JS 侧(harness)做的,见 `native/README.md` §二.2。
 */
export async function buildSnapshot({ cdp, header, options = {}, timeoutMs = 15_000 }) {
  // `maxResultLength` 是 harness 用的名字(`page-model.ts:704` 传 1 做廉价探针)
  const maxLength = Number.isFinite(options?.maxResultLength)
    ? options.maxResultLength
    : MAX_DEFAULT;

  // `maxResultLength: 1` 这类探针:不必去拉整棵 AX 树 —— 快照的唯一目的是
  // 让 user-control 门有机会 reject。少一次 CDP 往返,就少一分被用户察觉的动静。
  if (maxLength <= 8) {
    return { content: (header ? header + "\n" : "").slice(0, maxLength), refs: {} };
  }

  const res = await cdp.send("Accessibility.getFullAXTree", {}, { timeoutMs });
  const body = renderAxTree(res?.nodes ?? [], { maxLength });
  const content = header ? `${header}\n${body}` : body;
  return { content, refs: {} }; // refs 见文件头"没做的"
}
