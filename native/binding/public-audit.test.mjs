// native/binding/public-audit.test.mjs —— ADR-010 的材料审查闸
//
// 这道闸的失败模式有两种,都要守:
//   * **漏报**:该移出的材料还在 → 真出事
//   * **误报**:把正常文件判成违规 → 闸会被关掉,等于没有闸
// 所以下面既有"该拦的拦住",也有"不该拦的别拦"。

import test from "node:test";
import assert from "node:assert/strict";

import {
  ADR010_ITEMS,
  auditPaths,
  auditContent,
  auditPublicMaterial,
} from "./public-audit.mjs";

// 私钥标记故意拼出来:直接写完整字面量,这道闸会把它当成真的私钥内容。
// 这不是给闸开后门(没有 allowlist),是让测试数据不落成"看起来像密钥"的文本。
const PEM_HEAD = "-----BEGIN " + "PRIVATE KEY-----";

const reader = (map) => async (p) => {
  if (!(p in map)) throw new Error(`没有 ${p}`);
  return map[p];
};

// ---- 1. ADR-010 三项 ------------------------------------------------------

test("★ ADR-010 三项都在闸上(少一项这道闸就不完整)", () => {
  const paths = ADR010_ITEMS.map((i) => i.path ?? i.dir);
  assert.ok(paths.some((p) => p.includes("附录B-REA逆向结论.md")));
  assert.ok(paths.some((p) => p.includes("附录B-REA逆向结论-原文.md")));
  assert.ok(paths.some((p) => p === "re/ego-lite"));
  assert.ok(paths.some((p) => p.includes("方案-v1-竞品拆解.md")));
});

test("★ 该移出的文件还在 → 拦下,并说明为什么", () => {
  const r = auditPaths([
    "docs/附录B-REA逆向结论.md",
    "docs/里程碑.md",
    "docs/方案-v1-竞品拆解.md",
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 2);
  for (const v of r.violations) {
    assert.equal(v.kind, "adr-010");
    assert.ok(v.why.length > 5, "要说清为什么不能公开");
  }
});

test("★ 目录型条目:`re/ego-lite/` 下**任何**文件都算违规", () => {
  const r = auditPaths(["re/ego-lite/logs/run-001.txt", "re/ego-lite", "re/other/x.txt"]);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.violations.map((v) => v.path).sort(),
    ["re/ego-lite", "re/ego-lite/logs/run-001.txt"],
  );
});

test("★ 前缀相同但不同目录**不许**误伤(`re/ego-lite2` 不是 `re/ego-lite`)", () => {
  const r = auditPaths(["re/ego-lite2/x.txt"]);
  assert.equal(r.ok, true, "前缀匹配必须按路径段,不能按字符串前缀");
});

test("反斜杠路径也要认(Windows 检出)", () => {
  const r = auditPaths(["docs\\附录B-REA逆向结论.md"]);
  assert.equal(r.ok, false);
});

test("干净仓库 → 通过", () => {
  const r = auditPaths(["README.md", "native/binding/snapshot.mjs", "docs/里程碑.md"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

// ---- 2. 内容里的密钥 ------------------------------------------------------

test("★ 私钥内容 → 拦下", () => {
  const r = auditContent({ path: "x.md", content: `${PEM_HEAD}\nabc\n` });
  assert.equal(r.ok, false);
  assert.match(r.violations[0].why, /私钥/);
});

test("★ 各类 token 都要认", () => {
  const cases = [
    "ghp_" + "a".repeat(36),
    "github_pat_" + "b".repeat(60),
    "AKIA" + "C".repeat(16),
    "sk-" + "d".repeat(40),
  ];
  for (const c of cases) {
    const r = auditContent({ path: "x.env", content: `TOKEN=${c}` });
    assert.equal(r.ok, false, `${c.slice(0, 12)}… 应被拦下`);
  }
});

test("★ 不该误报:普通文本里出现 'key' / 'token' 这类词不算", () => {
  const r = auditContent({
    path: "README.md",
    content: "设置 API key 请用环境变量;token 不落日志。见 docs/决策记录.md。",
  });
  assert.equal(r.ok, true, "只认高信号模式,不认关键词");
});

test("短得像占位符的字符串不误报", () => {
  const r = auditContent({ path: "x.md", content: "示例:sk-xxxx" });
  assert.equal(r.ok, true);
});

// ---- 3. 组合审查 ----------------------------------------------------------

test("★ 组合审查:路径与内容都查", async () => {
  const files = ["README.md", "docs/附录B-REA逆向结论.md", "leak.md"];
  const r = await auditPublicMaterial({
    files,
    readFile: reader({
      "README.md": "# 项目说明\n正常内容",
      "docs/附录B-REA逆向结论.md": "分析记录",
      "leak.md": `${PEM_HEAD}\nzzz`,
    }),
  });
  assert.equal(r.ok, false);
  const kinds = r.violations.map((v) => v.kind).sort();
  assert.deepEqual(kinds, ["adr-010", "secret"]);
});

test("★ 二进制文件不查内容(读成乱码只会误报)", async () => {
  const r = await auditPublicMaterial({
    files: ["chrome.dll"],
    readFile: async () => PEM_HEAD,
  });
  assert.equal(r.ok, true, ".dll 不该被当文本扫");
});

test("读不到的文件跳过,不因此判失败", async () => {
  const r = await auditPublicMaterial({
    files: ["gone.md"],
    readFile: async () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(r.ok, true);
});

test("skipContent 里的前缀整棵跳过", async () => {
  const r = await auditPublicMaterial({
    files: ["vendor/x.md"],
    readFile: async () => PEM_HEAD,
    skipContent: ["vendor"],
  });
  assert.equal(r.ok, true);
});
