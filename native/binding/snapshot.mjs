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

import { normalizeAxNodes, simplifyTree, renderSimplifiedLines } from "./snapshot-simplify.mjs";
import { createRefAllocator, assignRefs, INTERACTIVE_ROLES } from "./snapshot-refs.mjs";

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

/**
 * CDP 的 role 值 → ego 风格的角色 token。
 *
 * `tagName` 只在**列表**这一处有用:CDP 的 `list` 角色**不携带有序/无序信息**,
 * 真正决定它的是 DOM 标签(`OL` / `UL`)。以前我们一律兜底成 `unordered_list`,
 * 那是**在不知道的时候装懂** —— 有序列表会被标错。现在:
 *   * 知道标签 → `ordered_list` / `unordered_list`
 *   * 不知道   → `list`(诚实的中性 token)
 *
 * @param {string} role
 * @param {{tagName?: string}} [hint]
 */
export function roleToToken(role, hint = {}) {
  if (typeof role !== "string" || role.length === 0) return "unknown";
  const alias = ROLE_ALIASES.get(role);
  if (alias) return alias;
  if (role === "list" || role === "List") {
    const tag = typeof hint?.tagName === "string" ? hint.tagName.toUpperCase() : "";
    if (tag === "OL") return "ordered_list";
    if (tag === "UL") return "unordered_list";
    return "list"; // 不知道有序无序就别编
  }
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
function buildPipeline(nodes, { frameId = null, tagNameOf = null } = {}) {
  // 列表的有序/无序只能从 DOM 标签看出来(`OL`/`UL`);调用方若给了映射就用,
  // 没给就退到中性 token `list` —— 不假装知道(见 `roleToToken` 的注释)。
  const tokenOf =
    typeof tagNameOf === "function"
      ? (role, n) => roleToToken(role, { tagName: tagNameOf(n?.backendDOMNodeId) })
      : roleToToken;
  const { root } = normalizeAxNodes(nodes, tokenOf);
  if (!root) return null;
  const allocator = createRefAllocator();
  const withRefs = assignRefs(root, { allocator, frameId });
  return { simplified: simplifyTree(withRefs), allocator };
}

/** 可交互角色 —— 这些是 agent 真正能**动手**的节点,预算紧张时优先保。
 *  清单的**唯一来源**是 `snapshot-refs.mjs`(它决定谁拿 ref);这里只做查表,
 *  另抄一份迟早会漂。 */
const INTERACTIVE = new Set(INTERACTIVE_ROLES);

/**
 * 一行快照的"重要性"。数字只用于**相对排序**,绝对值无意义。
 *
 * 排序依据是「agent 拿这条能做什么」:
 *   1. `root` —— 没有它整棵树没有归属
 *   2. **带 ref 的可交互节点** —— 能点、能输入,是行动入口
 *   3. `heading` —— 页面结构的骨架
 *   4. 有内容的 `text` —— 内容本身,**越长越可能是正文**
 *   5. 有名字的结构节点(列表项、表格行、段落)
 *   6. 无名 `container` —— 纯包装,信息量最低
 */
function scoreLine(l) {
  if (l.role === "root") return 1000;
  if (l.hasRef && INTERACTIVE.has(l.role)) return 900;
  if (l.role === "heading") return 820;
  if (l.role === "text") return 700 + Math.min(l.name.length, 300) / 10;
  if (INTERACTIVE.has(l.role)) return 600;
  if (l.name) return 420;
  if (l.role === "container") return 100;
  return 200;
}

/**
 * 在预算内**按重要性挑选**要保留的行,而不是从头一刀切。
 *
 * 三个必须一起满足的性质:
 *   * **不超预算** —— 调用方给了 `maxResultLength` 就是硬上限
 *   * **保留祖先链** —— 子节点孤零零出现会让人误判层级
 *   * **原顺序输出** —— 挑出来的行必须还在它原来的位置,否则树就读不通了
 *
 * 被丢掉的位置会写 `...(省略 N 行)`,**明说省略了多少** —— 静默丢内容
 * 会让 agent 以为自己看到了全貌。
 */
export function selectByImportance(lines, budget) {
  const join = (ls) => ls.map((l) => l.text).join("\n");
  if (join(lines).length <= budget) return { text: join(lines), keptLines: lines };

  const keep = new Array(lines.length).fill(false);
  let used = 0;
  // 给省略标记留位(最多几十个标记,64 字够)
  const reserve = 64;
  const byScore = lines
    .map((l, i) => i)
    .sort((a, b) => scoreLine(lines[b]) - scoreLine(lines[a]) || a - b);

  for (const i of byScore) {
    // 需要一起保留的:自己 + 尚未保留的祖先链
    const need = [];
    for (let j = i; j >= 0 && !keep[j]; j = lines[j].parent) need.push(j);
    let cost = 0;
    for (const j of need) cost += lines[j].text.length + 1;
    if (used + cost + reserve > budget) continue;
    for (const j of need) keep[j] = true;
    used += cost;
  }

  // 连 root 都放不下 —— 退回到"至少给你看个开头"
  if (!keep.some(Boolean)) {
    return {
      text: `${join(lines).slice(0, Math.max(0, budget))}\n...(快照被 maxResultLength 截断)`,
      keptLines: [],
    };
  }

  const out = [];
  const keptLines = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (skipped > 0) {
        out.push(`...(省略 ${skipped} 行)`);
        skipped = 0;
      }
      out.push(lines[i].text);
      keptLines.push(lines[i]);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) out.push(`...(省略 ${skipped} 行)`);
  return { text: out.join("\n"), keptLines };
}

/**
 * 把 CDP 的 AX 树渲染成缩进文本。
 *
 * @param {Array} nodes `Accessibility.getFullAXTree` 的 `nodes`
 * @param {object} [opts]
 * @param {number} [opts.maxLength] 结果上限;超了**按重要性挑行**,不是从头砍
 * @param {number} [opts.maxDepth]  深度上限(防御性:某些页面 AX 树极深)
 * @param {string|null} [opts.frameId] 这棵树属于哪个 frame
 * @param {((backendNodeId:number)=>string|null)} [opts.tagNameOf]
 *        可选的 DOM 标签解析器 —— 只用于区分 `ordered_list` / `unordered_list`
 */
export function renderAxTree(
  nodes,
  { maxLength = MAX_DEFAULT, maxDepth = 64, frameId = null, tagNameOf = null } = {},
) {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";

  // 三段式:`规范形状 → 分配 ref → §4.1 化简 → 缩进渲染`。
  // 以前这里是一趟自带"跳过空叶子"逻辑的遍历 —— 那等于把 §4.1 的规则
  // **隐式**写在渲染里,既测不了也改不动。规则现在集中在 `snapshot-simplify.mjs`。
  const built = buildPipeline(nodes, { frameId, tagNameOf });
  if (!built?.simplified) return "";

  return selectByImportance(renderSimplifiedLines(built.simplified, { maxDepth }), maxLength).text;
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
export async function buildSnapshot({
  cdp,
  header,
  options = {},
  timeoutMs = 15_000,
  frameId = null,
  tagNameOf = null,
}) {
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
  const built = buildPipeline(res?.nodes ?? [], { frameId, tagNameOf });
  if (!built?.simplified) return { content: header ?? "", refs: {} };

  // 预算要把**首行头**算进去,否则头一长正文就超
  const headerCost = header ? header.length + 1 : 0;
  const sel = selectByImportance(
    renderSimplifiedLines(built.simplified, { maxDepth: 64 }),
    Math.max(0, maxLength - headerCost),
  );
  const content = header ? `${header}\n${sel.text}` : sel.text;

  // **只留下快照里真出现的 ref** —— 内容里没有的节点,给了 ref 也没法点,
  // 留着只会让调用方以为那个节点可见。
  const keptRefs = new Set(sel.keptLines.map((l) => l.refId).filter((r) => r !== null));
  const all = built.allocator.snapshot();
  const refs = {};
  for (const [k, v] of Object.entries(all)) {
    if (keptRefs.has(Number(k))) refs[k] = v;
  }
  return { content, refs };
}
