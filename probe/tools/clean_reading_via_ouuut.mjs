// probe/tools/clean_reading_via_ouuut.mjs —— **用我们自己的驱动**取检测站的干净读数
//
// 为什么要有它:M1 收尾时留了一条「干净的检测分数拿不到」—— 当时那次测量是借 **omp 的 CDP harness**
// 驱动的,而 harness 会覆盖 UA、发 CDP 命令,于是 `platformMismatch` / `runtimeEnableLeak` 这类红
// **是驱动的产物,不是内核的**。要用自己的栈量,就必须用自己的驱动。
//
// 用法(在仓库根跑;**脚本本身从 stdin 喂给 CLI**):
//
//   OUUUT_BROWSER='F:\apps\ouuut-browser\0.1.3\chrome.exe' \
//     node native/bin/ouuut.mjs nodejs --headless < probe/tools/clean_reading_via_ouuut.mjs
//
// 输出:`__CLEAN__{...}` 一行 JSON —— 与 `probe/sites/bot_detector.py` 同一套判读
// (按站点自己的状态符号,不用自然语言正则),便于与 `probe/out/*/matrix.json` 的行人工对照。
//
// ⚠️ 它**不**产出 matrix.json 行:那需要一个走本 CLI 的 probe target 适配器(尚未写)。
//    这个脚本先把"干净读数"这件事坐实,适配器是后续项。

const URL = "https://bot-detector.rebrowser.net/";
const SETTLE_MS = 13000;

const EXTRACT = `(() => {
  const norm = (s) => (s || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').trim();
  const rows = [...document.querySelectorAll('table tr')];
  // 不能拿 \\S 取状态符号:🔴(U+1F534)是代理对,正则不带 u 会只吃到高代理项 —— 按第一个空格硬切。
  const split = (s) => { const i = s.indexOf(' '); return i < 0 ? ['', s] : [s.slice(0, i), s.slice(i + 1).trim()]; };
  return rows.map((tr) => {
    const tds = [...tr.children].map((td) => norm(td.innerText || td.textContent));
    if (tds.length < 2) return null;
    const [mark, name] = split(tds[0] || '');
    return { mark, name, detail: tds.slice(1).join(' | ') };
  }).filter(Boolean);
})()`;

const CP = { "\u{1F534}": "fail", "\u{1F7E1}": "warn", "\u{1F7E2}": "pass", "\u{1F7E0}": "warn",
             "\u{1F536}": "warn", "\u{1F6A8}": "fail", "\u26AA": "skip", "\u{1F535}": "skip", "\u2B1C": "skip" };

// 状态符号取**首个码位**(⚪ 带变体选择符 U+FE0F,整串比较会漏;而 🔴 是代理对,\S 也吃不准)。
const firstCp = (mark) => [...(mark || "").replace(/\uFE0F/g, "")][0] ?? "";

const t = await taskSpace("p8-clean");
const p = await t.newPage();
await p.goto(URL);
await p.waitForTimeout(SETTLE_MS);
const rows = await p.evaluate(EXTRACT);

const tests = rows
  // 表头那一行的"状态列"是文字 `Test name`,不是符号 ⇒ 按"首个码位是不是已知符号"筛掉
  .filter((r) => CP[firstCp(r.mark)] !== undefined)
  .map((r) => ({ name: r.name, status: CP[firstCp(r.mark)], mark: r.mark, detail: r.detail.slice(0, 200) }));

const tally = tests.reduce((acc, x) => ((acc[x.status] = (acc[x.status] || 0) + 1), acc), {});
const scored = tests.filter((x) => x.status !== "skip");

console.log("__CLEAN__" + JSON.stringify({
  url: URL,
  settle_ms: SETTLE_MS,
  scored: scored.length,
  tally,
  fails: scored.filter((x) => x.status === "fail").map((x) => x.name),
  warns: scored.filter((x) => x.status === "warn").map((x) => x.name),
  tests: scored,
}, null, 0));

console.log("__HEADLINE__ " + scored.length + " 项计分 → " +
  "fail " + scored.filter((x) => x.status === "fail").length +
  " / warn " + scored.filter((x) => x.status === "warn").length +
  " / pass " + scored.filter((x) => x.status === "pass").length);
