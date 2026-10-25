// native/serve/trajectory.mjs —— MCP 工具调用的**轨迹记录**(JSONL)
//
// 为什么要它:agent 跑完一串操作之后,"它到底做了什么"不能只存在于宿主的内存里。
// 轨迹是**可复盘的证据**:每次 `tools/call` 追加一行,失败也记(失败的调用最值得看)。
//
// ## 三条硬约束(不是风格)
//
// 1. **绝不污染 stdout** —— stdout 是 JSON-RPC 通道(见 `mcp.mjs` 抬头)。本文件只写文件,
//    出错时最多往 stderr 说一句,而且**只说一次**(别让一个只读目录刷满日志)。
// 2. **绝不落敏感值** —— cookie / Authorization / token / 代理凭据一律脱敏。
//    脱敏放在**写盘前的最后一步**(整条 entry 过一遍),而不是"记得给某个字段脱敏"。
// 3. **默认不落在仓库里** —— 默认目录是系统临时目录;要用仓库里的 `runs/` 得显式给
//    `OUUUT_MCP_RUNS_DIR`,且 `.gitignore` 已经兜住 `/runs/`。
//
// ## 快照单独存
//
// 快照正文是**产品输出**,动辄几百上千字符。塞进 JSONL 会让轨迹不可读、也不好 diff。
// 所以正文写 `snapshots/<seq>-<label>.txt`,轨迹行里只留**字符数 + 相对路径**。
// 批量里每一步的快照同样单独存(`batch-<index>-snapshot`)。

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** 轨迹根目录的环境变量(不给就用系统临时目录)。 */
export const RUNS_DIR_ENV = "OUUUT_MCP_RUNS_DIR";
/** 会话 id 的环境变量(不给就按时间 + pid + 随机数生成)。 */
export const SESSION_ID_ENV = "OUUUT_MCP_SESSION_ID";

/** 轨迹根目录。默认 `os.tmpdir()/ouuut-mcp-runs` —— 绝不默认写进仓库。 */
export function resolveRunsDir(env = process.env) {
  const raw = env?.[RUNS_DIR_ENV];
  if (typeof raw === "string" && raw.trim() !== "") return path.resolve(raw.trim());
  return path.join(os.tmpdir(), "ouuut-mcp-runs");
}

/** `YYYYMMDD-HHmmss-<pid>-<8 hex>`:按时间可排序,同时避免同秒多进程撞车。 */
export function newSessionId({
  now = new Date(),
  pid = process.pid,
  random = () => randomBytes(4).toString("hex"),
} = {}) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  return `${stamp}-${pid}-${random()}`;
}

/** 键名像秘密的字段 —— 命中就整值替换,不看值长什么样。 */
const SECRET_KEY_RE =
  /(cookie|authorization|proxy-authorization|token|secret|password|passwd|api[_-]?key|credential)/i;

/** URL 里的 `user:pass@` —— 代理串与带凭据的地址都会命中。 */
const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi;

/** URL 查询串里的秘密参数(OAuth token / api key / 签名)—— 值可能是凭据,整段抹掉。 */
const URL_SECRET_QUERY_RE =
  /([?&](?:access_token|id_token|refresh_token|token|api[_-]?key|apikey|key|secret|password|passwd|auth|signature|sig)=)([^&#\s]*)/gi;

const REDACTED = "[redacted]";

function redactString(value, maxString) {
  let out = String(value)
    .replace(URL_CREDENTIALS_RE, "$1***@")
    .replace(URL_SECRET_QUERY_RE, `$1${REDACTED}`);
  if (out.length > maxString) out = `${out.slice(0, maxString)}…(+${out.length - maxString})`;
  return out;
}

/**
 * 深度脱敏 + 截断。**导出是为了让用例直接钉住**(脱敏这种事靠人眼 review 不可靠)。
 *
 * @param {unknown} value
 * @param {{maxString?: number, maxDepth?: number}} [opts]
 */
export function redactForRecord(value, { maxString = 2000, maxDepth = 8 } = {}) {
  const walk = (node, depth) => {
    if (node === null || node === undefined) return node;
    if (typeof node === "string") return redactString(node, maxString);
    if (typeof node === "number" || typeof node === "boolean") return node;
    if (typeof node === "bigint") return String(node);
    if (typeof node === "function" || typeof node === "symbol") return String(node);
    if (depth >= maxDepth) return "[depth-limit]";
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (typeof node === "object") {
      const out = {};
      for (const [key, val] of Object.entries(node)) {
        out[key] = SECRET_KEY_RE.test(key) ? REDACTED : walk(val, depth + 1);
      }
      return out;
    }
    return String(node);
  };
  return walk(value, 0);
}

function resultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
}

/**
 * 一次工具调用的**摘要**(轨迹里不该出现整段快照正文)。
 *
 * @param {string} tool
 * @param {object} result  MCP 工具结果 `{content, isError?}`
 * @param {(label: string, text: string) => Promise<string>} saveSnapshot
 */
async function summarizeResult(tool, result, saveSnapshot) {
  const isError = Boolean(result?.isError);
  const text = resultText(result);

  if (tool === "browser_snapshot") {
    const file = await saveSnapshot("browser_snapshot", text);
    return { isError, textChars: text.length, file };
  }

  if (tool === "browser_batch") {
    const parsed = JSON.parse(text); // 坏形状由调用方兜底
    const steps = [];
    for (const step of Array.isArray(parsed?.steps) ? parsed.steps : []) {
      const summary = {
        index: step?.index,
        op: step?.op,
        ok: Boolean(step?.ok),
        durationMs: step?.durationMs,
      };
      if (!step?.ok) summary.error = step?.error ?? null;
      else if (step?.op === "snapshot" && typeof step?.result?.text === "string") {
        const file = await saveSnapshot(`batch-${step.index}-snapshot`, step.result.text);
        summary.result = { textChars: step.result.text.length, file };
      } else summary.result = redactForRecord(step?.result ?? null);
      steps.push(summary);
    }
    return {
      isError,
      ok: Boolean(parsed?.ok),
      stoppedAt: parsed?.stoppedAt ?? null,
      continueOnError: Boolean(parsed?.continueOnError),
      steps,
    };
  }

  // 其余工具的结果本来就是小对象(JSON 文本):解析后脱敏,解析不了就截断存文本。
  try {
    return { isError, result: redactForRecord(JSON.parse(text)) };
  } catch {
    return { isError, text: redactString(text, 2000) };
  }
}

/**
 * 建一个轨迹记录器。**懒建目录** —— 只有真的发生了 `tools/call` 才落盘
 * (一个只发 `tools/list` 的会话不该在磁盘上留垃圾)。
 *
 * @param {object} [o]
 * @param {string} [o.runsDir]   轨迹根目录(默认 `resolveRunsDir()`)
 * @param {string} [o.sessionId] 会话 id(默认 `newSessionId()`)
 * @param {NodeJS.WritableStream} [o.stderr] 失败提示走这里(**绝不走 stdout**)
 * @param {() => Date} [o.now]
 */
export function createTrajectoryRecorder({
  runsDir = resolveRunsDir(),
  sessionId = newSessionId(),
  stderr = process.stderr,
  now = () => new Date(),
} = {}) {
  const dir = path.join(runsDir, sessionId);
  const snapshotDir = path.join(dir, "snapshots");
  const trajectoryPath = path.join(dir, "trajectory.jsonl");
  let seq = 0;
  let warned = false;

  const warn = (err) => {
    if (warned) return;
    warned = true;
    try {
      stderr.write(
        `[ouuut-mcp] 轨迹写入失败(${trajectoryPath}):${err?.message ?? err};后续失败不再提示\n`,
      );
    } catch {
      /* stderr 都坏了就没什么可做的了 */
    }
  };

  const saveSnapshot = async (label, text) => {
    await mkdir(snapshotDir, { recursive: true });
    const name = `${String(seq).padStart(4, "0")}-${label}.txt`;
    await writeFile(path.join(snapshotDir, name), String(text ?? ""), "utf8");
    return `snapshots/${name}`;
  };

  /**
   * 记一次工具调用。**永不抛** —— 轨迹是旁路,不该把主流程(协议响应)带崩。
   *
   * @param {object} o
   * @param {string} o.tool
   * @param {unknown} [o.args]
   * @param {boolean} o.ok
   * @param {object} [o.result] MCP 结果
   * @param {Error} [o.error]
   * @param {number} o.durationMs
   * @returns {Promise<object|null>} 真正写进去的那一行(测试/调试用)
   */
  async function recordToolCall({ tool, args, ok, result, error, durationMs }) {
    seq += 1;
    const entry = {
      ts: now().toISOString(),
      sessionId,
      seq,
      tool: String(tool),
      args: redactForRecord(args ?? {}),
      ok: Boolean(ok),
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    };
    try {
      // 有 result 就记 result(失败的 batch 也是 result:它带着每步的错误)。
      if (result !== undefined) {
        try {
          entry.result = await summarizeResult(tool, result, saveSnapshot);
        } catch (err) {
          entry.result = { summaryError: String(err?.message ?? err) };
        }
      }
      // 只有**抛出**的失败才另记一条 error;batch 的逐步错误已经在 result.steps 里。
      if (!ok && error) {
        entry.error = {
          message: redactString(error?.message ?? error, 2000),
          code: error?.error_code ?? null,
        };
      }
      await mkdir(dir, { recursive: true });
      await appendFile(trajectoryPath, JSON.stringify(redactForRecord(entry)) + "\n", "utf8");
      return entry;
    } catch (err) {
      warn(err);
      return null;
    }
  }

  return { runsDir, sessionId, dir, trajectoryPath, recordToolCall, saveSnapshot };
}
