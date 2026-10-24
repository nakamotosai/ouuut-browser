// native/smoke/taskspace-smoke.mjs —— M2 的**共享冒烟脚本**
//
// 目的:同一段脚本要在**两个浏览器**上跑通 ——
//   1) ego lite(现成,今天就能跑 → 验证脚本与契约)
//   2) ouuut(自写原生层接通后 → 验证我们的实现满足了同一契约)
//
// 它刻意只用一个**最小的共同 API 子集**(见 docs/原生层接口.md):
//   taskSpace(name) · task.page(label) · page.goto(url) · page.evaluate(expr) · page.snapshot()
//
// 为什么用 heredoc / .mjs 而不是 `-e`:ego 的 CLI 在 PowerShell/cmd 下会破坏引号;
// 纯 ASCII 单行入口 + 文件是官方文档推荐的做法(见 `ego-browser skill`)。
//
// 运行(ego):
//   ego-browser nodejs < native/smoke/taskspace-smoke.mjs
//
// 输出:一行以 `__SMOKE__` 开头的 JSON —— 便于两个浏览器用同一个解析器对比。

const MARK = "__SMOKE__";
const TARGET_URL = "https://example.com";

async function main() {
  const out = { ok: false, steps: {}, errors: [] };

  try {
    // 1) 任务空间(所有权与交接的载体)
    const task = await taskSpace("ouuut-m2-smoke");
    out.steps.taskSpace = { spaceId: task.spaceId ?? null };

    // 2) 一个页面
    const page = await task.newPage();
    out.steps.page = { label: page.label ?? null };

    // 3) 导航
    await page.goto(TARGET_URL);
    out.steps.goto = { url: TARGET_URL };

    // 4) 页面内求值(必须能拿到**真实值**,不是句柄)
    const title = await page.evaluate("document.title");
    const url = await page.evaluate("location.href");
    out.steps.evaluate = { title, url };
    out.ok = typeof title === "string" && title.length > 0;

    // 5) 语义快照(内核生成,不注入页面 JS)
    try {
      const snap = await page.snapshot();
      const text =
        typeof snap === "string" ? snap : (snap && (snap.content ?? snap.text)) ?? "";
      out.steps.snapshot = {
        kind: typeof snap,
        length: typeof text === "string" ? text.length : 0,
        head: typeof text === "string" ? text.slice(0, 300) : null,
      };
    } catch (e) {
      out.steps.snapshot = { error: String(e).slice(0, 200) };
    }
  } catch (e) {
    out.errors.push(String(e).slice(0, 400));
  }

  console.log(MARK + JSON.stringify(out));
}

await main();
