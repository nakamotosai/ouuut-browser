#!/usr/bin/env bash
# tools/10-fetch-chromium.sh —— 取 Chromium 源码(不入库,见 .gitignore)
#
#   tools/10-fetch-chromium.sh                       # 用 chromium/UPSTREAM 的版本
#   tools/10-fetch-chromium.sh 156.0.8078.47-1       # 或指定 ungoogled tag
#
# 约 50 GB 下载。只需跑一次;之后跟版用 tools/20-rebase.sh。
#
# 说明:这里**手写 `.gclient`**(与 depot_tools 的 `fetch chromium` 生成的内容一致),
# 好处是源码落在 chromium/src,而不是 chromium/chromium/src。
# 这一点属于「尚未验证」项 —— 见 chromium/README.md §三。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROMIUM_DIR="${REPO_ROOT}/chromium"
SRC_DIR="${CHROMIUM_DIR}/src"
UPSTREAM_FILE="${CHROMIUM_DIR}/UPSTREAM"
GCLIENT_FILE="${CHROMIUM_DIR}/.gclient"

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
printf '%s' "$TARGET" | grep -qE '^[0-9]+\.[0-9]+' || die "本脚本只接受 tag 形式(如 156.0.8078.47-1)"
CHROMIUM_TAG="${TARGET%-*}"
log "目标:ungoogled tag=${TARGET} → chromium tag=${CHROMIUM_TAG}"

# ---- 已存在则校验,而不是盲信 -------------------------------------------------
if [ -e "$SRC_DIR" ]; then
  log "源码目录已存在,做校验而不是盲信"
  [ -d "$SRC_DIR/.git" ] || die "${SRC_DIR} 存在但不是 git 工作树 —— 删掉它重跑本脚本"
  TOPLEVEL="$(git -C "$SRC_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  [ "$TOPLEVEL" = "$SRC_DIR" ] || die "${SRC_DIR} 的仓库根是 ${TOPLEVEL},不是它自己 —— 删掉它重跑本脚本"
  URL="$(git -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)"
  case "$URL" in
    *chromium.googlesource.com/chromium/src*) : ;;
    *) die "${SRC_DIR} 的 origin 是 '${URL}',不是 chromium/src。删掉它重跑本脚本" ;;
  esac
  git -C "$SRC_DIR" rev-parse --verify HEAD >/dev/null 2>&1 \
    || die "${SRC_DIR} 还没 checkout 出任何 commit(残缺的 fetch)。删掉它重跑本脚本"
  log "校验通过;跟版请用 tools/20-rebase.sh"
  exit 0
fi

# ---- .gclient(内容与 fetch chromium 生成的一致)------------------------------
log "1/3 写 .gclient"
if [ -e "$GCLIENT_FILE" ]; then
  log "  .gclient 已存在,保留原样"
else
  cat > "$GCLIENT_FILE" <<'EOF'
solutions = [
  {
    "name": "src",
    "url": "https://chromium.googlesource.com/chromium/src.git",
    "managed": False,
    "custom_deps": {},
    "custom_vars": {},
  },
]
EOF
  echo "  wrote $GCLIENT_FILE"
fi

# ---- clone ------------------------------------------------------------------
log "2/3 git clone chromium/src(partial clone:blob 按需拉取)"
mkdir -p "$CHROMIUM_DIR"
# 刻意**不用 --depth=1**:`git apply --3way` 需要补丁 index 行的基对象,
# 浅克隆下不保证本地有。blobless partial clone 会按需补 blob,兼顾体积与三方合并。
git clone --filter=blob:none --no-checkout \
  https://chromium.googlesource.com/chromium/src.git "$SRC_DIR"
cd "$SRC_DIR"
git fetch origin "refs/tags/${CHROMIUM_TAG}:refs/tags/${CHROMIUM_TAG}" \
  || die "拉不到 tag ${CHROMIUM_TAG} —— 确认该版本存在于 chromium.googlesource.com"
git checkout -f "refs/tags/${CHROMIUM_TAG}"

log "3/3 gclient sync(拉依赖,约 50 GB)"
cd "$CHROMIUM_DIR"
gclient sync --with_branch_heads --with_tags

log "完成"
echo "源码:${SRC_DIR}"
echo "下一步:tools/20-rebase.sh --dry-run"
