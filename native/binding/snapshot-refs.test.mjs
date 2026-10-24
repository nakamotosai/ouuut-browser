// native/binding/snapshot-refs.test.mjs —— §4.2 跨 renderer ref 分配 的验收
//
//   node --test native/binding/snapshot-refs.test.mjs
//
// 这一片最容易出的错是**把两个"唯一性"当成一回事**:
//   * `backendNodeId` 只在**它自己的 renderer 内**唯一
//   * `refId` 在同一份快照里**跨进程**唯一
// 所以下面专门有一组测试就是拿"主 frame 的 21 与 OOPIF 的 21"来撞。

import test from "node:test";
import assert from "node:assert/strict";

import {
  createRefAllocator,
  assignRefs,
  assignRefsForFrames,
  assertRefIdsUnique,
  assertNodeIdentityUnique,
  INTERACTIVE_ROLES,
  SNAPSHOT_FORBIDDEN,
} from "./snapshot-refs.mjs";
import { auditSnapshotPhase } from "./cdp-guard.mjs";

/** 造一个规范形状的节点。 */
function n(role, backendNodeId, children = [], name = null) {
  return { role, name, backendNodeId, refId: null, children };
}

// ---- 分配:该给谁 ----------------------------------------------------------

test("★ 可交互角色拿到 ref,文本/容器不拿(文本是给 agent 读的,不是点的)", () => {
  const tree = n("root", 1, [
    n("text", 2, [], "一段正文"),
    n("button", 3, [], "提交"),
    n("container", 4, [n("anchor", 5, [], "链接")]),
  ]);
  const alloc = createRefAllocator();
  const out = assignRefs(tree, { allocator: alloc });

  assert.equal(out.refId, null, "root 不该有 ref");
  assert.equal(out.children[0].refId, null, "text 不该有 ref");
  assert.equal(out.children[1].refId, 1, "button 该有");
  assert.equal(out.children[2].refId, null, "container 不该有");
  assert.equal(out.children[2].children[0].refId, 2, "嵌套里的 anchor 该有");
});

test("refs 的形状满足 §4.2:{refId, backendNodeId, frameId, role, name}", () => {
  const alloc = createRefAllocator();
  assignRefs(n("root", 1, [n("button", 21, [], "Run iframe action")]), { allocator: alloc, frameId: "F1" });
  const refs = alloc.snapshot();
  assert.deepEqual(Object.keys(refs), ["1"]);
  assert.deepEqual(refs[1], {
    refId: 1,
    backendNodeId: 21,
    frameId: "F1",
    role: "button",
    name: "Run iframe action",
  });
});

test("缺 backendNodeId 的可交互节点拿不到 ref(不编一个假的)", () => {
  const alloc = createRefAllocator();
  const out = assignRefs(n("root", 1, [n("button", null)]), { allocator: alloc });
  assert.equal(out.children[0].refId, null);
  assert.equal(Object.keys(alloc.snapshot()).length, 0);
});

test("INTERACTIVE_ROLES 里每一条都真的会拿到 ref(清单与实现不能打架)", () => {
  const alloc = createRefAllocator();
  const kids = INTERACTIVE_ROLES.map((r, i) => n(r, 100 + i));
  assignRefs(n("root", 1, kids), { allocator: alloc });
  const got = Object.keys(alloc.snapshot()).map((k) => alloc.snapshot()[k].role);
  for (const r of INTERACTIVE_ROLES) assert.ok(got.includes(r), `${r} 在清单里却没拿到 ref`);
});

// ---- ★ 两个唯一性必须分开 ------------------------------------------------

test("★ 主 frame 的 21 与 OOPIF 的 21 是**两个不同节点**,各自拿到不同的 refId", () => {
  const main = n("root", 1, [n("button", 21, [], "主frame按钮")]);
  const oopif = n("root", 1, [n("button", 21, [], "iframe按钮")]);

  const { trees, refs } = assignRefsForFrames([
    { frameId: "MAIN", tree: main },
    { frameId: "OOPIF-1", tree: oopif },
  ]);

  const a = trees[0].tree.children[0];
  const b = trees[1].tree.children[0];
  assert.notEqual(a.refId, b.refId, "同一个 backendNodeId 在不同帧里必须是不同的 ref");
  assert.equal(a.refId, 1);
  assert.equal(b.refId, 2);
  // 身份是二元组
  assert.equal(refs[a.refId].backendNodeId, 21);
  assert.equal(refs[b.refId].backendNodeId, 21);
  assert.equal(refs[a.refId].frameId, "MAIN");
  assert.equal(refs[b.refId].frameId, "OOPIF-1");
});

test("★ refId 跨 frame 唯一(编号空间只有一个)", () => {
  const { refs } = assignRefsForFrames([
    { frameId: "MAIN", tree: n("root", 1, [n("button", 10), n("anchor", 11)]) },
    { frameId: "OOPIF-1", tree: n("root", 1, [n("textbox", 10), n("button", 12)]) },
    { frameId: "OOPIF-2", tree: n("root", 1, [n("checkbox", 10)]) },
  ]);
  const v = assertRefIdsUnique(refs);
  assert.equal(v.ok, true);
  assert.equal(v.count, 5, "5 个可交互节点应该有 5 个不同编号");
});

test("★ 记录里 (frameId, backendNodeId) 不许撞车", () => {
  const { refs } = assignRefsForFrames([
    { frameId: "MAIN", tree: n("root", 1, [n("button", 10)]) },
    { frameId: "OOPIF-1", tree: n("root", 1, [n("button", 10)]) },
  ]);
  assert.equal(assertNodeIdentityUnique(refs).ok, true, "不同帧的同号 backendNodeId 不算撞车");
});

test("同一个 frame 里两个 backendNodeId 相同 → 分配器只给一个 ref(它认为是同一个节点)", () => {
  const alloc = createRefAllocator();
  assignRefs(n("root", 1, [n("button", 10), n("anchor", 10)]), { allocator: alloc, frameId: "F" });
  // 同一帧内同号 —— 按 §4.2,那本来就是同一个节点,不该拿到两个编号
  assert.equal(Object.keys(alloc.snapshot()).length, 1);
});

test("两个 frameId 都空/缺失 → 报错(不能默默把所有帧当一帧)", () => {
  assert.throws(() => assignRefsForFrames([{ tree: n("root", 1) }]), /frameId/);
  assert.throws(() => assignRefsForFrames([{ frameId: "", tree: n("root", 1) }]), /frameId/);
});

// ---- ★ 稳定性:连拍两次 ref 不变 ------------------------------------------

test("★ 同一分配器里同一节点反复分配 → **同一个** refId(否则 agent 手上的 ref 立刻作废)", () => {
  const alloc = createRefAllocator();
  const tree = n("root", 1, [n("button", 21)]);
  const a = assignRefs(tree, { allocator: alloc, frameId: "F" });
  const b = assignRefs(tree, { allocator: alloc, frameId: "F" });
  assert.equal(a.children[0].refId, b.children[0].refId);
  assert.equal(Object.keys(alloc.snapshot()).length, 1, "不该重复登记");
});

test("★ 连拍两次:整棵树的 ref 序列逐字节相同(§4.1 的连拍要求在 ref 这一层也成立)", () => {
  const mk = () => n("root", 1, [n("button", 10, [], "A"), n("anchor", 11, [], "B"), n("textbox", 12)]);
  const alloc = createRefAllocator();
  const one = JSON.stringify(assignRefs(mk(), { allocator: alloc, frameId: "F" }));
  const two = JSON.stringify(assignRefs(mk(), { allocator: alloc, frameId: "F" }));
  assert.equal(one, two);
});

test("★ 纯计算:不改入参(同一棵树喂两个分配器互不影响)", () => {
  const tree = n("root", 1, [n("button", 21)]);
  const a1 = createRefAllocator();
  const a2 = createRefAllocator({ startAt: 900 });
  const r1 = assignRefs(tree, { allocator: a1, frameId: "F" });
  const r2 = assignRefs(tree, { allocator: a2, frameId: "F" });
  assert.equal(r1.children[0].refId, 1);
  assert.equal(r2.children[0].refId, 900);
  assert.equal(tree.children[0].refId, null, "入参不能被原地改");
});

test("startAt 可续号(便于把上一份快照的编号接上)", () => {
  const alloc = createRefAllocator({ startAt: 901 });
  assignRefs(n("root", 1, [n("button", 21)]), { allocator: alloc, frameId: "F" });
  assert.deepEqual(Object.keys(alloc.snapshot()), ["901"]);
});

test("空树 / null 不崩", () => {
  const alloc = createRefAllocator();
  assert.equal(assignRefs(null, { allocator: alloc }), null);
  assert.deepEqual(alloc.snapshot(), {});
  assert.equal(assignRefsForFrames([]).refs && Object.keys(assignRefsForFrames([]).refs).length, 0);
});

test("没有 allocator → 直接报错(不能默默不给 ref)", () => {
  assert.throws(() => assignRefs(n("root", 1), {}), TypeError);
});

// ---- §4.2 最后一条:拍快照不得激活 / focus / reload 任何 frame -------------

test("★ 快照期间的禁令:激活 / reload / focus / 输入 全部会被审出来", () => {
  const stream = [
    { method: "Target.getTargets" },
    { method: "Accessibility.getFullAXTree" },
    { method: "Target.activateTarget" }, // ← 违规
    { method: "Page.reload" }, // ← 违规
  ];
  const r = auditSnapshotPhase(stream);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations.map((v) => v.method), ["Target.activateTarget", "Page.reload"]);
});

test("★ 干净的快照流程 → 通过", () => {
  const r = auditSnapshotPhase([
    { method: "Target.getTargets" },
    { method: "Target.attachToTarget" },
    { method: "Accessibility.getFullAXTree" },
    { method: "Page.enable" },
  ]);
  assert.equal(r.ok, true);
});

test("SNAPSHOT_FORBIDDEN 的每一条都真的被审出来(清单与实现不打架)", () => {
  for (const m of SNAPSHOT_FORBIDDEN) {
    const r = auditSnapshotPhase([{ method: m }]);
    assert.equal(r.ok, false, `${m} 该被审出来`);
  }
});

test("空流 → 0 条,不假装通过也不假装有问题", () => {
  assert.equal(auditSnapshotPhase([]).total, 0);
  assert.equal(auditSnapshotPhase(null).total, 0);
});
