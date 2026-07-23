#!/usr/bin/env bash
#
# ADR-0007 §5: 备份新鲜度告警检查
#
# 功能：
#   1. 扫描 manifest 目录中的所有备份记录
#   2. 查找最近一次已验证（verificationStatus=verified）的备份
#   3. 检查该备份是否在新鲜度阈值内（默认 24 小时）
#   4. 如果没有已验证备份或已超时，返回非零退出码（触发告警）
#
# 用法：
#   ./freshness-check.sh --manifest-dir /data/backups/manifests
#   ./freshness-check.sh --manifest-dir /data/backups/manifests --max-age-hours 24
#
# CI 模式（用于测试，可指定自定义当前时间）：
#   ./freshness-check.sh --manifest-dir /tmp/backups --ci-mode --now "2026-07-20T12:00:00Z"
#
# 退出码：
#   0 — 新鲜度正常（存在阈值内的已验证备份）
#   1 — 新鲜度告警（无已验证备份或已超时）
#   2 — 参数错误或脚本错误

set -euo pipefail

# ─── 参数解析 ───────────────────────────────────────────────────────────

MANIFEST_DIR=""
MAX_AGE_HOURS=24
CI_MODE=false
NOW_OVERRIDE=""

usage() {
  cat <<EOF
用法: freshness-check.sh [选项]

必需选项:
  --manifest-dir PATH   manifest 存储目录

可选:
  --max-age-hours N     新鲜度阈值（小时），默认 24
  --ci-mode             CI 模式（启用 --now 参数）
  --now TIMESTAMP       覆盖当前时间（仅 CI 模式，ISO 8601 UTC）
  -h, --help            显示帮助
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-dir) MANIFEST_DIR="$2"; shift 2 ;;
    --max-age-hours) MAX_AGE_HOURS="$2"; shift 2 ;;
    --ci-mode) CI_MODE=true; shift ;;
    --now) NOW_OVERRIDE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

if [[ -z "$MANIFEST_DIR" ]]; then
  echo "[freshness] 错误: --manifest-dir 为必需参数" >&2
  exit 2
fi

if [[ ! -d "$MANIFEST_DIR" ]]; then
  echo "[freshness] 错误: manifest 目录不存在: $MANIFEST_DIR" >&2
  exit 2
fi

if ! [[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || [[ "$MAX_AGE_HOURS" -eq 0 ]]; then
  echo "[freshness] 错误: --max-age-hours 必须为正整数" >&2
  exit 2
fi

# ─── 工具函数 ───────────────────────────────────────────────────────────

log() { echo "[freshness] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }

# 从 manifest JSON 中提取字段值
extract_field() {
  local file="$1" field="$2"
  python3 -c "
import json, sys
with open('$file') as f:
    data = json.load(f)
print(data.get('$field', ''))
" 2>/dev/null || echo ""
}

# 将 ISO 8601 时间戳转换为 epoch 秒
to_epoch() {
  local iso_ts="$1"
  if [[ "$CI_MODE" == "true" ]]; then
    # CI 模式：使用 python 解析（兼容 macOS 和 Linux）
    python3 -c "
from datetime import datetime, timezone
ts = datetime.fromisoformat('$iso_ts'.replace('Z', '+00:00'))
print(int(ts.timestamp()))
" 2>/dev/null || echo "0"
  else
    # 生产模式：使用 date 命令
    if date -u -d "$iso_ts" +%s 2>/dev/null; then
      :
    elif date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso_ts" +%s 2>/dev/null; then
      :
    else
      echo "0"
    fi
  fi
}

get_now_epoch() {
  if [[ -n "$NOW_OVERRIDE" ]]; then
    to_epoch "$NOW_OVERRIDE"
  else
    date -u +%s
  fi
}

# ─── 主流程 ─────────────────────────────────────────────────────────────

log "开始备份新鲜度检查"
log "  manifest 目录: $MANIFEST_DIR"
log "  新鲜度阈值: ${MAX_AGE_HOURS}h"

# 收集所有 manifest 文件
MANIFESTS=()
while IFS= read -r f; do
  MANIFESTS+=("$f")
done < <(find "$MANIFEST_DIR" -name '*.manifest.json' | sort)

TOTAL=${#MANIFESTS[@]}
log "找到 $TOTAL 个 manifest"

if [[ "$TOTAL" -eq 0 ]]; then
  echo "CRITICAL: manifest 目录中没有备份记录" >&2
  echo "backup_freshness_status=critical" >&2
  echo "backup_freshness_reason=no_backups" >&2
  exit 1
fi

# 查找最近的已验证备份
LATEST_VERIFIED_FILE=""
LATEST_VERIFIED_COMPLETED=""
LATEST_VERIFIED_EPOCH=0

# 按文件名逆序遍历（最新的文件名时间戳最大）
for manifest in $(printf '%s\n' "${MANIFESTS[@]}" | sort -r); do
  verification_status=$(extract_field "$manifest" "verificationStatus")
  if [[ "$verification_status" == "verified" ]]; then
    completed_at=$(extract_field "$manifest" "completedAt")
    if [[ -n "$completed_at" ]]; then
      epoch=$(to_epoch "$completed_at")
      if [[ "$epoch" -gt 0 ]]; then
        LATEST_VERIFIED_FILE="$manifest"
        LATEST_VERIFIED_COMPLETED="$completed_at"
        LATEST_VERIFIED_EPOCH="$epoch"
        break
      fi
    fi
  fi
done

if [[ -z "$LATEST_VERIFIED_FILE" ]]; then
  echo "CRITICAL: 没有已验证的备份（所有备份均处于 pending 或 failed 状态）" >&2
  echo "backup_freshness_status=critical" >&2
  echo "backup_freshness_reason=no_verified_backup" >&2
  echo "backup_total_count=$TOTAL" >&2
  exit 1
fi

# 计算新鲜度
NOW_EPOCH=$(get_now_epoch)
if [[ "$NOW_EPOCH" -eq 0 ]]; then
  echo "ERROR: 无法确定当前时间" >&2
  exit 2
fi

AGE_SECONDS=$((NOW_EPOCH - LATEST_VERIFIED_EPOCH))
AGE_HOURS=$((AGE_SECONDS / 3600))
MAX_AGE_SECONDS=$((MAX_AGE_HOURS * 3600))

log "最近已验证备份: $(basename "$LATEST_VERIFIED_FILE")"
log "  完成时间: $LATEST_VERIFIED_COMPLETED"
log "  距今: ${AGE_HOURS}h (${AGE_SECONDS}s)"
log "  阈值: ${MAX_AGE_HOURS}h (${MAX_AGE_SECONDS}s)"

if [[ "$AGE_SECONDS" -gt "$MAX_AGE_SECONDS" ]]; then
  echo "WARNING: 最近已验证备份已过期（${AGE_HOURS}h > ${MAX_AGE_HOURS}h）" >&2
  echo "backup_freshness_status=warning" >&2
  echo "backup_freshness_reason=stale" >&2
  echo "backup_last_verified_at=$LATEST_VERIFIED_COMPLETED" >&2
  echo "backup_age_hours=$AGE_HOURS" >&2
  echo "backup_max_age_hours=$MAX_AGE_HOURS" >&2
  exit 1
fi

echo "OK: 备份新鲜度正常（最近已验证备份距今 ${AGE_HOURS}h，阈值 ${MAX_AGE_HOURS}h）" >&2
echo "backup_freshness_status=ok" >&2
echo "backup_last_verified_at=$LATEST_VERIFIED_COMPLETED" >&2
echo "backup_age_hours=$AGE_HOURS" >&2
echo "backup_max_age_hours=$MAX_AGE_HOURS" >&2
exit 0
