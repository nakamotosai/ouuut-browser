#!/usr/bin/env python3
"""tools/install-windows-sdk-nuget.py —— 从 NuGet 铺出 Windows SDK,装到标准位置。

**为什么需要它**

Chromium 156 硬性要求 **Windows SDK 10.0.28000+** —— 不是含糊的「建议」:
`base/win/windows_version.cc` 里有一句

    #if !defined(NTDDI_WIN11_BR)
    #error Windows 10.0.28000.0 SDK or higher required.
    #endif

而 `NTDDI_WIN11_BR` **只在 28000 及以上的 SDK 里才有**。
VS 2022 17.14 的组件目录里**没有** 28000 的 SDK 组件
(`vs_installer --add ...Windows11SDK.28000` 退 87),官方 SDK 下载页的 fwlink 也已失效。

**NuGet 上有**。Microsoft 现在把 SDK 作为 NuGet 包发布:

    Microsoft.Windows.SDK.CPP            头文件 / Catalogs / 其它
    Microsoft.Windows.SDK.CPP.x64        x64 的库
    Microsoft.Windows.SDK.CPP.x86        x86 的库(Chromium 的 32 位辅助目标要用)
    Microsoft.Windows.SDK.BuildTools     bin/ 下的工具

包内布局是 `c/`(内容根)与 `bin/`;x64/x86 包把库放在 `c/<sub>/<arch>/` 下。
本脚本把它们**映射成真实 SDK 的布局**(`Include/<ver>/`、`Lib/<ver>/<sub>/<arch>/`)。

用法(需管理员,写到 Program Files):
    probe/.venv/Scripts/python.exe tools/install-windows-sdk-nuget.py
    probe/.venv/Scripts/python.exe tools/install-windows-sdk-nuget.py --version 10.0.28000.2705
    probe/.venv/Scripts/python.exe tools/install-windows-sdk-nuget.py --dry-run
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import sys
import tempfile
import urllib.request
import zipfile

DEFAULT_VERSION = "10.0.28000.2705"      # NuGet 包版本
DEFAULT_SDK_VERSION = "10.0.28000.0"     # **SDK 目录版本** —— 与包版本不同!
# 包内路径用的是目录版本(`c/Include/10.0.28000.0/`),而库要落到
# `Lib/10.0.28000.0/<sub>/<arch>/`,Chromium 也是按这个找。
# 把两者混用会让 `Lib/10.0.28000.2705/` 建出来而 Chromium 找不到。
DEFAULT_DEST = pathlib.Path(r"C:\Program Files (x86)\Windows Kits\10")

PKG_MAIN = "microsoft.windows.sdk.cpp"
PKG_ARCH = ["microsoft.windows.sdk.cpp.x64", "microsoft.windows.sdk.cpp.x86"]
PKG_TOOLS = "microsoft.windows.sdk.buildtools"

# 这些 `c/` 下的子目录名是**每架构的库目录**(要落到 Lib/<ver>/ 下)
ARCH_SUBDIRS = {"ucrt", "ucrt_enclave", "um", "winrt", "shared"}


def nupkg_url(pkg: str, ver: str) -> str:
    return f"https://api.nuget.org/v3-flatcontainer/{pkg}/{ver}/{pkg}.{ver}.nupkg"


def download(pkg: str, ver: str, cache: pathlib.Path) -> pathlib.Path:
    dst = cache / f"{pkg}.{ver}.nupkg"
    if dst.exists() and dst.stat().st_size > 100_000:
        print(f"  已缓存 {pkg} ({round(dst.stat().st_size / 1e6, 1)} MB)")
        return dst
    url = nupkg_url(pkg, ver)
    print(f"  下载 {pkg} …")
    req = urllib.request.Request(url, headers={"User-Agent": "ouuut-build/1"})
    with urllib.request.urlopen(req, timeout=600) as r:
        dst.write_bytes(r.read())
    print(f"    -> {round(dst.stat().st_size / 1e6, 1)} MB")
    return dst


def plan_members(pkg: str, names: list[str], sdk_ver: str) -> list[tuple[str, str]]:
    """返回 (包内成员, 目标相对路径)。目标是相对 SDK 根的路径。"""
    out: list[tuple[str, str]] = []
    arch = None
    if pkg in PKG_ARCH:
        arch = pkg.rsplit(".", 1)[-1]  # x64 / x86
    for n in names:
        if n.endswith("/"):
            continue
        if n.startswith("c/"):
            rest = n[2:]
            parts = rest.split("/")
            if arch and len(parts) >= 3 and parts[0] in ARCH_SUBDIRS and parts[1] == arch:
                # c/<sub>/<arch>/... -> Lib/<ver>/<sub>/<arch>/...
                out.append((n, f"Lib/{sdk_ver}/" + "/".join(parts[:2]) + "/" + "/".join(parts[2:])))
            elif rest.startswith(f"Include/{sdk_ver}/") or rest.startswith("Include/"):
                out.append((n, rest))  # 头文件:原位
            else:
                out.append((n, rest))  # Catalogs / Redist / …:原位
        elif n.startswith("bin/"):
            out.append((n, n))  # 工具:原位
        # .nuspec / _rels / build/ / package/ 等:跳过
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default=DEFAULT_VERSION, help="NuGet 包版本")
    ap.add_argument("--sdk-version", default=DEFAULT_SDK_VERSION, help="SDK 目录版本(库落位用)")
    ap.add_argument("--dest", default=str(DEFAULT_DEST))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    dest = pathlib.Path(args.dest)
    ver = args.version
    sdk_ver = args.sdk_version
    print(f"目标 SDK 根:{dest}\n包版本:{ver}\nSDK 目录版本:{sdk_ver}\n")

    if not args.dry_run and not dest.exists():
        print(f"[fatal] 目标不存在:{dest}", file=sys.stderr)
        return 2

    pkgs = [PKG_MAIN, *PKG_ARCH, PKG_TOOLS]
    cache = pathlib.Path(tempfile.gettempdir()) / "winsdk-nuget"
    cache.mkdir(parents=True, exist_ok=True)

    total = 0
    for pkg in pkgs:
        f = download(pkg, ver, cache)
        with zipfile.ZipFile(f) as z:
            pairs = plan_members(pkg, z.namelist(), sdk_ver)
            print(f"  {pkg}:{len(pairs)} 个文件待落位")
            if args.dry_run:
                for src, rel in pairs[:5]:
                    print(f"      {src}  ->  {rel}")
                continue
            for src, rel in pairs:
                target = dest / rel.replace("/", "\\")
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(src) as fh, open(target, "wb") as out:
                    shutil.copyfileobj(fh, out)
                total += 1
    if args.dry_run:
        print("\n[dry-run] 未落盘")
        return 0

    print(f"\n落位 {total} 个文件。")
    # 验收:三个关键路径必须在
    checks = [
        dest / "Include" / sdk_ver / "um" / "fileapi.h",
        dest / "Include" / sdk_ver / "um" / "minwinbase.h",
        dest / "Lib" / sdk_ver / "um" / "x64" / "kernel32.lib",
        dest / "bin" / sdk_ver / "x64" / "rc.exe",
    ]
    ok = True
    for c in checks:
        exists = c.exists()
        ok = ok and exists
        print(f"  {'✅' if exists else '❌'} {c}")
    if not ok:
        print("\n[fatal] 关键路径缺失 —— 映射逻辑可能需要调整(见本文件 plan_members)", file=sys.stderr)
        return 1

    # NTDDI 宏的验收:28000 必须定义 NTDDI_WIN11_BR
    sdkddk = dest / "Include" / sdk_ver / "shared" / "sdkddkver.h"
    if sdkddk.exists():
        has = "NTDDI_WIN11_BR" in sdkddk.read_text(encoding="utf-8", errors="replace")
        print(f"  {'✅' if has else '❌'} sdkddkver.h 定义了 NTDDI_WIN11_BR")
        if not has:
            print("      (Chromium 会报 'Windows 10.0.28000.0 SDK or higher required.')", file=sys.stderr)
            return 1
    print(f"\n完成。接下来把 OUUUT_WINDOWS_SDK_VERSION 设为 {sdk_ver},并可撤掉 NTDDI 覆盖。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
