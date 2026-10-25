// native/binding/oopif.mjs —— **跨进程 iframe(OOPIF)的真取树**
//
// 背景:同进程 iframe 的节点会出现在主 frame 的 AX 树里,但 **OOPIF 是独立的
// target**(站点隔离下 `<iframe src="别的站点">` 就是这样)。主 frame 的
// `Accessibility.getFullAXTree` **看不到**它的内容 —— 只看到一个空壳。
//
// 所以「取全页快照」必须:
//   1. `Target.getTargets` 找出 type === "iframe" 的 target
//   2. 逐个 `Target.attachToTarget({flatten:true})` 拿 sessionId
//   3. 在**那个 session** 上调 `Accessibility.getFullAXTree`
//   4. 用**同一个 ref 分配器**合并(§4.2:refId 跨 frame 全局唯一)
//   5. ref 记录里带上 sessionId —— 否则后续动作路由不到那个 target
//
// 为什么不 detach:快照拍完还要能**点**。session 关掉的话,那些 ref 就成了死号。

import { createRefAllocator } from "./snapshot-refs.mjs";
import { renderSimplifiedLines } from "./snapshot-simplify.mjs";
import { buildPipeline, selectByImportance } from "./snapshot.mjs";

/** OOPIF 的 target 类型。同进程 iframe 不会出现在这里。 */
const OOPIF_TYPE = "iframe";

/**
 * 列出当前所有 OOPIF target。
 *
 * 用 `Target.getTargets` 而不是只靠 `setAutoAttach` 的事件:前者是**一次往返就能
 * 拿全**(包含已经存在的),后者要靠等事件,时序上永远有"等多久"的问题。
 */
export async function listOopifTargets({ cdp, timeoutMs = 15_000 } = {}) {
  const res = await cdp.send("Target.getTargets", {}, { timeoutMs });
  return (res?.targetInfos ?? []).filter(
    (t) => t?.type === OOPIF_TYPE && typeof t.targetId === "string" && t.targetId.length > 0,
  );
}

/**
 * 抓主 frame + 全部 OOPIF 的 AX 树。
 *
 * 单个 frame 抓失败**不该毁掉整张快照** —— 站点销毁中的 iframe 很常见,
 * 那种情况下少一个 frame 比整条挂掉有用。
 *
 * @returns {{main: {frameId: null, nodes: Array}, frames: Array<{frameId, sessionId, url, title, nodes}>}}
 */
export async function collectFrameTrees({ cdp, timeoutMs = 15_000, maxFrames = 32 } = {}) {
  const mainNodes = (await cdp.send("Accessibility.getFullAXTree", {}, { timeoutMs }))?.nodes ?? [];

  let targets = [];
  try {
    targets = (await listOopifTargets({ cdp, timeoutMs })).slice(0, maxFrames);
  } catch {
    // 拿不到 target 列表(老内核 / 无权限)就退化成"只有主 frame"
    targets = [];
  }

  const frames = [];
  for (const t of targets) {
    let sessionId;
    try {
      const att = await cdp.send(
        "Target.attachToTarget",
        { targetId: t.targetId, flatten: true },
        { timeoutMs },
      );
      sessionId = att?.sessionId;
    } catch {
      continue; // 已 attach 过 / 正在销毁
    }
    if (!sessionId) continue;

    try {
      const nodes =
        (await cdp.send("Accessibility.getFullAXTree", {}, { timeoutMs, sessionId }))?.nodes ?? [];
      frames.push({
        frameId: t.targetId,
        sessionId,
        url: t.url ?? "",
        title: t.title ?? "",
        nodes,
      });
    } catch {
      // 这个 frame 抓不到就跳过,但**别 detach** —— 下一轮可能就好了
    }
  }

  return { main: { frameId: null, nodes: mainNodes }, frames };
}

/** 把一棵树渲染出来的行接到已有行后面,并把 `parent` 下标整体平移。 */
function appendLines(into, lines) {
  const base = into.length;
  for (const l of lines) {
    into.push({ ...l, parent: l.parent < 0 ? -1 : l.parent + base });
  }
}

/**
 * 全页快照:**主 frame + 全部 OOPIF**,共用一套 ref 编号。
 *
 * 预算(`maxResultLength`)是**整张快照**的,不是每帧一份 —— 否则 N 个 iframe
 * 就能把输出撑成 N 倍。
 *
 * @returns {{content: string, refs: object, frames: Array<{frameId, url, refCount}>}}
 */
export async function buildMultiFrameSnapshot({
  cdp,
  header,
  options = {},
  timeoutMs = 15_000,
  tagNameOf = null,
} = {}) {
  const maxLength = Number.isFinite(options?.maxResultLength) ? options.maxResultLength : 40_000;

  // 与 `buildSnapshot` 同一条廉价探针规则:预算小到这个程度时快照的唯一目的
  // 是让 user-control 门有机会 reject —— 一次 CDP 都不该多发。
  if (maxLength <= 8) {
    return {
      content: (header ? `${header}\n` : "").slice(0, maxLength),
      refs: {},
      frames: [],
    };
  }

  const trees = await collectFrameTrees({ cdp, timeoutMs });

  const allocator = createRefAllocator();
  const lines = [];
  const frames = [];

  const mainBuilt = buildPipeline(trees.main.nodes, { allocator, tagNameOf });
  if (mainBuilt?.simplified) {
    appendLines(lines, renderSimplifiedLines(mainBuilt.simplified, { maxDepth: 64 }));
  }

  for (const f of trees.frames) {
    const built = buildPipeline(f.nodes, {
      allocator,
      frameId: f.frameId,
      sessionId: f.sessionId,
      tagNameOf,
    });
    if (!built?.simplified) continue;
    const frameLines = renderSimplifiedLines(built.simplified, { maxDepth: 64 });
    // 帧边界必须显式标出来 —— 否则读的人会以为这些节点都在主文档里
    appendLines(lines, [
      {
        text: `[frame ${f.frameId}${f.url ? ` "${f.url}"` : ""}]`,
        depth: 0,
        role: "frame_marker",
        name: f.url ?? "",
        hasRef: false,
        refId: null,
        parent: -1,
      },
    ]);
    appendLines(lines, frameLines);
    frames.push({
      frameId: f.frameId,
      url: f.url,
      refCount: frameLines.filter((l) => l.refId !== null).length,
    });
  }

  const headerCost = header ? header.length + 1 : 0;
  const sel = selectByImportance(lines, Math.max(0, maxLength - headerCost));
  const content = header ? `${header}\n${sel.text}` : sel.text;

  // 只保留快照里真出现的 ref(内容里没有的节点给了 ref 也点不到)
  const keptRefs = new Set(sel.keptLines.map((l) => l.refId).filter((r) => r !== null));
  const all = allocator.snapshot();
  const refs = {};
  for (const [k, v] of Object.entries(all)) {
    if (keptRefs.has(Number(k))) refs[k] = v;
  }

  return { content, refs, frames };
}
