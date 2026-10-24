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
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31m[fatal] %s\033[0m\n' "$*" >&2; exit 1; }

# 路径归一化:Windows 的 Git Bash 下 `pwd` 给 `/f/...`、`git` 给 `F:/...`,
# 同一个目录字符串永不相等 —— 任何路径比较前都要过这里。
norm() { ( cd "$1" 2>/dev/null && pwd -P ); }

# ---- 让 GitHub 出身的依赖走 GitHub,别去挤 googlesource ----
#
# 实测(2026-10-24):`gclient sync` 中途被 **HTTP 429** 打断 ——
#   `chromium.googlesource.com` 的**匿名共享配额按 IP 限流**。
#   而 `external/github.com/<org>/<repo>` 这类路径本来就是从 GitHub 镜像过去的,
#   重写回 GitHub 既快(实测 7 MB/s)也不吃 Google 配额。
#
# **用 `GIT_CONFIG_*` 环境变量,而不是 `git config --global`**:
#   - 只对本次 gclient 及其 git 子进程生效,**不污染用户的全局 gitconfig**
#   - **不会留下旧规则**:写成 `--global` 的话,规则改一版就残留一版
#     (实测踩过:`.../v8/` -> `github.com/` 那条错规则留在了全局配置里,
#      导致 v8 被映射成不存在的 `github.com/v8.git`)
#   - 作者/CI 拿到脚本就能复现,不需要先跑一遍「配置命令」
#
# ⚠️ `insteadOf` 用**最长前缀匹配**,所以针对性规则是安全的;
#    **别**写 `.../ -> github.com/` 这种泛规则(会把 `chromium/src.git` 也改坏)。
# ⚠️ `external/github.com/<org>/<repo>` **不一定**是 1:1 的 GitHub 仓库 ——
#    有的指向**子目录**(如 `SeleniumHQ/selenium/py`、`llvm/llvm-project/clang/tools/clang-format`)。
#    那些要靠 `.gclient` 的 `custom_deps` 跳过,否则一个 dep 失败会**整个 sync 退出**。
MIRROR_RULES=(
  "https://github.com/|https://chromium.googlesource.com/external/github.com/"
  "https://github.com/webmproject/|https://chromium.googlesource.com/webm/"
  # v8 这条**必须**带 org:仓库是 `v8/v8`,`.../v8/` 直接映射到 `github.com/`
  # 会得到 `github.com/v8.git`(不存在)。实测踩过。
  "https://github.com/v8/|https://chromium.googlesource.com/v8/"
)

export_git_mirror_env() {
  local i=0 r to from
  for r in "${MIRROR_RULES[@]}"; do
    to="${r%%|*}"; from="${r##*|}"
    export "GIT_CONFIG_KEY_${i}=url.${to}.insteadOf"
    export "GIT_CONFIG_VALUE_${i}=${from}"
    i=$((i + 1))
  done
  export GIT_CONFIG_COUNT="$i"
  log "  已注入 ${i} 条镜像重写(仅本次进程,不动全局配置)"
  for r in "${MIRROR_RULES[@]}"; do
    printf '    %s -> %s\n' "${r##*|}" "${r%%|*}"
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

# ---- 依赖镜像预检:自动生成 .gclient 的 custom_deps 跳过名单 ----
#
# 为什么要自动生成而不是手工维护:重写后的 URL **不一定存在** ——
# `external/github.com/<org>/<repo>` 里有**子目录型**条目(实测 10 个,
# 其中 7 个是 LLVM monorepo 的子目录:libc++ / libc++abi / libunwind / compiler-rt /
# llvm-libc / libFuzzer / clang-format)。而 **gclient 会因为一个 dep 失败退出整个 sync**。
# 手工维护的话,每换一个 Chromium 版本就要再踩一遍。
ROOT_POSIX="$(cygpath -u "$REPO_ROOT" 2>/dev/null || printf '%s' "$REPO_ROOT")"

find_python() {
  local cand="${ROOT_POSIX}/probe/.venv/Scripts/python.exe"
  if [ -x "$cand" ]; then printf '%s' "$cand"; return 0; fi
  local c
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

generate_skip_list() {
  local py
  py="$(find_python)" || {
    warn "找不到 python —— 跳过依赖预检。
  若 gclient sync 因某个 dep 失败,手工跑一次:
      <python> tools/preflight-deps-mirror.py
  把输出粘进 ${GCLIENT_FILE} 的 custom_deps。"
    return 0
  }
  log "  用 ${py} 预检 DEPS(可能需要几分钟)"
  "$py" "${ROOT_POSIX}/tools/preflight-deps-mirror.py" --emit-skips 2>/dev/null || true
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

# ---- .gclient(内容与 fetch chromium 生成的一致,外加两处必要调整)----------
log "1/5 写 .gclient"
if [ -f "$SRC_DIR/DEPS" ]; then
  log "  预检依赖镜像可达性(自动生成跳过名单)"
  SKIP_LINES="$(generate_skip_list)"
else
  warn "  还没有 src/DEPS(首次克隆),跳过预检 —— 下次运行时会自动补上"
  SKIP_LINES=""
fi
SKIP_BLOCK="${SKIP_LINES}"
if [ -z "${SKIP_BLOCK}" ]; then
  SKIP_BLOCK="      # (预检未发现不可达的依赖)"
fi

cat > "$GCLIENT_FILE" <<EOF
# 本文件由 tools/10-fetch-chromium.sh 生成 —— 手工改会被下次运行覆盖。
solutions = [
  {
    "name": "src",
    # 与 tools/10-fetch-chromium.sh 的 SRC_URL 保持一致(默认 GitHub 镜像)。
    # 指向 googlesource 会在批量拉取时被按 IP 限流(429)。
    "url": "https://github.com/chromium/chromium.git",
    "managed": False,
    "custom_deps": {
      # ★ 以下由 tools/preflight-deps-mirror.py 自动发现 ——
      #   这些依赖的 googlesource 路径指向 **GitHub 仓库的子目录**(不是 1:1 仓库),
      #   镜像重写后 URL 不存在。而 gclient 会因为**一个 dep 失败退出整个 sync**,
      #   所以必须显式跳过。它们都不是 Windows 桌面构建所必需的
      #   (7 个是 LLVM monorepo 的子目录:libc++/libc++abi/libunwind/compiler-rt/llvm-libc/libFuzzer/clang-format)。
${SKIP_BLOCK}
    },
    "custom_vars": {
      # PGO profile 约 1 GB,而我们的 gn args 里 chrome_pgo_phase=0,用不上
      "checkout_pgo_profiles": False,
    },
  },
]
EOF
echo "  wrote $GCLIENT_FILE"

# ---- clone ------------------------------------------------------------------
log "2/5 git clone chromium/src"
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

log "3/5 注入 git 镜像重写(仅本进程)"
export_git_mirror_env

log "4/5 gclient sync(拉依赖,约 50 GB;上游按 IP 限流,带重试)"
cd "$CHROMIUM_DIR"
sync_with_retry || die "gclient sync 连续多次失败 —— 多半是上游 429 限流未缓解。
  可以:① 稍后重跑本脚本(gclient sync 幂等,已拉好的会跳过);
        ② 换出口 IP 再跑(限流是按 IP 的);
        ③ 加大重试次数:GCLIENT_SYNC_ATTEMPTS=8 重跑。"

log "5/5 完成"
echo "源码:${SRC_DIR}"
echo "下一步:tools/20-rebase.sh --dry-run"
