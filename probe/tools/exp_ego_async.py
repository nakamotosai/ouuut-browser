"""定向实验:ego lite 的 `page.evaluate` 对**异步函数**怎么处理。

背景:`bot-detector` 探针用的是 `async () => {...}` 形式的提取函数。
在 ego 上取回的是 `{}` —— 怀疑它没有 await 页面侧的 Promise。
本实验把三种写法都试一遍,直接看返回什么。
"""

import json
import pathlib
import subprocess

EGO = r"<你的家目录>\.local\bin\ego-browser.cmd"
MARK = "__R__"
SCRIPT_DIR = pathlib.Path(r"F:/projects/ouuut-browser/probe/_ego_exp")
SCRIPT_DIR.mkdir(parents=True, exist_ok=True)

SETUP = """
const t = await taskSpace("m0-ego-exp");
const p = await t.newPage();
console.log('__R__' + JSON.stringify({label: p.label}));
"""

# 注意:这里的值必须是**表达式文本本身**(不带外层引号)。
# 脚本生成时会对它做一次 json.dumps → 变成正确的 JS 字符串字面量。
# 第一版把已经带引号的字符串又 dump 了一遍(双重编码),于是每个都被当成字符串字面量返回。
CASES = {
    "plain_expr": "document.title",
    "iife_sync": "(() => ({kind: 'iife_sync', title: document.title}))()",
    "iife_async": "(async () => ({kind: 'iife_async', title: document.title}))()",
    "iife_async_await": "(async () => { const r = await Promise.resolve(7); return {kind: 'iife_async_await', r, title: document.title}; })()",
    "fn_string_sync": "() => ({kind: 'fn_string_sync'})",
}

BODY = """
const t = await taskSpace("m0-ego-exp");
const p = t.page({label});
await p.goto("https://example.com");
const out = {{}};
{probes}
console.log('__R__' + JSON.stringify(out));
"""


def run_script(path: pathlib.Path, timeout: int = 180):
    with open(path, "rb") as fh:
        r = subprocess.run([EGO, "nodejs"], stdin=fh, capture_output=True, timeout=timeout)
    return (r.stdout or b"").decode("utf-8", "replace") + "\n" + (r.stderr or b"").decode("utf-8", "replace")


p0 = SCRIPT_DIR / "setup.mjs"
p0.write_text(SETUP, encoding="utf-8", newline="\n")
text = run_script(p0)
label = None
for line in text.splitlines():
    i = line.find(MARK)
    if i >= 0:
        label = json.loads(line[i + len(MARK) :])["label"]
print("label =", label, flush=True)

probes = []
for name, expr in CASES.items():
    probes.append(
        f"try {{ out[{json.dumps(name)}] = await p.evaluate({json.dumps(expr)}); }}"
        f" catch (e) {{ out[{json.dumps(name)}] = 'ERR: ' + String(e).slice(0, 200); }}"
    )
p1 = SCRIPT_DIR / "cases.mjs"
p1.write_text(BODY.format(label=json.dumps(label), probes="\n".join(probes)), encoding="utf-8", newline="\n")
text = run_script(p1)
print("=== 结果 ===", flush=True)
for line in text.splitlines():
    i = line.find(MARK)
    if i >= 0:
        print(json.dumps(json.loads(line[i + len(MARK) :]), ensure_ascii=False, indent=2))
        break
else:
    print("未取到结果,原始输出:")
    print(text[-2000:])
