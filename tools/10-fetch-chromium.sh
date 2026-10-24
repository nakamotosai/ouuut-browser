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

# 交给原生 Windows 程序的路径必须先归一化 —— 见 20-rebase.sh 里 winpath() 的说明。
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

REPO_ROOT="$(winpath "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")"
CHROMIUM_DIR="${REPO_ROOT}\\chromium"
SRC_DIR="${CHROMIUM_DIR}\\src"
UPSTREAM_FILE="${CHROMIUM_DIR}\\UPSTREAM"
GCLIENT_FILE="${CHROMIUM_DIR}\\.gclient"

log() { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[fatal] %s\033[0m\n' "$*" >&2; exit 1; }

# 路径归一化:Windows 的 Git Bash 下 `pwd` 给 `/f/...`、`git` 给 `F:/...`,
# 同一个目录字符串永不相等 —— 任何路径比较前都要过这里。
norm() { ( cd "$1" 2>/dev/null && pwd -P ); }

for d in "/f/depot_tools" "F:/depot_tools" "/c/depot_tools" "C:/depot_tools" "$HOME/depot_tools"; do
  if [ -d "$d" ]; then export PATH="${d}:${PATH}"; DEPOT_TOOLS="$d"; break; fi
done

IS_WINDOWS=0
case "$(uname -s)" in *MINGW*|*MSYS*|*CYGWIN*|Windows_NT) IS_WINDOWS=1 ;; esac
resolve_tool() {
  local cands
  if [ "$IS_WINDOWS" -eq 1 ]; then cands="$1.bat $1"; else cands="$1 $1.bat"; fi
  local c
  for c in $cands; do
    if command -v "$c" >/dev/null 2>&1; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

GCLIENT="$(resolve_tool gclient)" || die "找不到 gclient —— 先跑 chromium/README.md §二 第 0 步"

# **必需**:告诉 depot_tools 用本机的 Visual Studio,而不要去抓 Google 的
# hermetic toolchain(那个只对 Googler 可用,抓会失败)。
export DEPOT_TOOLS_WIN_TOOLCHAIN=0

for a in "$@"; do
  case "$a" in
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  esac
done

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
  [ -d "$SRC_DIR/.git" ] || die "${SRC_DIR} 存在但没有 .git —— 残缺的 checkout。
  确认里面没有你要留的东西后再删掉重跑本脚本。"
  TOPLEVEL="$(git -C "$SRC_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  # 归一化后再比(见 norm() 注释);不归一化在 Windows 上必然不等
  if [ "$(norm "$TOPLEVEL")" != "$(norm "$SRC_DIR")" ]; then
    die "${SRC_DIR} 的仓库根是 ${TOPLEVEL},不是它自己。
  **先别删** —— 这多半是路径写法问题而不是数据问题。手工确认:
      cd '$SRC_DIR' && git rev-parse --show-toplevel
  若确实不是它自己,再决定怎么处理。"
  fi
  URL="$(git -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)"
  case "$URL" in
    *chromium.googlesource.com/chromium/src*) : ;;
    *) die "${SRC_DIR} 的 origin 是 '${URL}',不是 chromium/src。确认后再决定是否删掉重跑。" ;;
  esac
  git -C "$SRC_DIR" rev-parse --verify HEAD >/dev/null 2>&1 \
    || die "${SRC_DIR} 还没 checkout 出任何 commit(残缺的 fetch)。确认后再决定是否删掉重跑。"
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
"$GCLIENT" sync --with_branch_heads --with_tags

log "完成"
echo "源码:${SRC_DIR}"
echo "下一步:tools/20-rebase.sh --dry-run"
