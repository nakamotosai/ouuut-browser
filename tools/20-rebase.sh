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

# 路径归一化:**必须**用它来把路径交给原生 Windows 程序(git / gn / autoninja / gclient)。
#
# 本机实测的坑:不同 shell 的路径写法不一致 ——
#   * 隐式 shell:`pwd` 给 `F:\projects\x`,而 `/f/projects/x` 只被 bash 内建(`[ -d ]`/`ls`)认;
#   * 显式 Git Bash:`pwd` 给 `/f/projects/x`。
# 而 **原生程序会把 `/f/x` 当成「当前盘根下的 f\x`」** —— 实测 `git clone /f/depot_tools`
# 落到了 `C:\f\depot_tools`。所以交给原生工具前一律转成 Windows 形。
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

REPO_ROOT="$(winpath "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")"
CHROMIUM_DIR="${REPO_ROOT}\\chromium"
SRC_DIR="${CHROMIUM_DIR}\\src"
PATCH_DIR="${CHROMIUM_DIR}\\patches"
OUT_DIR="${SRC_DIR}\\out\\Release"
UPSTREAM_FILE="${CHROMIUM_DIR}\\UPSTREAM"

for d in "/f/depot_tools" "F:/depot_tools" "/c/depot_tools" "C:/depot_tools" "$HOME/depot_tools"; do
  if [ -d "$d" ]; then export PATH="${d}:${PATH}"; DEPOT_TOOLS="$d"; break; fi
done

# 工具解析:Windows 上 depot_tools 同时提供 `gclient`(无扩展名脚本)与 `gclient.bat`。
# 在 Git Bash 下优先用 `.bat`(它自己会摆好 python 环境),否则回退到无扩展名形式。
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

# **必需**:这些是本机手工摸索出来的工具链要求,写进脚本才算「一条命令可复现」。
# 详见 docs/坑与解法.md 坑-21。
#
# 1) 用本机 VS,别去抓 Google 的 hermetic toolchain(那个只对 Googler 可用)
export DEPOT_TOOLS_WIN_TOOLCHAIN=0
#
# 2) `build/vs_toolchain.py` 只用 `%ProgramFiles%\...\2022\<版本>` 找 VS,
#    而本机 BuildTools 在 **Program Files (x86)** 下 —— 它的官方逃生口是这个变量。
export vs2022_install="C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools"

# **不再需要** SDK 版本 / NTDDI 的覆盖了 ——
# 我们已用 `tools/install-windows-sdk-nuget.py` 装好 **SDK 10.0.28000.0**
# (它里面 `sdkddkver.h` 定义了上游要的 `NTDDI_WIN11_BR`)。于是走的是
# **上游默认配置**,不需要构建补丁。
#
# ⚠️ 如果你手上**只有旧 SDK**(如 26100),上游会在两处卡住:
#    - `SDK_VERSION = '10.0.28000.0'` 硬钉在 `build/vs_toolchain.py` 与
#      `build/toolchain/win/setup_toolchain.py`
#    - `NTDDI_VERSION=NTDDI_WIN11_BR` 硬钉在 `build/config/win/BUILD.gn`,
#      而 `base/win/windows_version.cc` 会 `#error Windows 10.0.28000.0 SDK or higher required.`
#    那两条已从本仓库撤除(用上游默认更省事)。真需要时的做法见 chromium/README.md §二·五。
unset PYTHONUTF8 PYTHONIOENCODING || true

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

# 路径归一化:**必须**用它来比较路径。
# 在 Windows 的 Git Bash 下,`pwd` 给 POSIX 形(`/f/projects/x`),
# 而 `git rev-parse --show-toplevel` 给盘符形(`F:/projects/x`)—— 两者是同一个目录,
# 但字符串永不相等。任何「两个路径是否相同」的判断都要先过这里。
norm() { ( cd "$1" 2>/dev/null && pwd -P ); }

# 同一个临时文件的清理钩子(见阶段 7)
TMP_UPSTREAM=""
cleanup_tmp() { [ -n "$TMP_UPSTREAM" ] && rm -f "$TMP_UPSTREAM" 2>/dev/null || true; }
trap cleanup_tmp EXIT

# ---- 1/7 前置检查 -----------------------------------------------------------
log "1/7 前置检查"
[ -n "${DEPOT_TOOLS:-}" ] || die "找不到 depot_tools。先跑 chromium/README.md §二 第 0 步。"

GCLIENT="$(resolve_tool gclient)" || die "gclient 不在 PATH(depot_tools=${DEPOT_TOOLS};里面应有 gclient.bat 或无扩展名 gclient)"
GN="$(resolve_tool gn)" || warn "gn 暂不可用 —— gclient sync 之后它才会出现(depot_tools 自己会 bootstrap)"
AUTONINJA="$(resolve_tool autoninja)" || warn "autoninja 暂不可用 —— 同上,先让 gclient 跑一次 bootstrap"
printf '  工具:gclient=%s gn=%s autoninja=%s\n' "$GCLIENT" "${GN:-<未就绪>}" "${AUTONINJA:-<未就绪>}"
[ -d "$SRC_DIR" ]  || die "找不到 ${SRC_DIR}。先跑 tools/10-fetch-chromium.sh。"

# **关键守卫**:必须确认 SRC_DIR 自己就是一个 git 工作树。
# 否则 git 会向上找到外层项目仓库,`git checkout -f` 会强制作废本项目的未提交改动。
if [ "$DRY_RUN" -eq 0 ]; then
  [ -d "$SRC_DIR/.git" ] || die "${SRC_DIR} 没有 .git —— 残缺的 checkout。
  继续下去 git 会向上找到外层项目仓库并强制作废它的未提交改动。中止。"
  TOPLEVEL="$(git -C "$SRC_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$TOPLEVEL" ] || die "${SRC_DIR} 不是 git 工作树。删掉它重跑 tools/10-fetch-chromium.sh。"
  # 两边都归一化再比:直接比字符串在 Windows 上必然不等(见 norm() 注释)
  if [ "$(norm "$TOPLEVEL")" != "$(norm "$SRC_DIR")" ]; then
    die "${SRC_DIR} 的仓库根是 ${TOPLEVEL} —— 不是它自己。
  这说明 chromium/src 没建好,继续下去会误改外层仓库。中止。"
  fi
  # `pwd -P` 会把 junction / symlink 折叠成物理路径,于是「src 是指向本项目根的别名」
  # 这种情况会让上面那条相等判断**误判为通过**。所以再断言一次:解析结果不能是本项目根。
  if [ "$(norm "$TOPLEVEL")" = "$(norm "$REPO_ROOT")" ]; then
    die "${SRC_DIR} 解析到本项目仓库根 ${REPO_ROOT} —— 多半是个 junction/symlink 别名。
  继续下去 git 的 fetch/checkout 会在**本项目仓库**里执行、作废未提交改动。中止。
  请把 chromium/src 换成真实的 chromium/src 克隆(见 tools/10-fetch-chromium.sh)。"
  fi
else
  printf '  [dry-run] 会校验 %s 是自己的 git 工作树(路径先归一化再比)\n' "$SRC_DIR"
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
log "2/7 取版本"
cd "$SRC_DIR"

# ⚠️⚠️ 本仓库是 **`--depth 1` 浅克隆**,而且 `remote.origin.fetch` 是
#      `+refs/tags/*:refs/tags/*`。这两条合起来意味着:
#      **浅克隆里任何想补齐历史的 `git fetch`(尤其带 `--tags`)都会去拉整棵
#      chromium 历史 —— 实测要 29,397,996 个对象**,几十小时且可能撑爆磁盘。
#      (2026-10-24 实测踩过:`git fetch --tags …` 的 index-pack 卡了 50 分钟。)
#      所以这里的铁律是:**绝不**出现 `--tags` / `--with_tags` / `--with_branch_heads`。
#
# 正确策略:
#   * 目标 tag 已在本地 → **一个字节都不下载**,直接检出;
#   * 目标 tag 不在本地 → 用 **`--depth 1`** 只拉这一个 tag;
#   * src 已在目标 revision → 跳过检出(**rebase 必须幂等、可重跑**)。

TARGET_SHA=""
if [ "$REF_KIND" = "tag" ] && git rev-parse --verify -q "refs/tags/${CHROMIUM_REF}" >/dev/null 2>&1; then
  TARGET_SHA="$(git rev-parse "refs/tags/${CHROMIUM_REF}")"
  printf '  tag %s 已在本地(%s)→ 无需下载\n' "$CHROMIUM_REF" "${TARGET_SHA:0:10}"
fi
[ -n "$TARGET_SHA" ] || TARGET_SHA="$CHROMIUM_REF"

CUR_SHA="$(git rev-parse HEAD 2>/dev/null || true)"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '  [dry-run] 目标 %s(按 %s);已在本地=%s\n' "$CHROMIUM_REF" "$REF_KIND" \
    "$( [ "$TARGET_SHA" != "$CHROMIUM_REF" ] && echo 是 || echo 否 )"
  printf '  [dry-run] git checkout -f %s(每次复位,保证补丁从 pristine 打)\n' "$TARGET_SHA"
else
  # tag 不在本地才拉 —— 且 **--depth 1**,只拉一层
  if [ "$REF_KIND" = "tag" ] && [ "$TARGET_SHA" = "$CHROMIUM_REF" ]; then
    git fetch --depth 1 origin \
      "refs/tags/${CHROMIUM_REF}:refs/tags/${CHROMIUM_REF}" \
      || die "拉不到 tag ${CHROMIUM_REF}。
  确认该 tag 存在于 chromium.googlesource.com/chromium/src。
  若这个版本只有 commit、没有 tag,请直接把 commit SHA 作为参数传入(rebase 会按 sha 处理)。"
    TARGET_SHA="$(git rev-parse "refs/tags/${CHROMIUM_REF}")"
  fi
  # sha 目标:同样浅拉(浅克隆里 `git fetch origin <sha>` 会拉历史,故必须 --depth 1)
  if [ "$REF_KIND" = "sha" ]; then
    if git rev-parse --verify -q "${TARGET_SHA}^{commit}" >/dev/null 2>&1; then
      printf '  commit %s 已在本地 → 无需下载\n' "${TARGET_SHA:0:10}"
    else
      git fetch --depth 1 origin "$TARGET_SHA" \
        || die "拉不到 commit ${TARGET_SHA}(注意本仓库是**浅克隆**,需要能访问 chromium.googlesource.com)"
    fi
  fi

  # **每次都在目标 revision 上复位** —— 即使已经在目标上也要做。
  # 理由:`checkout -f` 会把上一次 rebase 打上的补丁**复原成 pristine**,
  # 于是 3/7 的 `git apply` 永远从干净状态开始 → rebase 幂等、可重跑。
  # (已在目标上时这一步是廉价的;未跟踪的依赖不受影响。)
  if [ "$CUR_SHA" = "$TARGET_SHA" ]; then
    printf '  已在目标 revision(%s)→ 仅复位工作树\n' "${TARGET_SHA:0:10}"
  fi
  git checkout -f "$TARGET_SHA"
fi

# gclient sync:**不加** `--with_tags` / `--with_branch_heads`(理由见上)。
# 本仓库 `.gclient` 里 src 是 `"managed": False` —— gclient **不会**改 src 的 git 状态,
# 只按当前 src 的 DEPS 去同步各依赖;依赖已就位时这是一次廉价的空转。
run "$GCLIENT" sync

# gclient 的第一次运行会把 gn / ninja / autoninja 装进 depot_tools(bootstrap),
# 所以这里再解析一次 —— 上一轮它们可能还不存在。
GN="$(resolve_tool gn 2>/dev/null || true)"
AUTONINJA="$(resolve_tool autoninja 2>/dev/null || true)"

# ---- 3/7 应用补丁 ----------------------------------------------------------
log "3/7 应用补丁(${PATCH_DIR})"
shopt -s nullglob
PATCHES=("${PATCH_DIR}"/*.patch)
shopt -u nullglob

if [ "${#PATCHES[@]}" -eq 0 ]; then
  warn "没有补丁可应用(补丁集尚未建立 —— 见 chromium/README.md §五)"
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
# 写成 args.gn 文件再 `gn gen out/Release`,而不是 `--args="..."` ——
# 少一层转义、可读、且与 `gn args` 的用法一致。
# 说明:工具链**不在这里指定** —— 走 Chromium 自己的自动探测,只需上面那两个环境变量。
# (试过直接写 visual_studio_path:那条分支在上游是坏的,见 chromium/README.md §二·五)
ARGS_FILE="${OUT_DIR}/args.gn"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  [dry-run] 会写 %s 并执行 gn gen\n' "$ARGS_FILE"
else
  mkdir -p "$OUT_DIR"
  {
    echo '# 由 tools/20-rebase.sh 生成 —— 手工改会被覆盖。'
    echo '# 工具链走自动探测,只需 vs2022_install / OUUUT_WINDOWS_SDK_VERSION 两个环境变量。'
    echo 'is_debug = false'
    echo 'is_official_build = true'
    echo 'symbol_level = 1'
    echo 'proprietary_codecs = true'
    echo 'ffmpeg_branding = "Chrome"'
    echo 'treat_warnings_as_errors = false'
    echo 'chrome_pgo_phase = 0'
  } > "$ARGS_FILE"
  [ -n "$GN" ] || die "gn 仍不可用 —— 先手工跑一次 \$DEPOT_TOOLS/gclient.bat 让它 bootstrap"
  "$GN" gen "$OUT_DIR"
fi

# ---- 5/7 构建 --------------------------------------------------------------
log "5/7 autoninja(首次全量构建约数小时)"
# 线程数可调:`OUUUT_JOBS=12 tools/20-rebase.sh`
# (在内存/CPU 吃紧的机器上降线程是常见需求;默认交给 autoninja 自己决定)
JOBS_ARG=()
if [ -n "${OUUUT_JOBS:-}" ]; then
  JOBS_ARG=(-j "$OUUUT_JOBS")
  printf '  线程数:%s(来自 OUUUT_JOBS)\n' "$OUUUT_JOBS"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  [dry-run] %s -C %s %s chrome\n' "${AUTONINJA:-autoninja}" "$OUT_DIR" "${JOBS_ARG[*]}"
else
  [ -n "$AUTONINJA" ] || die "autoninja 不可用"
  "$AUTONINJA" -C "$OUT_DIR" "${JOBS_ARG[@]}" chrome
fi

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
