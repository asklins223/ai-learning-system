#!/usr/bin/env bash
#
# ADR-0007 §1-5: Alpha 环境 12h 定时备份 cron 包装脚本
#
# 功能：
#   1. 读取 /etc/ailearn/backup.env 配置
#   2. 调用 backup.sh 执行加密备份 + S3 上传
#   3. 调用 rotate.sh 执行保留轮换
#   4. 调用 freshness-check.sh 检查备份新鲜度
#   5. 记录执行日志到 /var/log/ailearn/backup-cron.log
#   6. 任一步骤失败时退出非零（触发 cron 邮件告警）
#
# 用法（crontab 条目）：
#   0 */12 * * * /opt/ailearn/infra/backup/alpha-backup-cron.sh
#
# 配置文件 /etc/ailearn/backup.env 示例：
#   PG_HOST=localhost
#   PG_PORT=5432
#   PG_USER=ailearn_migrator
#   PG_DB=ailearn
#   SOURCE_RELEASE=0.5.0-alpha.1
#   SOURCE_COMMIT=abc1234
#   SOURCE_MIGRATION=0028
#   AGE_KEY_PATH=/etc/ailearn/backup-age.pub
#   S3_ENDPOINT=http://minio:9000
#   S3_BUCKET=ailearn-backups
#   S3_ACCESS_KEY=...
#   S3_SECRET_KEY=...
#   MANIFEST_DIR=/data/backups/manifests
#   DAILY_RETENTION=14
#   WEEKLY_RETENTION=4
#   FRESHNESS_MAX_AGE_HOURS=24
#
# 退出码：
#   0 — 全部步骤成功
#   1 — 配置缺失或备份失败
#   2 — 轮换失败（备份已成功，发出告警）
#   3 — 新鲜度检查失败（发出告警）

set -euo pipefail

# ─── 常量 ───────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${BACKUP_CONFIG_FILE:-/etc/ailearn/backup.env}"
LOG_DIR="${BACKUP_LOG_DIR:-/var/log/ailearn}"
LOG_FILE="$LOG_DIR/backup-cron.log"

# ─── 工具函数 ───────────────────────────────────────────────────────────

log() {
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "[$ts] $*" | tee -a "$LOG_FILE" >&2
}

# ─── 加载配置 ───────────────────────────────────────────────────────────

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "[alpha-backup-cron] 错误: 配置文件不存在: $CONFIG_FILE" >&2
  echo "[alpha-backup-cron] 请运行 alpha-cron-setup.sh 或手动创建配置文件" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$CONFIG_FILE"

# 校验必需配置
REQUIRED_VARS=(
  PG_HOST PG_USER PG_DB
  SOURCE_RELEASE SOURCE_COMMIT SOURCE_MIGRATION
  AGE_KEY_PATH
  S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY
  MANIFEST_DIR
)

MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "[alpha-backup-cron] 错误: 配置文件缺少必需变量: ${MISSING[*]}" >&2
  exit 1
fi

# 可选配置默认值
PG_PORT="${PG_PORT:-5432}"
DAILY_RETENTION="${DAILY_RETENTION:-14}"
WEEKLY_RETENTION="${WEEKLY_RETENTION:-4}"
FRESHNESS_MAX_AGE_HOURS="${FRESHNESS_MAX_AGE_HOURS:-24}"

# 确保日志目录存在
mkdir -p "$LOG_DIR" "$MANIFEST_DIR"

# ─── 步骤 1: 执行备份 ───────────────────────────────────────────────────

log "=== Alpha 备份 cron 开始 ==="
log "步骤 1/3: 执行加密备份"

BACKUP_OUTPUT_FILE=$(mktemp)
trap 'rm -f "$BACKUP_OUTPUT_FILE"' EXIT

if ! bash "$SCRIPT_DIR/backup.sh" \
  --pg-host "$PG_HOST" \
  --pg-port "$PG_PORT" \
  --pg-user "$PG_USER" \
  --pg-db "$PG_DB" \
  --release "$SOURCE_RELEASE" \
  --commit "$SOURCE_COMMIT" \
  --migration "$SOURCE_MIGRATION" \
  --age-key "$AGE_KEY_PATH" \
  --s3-endpoint "$S3_ENDPOINT" \
  --s3-bucket "$S3_BUCKET" \
  --s3-access-key "$S3_ACCESS_KEY" \
  --s3-secret-key "$S3_SECRET_KEY" \
  --manifest-dir "$MANIFEST_DIR" \
  2>&1 | tee -a "$LOG_FILE" > "$BACKUP_OUTPUT_FILE"; then
  log "错误: 备份失败"
  exit 1
fi

# 提取 manifest 路径（backup.sh 最后一行输出）
MANIFEST_PATH=$(tail -1 "$BACKUP_OUTPUT_FILE")
if [[ -n "$MANIFEST_PATH" && -f "$MANIFEST_PATH" ]]; then
  BACKUP_ID=$(python3 -c "import json; print(json.load(open('$MANIFEST_PATH')).get('backupId','unknown'))" 2>/dev/null || echo "unknown")
  log "备份成功: $BACKUP_ID"
else
  log "警告: 无法确定备份 manifest 路径，继续执行后续步骤"
fi

# ─── 步骤 2: 保留轮换 ───────────────────────────────────────────────────

log "步骤 2/3: 执行保留轮换"

if ! bash "$SCRIPT_DIR/rotate.sh" \
  --manifest-dir "$MANIFEST_DIR" \
  --s3-endpoint "$S3_ENDPOINT" \
  --s3-bucket "$S3_BUCKET" \
  --s3-access-key "$S3_ACCESS_KEY" \
  --s3-secret-key "$S3_SECRET_KEY" \
  --daily-retention "$DAILY_RETENTION" \
  --weekly-retention "$WEEKLY_RETENTION" \
  2>&1 | tee -a "$LOG_FILE"; then
  log "警告: 保留轮换失败（备份已成功）"
  exit 2
fi

log "保留轮换完成"

# ─── 步骤 3: 新鲜度检查 ─────────────────────────────────────────────────

log "步骤 3/3: 检查备份新鲜度"

if ! bash "$SCRIPT_DIR/freshness-check.sh" \
  --manifest-dir "$MANIFEST_DIR" \
  --max-age-hours "$FRESHNESS_MAX_AGE_HOURS" \
  2>&1 | tee -a "$LOG_FILE"; then
  log "告警: 备份新鲜度检查失败（可能需要手动干预）"
  exit 3
fi

log "=== Alpha 备份 cron 完成 ==="
