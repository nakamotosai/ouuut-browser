#!/usr/bin/env bash
# tools/20-rebase.sh —— **M1 的核心验收:一条命令 rebase**
#
#   tools/20-rebase.sh                    # 用 chromium/UPSTREAM 记录的版本
#   tools/20-rebase.sh 157.0.8103.15-1    # 或指定 ungoogled tag
#   tools/20-rebase.sh --dry-run          # 只打印动作,不落地
#
# 步骤:gclient sync → 应用补丁 → gn gen → autoninja → 写 UPSTREAM
# 补丁失败即中止,**绝不静默跳过**。
#
# 前提:工具链已就绪(见 chromium/README.md §二 第 0 步)。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROMIUM_DIR="${REPO_ROOT}/chromium"
SRC_DIR="${CHROMIUM_DIR}/src"
PATCH_DIR="${CHROMIUM_DIR}/patches"
OUT_DIR="${SRC_DIR}/out/Release"
UPSTREAM_FILE="${CHROMIUM_DIR}/UPSTREAM"

# depot_tools 常见位置(00-bootstrap-toolchain.ps1 会装到第一个)
for d in "F:/depot_tools" "/f/depot_tools" "$HOME/depot_tools" "/c/depot_tools"; do
  if [ -d "$d" ]; then export PATH="${d}:${PATH}"; DEPOT_TOOLS="$d"; break; fi
done

DRY_RUN=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) TARGET="$arg" ;;
  esac
done

log()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[fatal] %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

# ---- 0. 前置检查 ------------------------------------------------------------
log "0/6 前置检查"
[ -n "${DEPOT_TOOLS:-}" ] || die "找不到 depot_tools。先跑 chromium/README.md §二 第 0 步。"
command -v gclient >/dev/null || die "gclient 不在 PATH(depot_tools=${DEPOT_TOOLS})"
command -v gn      >/dev/null || warn "gn 不在 PATH,稍后 gclient sync 会把它带进来"
[ -d "$SRC_DIR" ] || die "找不到 ${SRC_DIR}。先跑 tools/10-fetch-chromium.sh。"

# 目标版本:参数 > UPSTREAM 记录 > 报错
if [ -z "$TARGET" ] && [ -f "$UPSTREAM_FILE" ]; then
  TARGET="$(grep -E '^version=' "$UPSTREAM_FILE" | head -1 | cut -d= -f2-)"
fi
[ -n "$TARGET" ] || die "没有目标版本:给个参数,或先让 chromium/UPSTREAM 里有 version=…"
log "目标版本: ${TARGET}"

if [ -f "$UPSTREAM_FILE" ]; then
  log "原 UPSTREAM 记录:"; sed 's/^/  /' "$UPSTREAM_FILE"
fi

# ---- 1. gclient sync -------------------------------------------------------
log "1/6 gclient sync @ ${TARGET}"
cd "$SRC_DIR"
# 说明:ungoogled-chromium 以 tag 形式发布(如 156.0.8078.47-1);
# gclient 需要的是 Chromium 自己的 tag(如 156.0.8078.47)。
CHROMIUM_TAG="${TARGET%-*}"
run git fetch --tags --depth=1 origin "refs/tags/${CHROMIUM_TAG}:refs/tags/${CHROMIUM_TAG}" || \
  warn "拉 tag ${CHROMIUM_TAG} 失败 —— 若该版本不是 tag 形式,请改用 commit SHA"
run git checkout -f "$CHROMIUM_TAG"
run gclient sync --with_branch_heads --with_tags -D

# ---- 2. 应用补丁 -----------------------------------------------------------
log "2/6 应用补丁(${PATCH_DIR})"
shopt -s nullglob
PATCHES=("${PATCH_DIR}"/*.patch)
shopt -u nullglob

if [ "${#PATCHES[@]}" -eq 0 ]; then
  warn "没有补丁可应用(补丁集尚未建立 —— 见 chromium/README.md §四)"
else
  for p in "${PATCHES[@]}"; do
    printf '  apply %s\n' "$(basename "$p")"
    if [ "$DRY_RUN" -eq 0 ]; then
      if ! git apply --3way --whitespace=nowarn "$p"; then
        die "补丁失败:$(basename "$p")
  → 冲突已留在工作区。手工解决后:
      git add -A && git -C '$SRC_DIR' diff > '$p'
  然后重跑本脚本。"
      fi
    fi
  done
fi

# ---- 3. gn gen -------------------------------------------------------------
log "3/6 gn gen out/Release"
mkdir -p "$(dirname "$OUT_DIR")"
# 说明:这是一份「能编出可跑 chrome.exe」的最小官方配置;
# 首次实跑时按 chromium/README.md §五 逐项核对。
GN_ARGS='is_debug=false
is_official_build=true
symbol_level=1
blink_symbol_level=0
v8_symbol_level=0
enable_nacl=false
is_component_build=false
proprietary_codecs=true
ffmpeg_branding="Chrome"
treat_warnings_as_errors=false
chrome_pgo_phase=0'
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  [dry-run] gn gen %s --args="%s"\n' "$OUT_DIR" "$GN_ARGS"
else
  printf '%s\n' "$GN_ARGS" > "${OUT_DIR}.args.tmp" 2>/dev/null || true
  gn gen "$OUT_DIR" --args="$GN_ARGS"
fi

# ---- 4. 构建 ---------------------------------------------------------------
log "4/6 autoninja(预计数小时,24 核)"
run autoninja -C "$OUT_DIR" chrome

# ---- 5. 记录 UPSTREAM ------------------------------------------------------
log "5/6 写 chromium/UPSTREAM"
CHROME_BIN="${OUT_DIR}/chrome.exe"
[ -f "$CHROME_BIN" ] || CHROME_BIN="${OUT_DIR}/chrome"
if [ "$DRY_RUN" -eq 0 ]; then
  [ -f "$CHROME_BIN" ] || die "构建完成但找不到产物:${CHROME_BIN}"
  SHA256="$(sha256sum "$CHROME_BIN" | cut -d' ' -f1)"
  {
    echo "version=${TARGET}"
    echo "chromium_tag=${CHROMIUM_TAG}"
    echo "commit=$(git rev-parse HEAD)"
    echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "patch_count=${#PATCHES[@]}"
    echo "patch_digest=$(cat "${PATCHES[@]}" 2>/dev/null | sha256sum | cut -d' ' -f1)"
    echo "artifact=${CHROME_BIN}"
    echo "artifact_sha256=${SHA256}"
    echo "gn_args_digest=$(printf '%s' "$GN_ARGS" | sha256sum | cut -d' ' -f1)"
  } > "$UPSTREAM_FILE"
  cat "$UPSTREAM_FILE"
fi

# ---- 6. 冒烟 ---------------------------------------------------------------
log "6/6 冒烟:启动一次"
if [ "$DRY_RUN" -eq 0 ]; then
  "$CHROME_BIN" --version || die "产物无法启动"
  echo "✅ rebase 完成:${TARGET}"
else
  echo "✅ dry-run 完成(未落地任何改动)"
fi
