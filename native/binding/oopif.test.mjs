// native/binding/oopif.test.mjs —— OOPIF 真取树
//
// 守的是「跨进程 iframe 能不能被看见、被点到」:
//   * 主 frame 的 AX 树**看不到** OOPIF 的内容 → 必须逐个 attach 再取
//   * 命令必须带 **sessionId**,否则根本路由不到那个 target
//   * ref 编号必须**跨 frame 全局唯一**(§4.2),而且记录里要带 sessionId

import test from "node:test";
import assert from "node:assert/strict";

import { listOopifTargets, collectFrameTrees, buildMultiFrameSnapshot } from "./oopif.mjs";

// ---- 假 CDP --------------------------------------------------------------

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

/** 把嵌套 spec 摊平成 CDP 的扁平行(带 childIds)。 */
function flat(spec) {
  const out = [];
  const walk = (s) => {
    const kids = (s.children ?? []).map(walk);
    const node = { ...s.node, childIds: kids.map((k) => k.nodeId) };
    out.push(node);
    return node;
  };
  walk(spec);
  return out;
}

/**
 * 一个能演 OOPIF 的假 CDP。
 * `trees` 的键:主 frame 用 `"main"`,子 frame 用 `"S-<targetId>"`。
 */
function fakeCdp({ targets = [], trees = {}, failAttach = [], failTree = [] } = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params = {}, opts = {}) {
      calls.push({ method, params, sessionId: opts.sessionId });
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.attachToTarget") {
        if (failAttach.includes(params.targetId)) throw new Error("attach 失败");
        return { sessionId: `S-${params.targetId}` };
      }
      if (method === "Accessibility.getFullAXTree") {
        const key = opts.sessionId ?? "main";
        if (failTree.includes(key)) throw new Error("取树失败");
        return { nodes: trees[key] ?? [] };
      }
      return {};
    },
    onMessage() {
      return () => {};
    },
  };
}

const oopifTarget = (id, url = "https://other.example/") => ({
  targetId: id,
  type: "iframe",
  url,
  title: "",
});

// ---- 1. 发现 target ------------------------------------------------------

test("listOopifTargets:只挑 type=iframe,忽略 page / worker", async () => {
  const cdp = fakeCdp({
    targets: [
      oopifTarget("T-a"),
      { targetId: "T-page", type: "page", url: "https://x/" },
      { targetId: "T-w", type: "worker", url: "" },
      { targetId: "", type: "iframe", url: "" }, // 空 id 要丢掉
    ],
  });
  const got = await listOopifTargets({ cdp });
  assert.deepEqual(
    got.map((t) => t.targetId),
    ["T-a"],
  );
});

// ---- 2. 取树 -------------------------------------------------------------

test("★ collectFrameTrees:主 frame + 每个 OOPIF 都取到,且**带 sessionId**", async () => {
  const cdp = fakeCdp({
    targets: [oopifTarget("T-a"), oopifTarget("T-b")],
    trees: {
      main: flat({ node: ax("RootWebArea", "主"), children: [{ node: ax("button", "主页按钮") }] }),
      "S-T-a": flat({ node: ax("RootWebArea", "A"), children: [{ node: ax("button", "A 按钮") }] }),
      "S-T-b": flat({ node: ax("RootWebArea", "B"), children: [{ node: ax("button", "B 按钮") }] }),
    },
  });

  const got = await collectFrameTrees({ cdp });
  assert.equal(got.main.nodes.length, 2, "主 frame 有 2 个节点");
  assert.equal(got.frames.length, 2);

  // 关键:子 frame 的取树请求必须带 sessionId,否则路由不到
  const childCalls = cdp.calls.filter(
    (c) => c.method === "Accessibility.getFullAXTree" && c.sessionId,
  );
  assert.deepEqual(
    childCalls.map((c) => c.sessionId).sort(),
    ["S-T-a", "S-T-b"],
    "每个 OOPIF 都要在**自己的 session** 上取树",
  );
  // 主 frame 那次不带 session
  const mainCall = cdp.calls.find(
    (c) => c.method === "Accessibility.getFullAXTree" && !c.sessionId,
  );
  assert.ok(mainCall, "主 frame 的取树不该带 sessionId");
});

test("★ collectFrameTrees:某个 frame 抓失败 → 跳过它,**不毁掉整张快照**", async () => {
  const cdp = fakeCdp({
    targets: [oopifTarget("T-ok"), oopifTarget("T-bad-attach"), oopifTarget("T-bad-tree")],
    trees: { main: flat({ node: ax("RootWebArea", "主") }), "S-T-ok": flat({ node: ax("RootWebArea", "OK") }) },
    failAttach: ["T-bad-attach"],
    failTree: ["S-T-bad-tree"],
  });
  const got = await collectFrameTrees({ cdp });
  assert.deepEqual(
    got.frames.map((f) => f.frameId),
    ["T-ok"],
    "坏的 frame 被跳过,好的还在",
  );
  assert.equal(got.main.nodes.length, 1, "主 frame 不受影响");
});

test("★ collectFrameTrees:拿不到 target 列表时退化成只有主 frame", async () => {
  const cdp = fakeCdp({ trees: { main: flat({ node: ax("RootWebArea", "主") }) } });
  cdp.send = async (method, params, opts) => {
    if (method === "Target.getTargets") throw new Error("不支持");
    if (method === "Accessibility.getFullAXTree") return { nodes: [{ ...ax("RootWebArea", "主"), childIds: [] }] };
    return {};
  };
  const got = await collectFrameTrees({ cdp });
  assert.equal(got.frames.length, 0);
  assert.equal(got.main.nodes.length, 1);
});

// ---- 3. 合并 -------------------------------------------------------------

test("★ buildMultiFrameSnapshot:ref 编号**跨 frame 全局唯一**", async () => {
  const cdp = fakeCdp({
    targets: [oopifTarget("T-a"), oopifTarget("T-b")],
    trees: {
      main: flat({ node: ax("RootWebArea", "主"), children: [{ node: ax("button", "主按钮") }] }),
      "S-T-a": flat({ node: ax("RootWebArea", "A"), children: [{ node: ax("button", "A按钮") }] }),
      "S-T-b": flat({ node: ax("RootWebArea", "B"), children: [{ node: ax("button", "B按钮") }] }),
    },
  });

  const snap = await buildMultiFrameSnapshot({ cdp, header: "[p1 测试]" });
  const refIds = Object.values(snap.refs).map((r) => r.refId);
  assert.equal(refIds.length, 3, "三个按钮各一个 ref");
  assert.equal(new Set(refIds).size, 3, "**编号不许撞车**");
});

test("★ buildMultiFrameSnapshot:OOPIF 的 ref 带 sessionId,主 frame 的不带", async () => {
  const cdp = fakeCdp({
    targets: [oopifTarget("T-a", "https://other.example/")],
    trees: {
      main: flat({ node: ax("RootWebArea", "主"), children: [{ node: ax("button", "主按钮") }] }),
      "S-T-a": flat({ node: ax("RootWebArea", "A"), children: [{ node: ax("button", "A按钮") }] }),
    },
  });

  const snap = await buildMultiFrameSnapshot({ cdp });
  const records = Object.values(snap.refs);
  const main = records.find((r) => r.name === "主按钮");
  const child = records.find((r) => r.name === "A按钮");
  assert.equal(main.sessionId, undefined, "主 frame 的 ref 不该带 session(走默认 session)");
  assert.equal(child.sessionId, "S-T-a", "OOPIF 的 ref 必须带 session,否则点不到");
  assert.equal(child.frameId, "T-a", "frameId 要记下来");
});

test("★ buildMultiFrameSnapshot:内容里必须**标出帧边界**", async () => {
  const cdp = fakeCdp({
    targets: [oopifTarget("T-a", "https://other.example/")],
    trees: {
      main: flat({ node: ax("RootWebArea", "主"), children: [{ node: ax("button", "主按钮") }] }),
      "S-T-a": flat({ node: ax("RootWebArea", "A"), children: [{ node: ax("button", "A按钮") }] }),
    },
  });
  const snap = await buildMultiFrameSnapshot({ cdp, header: "[p1]" });
  assert.match(snap.content, /\[frame T-a "https:\/\/other\.example\/"\]/, "要标出这是哪个 frame");
  assert.match(snap.content, /A按钮/, "OOPIF 的内容必须在快照里");
  assert.ok(
    snap.content.indexOf("主按钮") < snap.content.indexOf("A按钮"),
    "主 frame 在前,OOPIF 在后",
  );
});

test("★ buildMultiFrameSnapshot:预算作用于**整张快照**,不是每帧一份", async () => {
  const bigText = "内容".repeat(200);
  const bigTree = (n) =>
    flat({
      node: ax("RootWebArea", "x"),
      children: Array.from({ length: n }, (_, i) => ({ node: ax("StaticText", `${bigText}${i}`) })),
    });

  const cdp = fakeCdp({
    targets: [oopifTarget("T-a"), oopifTarget("T-b"), oopifTarget("T-c")],
    trees: { main: bigTree(6), "S-T-a": bigTree(6), "S-T-b": bigTree(6), "S-T-c": bigTree(6) },
  });

  const snap = await buildMultiFrameSnapshot({ cdp, options: { maxResultLength: 600 } });
  assert.ok(snap.content.length <= 600, `整张快照不许超预算(实际 ${snap.content.length})`);
});

test("★ buildMultiFrameSnapshot:frames 摘要给出每个帧的 ref 数", async () => {
  const cdp = fakeCdp({
    targets: [oopifTarget("T-a")],
    trees: {
      main: flat({ node: ax("RootWebArea", "主") }),
      "S-T-a": flat({
        node: ax("RootWebArea", "A"),
        children: [{ node: ax("button", "一") }, { node: ax("textbox", "二") }],
      }),
    },
  });
  const snap = await buildMultiFrameSnapshot({ cdp });
  assert.equal(snap.frames.length, 1);
  assert.equal(snap.frames[0].frameId, "T-a");
  assert.equal(snap.frames[0].refCount, 2);
});

// ---- 6. 主 frame 的 session 与"拍哪个标签页" -------------------------------
//
// 这两条都是 2026-10-25 在**真浏览器**上第一次跑出来的,假对端永远暴露不了:
//   * 不带 sessionId 的 `Accessibility.getFullAXTree` 会落到 browser 目标,
//     被拒 `'Accessibility.getFullAXTree' wasn't found`
//   * `Target.getTargets` 里第一个 page 常是启动时就有的 `chrome://newtab/`,
//     拍它就拍到一张空标签页 —— 快照里全是 container/iframe,一个字都没有

const pageTarget = (id, url = "https://x/", title = "") => ({
  targetId: id,
  type: "page",
  url,
  title,
});

test("★ 有 page target 时:主 frame 的取树**必须带它的 sessionId**", async () => {
  const cdp = fakeCdp({
    targets: [pageTarget("T-page")],
    trees: {
      main: flat({ node: ax("RootWebArea", "无 session 时的树") }),
      "S-T-page": flat({ node: ax("RootWebArea", "真页面"), children: [{ node: ax("button", "真按钮") }] }),
    },
  });

  const got = await collectFrameTrees({ cdp });
  assert.equal(got.main.nodes.length, 2, "应该拿到**带 session** 的那棵树");

  const fetch = cdp.calls.find(
    (c) => c.method === "Accessibility.getFullAXTree" && c.sessionId === "S-T-page",
  );
  assert.ok(fetch, "主 frame 的取树请求必须带 page 的 sessionId,否则会落到 browser 目标");
});

test("★ 指定 pageTargetId 时:attach 的是它,不是列表里第一个", async () => {
  const cdp = fakeCdp({
    targets: [pageTarget("T-newtab", "chrome://newtab/"), pageTarget("T-mine", "https://mine/")],
    trees: {
      "S-T-newtab": flat({ node: ax("RootWebArea", "新标签页") }),
      "S-T-mine": flat({ node: ax("RootWebArea", "我的页"), children: [{ node: ax("button", "买") }] }),
    },
  });

  const got = await collectFrameTrees({ cdp, pageTargetId: "T-mine" });
  const attached = cdp.calls.filter((c) => c.method === "Target.attachToTarget").map((c) => c.params.targetId);
  assert.deepEqual(attached, ["T-mine"], "只该 attach 指定的那个页面");
  assert.equal(got.main.nodes.length, 2);
});

test("★ 没指定 pageTargetId 时:取**最后一个** page(不是第一个 newtab)", async () => {
  const cdp = fakeCdp({
    targets: [pageTarget("T-newtab", "chrome://newtab/"), pageTarget("T-mine", "https://mine/")],
    trees: {
      "S-T-newtab": flat({ node: ax("RootWebArea", "新标签页") }),
      "S-T-mine": flat({ node: ax("RootWebArea", "我的页"), children: [{ node: ax("button", "买") }] }),
    },
  });

  const got = await collectFrameTrees({ cdp });
  const attached = cdp.calls.filter((c) => c.method === "Target.attachToTarget").map((c) => c.params.targetId);
  assert.deepEqual(attached, ["T-mine"], "第一个 page 往往是 newtab,取它会拍错页面");
  assert.equal(got.main.nodes.length, 2);
});
