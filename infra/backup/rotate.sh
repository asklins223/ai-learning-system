#!/usr/bin/env bash
#
# ADR-0007 §3: 保留轮换脚本
#
# 功能：
#   1. 扫描 manifest 目录中的所有备份记录
#   2. 保留最近 14 个 daily 备份和 4 个 weekly 备份
#   3. 删除超出保留期的备份对象（从 S3 和本地 manifest）
#   4. 只删除已验证（verificationStatus=verified）的超出备份
#      未验证的备份不会被轮换删除（安全起见保留）
#
# 用法：
#   ./rotate.sh --manifest-dir /data/backups/manifests \
#     --s3-endpoint http://minio:9000 --s3-bucket ailearn-backups \
#     --s3-access-key XXX --s3-secret-key YYY
#
# CI 模式（跳过 S3 删除）：
#   ./rotate.sh --manifest-dir /tmp/backups --ci-mode
#
# 退出码：
#   0 — 轮换成功
#   1 — 参数错误或轮换失败

set -euo pipefail

# ─── 参数解析 ───────────────────────────────────────────────────────────

MANIFEST_DIR=""
S3_ENDPOINT=""
S3_BUCKET=""
S3_ACCESS_KEY=""
S3_SECRET_KEY=""
CI_MODE=false
DAILY_RETENTION=14
WEEKLY_RETENTION=4
DRY_RUN=false

usage() {
  cat <<EOF
用法: rotate.sh [选项]

必需选项:
  --manifest-dir PATH   manifest 存储目录

S3 选项（Alpha 部署必需，CI 可省略）:
  --s3-endpoint URL     S3-compatible 端点
  --s3-bucket NAME      S3 bucket 名称
  --s3-access-key KEY   S3 access key
  --s3-secret-key KEY   S3 secret key

可选:
  --ci-mode             CI 模式（跳过 S3 删除）
  --daily-retention N   daily 保留数量（默认 14）
  --weekly-retention N  weekly 保留数量（默认 4）
  --dry-run             只打印将要删除的对象，不实际删除
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-dir) MANIFEST_DIR="$2"; shift 2 ;;
    --s3-endpoint) S3_ENDPOINT="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-access-key) S3_ACCESS_KEY="$2"; shift 2 ;;
    --s3-secret-key) S3_SECRET_KEY="$2"; shift 2 ;;
    --ci-mode) CI_MODE=true; shift ;;
    --daily-retention) DAILY_RETENTION="$2"; shift 2 ;;
    --weekly-retention) WEEKLY_RETENTION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

if [[ -z "$MANIFEST_DIR" ]]; then
  echo "[rotate] 错误: --manifest-dir 为必需参数" >&2
  exit 1
fi

if [[ ! -d "$MANIFEST_DIR" ]]; then
  echo "[rotate] 错误: manifest 目录不存在: $MANIFEST_DIR" >&2
  exit 1
fi

if [[ "$CI_MODE" == "false" ]]; then
  if [[ -z "$S3_ENDPOINT" || -z "$S3_BUCKET" || -z "$S3_ACCESS_KEY" || -z "$S3_SECRET_KEY" ]]; then
    echo "[rotate] 错误: 非 CI 模式下 S3 参数全部必需" >&2
    exit 1
  fi
fi

# ─── 工具函数 ───────────────────────────────────────────────────────────

log() { echo "[rotate] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }

delete_object() {
  local object_key="$1"
  if command -v aws &>/dev/null; then
    AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    aws s3 rm "s3://$S3_BUCKET/$object_key" --endpoint-url "$S3_ENDPOINT"
  elif command -v mc &>/dev/null; then
    mc alias set ailearn-backup "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
    mc rm "ailearn-backup/$S3_BUCKET/$object_key"
  else
    log "错误: 需要 aws CLI 或 mc (MinIO Client) 才能删除远端备份" >&2
    return 1
  fi
}

# 从 manifest JSON 中提取字段值
# 用法: extract_field <file> <field>
extract_field() {
  local file="$1" field="$2"
  # 使用 python3 解析 JSON（比 grep 更可靠）
  python3 -c "
import json, sys
with open('$file') as f:
    data = json.load(f)
print(data.get('$field', ''))
" 2>/dev/null || echo ""
}

# ─── 主流程 ─────────────────────────────────────────────────────────────

log "开始轮换"
log "  manifest 目录: $MANIFEST_DIR"
log "  daily 保留: $DAILY_RETENTION"
log "  weekly 保留: $WEEKLY_RETENTION"
log "  dry-run: $DRY_RUN"

# 收集所有 manifest 文件，按 backupId（时间戳）排序
MANIFESTS=()
while IFS= read -r f; do
  MANIFESTS+=("$f")
done < <(find "$MANIFEST_DIR" -name '*.manifest.json' | sort)

TOTAL=${#MANIFESTS[@]}
log "找到 $TOTAL 个 manifest"

if [[ "$TOTAL" -eq 0 ]]; then
  log "没有需要轮换的备份"
  exit 0
fi

# 分类 daily 和 weekly 备份
DAILY_BACKUPS=()
WEEKLY_BACKUPS=()

for manifest in "${MANIFESTS[@]}"; do
  retention_class=$(extract_field "$manifest" "retentionClass")
  if [[ "$retention_class" == "weekly" ]]; then
    WEEKLY_BACKUPS+=("$manifest")
  else
    DAILY_BACKUPS+=("$manifest")
  fi
done

log "  daily 备份: ${#DAILY_BACKUPS[@]}"
log "  weekly 备份: ${#WEEKLY_BACKUPS[@]}"

# 计算需要删除的备份
DELETE_LIST=()

# Daily: 超过 DAILY_RETENTION 的最旧备份
DAILY_COUNT=${#DAILY_BACKUPS[@]}
if [[ "$DAILY_COUNT" -gt "$DAILY_RETENTION" ]]; then
  DELETE_COUNT=$((DAILY_COUNT - DAILY_RETENTION))
  log "daily 需要删除 $DELETE_COUNT 个超期备份"
  for ((i = 0; i < DELETE_COUNT; i++)); do
    DELETE_LIST+=("${DAILY_BACKUPS[$i]}")
  done
fi

# Weekly: 超过 WEEKLY_RETENTION 的最旧备份
WEEKLY_COUNT=${#WEEKLY_BACKUPS[@]}
if [[ "$WEEKLY_COUNT" -gt "$WEEKLY_RETENTION" ]]; then
  DELETE_COUNT=$((WEEKLY_COUNT - WEEKLY_RETENTION))
  log "weekly 需要删除 $DELETE_COUNT 个超期备份"
  for ((i = 0; i < DELETE_COUNT; i++)); do
    DELETE_LIST+=("${WEEKLY_BACKUPS[$i]}")
  done
fi

if [[ ${#DELETE_LIST[@]} -eq 0 ]]; then
  log "没有需要删除的备份"
  exit 0
fi

log "总计需要删除 ${#DELETE_LIST[@]} 个备份"

# 执行删除
DELETED_COUNT=0
SKIPPED_COUNT=0

for manifest in "${DELETE_LIST[@]}"; do
  backup_id=$(extract_field "$manifest" "backupId")
  object_key=$(extract_field "$manifest" "objectKey")
  verification_status=$(extract_field "$manifest" "verificationStatus")

  # 安全检查：只删除已验证的备份
  # 未验证（pending/failed）的备份不删除，防止删除唯一可用备份
  if [[ "$verification_status" != "verified" ]]; then
    log "跳过 ${backup_id}: 验证状态为 ${verification_status}（仅删除已验证备份）"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  log "删除 $backup_id (object: $object_key)"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "  [dry-run] 跳过实际删除"
    continue
  fi

  # 删除 S3 对象
  if [[ "$CI_MODE" == "false" ]]; then
    delete_object "$object_key"
  fi

  # 删除本地加密文件（如果存在）
  encrypted_file="${manifest%.manifest.json}.dump.age"
  rm -f "$encrypted_file"

  # 删除 manifest 文件
  rm -f "$manifest"

  DELETED_COUNT=$((DELETED_COUNT + 1))
done

log "轮换完成: 删除 $DELETED_COUNT 个，跳过 $SKIPPED_COUNT 个未验证备份"
