#!/usr/bin/env bash
# dispatch-rea.sh — 派 REA 逆向任务给 codex(可选模型覆盖)
#
# 与 canonical 脚本 `<你的家目录>\.omp\agent\scripts\delegate-codex-rea.sh` 的**契约差异**:
#
#   位置参数          本脚本                        canonical 脚本
#   ---------------  --------------------------   ------------------------
#   1  工作目录       目录                          目录
#   2  任务             任务**描述文件路径**           任务**描述文本本身**
#   3  第三个参数       模型(留空/`-` = 用 codex 默认)  **超时秒数**
#   4  第四个参数       超时秒数                       不存在
#
#   → 想照抄 canonical 的调用形状会踩坑:它把你的超时值当成模型名。
#     本脚本不许省略第 3 个参数:要默认模型就写 `""` 或 `-`。
#
# 相同的契约:stdin 关死(`</dev/null`,否则 codex 会挂等输入)、
# nohup 脱离(调度官那一轮结束后继续跑)、`-o` 把末条消息落成 report.md、rc 单独落盘。
#
# 用法: dispatch-rea.sh <工作目录> <任务描述文件> [模型|""|-] [超时秒数]
# 查看: dispatch-rea.sh --poll <job目录>
#
# 注意(Git Bash 陷阱):本机 PATH 上第一个 `bash` 是 C:\WINDOWS\system32\bash.exe
# (WSL 启动器,未装发行版 → 报 "i/o error: stream did not contain valid UTF-8")。
# 必须用 "C:/Program Files/Git/bin/bash.exe" 调用本脚本。

set -uo pipefail

# --poll <job目录>:看进度或取报告
if [ "${1:-}" = "--poll" ]; then
  JOB="${2:?用法: --poll <job目录>}"
  # 先判存在性:否则打错路径会被误报成「仍在跑」,让人白等
  if [ ! -d "$JOB" ]; then
    echo "job 目录不存在: $JOB" >&2
    exit 2
  fi
  if [ -f "$JOB/rc" ]; then
    echo "== 完成 rc=$(cat "$JOB/rc") =="
    if [ -f "$JOB/report.md" ] && [ -s "$JOB/report.md" ]; then
      cat "$JOB/report.md"
    else
      echo "(报告文件为空,退回 stdout 尾部)"
      grep -v '^[[:space:]]*$' "$JOB/stdout.log" 2>/dev/null | tail -60
    fi
  else
    echo "== 仍在跑 =="
    echo "模型: $(cat "$JOB/model" 2>/dev/null)"
    echo "已耗时: $(( $(date +%s) - $(cat "$JOB/started" 2>/dev/null || date +%s) ))s"
    echo "--- stdout 尾部 ---"
    grep -v '^[[:space:]]*$' "$JOB/stdout.log" 2>/dev/null | tail -8
  fi
  exit 0
fi

WORKDIR="${1:?用法: dispatch-rea.sh <工作目录> <任务描述文件> [模型|\"\"|-] [超时秒数]}"
TASKFILE="${2:?缺少任务描述文件}"
# 第 3 参数留空(或传 `-`)则不覆盖模型,用 codex 自己的默认(config.toml 的 model)。
# 2026-10-24 起 codex 默认为 deepseek-v4.1-flash:free(tokenharbor 上游),
# 所以这里不硬编码任何模型名。
MODEL="${3:-}"
TIMEOUT="${4:-5400}"

MODEL_ARGS=()
if [ -n "$MODEL" ] && [ "$MODEL" != "-" ]; then
  MODEL_ARGS=(-c "model=$MODEL")
fi

[ -s "$TASKFILE" ] || { echo "任务描述文件不存在或为空: $TASKFILE" >&2; exit 1; }

# 工作目录/任务文件一律先解析成绝对路径。
# 原因:后台子 shell 会 `cd "$WORKDIR"`,若再把相对路径喂给 `codex -C`,
# 它会以「已经把 cd 进去的目录」为基准再拼一次 → 报 os error 2 直接死在启动前。
mkdir -p "$WORKDIR" 2>/dev/null \
  || { echo "无法创建工作目录: $WORKDIR" >&2; exit 1; }
WORKDIR="$(cd "$WORKDIR" && pwd)" \
  || { echo "无法进入工作目录: $WORKDIR" >&2; exit 1; }
TASKFILE="$(cd "$(dirname "$TASKFILE")" && pwd)/$(basename "$TASKFILE")" \
  || { echo "无法解析任务文件路径: $TASKFILE" >&2; exit 1; }
[ -s "$TASKFILE" ] || { echo "任务描述文件不存在或为空: $TASKFILE" >&2; exit 1; }

# mktemp -d 保证唯一:同一秒内派两次也不会撞同一个 job 目录(撞了就互相覆盖 stdout/rc/报告)
JOB="$(mktemp -d "$WORKDIR/.rea-job-$(date +%Y%m%d-%H%M%S)-XXXX")" \
  || { echo "无法创建 job 目录(在 $WORKDIR 下)" >&2; exit 1; }
date +%s > "$JOB/started" || { echo "无法写入 $JOB/started" >&2; exit 1; }
printf '%s\n' "$MODEL" > "$JOB/model" || { echo "无法写入 $JOB/model" >&2; exit 1; }
cp "$TASKFILE" "$JOB/task.txt" 2>/dev/null || true

# 任务文件用绝对 Windows 路径写进提示词,不依赖 codex 的 cwd。
if command -v cygpath >/dev/null 2>&1; then
  TASK_WIN="$(cygpath -w "$TASKFILE")"
else
  TASK_WIN="$TASKFILE"
fi

PROMPT="Read the file $TASK_WIN — it contains a complete reverse-engineering brief (in Chinese) for the ego lite browser binaries. Execute that task now. Static read-only analysis only: do not run the browser, do not modify any file. Deliver the full report as REA-REPORT.md in the current working directory, and also paste the full report text in your final reply.

【交付形态】按报告格式产出:1)结论 2)证据(每条挂 REA Evidence id/命令/产物路径/digest) 3)限制与未知 4)可复现步骤。把报告全文写进工作目录的 REA-REPORT.md,并在最终回复里也给全文。"

(
  cd "$WORKDIR" || { echo 1 > "$JOB/rc"; exit 1; }
  nohup timeout "$TIMEOUT" codex exec -C "$WORKDIR" --skip-git-repo-check \
    -c 'mcp_servers.rea.enabled=false' \
    "${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"}" \
    -o "$JOB/report.md" \
    "$PROMPT" < /dev/null > "$JOB/stdout.log" 2>&1
  echo "$?" > "$JOB/rc"
) >/dev/null 2>&1 &
disown 2>/dev/null || true

echo "$JOB"
echo "模型: ${MODEL:-(codex 默认)}"
echo "超时: ${TIMEOUT}s"
echo "轮询: bash $0 --poll \"$JOB\""
