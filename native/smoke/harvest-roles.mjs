// native/smoke/harvest-roles.mjs —— 从 **ego** 身上采「快照角色词汇表」
//
// 为什么要有这个:`docs/原生层接口.md` §4.3 只给了 example.com 一个样本
// (`root` / `svg_root` / `paragraph` / `text`)。而 CDP 的 a11y 角色名是
// `RootWebArea` / `StaticText` 这类 —— **两者不是简单的驼峰转换**,是一张词汇映射表。
//
// 与其猜那张表,不如多跑几个页面把词汇表**采下来**,再照它实现映射。
//
// 运行(ego):
//   ego-browser nodejs < native/smoke/harvest-roles.mjs
//
// 输出:一行 `__ROLES__` 开头的 JSON —— 每个 URL 对应的「出现过的行首 token 计数」。

const MARK = "__ROLES__";

const URLS = [
  "https://example.com",
  "https://www.iana.org/help/example-domains",
  "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/button",
];

async function main() {
  const out = { pages: {}, errors: [] };
  let task;
  try {
    task = await taskSpace("ouuut-role-harvest");
  } catch (e) {
    out.errors.push("taskSpace: " + String(e).slice(0, 200));
  }

  for (const url of URLS) {
    try {
      const page = await task.newPage();
      await page.goto(url);
      const snap = await page.snapshot();
      const text = typeof snap === "string" ? snap : (snap?.content ?? "");
      const counts = {};
      for (const raw of text.split("\n").slice(1)) {
        // 行首 token = 去掉缩进后的第一个词
        const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
        if (!m) continue;
        counts[m[1]] = (counts[m[1]] ?? 0) + 1;
      }
      out.pages[url] = { lines: text.split("\n").length, tokens: counts };
    } catch (e) {
      out.errors.push(url + ": " + String(e).slice(0, 200));
    }
  }

  console.log(MARK + JSON.stringify(out));
}

await main();
