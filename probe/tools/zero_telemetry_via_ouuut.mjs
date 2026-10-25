// probe/tools/zero_telemetry_via_ouuut.mjs —— P9 的「零遥测」取证
//
// 用法(仓库根):`node probe/tools/zero_telemetry_via_ouuut.mjs`
//
// 做法(可复跑、**不需要管理员权限**):
//   1. 起一个**记录式 SOCKS5**(`egress_watch_socks5.mjs`):全部拒绝转发 ⇒ 本机零出网;
//   2. 用 `--proxy` 把浏览器指过去,跑一段**只用本地页**(about:blank + 页面内造 DOM)的核心链路;
//   3. 断言:核心链路全功能可用(**不依赖公网**)、且浏览器**只连了我们让它连的东西**。
//
// ⚠️ 局限(诚实写在这里):这只能看见**走代理**的流量。所以要另外确认"代理确实生效了" ——
//    否则"清单很短"可能只是因为压根没走代理。下面用"访问公网地址必然失败"来确认这一点。
//    `pktmon` 抓包那一步(P9 原文)仍**未做**。

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startEgressWatcher } from "./egress_watch_socks5.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "native", "bin", "ouuut.mjs");

/** 注入页面的那段用**单引号**写,避免与外层拼接打架。 */
const INJECT = [
  "(() => {",
  "  const b = document.createElement('button');",
  "  b.id = 'b'; b.textContent = 'MARK-BTN';",
  "  b.onclick = () => { document.title = 'clicked'; };",
  "  document.body.appendChild(b);",
  "})()",
].join("\n");

/** 只用本地页的核心链路(顶层 await —— harness 就是按 async 体跑脚本的)。 */
const SCRIPT = [
  'const t = await taskSpace("p9-telemetry");',
  "const p = await t.newPage();",
  'await p.goto("about:blank");',
  `await p.evaluate(${JSON.stringify(INJECT)});`,
  "await p.waitForTimeout(200);",
  "const snap = String(await p.snapshot());",
  'await p.click("#b", { timeout: 3000 });',
  'const title = await p.evaluate("document.title");',
  "// 顺带确认「代理真的生效」:公网地址必须**连不上**(否则说明走了直连,清单就不算数)",
  "let publicOk = null;",
  "try {",
  '  await p.goto("https://api.ipify.org", { timeout: 8000 });',
  `  publicOk = String(await p.evaluate("document.body ? document.body.innerText : ''")).trim();`,
  "} catch (e) {",
  '  publicOk = "FAILED:" + String(e && e.message).slice(0, 60);',
  "}",
  'console.log("__ZERO__" + JSON.stringify({',
  '  snapshotHasBtn: snap.includes("MARK-BTN"),',
  '  clickWorked: title === "clicked",',
  "  publicReachable: publicOk,",
  "}));",
].join("\n");

const watcher = await startEgressWatcher();
const child = spawn(
  process.execPath,
  [CLI, "nodejs", "--headless", "--proxy", `socks5://127.0.0.1:${watcher.port}`],
  { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
);
let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
child.stdin.write(SCRIPT);
child.stdin.end();

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  child.on("close", (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});
await watcher.close();

const m = /__ZERO__(\{.*\})/.exec(out);
const core = m ? JSON.parse(m[1]) : null;
const hosts = watcher.hosts();
const expected = new Set(["api.ipify.org", "127.0.0.1", "localhost"]);
const unexpected = hosts.filter((h) => !expected.has(h));

console.log(
  "__ZERO_REPORT__" +
    JSON.stringify({ cliExitCode: code, core, attemptedHosts: hosts, attempts: watcher.seen, unexpected }),
);

const problems = [];
if (!core) {
  problems.push("没拿到核心链路的读数(脚本没跑完?)");
  process.stderr.write(`—— 子进程 stderr(前 600 字符):\n${err.slice(0, 600)}\n`);
  process.stderr.write(`—— 子进程 stdout(前 600 字符):\n${out.slice(0, 600)}\n`);
} else {
  if (!core.snapshotHasBtn) problems.push("本地页的快照里看不到按钮");
  if (!core.clickWorked) problems.push("本地页点不动(动作路径有问题)");
  if (typeof core.publicReachable === "string" && !core.publicReachable.startsWith("FAILED:")) {
    problems.push(`公网竟然可达(${core.publicReachable})⇒ 代理没生效,本清单不算数`);
  }
}
if (unexpected.length > 0) problems.push(`出现了意料外的目标主机:${JSON.stringify(unexpected)}`);

if (problems.length === 0) {
  console.log(`__VERDICT__ PASS:无出网下核心链路可用;浏览器尝试的目标只有 ${JSON.stringify(hosts)}`);
} else {
  console.log("__VERDICT__ FAIL:" + problems.join(";"));
  process.exitCode = 1;
}
