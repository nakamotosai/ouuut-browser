#!/usr/bin/env bash
# tools/30-verify-reproducible.sh —— 「第三方能复现同一二进制」的**可执行验收**
#
#   tools/30-verify-reproducible.sh             # 校验当前产物 vs 记录
#   tools/30-verify-reproducible.sh --record    # 把当前产物钉成"记录"(本机基线)
#   tools/30-verify-reproducible.sh --report    # 只打印"第三方需要知道的一切"
#
# ---- 为什么要有这个 ----
#
# M1 的验收之一是「**第三方能复现同一二进制**」。现状:本机三次构建逐字节相同已证,
# 但"第三方"那半边一直没法推进 —— 因为**缺的不是另一台机器,缺的是一份可交付的记录**:
# 别人不知道要和哪些输入对齐,也就无从谈起"复现"。
#
# 所以这个脚本做两件事:
#   1. `--record`:把**决定产物的全部输入**钉下来(chromium ref、补丁摘要、gn args、
#      工具链版本、以及产物 sha256)
#   2. 默认:重新算一遍产物 sha256 并逐条比对,不一致就**指出是哪一条输入对不上**
#
# ---- 「可复现」在工程上是什么意思(写清楚,免得自欺) ----
#
# 二进制可复现 = **同样的输入 → 同样的字节**。所以"记录"必须覆盖输入,不能只记产物。
# 本脚本钉的输入:
#   * chromium 的 commit(不是 tag —— tag 可以被移动)
#   * 补丁集的内容摘要(不是补丁文件名 —— 内容变了名字可以不变)
#   * gn args 的内容摘要(构建配置)
#   * 工具链版本(MSVC / Windows SDK)—— 换编译器版本本来就会改变字节
#   * 构建线程数**不**钉(它不该影响字节;若影响,那正是"不可复现"的证据,本脚本会暴露它)
#
# ---- 别把它当"证明" ----
#
# 本脚本只能证明**本机**可复现 + 给第三方一份可执行的对照清单。
# 真正的"第三方可复现"必须**在另一台机器上**跑本脚本并得到 `REPRODUCIBLE`,那才算。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECORD="${REPO_ROOT}/chromium/REPRODUCIBILITY.json"
UPSTREAM="${REPO_ROOT}/chromium/UPSTREAM"
PATCH_DIR="${REPO_ROOT}/chromium/patches"
SRC_DIR="${REPO_ROOT}/chromium/src"
OUT_DIR="${SRC_DIR}/out/Release"
ARGS_FILE="${OUT_DIR}/args.gn"

# 被钉的产物 —— 顺序稳定,便于 diff
ARTIFACTS=(chrome.dll chrome.exe chrome_elf.dll)
# 用来判断"工具链换了没有"的实体
TOOLCHAIN_FILES=(
  "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC"
  "C:/Program Files (x86)/Windows Kits/10/Include"
)

log()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[fatal] %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '  \033[1;32m✅ %s\033[0m\n' "$*"; }
bad()  { printf '  \033[1;31m❌ %s\033[0m\n' "$*"; }

# 用 stdin 喂 sha256sum:传 Windows 路径会因反斜杠被 GNU coreutils 转义而带上 `\` 前缀(坑-25)
sha_of() { sha256sum < "$1" | cut -d' ' -f1; }

[ -d "$SRC_DIR" ] || die "找不到 ${SRC_DIR}"

MODE="verify"
case "${1:-}" in
  --record) MODE="record" ;;
  --report) MODE="report" ;;
  "")       MODE="verify" ;;
  -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
  *) die "未知参数 $1" ;;
esac

# ---- 采集:决定产物的全部输入 ----------------------------------------------
collect() {
  local commit ref patch_digest gn_args_digest msvc sdk
  commit="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo "<未知>")"
  ref="$(grep -E '^chromium_ref=' "$UPSTREAM" 2>/dev/null | cut -d= -f2- || echo "<未知>")"

  # 补丁集:**内容**摘要(不是文件名)
  shopt -s nullglob
  local patches=("$PATCH_DIR"/*.patch)
  shopt -u nullglob
  if [ "${#patches[@]}" -gt 0 ]; then
    patch_digest="$( { for p in "${patches[@]}"; do printf '%s\n' "$(basename "$p")"; cat -- "$p"; done; } | sha256sum | cut -d' ' -f1)"
  else
    patch_digest="<无补丁>"
  fi

  gn_args_digest="$([ -f "$ARGS_FILE" ] && sha_of "$ARGS_FILE" || echo "<无 args.gn>")"

  # 工具链:目录名本身就是版本号(MSVC 14.44.35207 / SDK 10.0.28000.0)
  msvc="$(ls -1 "${TOOLCHAIN_FILES[0]}" 2>/dev/null | sort -V | tail -1 || echo "<未知>")"
  sdk="$(ls -1 "${TOOLCHAIN_FILES[1]}" 2>/dev/null | sort -V | tail -1 || echo "<未知>")"

  printf '{\n'
  printf '  "note": "本文件钉的是**决定产物的输入**,不是产物本身；见 tools/30-verify-reproducible.sh 顶部说明。",\n'
  printf '  "chromium_commit": %s,\n' "$(json_str "$commit")"
  printf '  "chromium_ref": %s,\n' "$(json_str "$ref")"
  printf '  "patch_digest": %s,\n' "$(json_str "$patch_digest")"
  printf '  "gn_args_digest": %s,\n' "$(json_str "$gn_args_digest")"
  printf '  "msvc_version": %s,\n' "$(json_str "$msvc")"
  printf '  "windows_sdk_version": %s,\n' "$(json_str "$sdk")"
  printf '  "gn_args_note": "构建线程数刻意**不**钉：它不该影响字节。若改了它就复现不出来，那本身就是不可复现的证据。",\n'
  printf '  "artifacts": {\n'
  local first=1 a
  for a in "${ARTIFACTS[@]}"; do
    local p="${OUT_DIR}/${a}"
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    if [ -f "$p" ]; then
      printf '    %s: { "sha256": "%s", "bytes": %s }' "$(json_str "$a")" "$(sha_of "$p")" "$(wc -c < "$p" | tr -d ' ')"
    else
      printf '    %s: null' "$(json_str "$a")"
    fi
  done
  printf '\n  }\n}\n'
}

json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# ---- 报告 ------------------------------------------------------------------
if [ "$MODE" = "report" ]; then
  log "第三方复现所需的全部信息"
  collect
  echo
  echo "第三方怎么做:"
  echo "  1. tools/00-bootstrap-toolchain.ps1      # 工具链(版本须与上面 msvc/sdk 一致)"
  echo "  2. tools/10-fetch-chromium.sh            # 取源码"
  echo "  3. tools/20-rebase.sh                    # 打补丁 + 构建(会写出 UPSTREAM)"
  echo "  4. tools/30-verify-reproducible.sh       # 比对产物 sha256"
  exit 0
fi

# ---- 记录 ------------------------------------------------------------------
if [ "$MODE" = "record" ]; then
  log "把当前产物钉成记录"
  collect > "$RECORD.tmp"
  mv -f "$RECORD.tmp" "$RECORD"
  ok "已写 ${RECORD#$REPO_ROOT/}"
  sed 's/^/    /' "$RECORD"
  exit 0
fi

# ---- 校验 ------------------------------------------------------------------
log "校验:当前产物 vs 记录"
[ -f "$RECORD" ] || die "没有记录(先跑 --record)。或者:这正说明'第三方可复现'还没建立基线。"

python - "$RECORD" "$OUT_DIR" <<'PY'
import json, sys, hashlib, os
rec = json.load(open(sys.argv[1], encoding="utf-8"))
out = sys.argv[2]

def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()

mismatch = []
for name, want in (rec.get("artifacts") or {}).items():
    p = os.path.join(out, name)
    if want is None:
        print(f"  ⚠️  {name}: 记录里是 null(当时没这个产物),跳过")
        continue
    if not os.path.exists(p):
        print(f"  ❌ {name}: 当前不存在")
        mismatch.append((name, "缺失", None, want.get("sha256")))
        continue
    got = sha(p)
    if got == want.get("sha256"):
        print(f"  ✅ {name}: 逐字节相同  {got[:16]}…")
    else:
        print(f"  ❌ {name}: 字节不同")
        print(f"      记录 {want.get('sha256')}")
        print(f"      当前 {got}")
        mismatch.append((name, "字节不同", got, want.get("sha256")))

print()
if mismatch:
    print("RESULT: NOT_REPRODUCIBLE")
    print()
    print("下一步:逐条比对**输入** —— 二进制不同,一定有一条输入不同:")
    for k in ("chromium_commit", "chromium_ref", "patch_digest", "gn_args_digest",
              "msvc_version", "windows_sdk_version"):
        print(f"  {k} = {rec.get(k)}")
    print()
    print("    git -C chromium/src rev-parse HEAD          # 对 chromium_commit")
    print("    sha256sum < out/Release/args.gn             # 对 gn_args_digest")
    print("    ls 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC'   # 对 msvc_version")
    print("    ls 'C:/Program Files (x86)/Windows Kits/10/Include'                                  # 对 windows_sdk_version")
    sys.exit(1)

print("RESULT: REPRODUCIBLE")
print()
print("本机产物与记录**逐字节一致**。")
print("⚠️ 这**只**证明本机可复现。真正的『第三方可复现』必须在**另一台机器上**跑本脚本,")
print("   并得到同样的 REPRODUCIBLE —— 那才算数。")
PY
