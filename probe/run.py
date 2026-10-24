"""probe.run —— M0 执行器。

用法:
    PY=probe/.venv/Scripts/python.exe
    $PY probe/run.py --list
    $PY probe/run.py --targets pw-naive,patchright --sites bot-detector --egress direct
    $PY probe/run.py --all

产出 `probe/out/<run-id>/`:`matrix.json` / `matrix.md` / `run.log` / `screenshots/`。

纪律(见 probe/README.md):
- 同一轮内所有 target 走**同一个出口**(固定 IP,不用轮换池)
- 每个 (target, site) 用**全新空档案 + 全新浏览器进程**,避免站点间相互污染
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import traceback
from pathlib import Path

# 允许 `python probe/run.py` 直接运行
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from probe.base import (  # noqa: E402
    EGRESSES,
    VERDICT_DETECTED,
    VERDICT_ERROR,
    VERDICT_PASSED,
    LaunchSpec,
    ProbeError,
    Result,
    get_site,
    get_target,
    json_dump,
    load_all,
    now_iso,
    run_id,
    site_names,
    target_names,
)

LOG_LINES: list[str] = []


def log(msg: str) -> None:
    line = f"[{now_iso()}] {msg}"
    LOG_LINES.append(line)
    print(line, flush=True)


def exit_ip_of(proxy: str | None, timeout: int = 20) -> str | None:
    """经指定出口取一次出口 IP(用于把「同一轮同一 IP」钉进证据)。"""
    cmd = ["curl", "-s", "--max-time", str(timeout)]
    if proxy:
        cmd += ["--proxy", proxy]
    cmd.append("https://api.ipify.org")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
        out = (r.stdout or "").strip()
        if r.returncode == 0 and out and "<" not in out and len(out) <= 64:
            return out
    except Exception:
        pass
    return None


def run_one(target: str, site_name: str, egress_name: str, args) -> Result:
    egress = EGRESSES[egress_name]
    site = get_site(site_name)
    launch = get_target(target)

    out_dir = Path(args.out)
    profile_dir = out_dir / "profiles" / f"{target}-{egress_name}-{site_name}"

    spec = LaunchSpec(
        target=target,
        egress=egress,
        profile_dir=profile_dir,
        out_dir=out_dir,
        headless=not args.headed,
        timeout_ms=args.timeout * 1000,
    )

    res = Result(
        target=target,
        site=site_name,
        egress=egress_name,
        verdict=VERDICT_ERROR,
        ts=now_iso(),
        proxy_effective=egress.proxy,
        exit_ip=args.exit_ips.get(egress_name),
    )

    t0 = time.monotonic()
    try:
        with launch(spec) as br:
            verdict, detail = site.run(br)
            res.verdict = verdict
            res.detail = detail
            if isinstance(detail, dict) and detail.get("screenshot"):
                res.screenshots.append(detail["screenshot"])
    except ProbeError:
        raise
    except Exception as exc:
        res.verdict = VERDICT_ERROR
        res.error = f"{type(exc).__name__}: {exc}"
        res.detail = {"traceback": traceback.format_exc()[-4000:]}
    finally:
        res.duration_s = round(time.monotonic() - t0, 2)

    return res


def render_markdown(results: list[Result], meta: dict) -> str:
    sites = sorted({r.site for r in results})
    pairs = sorted({(r.egress, r.target) for r in results})

    lines = [
        "# M0 检测矩阵",
        "",
        f"- run_id: `{meta['run_id']}`",
        f"- 时间: {meta['started']} → {meta['finished']}",
        f"- 出口: " + ", ".join(
            f"`{k}` = {v.get('ip') or '?'} ({'proxy' if v.get('proxy') else 'direct'})"
            for k, v in meta["egresses"].items()
        ),
        f"- probe_version: `{meta['probe_version']}`",
        "",
        "> `passed` = 未被拦;`detected` = 被识别;`error` = 探针或页面失败(**不等于通过**)",
        "",
        "| 出口 | target | " + " | ".join(sites) + " |",
        "|---|---|" + "|".join(["---"] * len(sites)) + "|",
    ]

    for egress, target in pairs:
        cells = []
        for s in sites:
            hit = next((r for r in results if r.egress == egress and r.target == target and r.site == s), None)
            if hit is None:
                cells.append("—")
            else:
                icon = {VERDICT_PASSED: "✅", VERDICT_DETECTED: "❌", VERDICT_ERROR: "⚠️"}.get(hit.verdict, "?")
                cells.append(f"{icon} {hit.verdict} ({hit.duration_s}s)")
        lines.append(f"| `{egress}` | `{target}` | " + " | ".join(cells) + " |")

    lines.append("")
    lines.append("## 逐条明细")
    lines.append("")
    for r in results:
        lines.append(f"### `{r.egress}` × `{r.target}` × `{r.site}` → **{r.verdict}**")
        if r.error:
            lines.append(f"- 错误: `{r.error}`")
        if r.exit_ip:
            lines.append(f"- 出口 IP: `{r.exit_ip}`")
        if r.screenshots:
            lines.append(f"- 截图: `{Path(r.screenshots[0]).name}`")
        detail = r.detail or {}
        if "row_count" in detail:
            lines.append(f"- 结果行: {detail['row_count']} · 列表项: {detail.get('list_count')}")
        hooks = detail.get("markers") or {}
        if hooks:
            lines.append("- 判定标记:")
            for sel, vals in list(hooks.items())[:6]:
                sample = " / ".join(v[:70] for v in vals[:3])
                lines.append(f"  - `{sel}` ×{len(vals)}: {sample}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="M0 检测基准执行器")
    ap.add_argument("--targets", default="", help="逗号分隔;或 --all")
    ap.add_argument("--sites", default="", help="逗号分隔;或 --all")
    ap.add_argument("--egress", action="append", default=[], help="可重复;或 --all")
    ap.add_argument("--all", action="store_true", help="全部 target × site × egress")
    ap.add_argument("--headed", action="store_true", help="有头运行(默认无头)")
    ap.add_argument("--out", default="", help="输出根目录(默认 probe/out/<run-id>)")
    ap.add_argument("--timeout", type=int, default=90, help="单站超时秒")
    ap.add_argument("--list", action="store_true", help="列出已注册 target / site / egress")
    args = ap.parse_args()

    load_all()

    if args.list:
        print("targets:", target_names())
        print("sites  :", site_names())
        print("egress :", sorted(EGRESSES))
        return 0

    if args.all:
        targets = target_names()
        sites = site_names()
        egresses = sorted(EGRESSES)
    else:
        targets = [t.strip() for t in args.targets.split(",") if t.strip()]
        sites = [s.strip() for s in args.sites.split(",") if s.strip()]
        egresses = args.egress or ["direct"]

    if not targets:
        print("没有指定 target。用 --list 看已注册项。", file=sys.stderr)
        return 2
    if not sites:
        print("没有指定 site。用 --list 看已注册项。", file=sys.stderr)
        return 2

    rid = run_id()
    out_root = Path(args.out) if args.out else (_REPO_ROOT / "probe" / "out" / rid)
    out_root.mkdir(parents=True, exist_ok=True)
    args.out = str(out_root)

    log(f"run_id={rid} out={out_root}")
    log(f"targets={targets} sites={sites} egresses={egresses} headed={args.headed}")

    # 每轮先钉一次出口 IP
    egress_meta: dict[str, dict] = {}
    args.exit_ips = {}
    for e in egresses:
        ip = exit_ip_of(EGRESSES[e].proxy)
        args.exit_ips[e] = ip
        egress_meta[e] = {"ip": ip, "proxy": EGRESSES[e].proxy, "kind": EGRESSES[e].kind}
        log(f"egress {e}: exit_ip={ip} proxy={EGRESSES[e].proxy}")

    started = now_iso()
    results: list[Result] = []
    for egress in egresses:
        for target in targets:
            for site in sites:
                log(f"run {egress} × {target} × {site} ...")
                try:
                    r = run_one(target, site, egress, args)
                except Exception as exc:
                    log(f"  FATAL {type(exc).__name__}: {exc}")
                    r = Result(target=target, site=site, egress=egress,
                               verdict=VERDICT_ERROR, ts=now_iso(),
                               error=f"{type(exc).__name__}: {exc}")
                results.append(r)
                log(f"  -> {r.verdict} ({r.duration_s}s)"
                    + (f" error={r.error}" if r.error else ""))

    finished = now_iso()
    meta = {
        "run_id": rid,
        "started": started,
        "finished": finished,
        "probe_version": results[0].probe_version if results else None,
        "egresses": egress_meta,
        "targets": targets,
        "sites": sites,
    }

    json_dump(out_root / "matrix.json", {"meta": meta, "results": [r.to_dict() for r in results]})
    (out_root / "matrix.md").write_text(render_markdown(results, meta), encoding="utf-8", newline="\n")
    (out_root / "run.log").write_text("\n".join(LOG_LINES) + "\n", encoding="utf-8", newline="\n")

    log(f"完成:{len(results)} 条结果 → {out_root / 'matrix.json'}")
    for r in results:
        log(f"  {r.egress:14} {r.target:12} {r.site:14} {r.verdict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
