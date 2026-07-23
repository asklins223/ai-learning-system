#!/usr/bin/env bash
#
# ADR-0007 §5-6: 恢复脚本
#
# 功能：
#   1. 从 S3（或本地）下载加密备份
#   2. 使用 age 私钥解密
#   3. 恢复到目标 PostgreSQL（必须是 allowlist 中的隔离环境）
#   4. 验证恢复结果（迁移末端、核心表计数）
#
# 安全要求（ADR-0007 §6）：
#   - 默认拒绝生产主机/数据库名
#   - 目标必须是显式 allowlist 的隔离环境
#   - 恢复前必须确认目标数据库为空或可覆盖
#
# 用法：
#   ./restore.sh --backup-id 20260719T120000-a1b2c3d4 \
#     --target-host restore-db.local --target-port 5432 \
#     --target-user study_restore --target-db study_restore \
#     --age-key ./backup.key \
#     --s3-endpoint http://minio:9000 --s3-bucket ailearn-backups \
#     --s3-access-key XXX --s3-secret-key YYY \
#     --manifest-dir /data/backups/manifests
#
# CI 模式（从本地文件恢复）：
#   ./restore.sh --backup-id 20260719T120000-a1b2c3d4 \
#     --target-host localhost --target-user study --target-db study_restore \
#     --ci-mode --backup-dir /tmp/backups --manifest-dir /tmp/backups

set -euo pipefail

# ─── 安全 allowlist ─────────────────────────────────────────────────────

# 允许恢复的目标主机名模式（必须是隔离环境）
# 生产主机名不在此列表中
ALLOWED_HOST_PATTERNS=(
  "^localhost$"
  "^127\.0\.0\.1$"
  "^restore-.*$"
  "^.*-restore$"
  "^ci-.*$"
  "^.*-ci$"
  "^staging-.*$"
)

# 禁止恢复的数据库名（生产数据库名）
FORBIDDEN_DB_NAMES=(
  "study"
  "ailearn"
  "production"
  "prod"
)

# ─── 参数解析 ───────────────────────────────────────────────────────────

BACKUP_ID=""
TARGET_HOST=""
TARGET_PORT="5432"
TARGET_USER=""
TARGET_DB=""
AGE_KEY=""
S3_ENDPOINT=""
S3_BUCKET=""
S3_ACCESS_KEY=""
S3_SECRET_KEY=""
MANIFEST_DIR=""
CI_MODE=false
BACKUP_DIR=""
FORCE=false

usage() {
  cat <<EOF
用法: restore.sh [选项]

必需选项:
  --backup-id ID        要恢复的备份 ID
  --target-host HOST    目标 PostgreSQL 主机（必须是 allowlist 中的隔离环境）
  --target-user USER    目标 PostgreSQL 用户名
  --target-db DB        目标 PostgreSQL 数据库名（不能是生产库名）
  --manifest-dir PATH   manifest 存储目录

加密选项（CI 模式可省略）:
  --age-key PATH        age 私钥文件路径

S3 选项（CI 模式可省略）:
  --s3-endpoint URL     S3-compatible 端点
  --s3-bucket NAME      S3 bucket 名称
  --s3-access-key KEY   S3 access key
  --s3-secret-key KEY   S3 secret key

CI 模式:
  --ci-mode             CI 模式（从本地文件恢复）
  --backup-dir PATH     CI 模式下本地备份文件目录

可选:
  --target-port PORT    目标 PostgreSQL 端口（默认 5432）
  --force               跳过安全确认提示（CI 中使用）
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-id) BACKUP_ID="$2"; shift 2 ;;
    --target-host) TARGET_HOST="$2"; shift 2 ;;
    --target-port) TARGET_PORT="$2"; shift 2 ;;
    --target-user) TARGET_USER="$2"; shift 2 ;;
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --age-key) AGE_KEY="$2"; shift 2 ;;
    --s3-endpoint) S3_ENDPOINT="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-access-key) S3_ACCESS_KEY="$2"; shift 2 ;;
    --s3-secret-key) S3_SECRET_KEY="$2"; shift 2 ;;
    --manifest-dir) MANIFEST_DIR="$2"; shift 2 ;;
    --ci-mode) CI_MODE=true; shift ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

# ─── 参数校验 ───────────────────────────────────────────────────────────

if [[ -z "$BACKUP_ID" || -z "$TARGET_HOST" || -z "$TARGET_USER" || -z "$TARGET_DB" || -z "$MANIFEST_DIR" ]]; then
  echo "[restore] 错误: 必需参数缺失" >&2
  usage
fi

# ─── 安全检查（ADR-0007 §6）─────────────────────────────────────────────

log() { echo "[restore] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }

sha256_file() {
  if command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    log "错误: 需要 sha256sum 或 shasum" >&2
    return 1
  fi
}

download_object() {
  local object_key="$1" destination="$2"
  if command -v aws &>/dev/null; then
    AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    aws s3 cp "s3://$S3_BUCKET/$object_key" "$destination" \
      --endpoint-url "$S3_ENDPOINT"
  elif command -v mc &>/dev/null; then
    mc alias set ailearn-backup "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
    mc cp "ailearn-backup/$S3_BUCKET/$object_key" "$destination"
  else
    log "错误: 需要 aws CLI 或 mc (MinIO Client) 才能下载备份" >&2
    return 1
  fi
}

# 检查目标主机是否在 allowlist 中
check_host_allowed() {
  local host="$1"
  for pattern in "${ALLOWED_HOST_PATTERNS[@]}"; do
    if [[ "$host" =~ $pattern ]]; then
      return 0
    fi
  done
  return 1
}

# 检查目标数据库名是否为禁止的生产库名
check_db_not_forbidden() {
  local db="$1"
  for forbidden in "${FORBIDDEN_DB_NAMES[@]}"; do
    if [[ "$db" == "$forbidden" ]]; then
      return 1
    fi
  done
  return 0
}

log "安全检查..."

if ! check_host_allowed "$TARGET_HOST"; then
  log "错误: 目标主机 '$TARGET_HOST' 不在 allowlist 中" >&2
  log "  允许的主机模式: ${ALLOWED_HOST_PATTERNS[*]}" >&2
  log "  如需恢复到生产环境，需事件指挥明确授权并手动执行" >&2
  exit 1
fi

if ! check_db_not_forbidden "$TARGET_DB"; then
  log "错误: 目标数据库名 '$TARGET_DB' 是禁止的生产库名" >&2
  log "  禁止的库名: ${FORBIDDEN_DB_NAMES[*]}" >&2
  log "  请使用隔离环境的数据库名（如 study_restore）" >&2
  exit 1
fi

if [[ "$CI_MODE" == "false" ]]; then
  if [[ -z "$AGE_KEY" || -z "$S3_ENDPOINT" || -z "$S3_BUCKET" || -z "$S3_ACCESS_KEY" || -z "$S3_SECRET_KEY" ]]; then
    log "错误: 非 CI 模式需要 age 私钥和全部 S3 参数" >&2
    exit 1
  fi
fi

log "安全检查通过: $TARGET_HOST/$TARGET_DB"

if [[ "$FORCE" != "true" ]]; then
  echo ""
  echo "========================================="
  echo "  恢复操作确认"
  echo "========================================="
  echo "  备份 ID: $BACKUP_ID"
  echo "  目标: $TARGET_HOST:$TARGET_PORT/$TARGET_DB"
  echo "  用户: $TARGET_USER"
  echo "  模式: $([[ "$CI_MODE" == "true" ]] && echo "CI" || echo "生产")"
  echo "========================================="
  echo ""
  read -rp "确认执行恢复？(yes/no): " confirm
  if [[ "$confirm" != "yes" ]]; then
    log "恢复已取消"
    exit 0
  fi
fi

# ─── 加载 manifest ──────────────────────────────────────────────────────

MANIFEST_FILE="${MANIFEST_DIR}/${BACKUP_ID}.manifest.json"

if [[ ! -f "$MANIFEST_FILE" ]]; then
  log "错误: manifest 文件不存在: $MANIFEST_FILE" >&2
  exit 1
fi

# 从 manifest 中提取信息
extract_field() {
  local field="$1"
  python3 -c "
import json
with open('$MANIFEST_FILE') as f:
    data = json.load(f)
print(data.get('$field', ''))
" 2>/dev/null || echo ""
}

OBJECT_KEY=$(extract_field "objectKey")
SOURCE_MIGRATION=$(extract_field "sourceMigration")
DUMP_SHA256=$(extract_field "sha256")
FORMAT=$(extract_field "format")

log "manifest 加载完成"
log "  对象 key: $OBJECT_KEY"
log "  源迁移: $SOURCE_MIGRATION"
log "  格式: $FORMAT"

# ─── 下载备份 ───────────────────────────────────────────────────────────

WORK_DIR="${RUNNER_TEMP:-/tmp}/restore-${BACKUP_ID}"
mkdir -p "$WORK_DIR"

ENCRYPTED_FILE="${WORK_DIR}/${OBJECT_KEY}"
DUMP_FILE="${WORK_DIR}/${BACKUP_ID}.dump"

if [[ "$CI_MODE" == "true" ]]; then
  # CI 模式: 从本地目录读取
  if [[ -z "$BACKUP_DIR" ]]; then
    BACKUP_DIR="$MANIFEST_DIR"
  fi
  LOCAL_FILE="${BACKUP_DIR}/${OBJECT_KEY}"
  if [[ ! -f "$LOCAL_FILE" ]]; then
    # 尝试 .dump 扩展名（CI 模式可能未加密）
    LOCAL_FILE="${BACKUP_DIR}/${BACKUP_ID}.dump"
  fi
  if [[ ! -f "$LOCAL_FILE" ]]; then
    log "错误: 本地备份文件不存在: $LOCAL_FILE" >&2
    exit 1
  fi
  ENCRYPTED_FILE="$LOCAL_FILE"
  log "CI 模式: 使用本地文件 $ENCRYPTED_FILE"
else
  # 生产模式: 从 S3 下载
  log "从 S3 下载: $S3_ENDPOINT/$S3_BUCKET/$OBJECT_KEY"

  download_object "$OBJECT_KEY" "$ENCRYPTED_FILE"
fi

# ─── 解密 ───────────────────────────────────────────────────────────────

if [[ "$CI_MODE" == "true" ]]; then
  # CI 模式: 文件可能未加密，直接使用
  DUMP_FILE="$ENCRYPTED_FILE"
  log "CI 模式: 跳过解密"
else
  if [[ -z "$AGE_KEY" ]]; then
    log "错误: 非 CI 模式下 --age-key 为必需参数" >&2
    exit 1
  fi

  if ! command -v age &>/dev/null; then
    log "错误: age 命令未安装" >&2
    exit 1
  fi

  log "解密 → $DUMP_FILE"
  age --decrypt --identity "$AGE_KEY" \
    --output "$DUMP_FILE" "$ENCRYPTED_FILE"
fi

# ─── 校验 ───────────────────────────────────────────────────────────────

ACTUAL_SHA256=$(sha256_file "$DUMP_FILE")
if [[ "$ACTUAL_SHA256" != "$DUMP_SHA256" ]]; then
  log "错误: SHA-256 校验失败" >&2
  log "  期望: $DUMP_SHA256" >&2
  log "  实际: $ACTUAL_SHA256" >&2
  exit 1
fi
log "SHA-256 校验通过"

# ─── 恢复到目标数据库 ───────────────────────────────────────────────────

log "恢复到 $TARGET_HOST:$TARGET_PORT/$TARGET_DB"

if [[ "$FORMAT" == "custom" ]]; then
  # custom format: 使用 pg_restore
  PGPASSWORD="${PGPASSWORD:-}" pg_restore \
    -h "$TARGET_HOST" \
    -p "$TARGET_PORT" \
    -U "$TARGET_USER" \
    -d "$TARGET_DB" \
    --no-owner \
    --no-privileges \
    --clean --if-exists \
    "$DUMP_FILE"
else
  # plain format: 使用 psql
  PGPASSWORD="${PGPASSWORD:-}" psql \
    -h "$TARGET_HOST" \
    -p "$TARGET_PORT" \
    -U "$TARGET_USER" \
    -d "$TARGET_DB" \
    --set=ON_ERROR_STOP=1 \
    < "$DUMP_FILE"
fi

log "恢复完成"

# ─── 恢复后验证 ─────────────────────────────────────────────────────────

log "执行恢复后验证..."

# 验证迁移末端
RESTORED_MIGRATION=$(PGPASSWORD="${PGPASSWORD:-}" psql \
  -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" \
  -v ON_ERROR_STOP=1 -t -A -c "SELECT max(created_at)::text FROM drizzle.__drizzle_migrations" 2>/dev/null) || {
  log "错误: 无法读取恢复后的迁移末端" >&2
  exit 1
}

if [[ ! "$RESTORED_MIGRATION" =~ ^[0-9]+$ ]]; then
  log "错误: 恢复后的迁移末端无效: ${RESTORED_MIGRATION:-empty}" >&2
  exit 1
fi

log "  恢复后迁移末端: $RESTORED_MIGRATION"

# 验证核心表计数
CORE_TABLES=("users" "workspaces" "notes" "note_versions" "learning_cards" "sources" "review_schedules")
for table in "${CORE_TABLES[@]}"; do
  COUNT=$(PGPASSWORD="${PGPASSWORD:-}" psql \
    -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" \
    -v ON_ERROR_STOP=1 -t -A -c "SELECT count(*) FROM $table" 2>/dev/null) || {
    log "错误: 无法验证核心表 $table" >&2
    exit 1
  }
  log "  表 $table: $COUNT 行"
done

# restore.sh only proves that decryption/checksum/restore/basic schema access
# succeeded.  rc-restore-verify.sh owns the final `verified` transition after
# migration, row-count, FK, RLS and role checks all pass.

log "恢复验证完成"
log "RTO 计时结束: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 清理临时文件
if [[ "$CI_MODE" != "true" ]]; then
  rm -rf "$WORK_DIR"
  log "临时文件已清理"
fi
