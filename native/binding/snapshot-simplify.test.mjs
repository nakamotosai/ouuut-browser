// native/binding/snapshot-simplify.test.mjs —— §4.1 化简 + §4.4 locator 的验收
//
//   node --test native/binding/snapshot-simplify.test.mjs
//
// 每条验收都对应 `docs/原生层接口.md` §4.1 / §4.4 的原文,不是我自己加的指标。

import test from "node:test";
import assert from "node:assert/strict";

import { roleToToken } from "./snapshot.mjs";
import {
  normalizeAxNodes,
  simplifyTree,
  renderSimplified,
  flattenTree,
  collectNonEmptyText,
  isBlankText,
  validateLocator,
  renderLocator,
  FORBIDDEN_LOCATOR_STRINGS,
} from "./snapshot-simplify.mjs";

// ---- fixture:构造 CDP 形状的 AX 树 ----------------------------------------

let nextId = 1;
function ax(role, name, children = [], extra = {}) {
  const nodeId = nextId;
  nextId += 1;
  const node = {
    nodeId,
    role: { value: role },
    name: name === null ? undefined : { value: name },
    childIds: [],
    ...extra,
  };
  // `backendDOMNodeId` **只在显式给了才有**(真实 CDP 里也不是每个节点都有);
  // 之前给了默认值,结果每个 container 都"带 ref",规则 3 永不触发 —— 那是 fixture 的错。
  if (extra.backendNodeId !== undefined) node.backendDOMNodeId = extra.backendNodeId;
  if (extra.refId !== undefined) node.refId = extra.refId;
  for (const c of children) node.childIds.push(c.nodeId);
  node._kids = children;
  node._flat = [node, ...children.flatMap((c) => c._flat)];
  return node;
}
function flattenRoots(root) {
  return root._flat;
}

function build(root) {
  const nodes = flattenRoots(root).map(({ _kids, _flat, ...n }) => n);
  return normalizeAxNodes(nodes, roleToToken);
}

// ---- 规则 1:空 / 纯空白 / 零宽文本 ----------------------------------------

test("isBlankText:空、空白、NBSP、零宽都算空", () => {
  for (const s of ["", " ", "\t", "\n", "\u00A0", "\u3000", "\u200B", "\uFEFF", "\u200B\u200C", "\u00AD"]) {
    assert.equal(isBlankText(s), true, JSON.stringify(s));
  }
  for (const s of ["a", " a ", "。", "0", "\u00A0a"]) {
    assert.equal(isBlankText(s), false, JSON.stringify(s));
  }
  assert.equal(isBlankText(undefined), true);
  assert.equal(isBlankText(123), true);
});

test("规则 1:空文本节点被丢掉(含 NBSP 与零宽)", () => {
  const { root } = build(
    ax("RootWebArea", "T", [
      ax("StaticText", "keep"),
      ax("StaticText", " "),
      ax("StaticText", "\u00A0"),
      ax("StaticText", "\u200B\u200C"),
      ax("StaticText", ""),
    ]),
  );
  const s = simplifyTree(root);
  const texts = flattenTree(s).filter((n) => n.role === "text");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].name, "keep");
});

// ---- 规则 2:空 container 被丢掉 -------------------------------------------

test("规则 2:没有名字且没有子节点的 container → 丢掉", () => {
  const { root } = build(ax("RootWebArea", "T", [ax("generic", undefined), ax("StaticText", "x")]));
  const s = simplifyTree(root);
  assert.deepEqual(
    flattenTree(s).map((n) => n.role),
    ["root", "text"],
  );
});

test("规则 4:结构角色**即使空也留下**(少了 agent 就看不出边界)", () => {
  for (const role of ["image", "svgRoot", "canvas", "Iframe", "ListItem", "cell"]) {
    const { root } = build(ax("RootWebArea", "T", [ax(role, undefined)]));
    const s = simplifyTree(root);
    const roles = flattenTree(s).map((n) => n.role);
    assert.equal(roles.length, 2, `${role} 被丢了:${roles}`);
  }
});

test("规则 4:有名字的 container 留下", () => {
  const { root } = build(ax("RootWebArea", "T", [ax("generic", "导航区")]));
  const s = simplifyTree(root);
  const c = flattenTree(s).find((n) => n.role === "container");
  assert.equal(c.name, "导航区");
});

test("规则 4:带 ref 的 container 留下(即使无名、只有一个子节点)", () => {
  const inner = ax("StaticText", "里面的字", [], { backendNodeId: 555 });
  const { root } = build(
    ax("RootWebArea", "T", [ax("generic", undefined, [inner], { refId: 7, backendNodeId: 7777 })]),
  );
  const s = simplifyTree(root);
  const c = flattenTree(s).find((n) => n.role === "container");
  assert.ok(c, "带 ref 的 container 不该被替换掉 —— 否则 agent 手上那个 ref 就悬空了");
  assert.equal(c.backendNodeId, 7777);
});

test("规则 4:没 ref 的 container **会**被替换(对照,证明上一条不是恒真)", () => {
  const inner = ax("StaticText", "里面的字", [], { backendNodeId: 555 });
  const { root } = build(ax("RootWebArea", "T", [ax("generic", undefined, [inner], { backendNodeId: 7777 })]));
  const s = simplifyTree(root);
  assert.equal(
    flattenTree(s).find((n) => n.role === "container"),
    undefined,
    "只有 backendNodeId 不算带 ref",
  );
});

// ---- 规则 3:单子节点 container 被替换 --------------------------------------

test("规则 3:无名且只有一个子节点的 container → 用子节点替换它", () => {
  const { root } = build(
    ax("RootWebArea", "T", [ax("generic", undefined, [ax("StaticText", "只有我")])]),
  );
  const s = simplifyTree(root);
  const roles = flattenTree(s).map((n) => n.role);
  assert.deepEqual(roles, ["root", "text"], "中间那层 container 应该消失,子节点提上来");
});

test("规则 3:**没有丢东西** —— 被替换掉的只有那一层壳", () => {
  const inner = ax("StaticText", "内容");
  const { root } = build(ax("RootWebArea", "T", [ax("generic", undefined, [inner])]));
  const before = flattenTree(simplifyTree(root));
  const s = simplifyTree(root);
  assert.equal(s.children[0].name, "内容");
  assert.equal(before.length, 2);
});

test("规则 3:两个子节点的 container **不**被替换(否则会改变兄弟分组)", () => {
  const { root } = build(
    ax("RootWebArea", "T", [ax("generic", undefined, [ax("StaticText", "a"), ax("StaticText", "b")])]),
  );
  const s = simplifyTree(root);
  assert.deepEqual(
    flattenTree(s).map((n) => n.role),
    ["root", "container", "text", "text"],
  );
});

// ---- 规则 5:顺序 / ref 不变 ------------------------------------------------

test("规则 5:化简不改变剩余节点的**顺序**", () => {
  const { root } = build(
    ax("RootWebArea", "T", [
      ax("StaticText", "1"),
      ax("generic", undefined, [ax("StaticText", "2")]),
      ax("StaticText", "3"),
      ax("StaticText", "   "),
      ax("StaticText", "4"),
    ]),
  );
  const s = simplifyTree(root);
  const texts = flattenTree(s).filter((n) => n.role === "text").map((n) => n.name);
  assert.deepEqual(texts, ["1", "2", "3", "4"]);
});

test("★ 规则 5:每个 ref 化简后仍解析到**同一个** backendNodeId", () => {
  const { root, byBackendNodeId } = build(
    ax("RootWebArea", "T", [
      // 被化简的壳底下也有带 ref 的节点 —— 替换那一层壳不能动到它
      ax("generic", undefined, [ax("StaticText", "深", [], { backendNodeId: 3001 })]),
      ax("button", "按钮", [], { backendNodeId: 4242, refId: 1 }),
      ax("StaticText", "\u00A0"),
      ax("StaticText", "留着", [], { backendNodeId: 3002 }),
    ]),
  );
  assert.ok(byBackendNodeId.size >= 3, "fixture 得真的有几个 backendNodeId");
  const s = simplifyTree(root);
  const after = flattenTree(s);

  // 原树里每个 backendNodeId,化简后要么还在(且角色/名字一致),要么是被"等于没有"的规则丢掉的空白文本
  for (const [bid, orig] of byBackendNodeId) {
    const found = after.find((n) => n.backendNodeId === bid);
    if (!found) {
      assert.equal(orig.role, "text", `非文本节点 ${orig.role}#${bid} 不该消失`);
      assert.ok(isBlankText(orig.name), `非空文本"${orig.name}"#${bid} 不该消失(规则 6)`);
      continue;
    }
    assert.equal(found.role, orig.role, `#${bid} 角色变了`);
    assert.equal(found.name, orig.name, `#${bid} 名字变了`);
  }
  // 明确点一条:在壳被替换的情况下,深层的 ref 依然指向原节点
  assert.ok(after.some((n) => n.backendNodeId === 3001), "被替换容器底下的节点必须还在");
});

// ---- 规则 6:绝不删非空页面文本 ---------------------------------------------

test("★ 规则 6:非空文本**零丢失**(含被化简容器底下的)", () => {
  const { root } = build(
    ax("RootWebArea", "T", [
      ax("generic", undefined, [ax("generic", undefined, [ax("StaticText", "藏在两层壳里")])]),
      ax("paragraph", undefined, [ax("StaticText", "段落里的字")]),
      ax("generic", undefined, []), // 空的,该丢
    ]),
  );
  const s = simplifyTree(root);
  const before = collectNonEmptyText(root).map((x) => x.name);
  const after = collectNonEmptyText(s).map((x) => x.name);
  assert.deepEqual(after, before, "非空文本集合必须完全一致");
  assert.ok(after.includes("藏在两层壳里"), "被化简容器底下的文本不能丢");
});

test("★ 规则 6:纯空白文本不算「页面文本」,可以丢", () => {
  const { root } = build(ax("RootWebArea", "T", [ax("StaticText", "\u00A0\u00A0")]));
  const s = simplifyTree(root);
  assert.equal(
    flattenTree(s).filter((n) => n.role === "text").length,
    0,
    "纯空白文本该被丢掉",
  );
  // root 自己的名字(AX 里就是文档标题)不算"页面文本",它另有用途
  assert.ok(collectNonEmptyText(s).length <= 1, "除了 root 的标题,不该还有别的非空名字");
});

// ---- §4.1 验收:连拍两次逐字节相同 -----------------------------------------

test("★ §4.1 验收:同一 fixture 化简两次,输出**逐字节相同**", () => {
  const mk = () =>
    build(
      ax("RootWebArea", "T", [
        ax("generic", undefined, [ax("StaticText", "a")]),
        ax("paragraph", undefined, [ax("StaticText", "b")]),
        ax("StaticText", "  "),
        ax("button", "点我"),
      ]),
    ).root;
  const one = renderSimplified(simplifyTree(mk()));
  const two = renderSimplified(simplifyTree(mk()));
  assert.equal(one, two);
});

test("★ §4.1 验收:化简是**幂等**的(simplify(simplify(x)) === simplify(x))", () => {
  const { root } = build(
    ax("RootWebArea", "T", [
      ax("generic", undefined, [ax("StaticText", "x")]),
      ax("generic", undefined, [ax("generic", undefined, [ax("StaticText", "y")])]),
      ax("generic", undefined, []),
    ]),
  );
  const once = renderSimplified(simplifyTree(root));
  const twice = renderSimplified(simplifyTree(simplifyTree(root)));
  assert.equal(once, twice, "不幂等 = 反复化简会持续变形");
});

test("★ §4.1 验收:兄弟分组仍可区分(有名字的 container 不被合并)", () => {
  const { root } = build(
    ax("RootWebArea", "T", [
      ax("generic", "组一", [ax("StaticText", "a")]),
      ax("generic", "组二", [ax("StaticText", "b")]),
    ]),
  );
  const text = renderSimplified(simplifyTree(root));
  assert.match(text, /container "组一"/);
  assert.match(text, /container "组二"/);
  assert.equal(text.split("\n").filter((l) => l.includes("container")).length, 2);
});

// ---- 渲染 ------------------------------------------------------------------

test("渲染:root 不缩进,每层两空格,text 带引号原样", () => {
  const { root } = build(
    ax("RootWebArea", "T", [ax("paragraph", undefined, [ax("StaticText", "页面原文 \"引号\" 也在")])]),
  );
  const text = renderSimplified(simplifyTree(root));
  assert.equal(
    text,
    ['root', '  paragraph', '    text "页面原文 \\"引号\\" 也在"'].join("\n"),
  );
});

test("空树 / null 不崩", () => {
  assert.deepEqual(normalizeAxNodes([], roleToToken), { root: null, byBackendNodeId: new Map() });
  assert.equal(simplifyTree(null), null);
  assert.equal(renderSimplified(null), "");
});

// ---- §4.4 stable locator ---------------------------------------------------

test("★ §4.4:0 个匹配 → 无效", () => {
  assert.deepEqual(validateLocator({ matches: [], expectBackendNodeId: 1 }), { ok: false, reason: "no-match" });
});

test("★ §4.4:多个匹配 → 无效", () => {
  const v = validateLocator({ matches: [{ backendNodeId: 1 }, { backendNodeId: 1 }], expectBackendNodeId: 1 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "ambiguous");
});

test("★ §4.4:唯一但指向**不同** backendNodeId → 无效", () => {
  const v = validateLocator({ matches: [{ backendNodeId: 2 }], expectBackendNodeId: 1 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "different-node");
});

test("★ §4.4:唯一且同一 → 有效", () => {
  const v = validateLocator({ matches: [{ backendNodeId: 7 }], expectBackendNodeId: 7 });
  assert.equal(v.ok, true);
  assert.equal(renderLocator(v), "loc=7");
});

test("★ §4.4:无效时**省略** locator,而不是打状态串", () => {
  for (const matches of [[], [{ backendNodeId: 1 }, { backendNodeId: 2 }], [{ backendNodeId: 99 }]]) {
    const v = validateLocator({ matches, expectBackendNodeId: 1 });
    assert.equal(renderLocator(v), "", "无效必须给空串");
  }
  // 违禁串一个都不许出现在输出里
  const out = [renderLocator({ ok: false, reason: "ambiguous" }), renderLocator({ ok: false, reason: "no-match" })].join("");
  for (const bad of FORBIDDEN_LOCATOR_STRINGS) {
    assert.ok(!out.includes(bad), `content 里不许出现 ${bad}`);
  }
});

test("§4.4:同名按钮重复 → ambiguous;同名但一隐一显在**可见性过滤后**可区分", () => {
  // 两个都在 → ambiguous
  const both = validateLocator({ matches: [{ backendNodeId: 11 }, { backendNodeId: 12 }], expectBackendNodeId: 11 });
  assert.equal(both.reason, "ambiguous");
  // 调用方已按可见性过滤,只剩一个 → 有效
  const one = validateLocator({ matches: [{ backendNodeId: 11 }], expectBackendNodeId: 11 });
  assert.equal(one.ok, true);
});

// ---- 动静:nothing 在这里也应该"看起来对" ------------------------------------
// 下面两条是防"顺手删文本"的回归线:任何未来的"优化"都不许越过它们。

test("回归:深层嵌套的文本,化简后既在、且顺序不变", () => {
  const deep = ax("generic", undefined, [
    ax("generic", undefined, [ax("generic", undefined, [ax("StaticText", "最深处")])]),
  ]);
  const { root } = build(ax("RootWebArea", "T", [deep, ax("StaticText", "浅处")]));
  const names = flattenTree(simplifyTree(root))
    .filter((n) => n.role === "text")
    .map((n) => n.name);
  assert.deepEqual(names, ["最深处", "浅处"]);
});
