// native/binding/public-audit.mjs —— 「转 public」前的材料审查(ADR-010)
//
// ADR-010 定了三样东西**不许进公开仓库**:
//   1. `docs/附录B-REA逆向结论.md` / `-原文.md` —— 对 ego lite 二进制的静态分析记录
//   2. `re/ego-lite/` —— REA 任务日志与原始输出
//   3. `docs/方案-v1-竞品拆解.md` —— CloakBrowser 的实测细节
//
// 理由不是"我们做错了",而是:private 仓库里留着自研用,与**对外发布**是两件事 ——
// 后者可能被解读成协助他人逆向,或构成对上游条款的公开挑战。
// 我们的公开价值是**代码与基准**,不是对别人二进制的分析报告。
//
// 这个模块把那条决策变成**可执行的一道闸**,而不是一句"记得删"。

/** ADR-010 的三项。`dir` 表示整棵子树。 */
export const ADR010_ITEMS = Object.freeze([
  {
    path: "docs/附录B-REA逆向结论.md",
    why: "对 ego lite 二进制的静态分析结论(ADR-010 第 1 项)",
  },
  {
    path: "docs/附录B-REA逆向结论-原文.md",
    why: "同上,原文版(ADR-010 第 1 项)",
  },
  {
    dir: "re/ego-lite",
    why: "REA 任务日志与原始输出(ADR-010 第 2 项)",
  },
  {
    path: "docs/方案-v1-竞品拆解.md",
    why: "CloakBrowser 的实测细节(ADR-010 第 3 项)",
  },
]);

/**
 * 内容里**绝不该出现**的东西。高信号模式,不追求覆盖一切 ——
 * 一道会误报的闸最终会被关掉,那等于没有闸。
 */
export const SECRET_PATTERNS = Object.freeze([
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "私钥内容" },
  { re: /\bghp_[A-Za-z0-9]{36}\b/, why: "GitHub personal access token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/, why: "GitHub fine-grained token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS access key id" },
  { re: /\bsk-[A-Za-z0-9]{32,}\b/, why: "OpenAI 风格 API key" },
]);

/**
 * ADR-010 移出之后,文档里**不该再指向**那些不存在的文件 —— 对公开读者来说那是死链(P12 的判据之一)。
 * 允许的唯一形式:**同一行里说明了**「已移出」或引用了 ADR-010(真相源索引里那种删除线条目就该这么写)。
 */
export const MOVED_OUT_REFS = Object.freeze([
  /附录B-REA逆向结论-原文\.md/,
  /附录B-REA逆向结论\.md/,
  /方案-v1-竞品拆解\.md/,
  /re\/ego-lite(?:\/|\b)/,
]);

/** 只看**这一行**有没有把话说清楚,不做跨行推断(免得"闸"变成猜谜)。 */
const EXPLAINED = /已移出|未公开|ADR-010/;

/**
 * 豁免清单 —— 只有三类,每类都有理由:
 *   1. `docs/决策记录.md`:ADR-010 自己的记录,它就是"什么移出去了"的权威,必须点名这些路径;
 *   2. 本文件与它的用例:**必须**把路径写下来才谈得上检查它们(不豁免就成了自指假阳性)。
 */
export const DANGLING_EXEMPT = Object.freeze([
  "docs/决策记录.md",
  "native/binding/public-audit.mjs",
  "native/binding/public-audit.test.mjs",
]);

/**
 * 查内容里指向**已移出材料**的死链。
 *
 * @param {{path: string, content: string}} o
 */
export function auditDanglingRefs({ path: p, content } = {}) {
  const file = norm(p);
  if (DANGLING_EXEMPT.includes(file)) return { ok: true, violations: [] };
  const violations = [];
  const lines = String(content ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!MOVED_OUT_REFS.some((re) => re.test(line))) continue;
    if (EXPLAINED.test(line)) continue;
    violations.push({
      path: `${file}:${i + 1}`,
      kind: "dangling",
      why: "指向 ADR-010 已移出的材料 —— 公开仓库里是死链;要留就把这一行改成「已移出仓库,见 ADR-010」",
    });
  }
  return { ok: violations.length === 0, violations };
}

/** 路径归一:`\` → `/`,去掉开头的 `./`。 */
const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * 只查路径。给"还没有文件内容"的场合用(比如只看 `git ls-files`)。
 *
 * @param {string[]} files 仓库相对路径列表
 */
export function auditPaths(files = []) {
  const list = files.map(norm);
  const violations = [];
  for (const item of ADR010_ITEMS) {
    const target = norm(item.path ?? item.dir);
    const hit = item.dir
      ? list.filter((f) => f === target || f.startsWith(`${target}/`))
      : list.filter((f) => f === target);
    for (const f of hit) violations.push({ path: f, kind: "adr-010", why: item.why });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 查内容里的密钥类字符串。
 *
 * @param {{path: string, content: string}} o
 */
export function auditContent({ path: p, content } = {}) {
  const text = String(content ?? "");
  const violations = [];
  for (const { re, why } of SECRET_PATTERNS) {
    if (re.test(text)) violations.push({ path: norm(p), kind: "secret", why });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 完整审查:路径 + 内容。
 *
 * @param {object} o
 * @param {string[]} o.files 仓库相对路径列表
 * @param {(p: string) => Promise<string>} [o.readFile] 给了才查内容
 * @param {string[]} [o.skipContent] 不查内容的路径前缀(二进制等)
 */
export async function auditPublicMaterial({ files = [], readFile = null, skipContent = [] } = {}) {
  const pathResult = auditPaths(files);
  const violations = [...pathResult.violations];

  if (typeof readFile === "function") {
    const skip = skipContent.map(norm);
    for (const f of files.map(norm)) {
      if (skip.some((s) => f === s || f.startsWith(`${s}/`))) continue;
      // 只查文本类;二进制读成乱码没有意义,反而会误报
      if (!/\.(md|txt|json|mjs|js|cjs|ts|py|sh|ps1|ya?ml|toml|ini|cfg|html|css)$/i.test(f)) continue;
      let content;
      try {
        content = await readFile(f);
      } catch {
        continue; // 读不到就跳过(比如软链),不因此判失败
      }
      violations.push(...auditContent({ path: f, content }).violations);
      violations.push(...auditDanglingRefs({ path: f, content }).violations);
    }
  }

  return { ok: violations.length === 0, violations };
}
