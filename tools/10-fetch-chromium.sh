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

# ---- 让 GitHub 出身的依赖走 GitHub,别去挤 googlesource ----
#
# 实测(2026-10-24):`gclient sync` 中途被 **HTTP 429** 打断 ——
#   `chromium.googlesource.com` 的 **匿名共享配额**按 IP 限流,
#   报 `Short term server-time rate limit exceeded`。而单个 `git ls-remote` 秒回,
#   说明是「批量克隆把它打爆」,不是不通。
#
# `external/github.com/<org>/<repo>` 这类路径本来就是从 GitHub 镜像过去的,
# 重写回 GitHub 既快(实测 7 MB/s)也不受 Google 配额限制。
# 用 `--global` 是因为 gclient 的子进程只认全局配置。
configure_git_mirrors() {
  local rules=(
    "https://github.com/|https://chromium.googlesource.com/external/github.com/"
    "https://github.com/webmproject/|https://chromium.googlesource.com/webm/"
    "https://github.com/|https://chromium.googlesource.com/v8/"
  )
  local r from to have
  for r in "${rules[@]}"; do
    to="${r%%|*}"; from="${r##*|}"
    have="$(git config --global --get "url.${to}.insteadOf" 2>/dev/null || true)"
    if [ "$have" != "$from" ]; then
      git config --global --add "url.${to}.insteadOf" "$from"
      echo "  git 镜像重写:+ ${from} -> ${to}"
    fi
  done
}

# ---- 带重试的 gclient sync ----
#
# 上游按 IP 限流时,`gclient` 自己重试几轮后会放弃退出。所以外层再包一层:
# 每次失败退避后重跑 —— `gclient sync` 是幂等的,已拉好的部分会跳过。
sync_with_retry() {
  local attempts="${GCLIENT_SYNC_ATTEMPTS:-5}" i delay=60
  for i in $(seq 1 "$attempts"); do
    log "  第 ${i}/${attempts} 次 gclient sync(每次失败后退避 ${delay}s)"
    if "$GCLIENT" sync --with_branch_heads --with_tags; then
      return 0
    fi
    if [ "$i" -lt "$attempts" ]; then
      warn "gclient sync 失败(多为上游 429 限流);${delay}s 后重试"
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done
  return 1
}

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

# 源码来源。**默认用 GitHub 镜像**,不是 chromium.googlesource.com ——
# 实测(2026-10-24,本机):googlesource 的克隆 75 秒**零字节增长**(TCP 已建立、CPU 近乎 0,
# 就是不走数据);而 GitHub 镜像 25 秒下了 179 MB(≈7.2 MB/s)。差两个数量级。
# 需要换回官方源时:`CHROMIUM_SRC_URL=... tools/10-fetch-chromium.sh`
SRC_URL="${CHROMIUM_SRC_URL:-https://github.com/chromium/chromium.git}"

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
    *chromium.googlesource.com/chromium/src*|*github.com/chromium/chromium*) : ;;
    *) die "${SRC_DIR} 的 origin 是 '${URL}',不是 chromium/src 的镜像。确认后再决定是否删掉重跑。" ;;
  esac
  git -C "$SRC_DIR" rev-parse --verify HEAD >/dev/null 2>&1 \
    || die "${SRC_DIR} 还没 checkout 出任何 commit(残缺的 fetch)。确认后再决定是否删掉重跑。"
  log "校验通过 —— 跳过克隆,直接续 sync(本脚本幂等,已拉好的会跳过)"
  NEED_CLONE=0
else
  NEED_CLONE=1
fi

# ---- .gclient(内容与 fetch chromium 生成的一致)------------------------------
log "1/4 写 .gclient"
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
log "2/4 git clone chromium/src"
echo "  来源:${SRC_URL}"
mkdir -p "$CHROMIUM_DIR"
# `--depth=1`:只取目标 tag 那一个 commit。Chromium 的完整历史对我们是纯负担
#   (几十万 commit,而 rebase 走的是 checkout 一个新 tag,不需要旧历史)。
# `--filter=blob:none`:blob 按需拉取 —— 兼顾体积与 `git apply --3way`
#   (三方合并要补丁 index 行的基对象,blobless 克隆会在需要时联网补)。
# `--depth=1` 只取目标 tag 那一个 commit —— Chromium 的完整历史对我们是纯负担。
# **刻意不加 `--filter=blob:none`**:实测那样会让工作区检不出来 ——
#   索引里有一条条文件、但 worktree **0 个文件**,`git status` 全是 `D`。
#   原因是 blobless 克隆要按需拉 10 万+ 个 blob,在这条链路上不现实。
#   不加 filter 就是一次把该 commit 的 blob 全拉下来(约 2 GB),可预测得多;
#   而且 `git apply --3way` 需要的基对象一定在本地。
if [ "$NEED_CLONE" -eq 1 ]; then
  git clone --branch "$CHROMIUM_TAG" --depth=1 "$SRC_URL" "$SRC_DIR" \
    || die "克隆失败或 tag ${CHROMIUM_TAG} 不存在于 ${SRC_URL}"
  cd "$SRC_DIR"
  printf '  已 checkout:%s  文件数:%s\n' \
    "$(git describe --tags --always 2>/dev/null || echo '?')" "$(git ls-files | wc -l)"
else
  log "  (跳过克隆;SRC_DIR 已存在且校验通过)"
fi

log "3/4 配置 git 镜像重写"
configure_git_mirrors

log "4/4 gclient sync(拉依赖,约 50 GB;上游按 IP 限流,带重试)"
cd "$CHROMIUM_DIR"
sync_with_retry || die "gclient sync 连续多次失败 —— 多半是上游 429 限流未缓解。
  可以:① 稍后重跑本脚本(gclient sync 幂等,已拉好的会跳过);
        ② 换出口 IP 再跑(限流是按 IP 的);
        ③ 用更小的并发:GCLIENT_SYNC_ATTEMPTS=8 重跑。"

log "完成"
echo "源码:${SRC_DIR}"
echo "下一步:tools/20-rebase.sh --dry-run"
