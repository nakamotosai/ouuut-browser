// probe/tools/shadow_dom_via_ouuut.mjs —— shadow DOM:快照看不看得见(P9),以及**点不点得动**
//
// 用法(仓库根):
//   node native/bin/ouuut.mjs nodejs --headless < probe/tools/shadow_dom_via_ouuut.mjs
//
// 输出 `__SHADOW__{...}` 一行 JSON + `__VERDICT__`。
// 断言的是「开着的 shadow DOM 内容在快照里可见」(用户能看见,agent 就该看得见);
// **点击**那条只记录不判失败 —— 它是"能看见但能不能操作"的证据,属于下一个问题。
//
// 为什么用 `about:blank` + 页面内造 DOM:Chrome 禁止顶层导航到 data: URL;file: 要落盘。
// 这里要验的是"AX 快照看不看得见 shadow 内容",与页面来源无关。

const BUILD = `(() => {
  const mk = (root, html) => { const d = document.createElement("div"); document.body.appendChild(d); const r = d.attachShadow({ mode: root }); r.innerHTML = html; return r; };

  // 光 DOM 的对照按钮(用来区分"点不动"到底是 shadow 的锅还是一切都点不动)
  const lightBtn = document.createElement("button");
  lightBtn.id = "light-btn";
  lightBtn.textContent = "MARK-LIGHT-BUTTON";
  lightBtn.onclick = () => { document.title = "clicked-light"; };
  document.body.appendChild(lightBtn);

  const openRoot = mk("open", '<p>MARK-OPEN-SHADOW-P</p><button id="b">MARK-OPEN-SHADOW-BUTTON</button>');
  openRoot.getElementById("b").onclick = () => { document.title = "clicked-open-shadow"; };

  mk("closed", '<p>MARK-CLOSED-SHADOW-P</p>');

  class XSlot extends HTMLElement {
    constructor() { super(); const r = this.attachShadow({ mode: "open" }); r.innerHTML = '<div><slot></slot></div>'; }
  }
  customElements.define("x-slot", XSlot);
  const slotted = document.createElement("x-slot");
  slotted.innerHTML = '<button id="sb">MARK-SLOTTED-BUTTON</button>';
  document.body.appendChild(slotted);
  // slot 投影的那个按钮给**自己的** onclick —— 否则"点成功"与"上一次点成功"的读数一样,
  // 证据就退化成"没报错"(2026-10-25 第一版就是这样,自己差点读错)。
  document.querySelector("#sb").onclick = () => { document.title = "clicked-slotted"; };

  const p = document.createElement("p");
  p.textContent = "MARK-LIGHT-P";
  document.body.appendChild(p);

  return { lightFound: !!document.querySelector("#host-open"), title: document.title };
})()`;

const t = await taskSpace("p9-shadow");
const p = await t.newPage();
await p.goto("about:blank");
const built = await p.evaluate(BUILD);
await p.waitForTimeout(400); // 让 AX 树把新节点纳入

const text = String(await p.snapshot());
const has = (s) => text.includes(s);

/** 点一下并读回 `document.title`(onclick 会写它)。失败不抛,把错误记下来。 */
async function tryClick(selector) {
  try {
    await p.click(selector, { timeout: 3000 });
    const title = await p.evaluate("document.title");
    return { selector, ok: true, title };
  } catch (e) {
    return { selector, ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }
}

await p.evaluate("document.title = ''"); // 清干净
const clickLight = await tryClick("#light-btn");
const clickShadow = await tryClick("#b"); // shadow 里的按钮:光 DOM 的 querySelector 查不到它
const clickSlotted = await tryClick("#sb"); // slot 投影进来的按钮(它在光 DOM 里!)

const verdict = {
  built,
  visible: {
    light: has("MARK-LIGHT-P"),
    openShadowP: has("MARK-OPEN-SHADOW-P"),
    openShadowButton: has("MARK-OPEN-SHADOW-BUTTON"),
    closedShadowP: has("MARK-CLOSED-SHADOW-P"), // 规范上说 document.querySelector 拿不到;实测见下
    slottedButton: has("MARK-SLOTTED-BUTTON"),
  },
  click: { light: clickLight, shadowInOpenRoot: clickShadow, slotted: clickSlotted },
  snapshotChars: text.length,
};
console.log("__SHADOW__" + JSON.stringify(verdict));

if (!verdict.visible.light) {
  console.log("__VERDICT__ FAIL:连光 DOM 文本都没进快照(先查快照本身)");
  process.exitCode = 1;
} else if (!verdict.visible.openShadowP || !verdict.visible.openShadowButton) {
  console.log("__VERDICT__ FAIL:开着的 shadow DOM 在快照里看不见(用户能看见,agent 却看不到)");
  process.exitCode = 1;
} else if (!clickLight.ok) {
  console.log("__VERDICT__ FAIL:连光 DOM 的按钮都点不动 ⇒ 后面的 shadow 点击结论不成立(对照失效)");
  process.exitCode = 1;
} else {
  console.log(
    "__VERDICT__ PASS:开着的 shadow DOM 在快照里可见;" +
      `点击:光 DOM ${clickLight.ok ? "OK" : "不行"} / shadow 内 ${clickShadow.ok ? "OK" : "不行"} /` +
      ` slot 投影 ${clickSlotted.ok ? "OK" : "不行"}`,
  );
}
