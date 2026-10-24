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
import time
import warnings

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEPS_FILE = REPO_ROOT / "chromium" / "src" / "DEPS"

# 与 tools/10-fetch-chromium.sh 里的 MIRROR_RULES **必须保持一致**。
# 改这里就要改那里(两处都写了注释互相指认)。
#
# 「排除」规则 = 更长前缀 + 映射到自己 → 该子树留在 googlesource
# (那里有合成的子目录仓库,GitHub 上没有对应仓库)。
MIRROR_RULES: list[tuple[str, str]] = [
    ("https://chromium.googlesource.com/external/github.com/", "https://github.com/"),
    ("https://chromium.googlesource.com/webm/", "https://github.com/webmproject/"),
    ("https://chromium.googlesource.com/v8/v8.git", "https://github.com/v8/v8.git"),
    (
        "https://chromium.googlesource.com/external/github.com/llvm/",
        "https://chromium.googlesource.com/external/github.com/llvm/",
    ),
    (
        "https://chromium.googlesource.com/external/github.com/SeleniumHQ/",
        "https://chromium.googlesource.com/external/github.com/SeleniumHQ/",
    ),
    # googlesource 上的合成仓库名是 `google/cld_3`;GitHub 上是 `google/cld3`(无下划线)
    (
        "https://chromium.googlesource.com/external/github.com/google/cld_3.git",
        "https://chromium.googlesource.com/external/github.com/google/cld_3.git",
    ),
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


def load_deps_from(path: pathlib.Path) -> dict[str, str]:
    """执行一个 DEPS 文件拿到 deps 字典。

    DEPS 是合法的 Python(路径 -> URL 的字典赋值),里面用 `Var('name')` 引用文件顶部
    定义的 `vars` 字典。所以我们只要提供一个能看到 ns 的 `Var` 就能 exec。
    """
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"^\s*import .*$", "", src, flags=re.M)  # 去掉 import,我们自己供
    ns: dict = {
        "os": os,
        # gclient 的 DEPS 内建函数:Var(name) 取 vars[name];Str(x) 把值当字符串
        "Var": lambda name: ns["vars"][name],
        "Str": lambda s: s if isinstance(s, str) else str(s),
    }
    try:
        # 嵌套 DEPS 里有正则字符串(如 v8 的 "a\.cc"),exec 时会刷一屏 SyntaxWarning。
        # 与我们要的信息无关,压掉。
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            exec(compile(src, str(path), "exec"), ns)
    except Exception as exc:  # pragma: no cover
        print(f"[fatal] 解析 {path} 失败: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("        该文件的语法可能变了 —— 改用正则兜底或更新本工具。", file=sys.stderr)
        raise SystemExit(2) from exc
    return ns.get("deps", {})


def load_deps() -> dict[str, str]:
    return load_deps_from(DEPS_FILE)


def strip_rev(url: str) -> tuple[str, str]:
    """DEPS 里形如 `<url>@<rev>`;拆成 (url, rev)。"""
    if "@" in url:
        u, rev = url.rsplit("@", 1)
        return u, rev
    return url, ""


# 判定分类:**必须**区分「仓库不存在」与「被限流/超时」。
# 混为一谈会出**致命的假阳性** —— 实测:因为分不清,工具一度把
# `v8` / `skia` / `webrtc` / `pdfium` 判成「嵌套依赖不可达」,
# 而照那份名单跳过会直接把核心构建依赖砍掉。
OK = "ok"
NOT_FOUND = "not_found"  # 可以安全跳过
UNCERTAIN = "uncertain"  # 限流/超时/未知 —— **不许**据此跳过

_NOT_FOUND_HINTS = ("not found", "404")
_RATE_HINTS = ("429", "rate limit", "resource has been exhausted", "quota")


def _classify(returncode: int, err: str) -> str:
    if returncode == 0:
        return OK
    low = (err or "").lower()
    if any(h in low for h in _NOT_FOUND_HINTS):
        return NOT_FOUND
    if any(h in low for h in _RATE_HINTS):
        return UNCERTAIN
    return UNCERTAIN


def check(url: str, timeout: int = 45, attempts: int = 3) -> tuple[str, str, str]:
    """返回 (url, verdict, detail)。verdict ∈ {ok, not_found, uncertain}。

    失败会重试 —— 单次失败常常是上游限流的抖动,**不能当结论**。
    """
    last = ""
    for i in range(attempts):
        try:
            r = subprocess.run(
                ["git", "ls-remote", "--exit-code", "--heads", url],
                capture_output=True,
                text=True,
                timeout=timeout,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"},
            )
            err = (r.stderr or r.stdout).strip().splitlines()
            last = err[-1][:200] if err else f"rc={r.returncode}"
            verdict = _classify(r.returncode, last)
            if verdict != UNCERTAIN:
                return url, verdict, last
        except subprocess.TimeoutExpired:
            last = f"TIMEOUT({timeout}s)"
        except Exception as exc:
            last = repr(exc)[:200]
        if i < attempts - 1:
            time.sleep(2 + 2 * i)
    return url, UNCERTAIN, last


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

    # 也扫一遍**已存在的嵌套 DEPS**(子方案自己的 DEPS,如 third_party/webpagereplay/DEPS)。
    #
    # ⚠️ **不能见到嵌套 DEPS 就建议跳过父目录** —— 那样会把 v8 / skia / webrtc /
    #    pdfium / crashpad 这些**核心构建依赖**也列进去(实测踩过:一版天真实现列了 14 个,
    #    包含 v8 与 skia)。所以这里**只报嵌套依赖真的不可达**的父目录。
    #
    # 为什么只能跳到父目录:gclient 的 `custom_deps` **只覆盖顶层方案**,
    # 管不到子方案内部的依赖。
    nested_bad: list[dict] = []
    src_root = DEPS_FILE.parent
    nested_urls: set[str] = set()
    nested_items: list[dict] = []
    for df in src_root.rglob("DEPS"):
        if df == DEPS_FILE:
            continue
        if any(part in {".git", "out", "buildtools", "node_modules"} for part in df.parts):
            continue
        try:
            nd = load_deps_from(df)
        except Exception:
            continue
        for path, raw in nd.items():
            if isinstance(raw, str) and "chromium.googlesource.com" in raw:
                url, _ = strip_rev(raw)
                nested_items.append(
                    {
                        "parent": str(df.parent.relative_to(src_root)).replace("\\", "/"),
                        "path_in_deps": path,
                        "mirror": rewrite(url),
                    }
                )
                nested_urls.add(rewrite(url))

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

    uniq = {r["mirror"] for r in rows} | nested_urls
    results: dict[str, tuple[str, str]] = {}
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for url, verdict, err in ex.map(check, sorted(uniq)):
            results[url] = (verdict, err)

    def vd(url: str) -> str:
        return results[url][0]

    # 只保留「嵌套依赖**确认不存在**」的父目录。
    # uncertain(限流/超时)一律不算 —— 那是本次探测的问题,不是仓库的问题。
    nested_bad = sorted({n["parent"] for n in nested_items if vd(n["mirror"]) == NOT_FOUND})

    bad = [r for r in rows if vd(r["mirror"]) == NOT_FOUND]
    uniq_bad = sorted({x["path"]: x for x in bad}.values(), key=lambda x: x["path"])
    uncertain = sorted({u for u in uniq if vd(u) == UNCERTAIN})

    # 给脚本用的纯净输出:只要**顶层** DEPS 里确认不存在的跳过行。
    #
    # ⚠️ **刻意不输出嵌套 DEPPS 的父目录跳过行** —— 虽然工具能报出它们,
    #    但那些 URL 是**相对各自子仓库的 remote** 写的,独立 exec 解析不可靠
    #    (实测:一度算出 v8 / skia / webrtc / pdfium / crashpad「嵌套依赖不可达」)。
    #    这里错一边的代价是**不对称的**:
    #      - 假阳性 → 跳过 v8/skia → 构建直接废掉(灾难)
    #      - 假阴性 → sync 多失败一次,重跑就行(可承受)
    #    所以嵌套项**只报告、不自动生成跳过**;真要跳必须人工确认后写进脚本的
    #    `generate_skip_list()`(那里有一条人工确认过的 webpagereplay)。
    if args.emit_skips:
        for r in uniq_bad:
            print(f'      "{r["path"]}": None,   # {r["mirror"]}')
        if uncertain:
            print(
                f"      # ⚠️ 另有 {len(uncertain)} 个 URL 本次探测「不确定」(限流/超时),"
                f"未据此跳过 —— 需要的话重跑本工具。",
                file=sys.stderr,
            )
        return 0

    ok_n = sum(1 for u in uniq if vd(u) == OK)
    print(f"镜像可达 {ok_n} / {len(uniq)} 个不同 URL(另有 {len(uncertain)} 个不确定)\n")

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

    if nested_bad:
        print("\n" + "=" * 78)
        print("【仅供参考】**以下目录自带 DEPS,其中有些依赖本次探测认为不可达。**")
        print("  ⚠️ 这份名单**不可直接用于跳过** —— 嵌套 DEPS 的 URL 是相对各自子仓库写的,")
        print("     独立解析不可靠(实测报出过 v8 / skia / webrtc / pdfium / crashpad,")
        print("     那些是核心构建依赖,跳掉就构不出来了)。")
        print("     真要跳,必须人工确认后再写进 tools/10-fetch-chromium.sh 的")
        print("     generate_skip_list()(那里有一条人工确认过的 webpagereplay)。")
        print("=" * 78)
        for p in nested_bad:
            why = sorted({n["mirror"] for n in nested_items if n["parent"] == p})
            print(f"      src/{p}   ← {why[0]}")

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
