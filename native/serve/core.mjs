// native/serve/core.mjs —— 入口无关的**操作层**(三入口共用的那部分)
//
// 分工:传输(HTTP/WS / MCP stdio / CLI 的脚本)各自不同,但"要浏览器做什么"只有一份。
// 这里只做**转发与形状统一**,不含传输、不含档案/代理逻辑 —— 那些在 `openSession()` 里。
//
// ## 为什么要走 harness 的页面模型,而不是直接调原生 `api`
//
// 因为"快照文本"是**产品输出**:它由 harness 的页面模型(化简 + 压缩 + 分配 ref)决定。
// 直接调原生 `api.snapshot()` 拿到的是**另一种渲染**(缩进树、没有 ref 编号)——
// 于是"同一个任务经三条入口驱动,结果一致"这句话就不成立了:用 MCP 的人看到的快照
// 与用 CLI 的人看到的**不是同一样东西**(2026-10-25 实测,两侧文本确实不同)。
// 所以服务端也装 harness 的 SDK(`installEgoSdk`),走同一条管道。
//
// ⚠️ harness **硬编码**认 `globalThis.ouuut`(见 `dist/src/helpers.js`)——
// 所以服务端必须把我们的 api 装在**这个名字**下(`boot.mjs` 里有断言)。

import { ServeError } from "./errors.mjs";

/**
 * @param {object} o
 * @param {{taskSpace: Function}} o.harness 装了 SDK 之后的 harness 面(`globalThis.taskSpace` 等)
 * @param {object} o.api                     原生 api(只用来做传输层的事:列页等)
 * @param {string} [o.spaceName]             服务端用的任务空间名(CLI 那边是脚本自己起的名字)
 */
export function createServeCore({ harness, api, spaceName = "serve" } = {}) {
  if (!harness || typeof harness.taskSpace !== "function") {
    throw new ServeError("createServeCore 需要 harness.taskSpace(装了 harness SDK 之后再调)");
  }
  /** 已经打开的页(按打开顺序)。`snapshot()` 拍**最后一张** —— 与脚本里"我刚开的那个页"一致。 */
  const pages = [];

  return {
    pages,

    /**
     * 打开一个页面并等它加载完。
     *
     * ⚠️ **一个服务端进程只服务一个档案**(就是这次会话的主档案)。
     * 多档案(各自绑不同出口)在 **CLI / 脚本**那条路是可行的、也实测过(两个空间 + `taskSpace(name,{profileId})`),
     * 但服务端这条路走不通:harness 的任务空间要求"建空间时浏览器恰好一个标签页",而服务端要先起服务再按请求开页;
     * 且预建多个空间之后,它的页面模型会把快照认到别的文档上(实测 `Page changed during snapshot`)。
     * ⇒ 与其做成半可用,不如在这里**明说**:要双档案请用 CLI 那条路。
     */
    async goto(url, { timeoutMs } = {}) {
      if (typeof url !== "string" || url === "") throw new ServeError("goto 需要一个 url", "OUUUT_SERVE_BAD_ARGS");
      const space = await harness.taskSpace(spaceName);
      const page = await space.newPage();
      await page.goto(url, Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : {});
      pages.push(page);
      return { targetId: page.targetId ?? null, url };
    },

    /**
     * 拍快照(harness 管道)。
     *
     * harness 的 `page.snapshot()` 返回**字符串**;但原生 api 那条返回的是对象 `{content, refs}` ——
     * 两种形状都收,免得哪天换了管道又变成 `"[object Object]"`(实测踩过一次)。
     */
    async snapshot(options = {}) {
      const page = pages.at(-1);
      if (!page) throw new ServeError("还没有打开的页:先 goto", "OUUUT_SERVE_NO_PAGE");
      const r = await page.snapshot(options);
      if (typeof r === "string") return { text: r };
      const text = typeof r?.content === "string" ? r.content : JSON.stringify(r ?? null);
      return { text, ...(Array.isArray(r?.refs) ? { refs: r.refs.length } : {}) };
    },

    /** 现在有哪些页(传输层事实,走原生 api)。 */
    async tabs() {
      const r = await api.listTabs();
      return { tabs: r?.tabs ?? [] };
    },

    /** 浏览器版本(最便宜的一次"活着吗"探针)。 */
    async version() {
      const v = typeof harness.getBrowserVersion === "function" ? await harness.getBrowserVersion() : await api.getBrowserVersion();
      return { version: v?.product ?? String(v) };
    },
  };
}

/** 快照文本的**归一化**:三入口比对时,头部那行(空间名/页数)按设计可以不同。 */
export function snapshotBody(text) {
  // 头部行(`[p2 "标题" | space "名字"(1): ...`)在快照里**可能出现不止一次**(harness 自己加一层,
  // 原生 content 里还有一层)—— 所以去掉的是**所有**这样的行,不是"第一行"。
  // 三入口的空间名按设计可以不同,头部里的空间名/页数因此不能进比对。
  return String(text ?? "")
    .split("\n")
    .filter((line) => !/^\[p\d+\b.*\|\s*space\s"/.test(line.trim()))
    // 帧标注里的 target id 是**每次启动**由浏览器分配的(32 位十六进制)——
    // 三个入口各自起一个浏览器,这个 id 本来就不同,拿它比等于比"谁先起"。
    .map((line) => line.replace(/\b[0-9A-F]{16,}\b/g, "<targetId>"))
    .join("\n")
    .trim();
}
