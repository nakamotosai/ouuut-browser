#!/usr/bin/env python3
"""tools/preflight-deps-mirror.py —— 预检 DEPS 里所有 googlesource 依赖在镜像上是否存在。

**为什么需要它**

`tools/10-fetch-chromium.sh` 会用 git 的 `insteadOf` 把
`chromium.googlesource.com` 的若干前缀重写到 GitHub 镜像(为了绕开上游按 IP 的 429 限流)。
但重写**不是永远成立**的:

- `external/github.com/<org>/<repo>` **不一定**是 1:1 的仓库 ——
  有的指向**子目录**(如 `SeleniumHQ/selenium/py`、`llvm/llvm-project/clang/tools/clang-format/script`)
- 有的前缀映射少了 org(如 `.../v8/` 必须映射到 `github.com/v8/`,否则得到不存在的
  `github.com/v8.git`)

而 `gclient` 会因为**一个 dep 失败就把整个 `sync` 退出**。所以**必须提前知道哪些会失败**,
把它们写进 `.gclient` 的 `custom_deps`,值设 `None` 跳过。

**做法**:解析 `src/DEPS` → 对每个 googlesource 依赖算出重写后的 URL →
`git ls-remote` 探活 → 输出可直接粘进 `.gclient` 的跳过块。

**每次 rebase 到新 Chromium 版本后都该重跑一次** —— 新版本可能引入新的子目录型依赖。

用法:
    probe/.venv/Scripts/python.exe tools/preflight-deps-mirror.py
    probe/.venv/Scripts/python.exe tools/preflight-deps-mirror.py --json out.json
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import pathlib
import re
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEPS_FILE = REPO_ROOT / "chromium" / "src" / "DEPS"

# 与 tools/10-fetch-chromium.sh 里的 MIRROR_RULES **必须保持一致**。
# 改这里就要改那里(两处都写了注释互相指认)。
MIRROR_RULES: list[tuple[str, str]] = [
    ("https://chromium.googlesource.com/external/github.com/", "https://github.com/"),
    ("https://chromium.googlesource.com/webm/", "https://github.com/webmproject/"),
    ("https://chromium.googlesource.com/v8/", "https://github.com/v8/"),
]


def rewrite(url: str) -> str:
    """按**最长前缀**匹配应用镜像重写(与 git 的 insteadOf 语义一致)。"""
    best_from = ""
    best_to = ""
    for frm, to in MIRROR_RULES:
        if url.startswith(frm) and len(frm) > len(best_from):
            best_from, best_to = frm, to
    if not best_from:
        return url
    return best_to + url[len(best_from) :]


def load_deps() -> dict[str, str]:
    """执行 DEPS 拿到 deps 字典。

    DEPS 是合法的 Python(路径 -> URL 的字典赋值),里面用 `Var('name')` 引用文件顶部
    定义的 `vars` 字典。所以我们只要提供一个能看到 ns 的 `Var` 就能 exec。
    """
    src = DEPS_FILE.read_text(encoding="utf-8")
    src = re.sub(r"^\s*import .*$", "", src, flags=re.M)  # 去掉 import,我们自己供
    ns: dict = {
        "os": os,
        # gclient 的 DEPS 内建函数:Var(name) 取 vars[name];Str(x) 把值当字符串
        "Var": lambda name: ns["vars"][name],
        "Str": lambda s: s if isinstance(s, str) else str(s),
    }
    try:
        exec(compile(src, str(DEPS_FILE), "exec"), ns)  # noqa: S102
    except Exception as exc:  # pragma: no cover
        print(f"[fatal] 解析 DEPS 失败: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("        DEPS 的语法可能变了 —— 改用正则兜底或更新本工具。", file=sys.stderr)
        raise SystemExit(2)
    return ns.get("deps", {})


def strip_rev(url: str) -> tuple[str, str]:
    """DEPS 里形如 `<url>@<rev>`;拆成 (url, rev)。"""
    if "@" in url:
        u, rev = url.rsplit("@", 1)
        return u, rev
    return url, ""


def check(url: str, timeout: int = 45) -> tuple[str, bool, str]:
    try:
        r = subprocess.run(
            ["git", "ls-remote", "--exit-code", "--heads", url],
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"},
        )
        if r.returncode == 0:
            return url, True, ""
        err = (r.stderr or r.stdout).strip().splitlines()
        return url, False, (err[-1][:160] if err else f"rc={r.returncode}")
    except subprocess.TimeoutExpired:
        return url, False, f"TIMEOUT({timeout}s)"
    except Exception as exc:
        return url, False, repr(exc)[:160]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="", help="把结果写成 JSON")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--all", action="store_true", help="也检查不需要重写的依赖")
    ap.add_argument(
        "--emit-skips",
        action="store_true",
        help="只输出可直接嵌进 .gclient 的 custom_deps 跳过行(给 tools/10-fetch-chromium.sh 用)",
    )
    args = ap.parse_args()

    if not DEPS_FILE.is_file():
        print(f"[fatal] 找不到 {DEPS_FILE} —— 先跑 tools/10-fetch-chromium.sh", file=sys.stderr)
        return 2

    deps = load_deps()
    rows = []
    for path, raw in deps.items():
        if not isinstance(raw, str) or "chromium.googlesource.com" not in raw:
            continue
        url, rev = strip_rev(raw)
        new = rewrite(url)
        if not args.all and new == url:
            continue
        rows.append({"path": path, "orig": url, "mirror": new, "rev": rev, "rewritten": new != url})

    if not args.emit_skips:
        print(
            f"DEPS 里 googlesource 依赖共 {len(rows)} 项(其中需重写 "
            f"{sum(1 for r in rows if r['rewritten'])} 项),开始探活 …\n"
        )

    uniq = {r["mirror"] for r in rows}
    results: dict[str, tuple[bool, str]] = {}
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for url, ok, err in ex.map(check, sorted(uniq)):
            results[url] = (ok, err)

    bad = [r for r in rows if not results[r["mirror"]][0]]
    uniq_bad = sorted({x["path"]: x for x in bad}.values(), key=lambda x: x["path"])

    # 给脚本用的纯净输出:只要跳过行,不要任何装饰
    if args.emit_skips:
        for r in uniq_bad:
            print(f'      "{r["path"]}": None,   # {r["mirror"]}')
        return 0

    good_n = len(uniq) - len({r["mirror"] for r in bad})
    print(f"镜像可达 {good_n} / {len(uniq)} 个不同 URL\n")

    if bad:
        print("=" * 78)
        print("以下依赖在镜像上不可达 —— 把它们写进 chromium/.gclient 的 custom_deps,")
        print("值设 None 跳过(否则一个失败会让整个 gclient sync 退出):")
        print("=" * 78)
        for r in sorted({x["path"]: x for x in bad}.values(), key=lambda x: x["path"]):
            print(f'      "{r["path"]}": None,   # {r["mirror"]}')
            print(f"      #   ^ {results[r['mirror']][1]}")
    else:
        print("✅ 所有需要重写的依赖在镜像上都可达,不需要跳过名单")

    if args.json:
        pathlib.Path(args.json).write_text(
            json.dumps(
                {"rows": rows, "results": {k: {"ok": v[0], "err": v[1]} for k, v in results.items()}},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
            newline="\n",
        )
        print(f"\n全量结果: {args.json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
