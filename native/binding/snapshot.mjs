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
//   * `ref` / `loc=` 选择器**编号**(§4.5):需要跨 frame 唯一编号与"同一性"校验。
//     —— **join 点已经就位**:`snapshot-simplify.mjs` 的 `validateLocator()` 实现了
//     §4.4 的唯一性/同一性判定(0 个、多个、唯一但不同节点 → 一律省略 locator,
//     绝不打 `loc=unstable` 这类状态串),`simplifyTree` 也已经把 `refId` 当作
//     "必须保留的 container"的判据。缺的只是**分配** refId 那一步(§4.2 的跨 renderer 编号)
//   * `maxResultLength` 目前的实现是**截断**,不是"按重要性选择要保留哪些节点"
//   * §4.2 的跨 renderer `refId` 分配(iframe 里的可操作节点)未做
//
// §4.1 的**文本化简已做**,在 `snapshot-simplify.mjs`(独立、纯粹、可脱离 CDP 测)

import { normalizeAxNodes, simplifyTree, renderSimplified } from "./snapshot-simplify.mjs";
import { createRefAllocator, assignRefs } from "./snapshot-refs.mjs";

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
 * 从 CDP 的 AX 扁平行走到"可渲染的简化树 + ref 分配器"。
 *
 * `renderAxTree` 与 `buildSnapshot` **共用**这一条流程 —— 两条路各写一遍的话,
 * §4.1 规则 4(带 ref 的 container 要保留)会在其中一条里悄悄失效。
 *
 * 顺序有讲究:**先分配 ref,再化简**。反过来的话化简时看不到 ref,
 * 那条"保留带 ref 的 container"就永远不触发。
 */
function buildPipeline(nodes, { frameId = null } = {}) {
  const { root } = normalizeAxNodes(nodes, roleToToken);
  if (!root) return null;
  const allocator = createRefAllocator();
  const withRefs = assignRefs(root, { allocator, frameId });
  return { simplified: simplifyTree(withRefs), allocator };
}

/**
 * 把 CDP 的 AX 树渲染成缩进文本。
 *
 * @param {Array} nodes `Accessibility.getFullAXTree` 的 `nodes`
 * @param {object} [opts]
 * @param {number} [opts.maxLength] 结果上限(超过就截断,并明说截断了)
 * @param {number} [opts.maxDepth]  深度上限(防御性:某些页面 AX 树极深)
 * @param {string|null} [opts.frameId] 这棵树属于哪个 frame
 */
export function renderAxTree(nodes, { maxLength = MAX_DEFAULT, maxDepth = 64, frameId = null } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";

  // 三段式:`规范形状 → 分配 ref → §4.1 化简 → 缩进渲染`。
  // 以前这里是一趟自带"跳过空叶子"逻辑的遍历 —— 那等于把 §4.1 的规则
  // **隐式**写在渲染里,既测不了也改不动。规则现在集中在 `snapshot-simplify.mjs`。
  const built = buildPipeline(nodes, { frameId });
  if (!built?.simplified) return "";

  let text = renderSimplified(built.simplified, { maxDepth });
  if (text.length > maxLength) {
    // **明说被截断了** —— 静默截断会让 agent 以为自己看到了全貌
    text = text.slice(0, maxLength) + "\n...(快照被 maxResultLength 截断)";
  }
  return text;
}

/**
 * 完整快照:`{content, refs}`。**对象,不是字符串** ——
 * 压缩是 JS 侧(harness)做的,见 `native/README.md` §二.2。
 *
 * 流程:`规范形状 → 分配 ref(§4.2)→ §4.1 化简 → 缩进渲染`。
 *
 * **分配必须在化简之前**:§4.1 规则 4 要"保留**带 ref 的** container" ——
 * 先化简的话那个判据永远看不到 ref,规则就死了。
 *
 * @param {object} o
 * @param {string|null} [o.frameId] 这棵 AX 树属于哪个 frame(OOPIF 用它的 target id)
 */
export async function buildSnapshot({ cdp, header, options = {}, timeoutMs = 15_000, frameId = null }) {
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
  const built = buildPipeline(res?.nodes ?? [], { frameId });
  if (!built?.simplified) return { content: header ?? "", refs: {} };

  const body = renderSimplified(built.simplified, { maxDepth: 64 }).slice(0, maxLength);
  const content = header ? `${header}\n${body}` : body;
  return { content, refs: built.allocator.snapshot() };
}
