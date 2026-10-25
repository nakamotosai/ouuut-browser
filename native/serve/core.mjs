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

/** `browser_wait` 允许的三种等待目标(与 harness `page.waitFor*` 的参数逐字对齐)。 */
export const WAIT_LOAD_STATES = Object.freeze(["domcontentloaded", "load", "networkidle"]);
export const WAIT_SELECTOR_STATES = Object.freeze(["attached", "detached", "visible", "hidden"]);

const BAD_ARGS = "OUUUT_SERVE_BAD_ARGS";

/**
 * @param {object} o
 * @param {{taskSpace: Function}} o.harness 装了 SDK 之后的 harness 面(`globalThis.taskSpace` 等)
 * @param {object} o.api                     原生 api(只用来做传输层的事:列页等)
 * @param {string} [o.spaceName]             服务端用的任务空间名(CLI 那边是脚本自己起的名字)
 * @param {object} [o.profile]               档案信息(`{sessionProfileId, profiles, archive}`),
 *        由 `boot.mjs` 从会话层取;**没有它时 `profile()` 如实说"档案引擎不可达"**。
 */
export function createServeCore({ harness, api, spaceName = "serve", profile = null } = {}) {
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

    /**
     * 等页面进入某种状态。**用 harness 的页面等待 API,不轮询快照**:
     * `waitForSelector` / `waitForFunction` / `waitForLoadState` 都在**页面侧**判定,
     * 轮询快照会把"快照渲染"混进等待语义(慢、还会让 OOPIF 的 attach 时机变成判据)。
     *
     * 三者**互斥**:`selector` / `text` / `loadState` 只能给一个;都不给 = 等 `load`。
     *
     * @param {object} [o]
     * @param {string} [o.selector]  CSS / harness 选择器(`css:…` 也行)
     * @param {"attached"|"detached"|"visible"|"hidden"} [o.state] 只对 selector 有意义
     * @param {string} [o.text]      等页面可见文本包含它
     * @param {"domcontentloaded"|"load"|"networkidle"} [o.loadState]
     * @param {number} [o.timeoutMs]
     */
    async wait({ selector, text, loadState, state, timeoutMs } = {}) {
      const page = pages.at(-1);
      if (!page) throw new ServeError("还没有打开的页:先 goto", "OUUUT_SERVE_NO_PAGE");

      const hasSelector = typeof selector === "string" && selector !== "";
      const hasText = typeof text === "string" && text !== "";
      if (hasSelector && hasText) throw new ServeError("selector 与 text 只能给一个", BAD_ARGS);
      if (loadState !== undefined && (hasSelector || hasText)) {
        throw new ServeError("loadState 与 selector / text 只能给一个", BAD_ARGS);
      }
      if (state !== undefined && !hasSelector) {
        throw new ServeError("state 只对 selector 有意义;请同时给 selector", BAD_ARGS);
      }

      const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
      const startedAt = Date.now();

      if (hasSelector) {
        if (typeof page.waitForSelector !== "function") {
          throw new ServeError("这个 harness 的页面没有 waitForSelector", "OUUUT_SERVE_NO_WAIT");
        }
        const waitState = state ?? "visible";
        if (!WAIT_SELECTOR_STATES.includes(waitState)) {
          throw new ServeError(
            `state=${JSON.stringify(waitState)} 不合法;只允许 ${WAIT_SELECTOR_STATES.join(" / ")}`,
            BAD_ARGS,
          );
        }
        await page.waitForSelector(selector, { timeout, state: waitState });
        return { waitedFor: "selector", selector, state: waitState, timeoutMs: timeout, elapsedMs: Date.now() - startedAt };
      }

      if (hasText) {
        if (typeof page.waitForFunction !== "function") {
          throw new ServeError("这个 harness 的页面没有 waitForFunction", "OUUUT_SERVE_NO_WAIT");
        }
        // 字符串表达式(harness 会把它包成 `await (<expr>)`);文本走 JSON 编码,不会被引号/换行破坏。
        const expression =
          `(() => { const t = (document.body && document.body.innerText) || ""; ` +
          `return t.includes(${JSON.stringify(text)}); })()`;
        await page.waitForFunction(expression, undefined, { timeout });
        return { waitedFor: "text", text, timeoutMs: timeout, elapsedMs: Date.now() - startedAt };
      }

      const waitState = loadState ?? "load";
      if (!WAIT_LOAD_STATES.includes(waitState)) {
        throw new ServeError(
          `loadState=${JSON.stringify(waitState)} 不合法;只允许 ${WAIT_LOAD_STATES.join(" / ")}`,
          BAD_ARGS,
        );
      }
      if (typeof page.waitForLoadState !== "function") {
        throw new ServeError("这个 harness 的页面没有 waitForLoadState", "OUUUT_SERVE_NO_WAIT");
      }
      await page.waitForLoadState(waitState, { timeout });
      return { waitedFor: "loadState", loadState: waitState, timeoutMs: timeout, elapsedMs: Date.now() - startedAt };
    },

    /**
     * 当前档案 + 档案列表。
     *
     * 服务端**只服务一个档案**(见 `boot.mjs` 的多档案拒绝),所以 `profileId` 就是这次会话的
     * 主档案;`profiles` 来自会话层交出来的档案引擎(`archive.listProfiles()`)。
     * 没给 `--profile-kind` 时会话里只有硬编码的默认档案 —— 这里**如实**返回它,
     * 而不是编一个 kind 出来。
     *
     * ⚠️ **建 / 关档案没有经 MCP 暴露**:建 persona/disposable 要 `Target.createBrowserContext`,
     * 销毁要 `Target.disposeBrowserContext`,而这两件事的生命周期归会话层
     * (`binding/session-profiles.mjs`)所有 —— 从 MCP 单点开放会把收尾顺序(ADR-007 的
     * "用完即弃")撕成两半。所以 `capabilities` 明说 `false`,不假装支持。
     */
    async profile() {
      const archive = profile?.archive ?? null;
      let profiles = [];
      let archiveReachable = false;
      if (archive && typeof archive.listProfiles === "function") {
        profiles = archive.listProfiles().profiles ?? [];
        archiveReachable = true;
      } else if (Array.isArray(profile?.profiles)) {
        profiles = profile.profiles;
      }

      const sessionProfileId = profile?.sessionProfileId ?? null;
      const current =
        profiles.find((p) => p.id === sessionProfileId) ??
        (profiles.length === 1 ? profiles[0] : null);

      return {
        profileId: current?.id ?? sessionProfileId ?? "default",
        kind: current?.kind ?? null,
        isDefault: Boolean(current?.isDefault),
        archiveReachable,
        profiles,
        capabilities: {
          create: false,
          close: false,
          reason:
            "档案的 browser context 生命周期归会话层(session-profiles);经 MCP 建/关会撕开收尾顺序," +
            "属侵入式改动,未做。要多种档案请用 CLI 的 --profile-kind / --profiles。",
        },
      };
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
