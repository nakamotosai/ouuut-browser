// native/binding/snapshot.test.mjs —— 快照的**预算策略**与**角色诚实度**
//
// 这里守两件事:
//   1. `maxResultLength` 是「**按重要性挑行**」,不是从头一刀切。
//      理由:一刀切会把页面末尾的按钮/输入框整段砍掉 —— 那正是 agent 要动手的地方。
//   2. 列表的**有序/无序**不许装懂。CDP 的 `list` 角色不携带这个信息,
//      以前一律兜底成 `unordered_list`,有序列表就被标错了。

import test from "node:test";
import assert from "node:assert/strict";

import { renderAxTree, selectByImportance, roleToToken } from "./snapshot.mjs";

// ---- 构造 AX 节点的小工具 -------------------------------------------------

let seq = 1;
const INTERACTIVE_ROLES = new Set([
  "button", "textbox", "anchor", "combobox", "searchbox", "checkbox",
  "radio", "switch", "slider", "tab", "menuitem", "canvas", "image",
]);
let backendId = 1000;
const ax = (role, name, extra = {}) => ({
  nodeId: `n${seq++}`,
  role: { value: role },
  name: { value: name },
  // 真实 AX 节点都带 backendDOMNodeId —— 没有它就**没法寻址**,不给 ref 是对的。
  // 夹具必须照着真实形状造,否则测出来的是假绿。
  ...(INTERACTIVE_ROLES.has(role) ? { backendDOMNodeId: backendId++ } : {}),
  ...extra,
});

/** 把 [{node, children:[...]}] 摊平成 CDP 的扁平行(带 childIds)。 */
function flatten(spec) {
  const out = [];
  const walk = (s) => {
    const kids = (s.children ?? []).map(walk);
    out.push({ ...s.node, childIds: kids.map((k) => k.nodeId) });
    return out[out.length - 1];
  };
  const root = walk(spec);
  return { nodes: out, root };
}

const line = (text, parent, extra = {}) => ({
  text,
  depth: 0,
  role: "container",
  name: "",
  hasRef: false,
  refId: null,
  parent,
  ...extra,
});

// ---- 1. 列表角色:不知道就别装懂 -------------------------------------------

test("roleToToken:OL → ordered_list,UL → unordered_list", () => {
  assert.equal(roleToToken("list", { tagName: "OL" }), "ordered_list");
  assert.equal(roleToToken("list", { tagName: "ul" }), "unordered_list");
});

test("★ roleToToken:拿不到标签时给中性的 `list`,**不许**假装是无序列表", () => {
  assert.equal(roleToToken("list"), "list");
  assert.equal(roleToToken("list", { tagName: "DIV" }), "list");
  assert.equal(roleToToken("list", {}), "list");
});

test("★ renderAxTree:给了 tagNameOf 就能把 <ol> 标成 ordered_list", () => {
  const { nodes } = flatten({
    node: ax("RootWebArea", "标题"),
    children: [
      { node: ax("list", "", { backendDOMNodeId: 11 }), children: [{ node: ax("listitem", "一") }] },
      { node: ax("list", "", { backendDOMNodeId: 12 }), children: [{ node: ax("listitem", "二") }] },
    ],
  });
  // 只有 11 是 OL
  const tags = new Map([
    [11, "OL"],
    [12, "UL"],
  ]);
  const text = renderAxTree(nodes, { maxLength: 100_000, tagNameOf: (id) => tags.get(id) ?? null });
  assert.match(text, /ordered_list/, "OL 必须标成 ordered_list");
  assert.match(text, /unordered_list/, "UL 必须标成 unordered_list");
  assert.ok(!/^\s*list$/m.test(text), "两个都解析出来了,不该再有裸 list");
});

test("★ renderAxTree:没给 tagNameOf 时不许输出 unordered_list", () => {
  const { nodes } = flatten({
    node: ax("RootWebArea", "标题"),
    children: [{ node: ax("list", "", { backendDOMNodeId: 11 }), children: [{ node: ax("listitem", "一") }] }],
  });
  const text = renderAxTree(nodes, { maxLength: 100_000 });
  assert.match(text, /^\s*list$/m, "应输出中性 token list");
  assert.ok(!/unordered_list/.test(text), "不知道有序无序就不许说 unordered_list");
});

// ---- 2. 预算:按重要性挑,不是一刀切 ---------------------------------------

test("★ selectByImportance:预算够时**逐字节等于**原样拼接(不做任何挑选)", () => {
  const lines = [line("root", -1, { role: "root" }), line("  container", 0)];
  const sel = selectByImportance(lines, 10_000);
  assert.equal(sel.text, lines.map((l) => l.text).join("\n"));
  assert.equal(sel.keptLines.length, lines.length);
});

test("★ selectByImportance:超预算时保住**可交互节点**,丢掉冗长文本", () => {
  const long = "x".repeat(400);
  const lines = [
    line("root", -1, { role: "root" }),
    line("  container", 0),
    line(`    text "${long}"`, 1, { role: "text", name: long }),
    line('    button "提交"', 1, { role: "button", name: "提交", hasRef: true, refId: 7 }),
  ];
  const sel = selectByImportance(lines, 120);

  assert.match(sel.text, /button "提交"/, "按钮必须活下来 —— 那是 agent 能动手的地方");
  assert.ok(!sel.text.includes(long), "冗长文本应该被丢掉");
  assert.match(sel.text, /\.\.\.\(省略 \d+ 行\)/, "必须明说省略了多少行,不许静默丢");
  assert.ok(sel.text.length <= 120, `不许超预算(实际 ${sel.text.length})`);
});

test("★ selectByImportance:保住子节点时**必须连祖先一起保**(否则层级读不通)", () => {
  const long = "y".repeat(400);
  const lines = [
    line("root", -1, { role: "root" }),
    line("  container", 0),
    line("    container", 1),
    line(`      text "${long}"`, 2, { role: "text", name: long }),
    line('      button "Go"', 2, { role: "button", name: "Go", hasRef: true, refId: 3 }),
  ];
  const sel = selectByImportance(lines, 160);
  const kept = sel.keptLines.map((l) => l.text);
  assert.ok(kept.includes('      button "Go"'));
  // 两级祖先都在,且顺序是原序
  assert.deepEqual(kept, ["root", "  container", "    container", '      button "Go"']);
});

test("★ selectByImportance:挑出来的行必须还在**原来的位置**(顺序不变)", () => {
  const lines = [
    line("root", -1, { role: "root" }),
    line('  heading "标题"', 0, { role: "heading", name: "标题" }),
    line(`  text "${"z".repeat(500)}"`, 0, { role: "text", name: "z".repeat(500) }),
    line('  button "末"', 0, { role: "button", name: "末", hasRef: true, refId: 9 }),
  ];
  const sel = selectByImportance(lines, 120);
  const idx = sel.keptLines.map((l) => lines.indexOf(l));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "保持原序");
  assert.ok(sel.text.indexOf("heading") < sel.text.indexOf("button"), "标题在按钮之前");
});

test("★ selectByImportance:省略标记里的数字必须**准**", () => {
  const lines = [
    line("root", -1, { role: "root" }),
    line(`  text "${"q".repeat(300)}"`, 0, { role: "text", name: "q".repeat(300) }),
    line(`  text "${"r".repeat(300)}"`, 0, { role: "text", name: "r".repeat(300) }),
    line('  button "B"', 0, { role: "button", name: "B", hasRef: true, refId: 1 }),
  ];
  const sel = selectByImportance(lines, 120);
  const m = sel.text.match(/\.\.\.\(省略 (\d+) 行\)/);
  assert.ok(m, "要有省略标记");
  const omitted = Number(m[1]);
  assert.equal(omitted, lines.length - sel.keptLines.length, "标记的数字要等于真被丢掉的条数");
});

test("★ selectByImportance:连 root 都放不下时,退回截断并**明说**被截断", () => {
  const lines = [line("root", -1, { role: "root" }), line(`  text "${"w".repeat(500)}"`, 0)];
  const sel = selectByImportance(lines, 8);
  assert.match(sel.text, /快照被 maxResultLength 截断/);
  assert.equal(sel.keptLines.length, 0);
});

// ---- 3. 端到端:真的走一遍 AX 树 ------------------------------------------

test("★ renderAxTree:超预算时页面末尾的按钮仍在,冗长正文被让位", () => {
  const longText = "很长的正文".repeat(60);
  const children = [];
  for (let i = 0; i < 12; i++) children.push({ node: ax("StaticText", `${longText}${i}`) });
  children.push({ node: ax("button", "确认下单", { backendDOMNodeId: 900 }) });

  const { nodes } = flatten({
    node: ax("RootWebArea", "商店"),
    children: [{ node: ax("generic", ""), children }],
  });

  const text = renderAxTree(nodes, { maxLength: 400 });
  assert.match(text, /确认下单/, "预算再紧也要保住可交互节点");
  assert.match(text, /\.\.\.\(省略 \d+ 行\)/, "要说明省略了多少");
  assert.ok(text.length <= 400, `不许超预算(实际 ${text.length})`);
});
