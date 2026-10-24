"""扫描可用作**固定出口**的 `bind-socks5` 节点。

为什么需要它:resin 轮换池每次连接换一个出口,会毁掉「同一轮同一出口」的对照纪律
(见 ADR-011 / `probe/README.md` §二)。本脚本找出**出口稳定**的单节点。

用法:
    probe/.venv/Scripts/python.exe probe/tools/scan_pinned_egress.py
    probe/.venv/Scripts/python.exe probe/tools/scan_pinned_egress.py --host 198.51.100.7 --from 41105 --to 41139

判定:对同一端口连打两次 `api.ipify.org`,两次回同一个 IP 即 STICKY(可用)。
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import subprocess


def probe_port(host: str, port: int, samples: int = 2, timeout: int = 12) -> tuple[int, list[str]]:
    proxy = f"socks5h://{host}:{port}"
    ips: list[str] = []
    for _ in range(samples):
        r = subprocess.run(
            ["curl", "-s", "--proxy", proxy, "--max-time", str(timeout), "https://api.ipify.org"],
            capture_output=True,
            text=True,
        )
        v = (r.stdout or "").strip()
        ok = v and "<" not in v and len(v) <= 64
        ips.append(v if ok else f"ERR(rc={r.returncode})")
    return port, ips


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="198.51.100.7")
    ap.add_argument("--from", dest="lo", type=int, default=41105)
    ap.add_argument("--to", dest="hi", type=int, default=41140)
    ap.add_argument("--samples", type=int, default=2)
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    ports = list(range(args.lo, args.hi))
    live: list[tuple[int, list[str]]] = []
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for port, ips in ex.map(lambda p: probe_port(args.host, p, args.samples), ports):
            if ips and not ips[0].startswith("ERR"):
                live.append((port, ips))

    print(f"host={args.host} scanned={len(ports)} live={len(live)}")
    for port, ips in live:
        sticky = "STICKY" if len(set(ips)) == 1 else "ROTATE"
        print(f"  socks5://{args.host}:{port}  {ips[0]:18} {sticky}")
    print(f"\n可用作固定出口的节点数(STICKY):{sum(1 for _, ips in live if len(set(ips)) == 1)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
