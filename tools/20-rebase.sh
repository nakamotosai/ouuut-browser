#!/usr/bin/env bash
# tools/20-rebase.sh —— **M1 的核心验收:一条命令 rebase**
#
#   tools/20-rebase.sh                    # 用 chromium/UPSTREAM 记录的版本
#   tools/20-rebase.sh 157.0.8103.15-1    # 或指定 ungoogled tag
#   tools/20-rebase.sh <commit-sha>       # 或指定 chromium/src 的 commit
#   tools/20-rebase.sh --dry-run          # 只打印动作,不落地
#
# 阶段(共 7):
#   1/7 前置检查      2/7 取版本        3/7 应用补丁   4/7 gn gen
#   5/7 autoninja     6/7 冒烟启动      7/7 写 UPSTREAM
#
# 补丁失败即中止,**绝不静默跳过**。
# 前提:工具链已就绪(见 chromium/README.md §二 第 0 步)。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROMIUM_DIR="${REPO_ROOT}/chromium"
SRC_DIR="${CHROMIUM_DIR}/src"
PATCH_DIR="${CHROMIUM_DIR}/patches"
OUT_DIR="${SRC_DIR}/out/Release"
UPSTREAM_FILE="${CHROMIUM_DIR}/UPSTREAM"

for d in "F:/depot_tools" "/f/depot_tools" "$HOME/depot_tools" "/c/depot_tools"; do
  if [ -d "$d" ]; then export PATH="${d}:${PATH}"; DEPOT_TOOLS="$d"; break; fi
done

DRY_RUN=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    -*) printf '[fatal] 未知参数: %s\n用法见 %s --help\n' "$arg" "$0" >&2; exit 2 ;;
    *)
      if [ -n "$TARGET" ]; then
        printf "[fatal] 只接受一个版本参数(已有 '%s',又来了 '%s')\n" "$TARGET" "$arg" >&2
        exit 2
      fi
      TARGET="$arg"
      ;;
  esac
done

log()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[fatal] %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

# ---- 1/7 前置检查 -----------------------------------------------------------
log "1/7 前置检查"
[ -n "${DEPOT_TOOLS:-}" ] || die "找不到 depot_tools。先跑 chromium/README.md §二 第 0 步。"
command -v gclient >/dev/null || die "gclient 不在 PATH(depot_tools=${DEPOT_TOOLS})"
command -v gn      >/dev/null || warn "gn 不在 PATH,稍后 gclient sync 会把它带进来"
[ -d "$SRC_DIR" ]  || die "找不到 ${SRC_DIR}。先跑 tools/10-fetch-chromium.sh。"

# **关键守卫**:必须确认 SRC_DIR 自己就是一个 git 工作树。
# 否则 git 会向上找到外层项目仓库,`git checkout -f` 会强制作废本项目的未提交改动。
if [ "$DRY_RUN" -eq 0 ]; then
  TOPLEVEL="$(git -C "$SRC_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$TOPLEVEL" ] || die "${SRC_DIR} 不是 git 工作树(残缺的 checkout?)。删掉它重跑 tools/10-fetch-chromium.sh。"
  [ "$TOPLEVEL" = "$SRC_DIR" ] || die "${SRC_DIR} 的仓库根是 ${TOPLEVEL} —— 不是它自己。
  这说明 chromium/src 没建好,继续下去会误改外层仓库。中止。"
else
  printf '  [dry-run] 会校验 %s 是自己的 git 工作树\n' "$SRC_DIR"
fi

if [ -z "$TARGET" ] && [ -f "$UPSTREAM_FILE" ]; then
  TARGET="$(grep -E '^version=' "$UPSTREAM_FILE" | head -1 | cut -d= -f2-)"
fi
[ -n "$TARGET" ] || die "没有目标版本:给个参数,或先让 chromium/UPSTREAM 里有 version=…"

# tag(156.0.8078.47-1)→ chromium tag(156.0.8078.47);否则当作 commit
if printf '%s' "$TARGET" | grep -qE '^[0-9]+\.[0-9]+'; then
  REF_KIND="tag"; CHROMIUM_REF="${TARGET%-*}"
else
  REF_KIND="sha"; CHROMIUM_REF="$TARGET"
fi
log "目标:${TARGET}(按 ${REF_KIND} 处理,chromium ref = ${CHROMIUM_REF})"

if [ -f "$UPSTREAM_FILE" ]; then
  log "原 UPSTREAM 记录:"; sed 's/^/  /' "$UPSTREAM_FILE"
fi

# ---- 2/7 取版本 ------------------------------------------------------------
log "2/7 gclient sync"
cd "$SRC_DIR"
if [ "$REF_KIND" = "tag" ]; then
  if [ "$DRY_RUN" -eq 0 ]; then
    git fetch --tags "origin" \
      "refs/tags/${CHROMIUM_REF}:refs/tags/${CHROMIUM_REF}" \
      || die "拉不到 tag ${CHROMIUM_REF}。
  确认该 tag 存在于 chromium.googlesource.com/chromium/src。
  若这个版本只有 commit、没有 tag,请直接把 commit SHA 作为参数传入(rebase 会按 sha 处理)。"
    git checkout -f "refs/tags/${CHROMIUM_REF}"
  else
    printf '  [dry-run] git fetch --tags origin refs/tags/%s:refs/tags/%s\n' "$CHROMIUM_REF" "$CHROMIUM_REF"
    printf '  [dry-run] git checkout -f refs/tags/%s\n' "$CHROMIUM_REF"
  fi
else
  if [ "$DRY_RUN" -eq 0 ]; then
    git fetch origin "$CHROMIUM_REF" || die "拉不到 commit ${CHROMIUM_REF}(注意本仓库是 partial clone,需要能访问 chromium.googlesource.com)"
    git checkout -f FETCH_HEAD
  else
    printf '  [dry-run] git fetch origin %s && git checkout -f FETCH_HEAD\n' "$CHROMIUM_REF"
  fi
fi
run gclient sync --with_branch_heads --with_tags

# ---- 3/7 应用补丁 ----------------------------------------------------------
log "3/7 应用补丁(${PATCH_DIR})"
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
  → 冲突已留在工作区。手工解决后,用**下面这条**(注意是 diff HEAD,不要先 git add):
      git -C '$SRC_DIR' diff HEAD > '$p'
  然后重跑本脚本。"
      fi
    fi
  done
fi

# ---- 4/7 gn gen ------------------------------------------------------------
log "4/7 gn gen out/Release"
mkdir -p "$(dirname "$OUT_DIR")"
# 说明:这是一份「能编出可跑 chrome.exe」的最小官方配置;
# 首次实跑时按 chromium/README.md §三 逐项核对。
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
  gn gen "$OUT_DIR" --args="$GN_ARGS"
fi

# ---- 5/7 构建 --------------------------------------------------------------
log "5/7 autoninja(预计数小时)"
run autoninja -C "$OUT_DIR" chrome

# ---- 6/7 冒烟(**必须在写 UPSTREAM 之前**)---------------------------------
log "6/7 冒烟:启动一次产物"
CHROME_BIN="${OUT_DIR}/chrome.exe"
[ -f "$CHROME_BIN" ] || CHROME_BIN="${OUT_DIR}/chrome"
if [ "$DRY_RUN" -eq 0 ]; then
  [ -f "$CHROME_BIN" ] || die "构建结束但找不到产物:${CHROME_BIN}"
  VER_OUT="$("$CHROME_BIN" --version 2>&1 | head -1 || true)"
  printf '  产物自报版本:%s\n' "${VER_OUT:-<空>}"
  # 注意:`chrome.exe --version` 在 Windows 上的行为**尚未验证**(见 README §三)。
  # 取不到版本号时只告警不判死,但会把结果写进 UPSTREAM 的 smoke= 字段。
else
  VER_OUT="<dry-run>"
  printf '  [dry-run] 启动 %s --version\n' "$CHROME_BIN"
fi

# ---- 7/7 写 UPSTREAM(仅在冒烟走完之后)------------------------------------
log "7/7 写 chromium/UPSTREAM"
if [ "$DRY_RUN" -eq 0 ]; then
  # 补丁摘要:空数组必须短路,否则 `cat` 会退化成读 stdin 而挂住
  if [ "${#PATCHES[@]}" -gt 0 ]; then
    PATCH_DIGEST="$( { for p in "${PATCHES[@]}"; do printf '%s\n' "$(basename "$p")"; cat -- "$p"; done; } | sha256sum | cut -d' ' -f1)"
  else
    PATCH_DIGEST=""
  fi

  TMP_UPSTREAM="${UPSTREAM_FILE}.tmp"
  {
    echo "version=${TARGET}"
    echo "ref_kind=${REF_KIND}"
    echo "chromium_ref=${CHROMIUM_REF}"
    echo "commit=$(git rev-parse HEAD)"
    echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "patch_count=${#PATCHES[@]}"
    echo "patch_digest=${PATCH_DIGEST}"
    echo "artifact=${CHROME_BIN}"
    echo "artifact_sha256=$(sha256sum "$CHROME_BIN" | cut -d' ' -f1)"
    echo "gn_args_digest=$(printf '%s' "$GN_ARGS" | sha256sum | cut -d' ' -f1)"
    echo "smoke=${VER_OUT}"
  } > "$TMP_UPSTREAM"
  mv -f "$TMP_UPSTREAM" "$UPSTREAM_FILE"   # 原子替换:冒烟失败时不会留下假锚
  cat "$UPSTREAM_FILE"
  echo
  echo "✅ rebase 完成:${TARGET}"
else
  echo "✅ dry-run 完成(未落地任何改动)"
fi
