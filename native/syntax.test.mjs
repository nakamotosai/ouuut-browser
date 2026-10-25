// native/syntax.test.mjs —— 套件里的**语法闸**
//
// 为什么要有它:一个谁都没 import 的新文件里的语法错,测试是**看不见**的(测试只加载被引用到的模块)。
// 而语法错这类事(尤其**中文串里嵌 ASCII 双引号**、或**模板字符串里塞反引号**)用眼睛几乎发现不了,
// 一到运行时就是整套挂掉。2026-10-26:同一个坑在一个会话里踩了 6 次 —— 所以让每次 `node --test` 都查一遍。

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function listMjs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listMjs(abs, out);
    else if (e.isFile() && /\.(mjs|js)$/.test(e.name)) out.push(abs);
  }
  return out;
}

test("★ 语法闸:native/ 下每个 .mjs 都能解析(没被 import 的文件也要查)", () => {
  const files = listMjs(HERE);
  assert.ok(files.length > 30, `至少该有几十个文件,实际 ${files.length}`);
  const bad = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    } catch (err) {
      bad.push(`${path.relative(HERE, f)}: ${String(err.stderr ?? err.message).split("\n")[2] ?? ""}`);
    }
  }
  assert.deepEqual(bad, [], `解析不了的文件:\n${bad.join("\n")}`);
});
