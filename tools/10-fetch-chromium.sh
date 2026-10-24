#!/usr/bin/env bash
# tools/10-fetch-chromium.sh —— 取 Chromium 源码(不入库,见 .gitignore)
#
#   tools/10-fetch-chromium.sh                       # 用 chromium/UPSTREAM 的版本
#   tools/10-fetch-chromium.sh 156.0.8078.47-1       # 或指定 ungoogled tag
#
# 约 50 GB 下载。只需跑一次;之后跟版用 tools/20-rebase.sh。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROMIUM_DIR="${REPO_ROOT}/chromium"
SRC_DIR="${CHROMIUM_DIR}/src"
UPSTREAM_FILE="${CHROMIUM_DIR}/UPSTREAM"

log() { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[fatal] %s\033[0m\n' "$*" >&2; exit 1; }

for d in "F:/depot_tools" "/f/depot_tools" "$HOME/depot_tools" "/c/depot_tools"; do
  if [ -d "$d" ]; then export PATH="${d}:${PATH}"; break; fi
done
command -v gclient >/dev/null || die "找不到 gclient —— 先跑 chromium/README.md §二 第 0 步"

TARGET="${1:-}"
if [ -z "$TARGET" ] && [ -f "$UPSTREAM_FILE" ]; then
  TARGET="$(grep -E '^version=' "$UPSTREAM_FILE" | head -1 | cut -d= -f2-)"
fi
[ -n "$TARGET" ] || die "没有目标版本:给个参数,或让 chromium/UPSTREAM 有 version=…"
CHROMIUM_TAG="${TARGET%-*}"
log "目标:ungoogled tag=${TARGET} → chromium tag=${CHROMIUM_TAG}"

if [ -d "$SRC_DIR/.git" ]; then
  log "源码已存在,跳过首次 fetch:${SRC_DIR}"
  echo "  跟版请用 tools/20-rebase.sh"
  exit 0
fi

log "1/2 git clone chromium/src(浅克隆 tag)"
mkdir -p "$CHROMIUM_DIR"
git clone --filter=blob:none --no-checkout \
  https://chromium.googlesource.com/chromium/src.git "$SRC_DIR"
cd "$SRC_DIR"
git fetch --depth=1 origin "refs/tags/${CHROMIUM_TAG}:refs/tags/${CHROMIUM_TAG}" || \
  die "拉不到 tag ${CHROMIUM_TAG} —— 确认该版本存在于 chromium.googlesource.com"
git checkout -f "$CHROMIUM_TAG"

log "2/2 gclient sync(拉依赖,约 50 GB)"
gclient sync --with_branch_heads --with_tags -D

log "完成"
echo "源码:${SRC_DIR}"
echo "下一步:tools/20-rebase.sh --dry-run"
