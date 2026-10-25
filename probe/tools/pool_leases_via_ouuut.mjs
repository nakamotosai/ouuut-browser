// probe/tools/pool_leases_via_ouuut.mjs —— P3「轮换」的取证(真网络)
//
// 用法(仓库根):`node probe/tools/pool_leases_via_ouuut.mjs`
//
// 验三件事(前两件要真出口,第三件要真拒绝):
//   1. **两个档案 = 两个出口**:一次会话里 A/B 各领一条节点,出口 IP **不相同**;
//   2. **会话中途不换出口**:同一个档案连量两次,IP **相同**(ADR-013 的"一次访问一个 IP");
//   3. **独占**:池里只有一条节点却要两个档案 ⇒ **拒绝启动**(宁可不开,也不共用出口)。
//
// 节点用 ADR-013 记的那批固定出口(`198.51.100.7:41105+NN`,已扫过 STICKY、无需认证)。

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "native", "bin", "ouuut.mjs");

const NODE_JP_1 = { id: "jp-41105", url: "socks5://198.51.100.7:41105", country: "JP", note: "ADR-013 记的固定出口" };
const NODE_JP_2 = { id: "jp-41106", url: "socks5://198.51.100.7:41106", country: "JP", note: "同上,`41105+NN` 里的第二条" };

/** 脚本侧:每个档案各开一张页、量一次出口;A 量**两次**用来证明中途没换出口。 */
const SCRIPT = [
  // 量出口用**产品自己的仪表**(runtime.probeEgressIp):它复用 createTab,
  // 把自检页建在**当前选中档案**的 context 里,量完自己收掉。
  // ⚠️ 不走 harness 的 taskSpace/newPage:那套一次只认一个空间
  //    (两个空间同时在会报「new task space expected one default tab, found 2」,实测)。
  "const ipOf = async () => {",
  "  try { return await ouuut.probeEgressIp(); }",
  "  catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 120); }",
  "};",
  "await ouuut.createTaskSpace('pool-a', 'A');",
  "const ipA = await ipOf();",
  "const ipA2 = await ipOf();",
  "await ouuut.createTaskSpace('pool-b', 'B');",
  "const ipB = await ipOf();",
  "console.log('__POOL__' + JSON.stringify({ ipA, ipA2, ipB }));",
].join("\n");

async function writePool(nodes) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ouuut-pool-accept-"));
  const file = path.join(dir, "pool.json");
  await fsp.writeFile(file, `${JSON.stringify({ nodes }, null, 2)}\n`, "utf8");
  return { dir, file };
}

function runPool({ poolFile, profiles, timeoutMs = 240000 }) {
  const child = spawn(
    process.execPath,
    [CLI, "nodejs", "--headless", "--proxy-pool", poolFile, "--profiles", JSON.stringify(profiles)],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.write(SCRIPT);
  child.stdin.end();
  const code = new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  return { code, out: () => out, err: () => err };
}

const leasesOf = (err) => [...err.matchAll(/出口租约:档案 (\S+) → 节点 (\S+)\(([^)]*)\)/g)].map((m) => ({ profile: m[1], node: m[2], redacted: m[3] }));
const problems = [];

// ---- 场景 1:两条节点 + 两个档案 -------------------------------------------------
const two = await writePool([NODE_JP_1, NODE_JP_2]);
const r1 = runPool({
  poolFile: two.file,
  profiles: [
    { id: "A", kind: "disposable" },
    { id: "B", kind: "disposable" },
  ],
});
const code1 = await r1.code;
const err1 = r1.err();
const out1 = r1.out();
const leases1 = leasesOf(err1);
const m = /__POOL__(\{.*\})/.exec(out1);
const ips = m ? JSON.parse(m[1]) : null;
let after = null;
try {
  after = JSON.parse(await fsp.readFile(`${two.file}.leases.json`, "utf8"));
} catch (err) {
  problems.push(`租约表没读到:${err?.message ?? err}`);
}

if (code1 !== 0) problems.push(`场景 1 退出码 ${code1}(应当 0);stderr 尾部:${err1.slice(-400)}`);
if (!ips) problems.push("场景 1 没拿到出口读数(脚本没跑到)");
if (leases1.length !== 2) problems.push(`应当正好两条租约,实际 ${leases1.length}:${JSON.stringify(leases1)}`);
if (leases1[0] && leases1[1] && leases1[0].node === leases1[1].node) problems.push("两个档案领到了**同一条**节点(独占被破坏了)");
if (ips) {
  for (const [k, v] of Object.entries(ips)) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(v))) problems.push(`场景 1 出口读数不合法 ${k}=${v}`);
  }
  if (ips.ipA === ips.ipB) problems.push(`两个档案出口 IP 相同(${ips.ipA})—— 那等于把两个身份连起来`);
  if (ips.ipA !== ips.ipA2) problems.push(`同一个档案两次量的出口不同(${ips.ipA} → ${ips.ipA2})—— 会话中途换出口了`);
}
if (after) {
  if (Object.keys(after.leases ?? {}).length !== 0) problems.push(`会话结束后租约没还干净:${JSON.stringify(after.leases)}`);
  if (Object.keys(after.pins ?? {}).length !== 0) problems.push(`disposable 不该留下钉子:${JSON.stringify(after.pins)}`);
}

// ---- 场景 3:persona(长期身份)**不轮换** —— 两次会话领**同一条**节点 ----------
const SCRIPT_PERSONA = ["const ip = await ouuut.probeEgressIp();", "console.log('__POOL__' + JSON.stringify({ ip }));"].join("\n");

function runPersona(poolFile) {
  const child = spawn(
    process.execPath,
    [CLI, "nodejs", "--headless", "--proxy-pool", poolFile, "--profile-kind", "persona"],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.write(SCRIPT_PERSONA);
  child.stdin.end();
  const code = new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  return { code, out: () => out, err: () => err };
}

const persona = await writePool([NODE_JP_1, NODE_JP_2]);
const p1 = runPersona(persona.file);
const pc1 = await p1.code;
const perr1 = p1.err();
const pips1 = /__POOL__(\{.*\})/.exec(p1.out());
const p2 = runPersona(persona.file);
const pc2 = await p2.code;
const perr2 = p2.err();
const pips2 = /__POOL__(\{.*\})/.exec(p2.out());
const nodeOf = (err) => leasesOf(err)[0]?.node ?? null;
let personaState = null;
try {
  personaState = JSON.parse(await fsp.readFile(`${persona.file}.leases.json`, "utf8"));
} catch {
  personaState = null;
}

if (pc1 !== 0 || pc2 !== 0) problems.push(`场景 3 两次会话的退出码应当都是 0,实际 ${pc1} / ${pc2}`);
if (!nodeOf(perr1) || nodeOf(perr1) !== nodeOf(perr2)) {
  problems.push(`长期身份换了出口:第一次 ${nodeOf(perr1)},第二次 ${nodeOf(perr2)}`);
}
const pIp = (m) => (m ? JSON.parse(m[1]).ip : null);
if (pIp(pips1) !== pIp(pips2)) problems.push(`长期身份两次的出口 IP 不同(${pIp(pips1)} → ${pIp(pips2)})`);
// persona 没给 id 时用 kind 当 id(session-profiles 的已定规矩)⇒ 钉子的键是 persona
if (!personaState?.pins?.persona) problems.push(`钉子没落盘:${JSON.stringify(personaState?.pins ?? null)}`);
if (personaState && Object.keys(personaState.leases ?? {}).length !== 0) problems.push("场景 3 结束后租约没还干净");
await fsp.rm(persona.dir, { recursive: true, force: true });

// ---- 场景 2:一条节点 + 两个档案 ⇒ 拒绝启动 ------------------------------------
const one = await writePool([NODE_JP_1]);
const r2 = runPool({
  poolFile: one.file,
  profiles: [
    { id: "A", kind: "disposable" },
    { id: "B", kind: "disposable" },
  ],
});
const code2 = await r2.code;
const err2 = r2.err();
let leases2 = null;
try {
  leases2 = JSON.parse(await fsp.readFile(`${one.file}.leases.json`, "utf8"));
} catch {
  leases2 = { leases: {}, pins: {}, dead: {} };
}
if (code2 !== 2) problems.push(`场景 2 的退出码应当是 2(拒绝启动),实际 ${code2}`);
if (!/没有空闲节点|OUUUT_POOL_EXHAUSTED/.test(err2)) problems.push(`场景 2 的拒绝理由不对:${err2.slice(-300)}`);
if (/__POOL__/.test(r2.out())) problems.push("场景 2 拒绝之后还跑了脚本(应当**在起浏览器之前**就失败)");
if (leases2 && Object.keys(leases2.leases ?? {}).length !== 0) problems.push(`场景 2 留下了半场租约:${JSON.stringify(leases2.leases)}`);

await fsp.rm(two.dir, { recursive: true, force: true });
await fsp.rm(one.dir, { recursive: true, force: true });

console.log(
  "__POOL_REPORT__" +
    JSON.stringify({
      scenario1: { exit: code1, leases: leases1, ips, leasesAfter: after },
      scenario2: { exit: code2, tail: err2.slice(-300), leasesAfter: leases2?.leases ?? null },
      scenario3: {
        exit: [pc1, pc2],
        node: [nodeOf(perr1), nodeOf(perr2)],
        ip: [pIp(pips1), pIp(pips2)],
        pins: personaState?.pins ?? null,
      },
      problems,
    }),
);

if (problems.length === 0) {
  console.log(
    `__VERDICT__ PASS:两档案两出口(A=${ips.ipA} B=${ips.ipB}),同一档案两次同 IP(${ips.ipA2});` +
      `长期身份(persona)两次会话都钉在 ${nodeOf(perr1)} 上、出口 ${pIp(pips1)} 不变;` +
      "会话结束租约还干净;池不够时**拒绝启动**(rc=2)且不留半场租约。",
  );
} else {
  console.log(`__VERDICT__ FAIL:${problems.join(" | ")}`);
  process.exitCode = 1;
}