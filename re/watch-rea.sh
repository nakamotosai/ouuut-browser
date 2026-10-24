#!/usr/bin/env bash
# watch-rea.sh — 盯住 REA 任务:限流 / 卡死 / 结束,任一条命中就退出并报告
#
# 为什么需要:codex 跑在共享上游上,可能中途被限流;而限流不一定致命
# (实测 2026-10-24:命中 429 后 codex 重试并继续跑了下去)。
# 所以本脚本看的是**当前状态**,不是历史记录。
#
# 退出码:0 = 任务正常结束(rc 已落盘);2 = 当前处于限流;4 = 卡死(日志不再增长);3 = job 目录消失
#
# 用法: watch-rea.sh <job目录> [轮询间隔秒,默认45] [卡死判定秒,默认600]
#
# 2026-10-24 两处修正(都踩过):
#   1. 早期版本对**整份**日志 grep 限流词 → 会把历史上已经恢复的 429 报成当前故障。
#      现在只看最近 200 行。
#   2. 早期版本的限流正则含 `rate.?limit` → 命中了 agent 正在分析的源码内容
#      (langfuse-*.mjs 里的 ATTR_ASPNETCORE_RATE_LIMITING_POLICY)。
#      现在只匹配 codex 自己的报错格式。

set -uo pipefail

JOB="${1:?用法: watch-rea.sh <job目录> [间隔秒] [卡死秒]}"
INTERVAL="${2:-45}"
STALL="${3:-600}"
LOG="$JOB/stdout.log"

if [ ! -d "$JOB" ]; then
  echo "job 目录不存在: $JOB"
  exit 3
fi

last_size=0
last_change=$(date +%s)
announced_running=0

while true; do
  if [ -f "$JOB/rc" ]; then
    echo "== 任务结束 rc=$(cat "$JOB/rc") =="
    echo "耗时: $(( $(date +%s) - $(cat "$JOB/started" 2>/dev/null || date +%s) ))s"
    if [ -s "$JOB/report.md" ]; then
      echo "报告: $(wc -c < "$JOB/report.md")B"
    else
      echo "报告: 未生成或为空(退回 stdout:$(wc -c < "$LOG" 2>/dev/null || echo 0)B)"
    fi
    exit 0
  fi

  if [ ! -d "$JOB" ]; then
    echo "== job 目录消失 =="
    exit 3
  fi

  size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ "$size" != "$last_size" ]; then
    last_size="$size"
    last_change=$now
    announced_running=0
  fi

  # 限流:只看最近 200 行 = 当前状态,不是历史
  # 用 herestring 而不是 `printf | grep`:200 行可能超过 64 KiB 管道缓冲,
  # 在 `set -o pipefail` 下 printf 会吃 SIGPIPE(141)→ if 走假分支 → **静默漏报**。
  # `tr -d '\000'` 先清空字节:REA 这类任务会把二进制内容打进日志,bash 的命令替换
  # 遇到 NUL 会打 "ignored null byte in input" 警告(实测 2026-10-24 刷屏)。
  recent="$(tail -200 "$LOG" 2>/dev/null | tr -d '\000')"
  if grep -qiE "exceeded retry limit|last status: 429" <<<"$recent"; then
    echo "== 当前处于限流 =="
    grep -iE "exceeded retry limit|last status: 429" <<<"$recent" | tail -3
    echo "日志大小: ${size}B,已耗时 $(( now - $(cat "$JOB/started" 2>/dev/null || echo "$now") ))s"
    exit 2
  fi

  # 卡死:日志在 STALL 秒内一字未增,且没有 rc
  if [ $(( now - last_change )) -ge "$STALL" ]; then
    echo "== 疑似卡死 =="
    echo "日志已 $(( now - last_change ))s 没有增长,大小停在 ${size}B"
    echo "--- 最后 5 行非空 ---"
    grep -v '^[[:space:]]*$' <<<"$recent" | tail -5
    exit 4
  fi

  if [ "$announced_running" = 0 ]; then
    echo "进行中: ${size}B,utime=$(( now - $(cat "$JOB/started" 2>/dev/null || echo "$now") ))s"
    announced_running=1
  fi

  sleep "$INTERVAL"
done
