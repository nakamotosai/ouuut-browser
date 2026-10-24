#!/usr/bin/env bash
# tools/find-dirty-deps.sh —— 找出(并可选清理)gclient 依赖里被弄脏的 checkout。
#
#   tools/find-dirty-deps.sh            # 只报告,不动
#   tools/find-dirty-deps.sh --clean    # 报告 + 删掉脏的 checkout(gclient 会重拉)
#
# **为什么需要它**
#
# `gclient sync` 在多个依赖上是并行跑的。一旦中途被打断(限流、Ctrl-C、进程被杀),
# 某些依赖的 checkout 会停在「工作区有本地改动」的状态。之后 gclient 再 sync 到
# **另一个** revision 时会报:
#
#     error: Your local changes to the following files would be overwritten by checkout
#     Error: <tid>> Unrecognized error, please merge or rebase manually.
#
# 这个错**只说线程号,不说是哪个依赖**(实测:只看到 `207>` / `208>`),
# 而且 gclient 自己的重试救不回来 —— 每次都在同一个地方失败。
#
# **为什么是「删掉」而不是 `git reset --hard`**
#
# 这些 checkout 是**由 gclient 管理的构建依赖**,不是任何人的工作成果
# (整个 `chromium/src` 都在 .gitignore 里)。它们的「本地改动」是**中断留下的残骸**。
# 删掉整个 checkout 让 gclient 重新 clone/checkout,是语义最干净、也最不容易
# 误伤别的东西的做法 —— 比在别人的理论上干净的仓库里敲 `reset --hard` 稳。
#
# 实测:132 个子仓库里只有 2 个是脏的,删掉这两个后 sync 就能继续。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_POSIX="$(cygpath -u "$REPO_ROOT" 2>/dev/null || printf '%s' "$REPO_ROOT")"
SRC_DIR="${ROOT_POSIX}/chromium/src"

CLEAN=0
for a in "$@"; do
  case "$a" in
    --clean) CLEAN=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) printf '[fatal] 未知参数: %s\n' "$a" >&2; exit 2 ;;
  esac
done

[ -d "$SRC_DIR" ] || { printf '[fatal] 找不到 %s\n' "$SRC_DIR" >&2; exit 1; }

cd "$SRC_DIR"
total=0
dirty_dirs=()

# gclient 的依赖 checkout 都在 4 层以内;用 .git 目录识别「一个独立仓库」
while IFS= read -r g; do
  d="$(dirname "$g")"
  [ "$d" = "." ] && continue      # 跳过 src 自己
  total=$((total + 1))
  st="$(git -C "$d" status --short 2>/dev/null | head -1)"
  if [ -n "$st" ]; then
    dirty_dirs+=("$d")
    printf 'DIRTY  %-58s %s\n' "$d" "$st"
  fi
done < <(find . -maxdepth 4 -name ".git" -not -path "./.git" 2>/dev/null)

printf '\n扫描 %d 个子仓库,脏的 %d 个\n' "$total" "${#dirty_dirs[@]}"

if [ "${#dirty_dirs[@]}" -eq 0 ]; then
  echo "✅ 没有脏的依赖 checkout"
  exit 0
fi

if [ "$CLEAN" -eq 0 ]; then
  echo
  echo "要清理就加 --clean(会删掉这些目录,gclient 下次 sync 会重新拉)"
  exit 0
fi

echo
for d in "${dirty_dirs[@]}"; do
  # 注意:必须用**绝对 Windows 路径**调 PowerShell/Remove-Item ——
  # 相对 POSIX 路径在这个 shell 里会被解析成别的地方(见 docs/坑与解法.md 坑-17)
  win="${REPO_ROOT}/chromium/src/$(printf '%s' "$d" | sed 's|^\./||' | tr '/' '\\')"
  if powershell -NoProfile -Command "if (Test-Path '$win') { Remove-Item -Recurse -Force '$win'; 'deleted' } else { 'absent' }" 2>/dev/null | tail -1 | grep -q deleted; then
    printf '  已删 %s\n' "$d"
  else
    printf '  删除失败 %s  —— 手工处理:%s\n' "$d" "$win" >&2
  fi
done
echo
echo "清完。重新跑 tools/10-fetch-chromium.sh"