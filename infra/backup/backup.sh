#!/usr/bin/env bash
#
# ADR-0007 §1-4: 加密备份脚本
#
# 功能：
#   1. 从 PostgreSQL 执行一致性 custom-format pg_dump
#   2. 生成 SHA-256 校验和
#   3. 使用 age envelope encryption 加密（CI fallback: 跳过加密）
#   4. 上传到 S3-compatible bucket（CI fallback: 本地目录）
#   5. 生成 manifest JSON 记录所有元数据
#
# 用法：
#   ./backup.sh --pg-host localhost --pg-port 5432 --pg-user study \
#     --pg-db study --release 0.5.0-alpha.1 --commit abc1234 \
#     --migration 0021 --age-key ./backup.pub \
#     --s3-endpoint http://minio:9000 --s3-bucket ailearn-backups \
#     --s3-access-key XXX --s3-secret-key YYY
#
# CI 模式（跳过加密和 S3 上传）：
#   ./backup.sh --pg-host localhost --pg-user study --pg-db study \
#     --release 0.5.0-ci --commit abc1234 --migration 0021 \
#     --ci-mode --output-dir /tmp/backups
#
# 退出码：
#   0 — 备份成功
#   1 — 参数错误或备份失败

set -euo pipefail

# ─── 参数解析 ───────────────────────────────────────────────────────────

PG_HOST=""
PG_PORT="5432"
PG_USER=""
PG_DB=""
SOURCE_RELEASE="unknown"
SOURCE_COMMIT="unknown"
SOURCE_MIGRATION="unknown"
AGE_KEY=""
S3_ENDPOINT=""
S3_BUCKET=""
S3_ACCESS_KEY=""
S3_SECRET_KEY=""
CI_MODE=false
OUTPUT_DIR=""
MANIFEST_DIR=""

usage() {
  cat <<EOF
用法: backup.sh [选项]

必需选项:
  --pg-host HOST        PostgreSQL 主机名
  --pg-user USER        PostgreSQL 用户名
  --pg-db DB            PostgreSQL 数据库名
  --release VERSION     源系统版本号
  --commit SHA          源系统 Git commit SHA
  --migration NUM       源数据库最新迁移编号

加密选项（Alpha 部署必需，CI 可省略）:
  --age-key PATH        age 公钥文件路径

S3 上传选项（Alpha 部署必需，CI 可省略）:
  --s3-endpoint URL     S3-compatible 端点
  --s3-bucket NAME      S3 bucket 名称
  --s3-access-key KEY   S3 access key
  --s3-secret-key KEY   S3 secret key

CI 模式:
  --ci-mode             启用 CI 模式（跳过加密和 S3 上传）
  --output-dir PATH     CI 模式下本地输出目录
  --manifest-dir PATH   manifest 存储目录（默认与 output-dir 相同）

可选:
  --pg-port PORT        PostgreSQL 端口（默认 5432）
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pg-host) PG_HOST="$2"; shift 2 ;;
    --pg-port) PG_PORT="$2"; shift 2 ;;
    --pg-user) PG_USER="$2"; shift 2 ;;
    --pg-db) PG_DB="$2"; shift 2 ;;
    --release) SOURCE_RELEASE="$2"; shift 2 ;;
    --commit) SOURCE_COMMIT="$2"; shift 2 ;;
    --migration) SOURCE_MIGRATION="$2"; shift 2 ;;
    --age-key) AGE_KEY="$2"; shift 2 ;;
    --s3-endpoint) S3_ENDPOINT="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-access-key) S3_ACCESS_KEY="$2"; shift 2 ;;
    --s3-secret-key) S3_SECRET_KEY="$2"; shift 2 ;;
    --ci-mode) CI_MODE=true; shift ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --manifest-dir) MANIFEST_DIR="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

# ─── 参数校验 ───────────────────────────────────────────────────────────

if [[ -z "$PG_HOST" || -z "$PG_USER" || -z "$PG_DB" ]]; then
  echo "[backup] 错误: --pg-host, --pg-user, --pg-db 为必需参数" >&2
  exit 1
fi

if [[ "$CI_MODE" == "false" ]]; then
  if [[ -z "$AGE_KEY" ]]; then
    echo "[backup] 错误: 非 CI 模式下 --age-key 为必需参数" >&2
    exit 1
  fi
  if [[ -z "$S3_ENDPOINT" || -z "$S3_BUCKET" || -z "$S3_ACCESS_KEY" || -z "$S3_SECRET_KEY" ]]; then
    echo "[backup] 错误: 非 CI 模式下 S3 参数全部必需" >&2
    exit 1
  fi
else
  if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="${RUNNER_TEMP:-/tmp}/ailearn-backups"
  fi
  if [[ -z "$MANIFEST_DIR" ]]; then
    MANIFEST_DIR="$OUTPUT_DIR"
  fi
fi

if [[ -z "$MANIFEST_DIR" ]]; then
  MANIFEST_DIR="${OUTPUT_DIR:-/tmp/ailearn-manifests}"
fi

# ─── 工具函数 ───────────────────────────────────────────────────────────

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }

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

upload_object() {
  local source_file="$1" object_key="$2"
  if command -v aws &>/dev/null; then
    AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    aws s3 cp "$source_file" "s3://$S3_BUCKET/$object_key" \
      --endpoint-url "$S3_ENDPOINT"
  elif command -v mc &>/dev/null; then
    mc alias set ailearn-backup "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
    mc cp "$source_file" "ailearn-backup/$S3_BUCKET/$object_key"
  else
    log "错误: 需要 aws CLI 或 mc (MinIO Client) 才能上传备份" >&2
    return 1
  fi
}

# 生成唯一 backup ID
gen_backup_id() {
  local ts uuid
  ts=$(date -u +%Y%m%dT%H%M%S)
  uuid=$(printf '%08x' $((RANDOM * RANDOM % 4294967295)))
  echo "${ts}-${uuid}"
}

# 生成 ISO 8601 UTC 时间戳
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ─── 主流程 ─────────────────────────────────────────────────────────────

BACKUP_ID=$(gen_backup_id)
STARTED_AT=$(iso_now)
DUMP_FILE=""

log "开始备份 $BACKUP_ID"
log "  源: $PG_HOST:$PG_PORT/$PG_DB"
log "  版本: $SOURCE_RELEASE ($SOURCE_COMMIT)"
log "  迁移: $SOURCE_MIGRATION"

# 1. 执行 pg_dump（custom format）
DUMP_FILE="${OUTPUT_DIR:-${RUNNER_TEMP:-/tmp}}/${BACKUP_ID}.dump"
log "执行 pg_dump → $DUMP_FILE"

mkdir -p "$(dirname "$DUMP_FILE")"

PGPASSWORD="${PGPASSWORD:-}" pg_dump \
  -h "$PG_HOST" \
  -p "$PG_PORT" \
  -U "$PG_USER" \
  -d "$PG_DB" \
  --no-owner \
  --no-privileges \
  --format=custom \
  --file="$DUMP_FILE"

if [[ ! -s "$DUMP_FILE" ]]; then
  log "错误: pg_dump 生成空文件" >&2
  exit 1
fi

DUMP_SIZE=$(stat -f%z "$DUMP_FILE" 2>/dev/null || stat -c%s "$DUMP_FILE" 2>/dev/null)
DUMP_SHA256=$(sha256_file "$DUMP_FILE")

log "  dump 大小: $DUMP_SIZE bytes"
log "  dump SHA-256: $DUMP_SHA256"

# 2. 加密（CI 模式跳过）
ENCRYPTED_FILE=""
ENCRYPTED_SIZE=0
ENCRYPTED_SHA256=""

if [[ "$CI_MODE" == "true" ]]; then
  log "CI 模式: 跳过加密"
  ENCRYPTED_FILE="$DUMP_FILE"
  ENCRYPTED_SIZE="$DUMP_SIZE"
  ENCRYPTED_SHA256="$DUMP_SHA256"
else
  ENCRYPTED_FILE="${DUMP_FILE}.age"
  log "加密 → $ENCRYPTED_FILE"

  if ! command -v age &>/dev/null; then
    log "错误: age 命令未安装" >&2
    exit 1
  fi

  age --encrypt --recipient "$(cat "$AGE_KEY")" \
    --output "$ENCRYPTED_FILE" "$DUMP_FILE"

  ENCRYPTED_SIZE=$(stat -f%z "$ENCRYPTED_FILE" 2>/dev/null || stat -c%s "$ENCRYPTED_FILE" 2>/dev/null)
  ENCRYPTED_SHA256=$(sha256_file "$ENCRYPTED_FILE")

  log "  加密后大小: $ENCRYPTED_SIZE bytes"
  log "  加密后 SHA-256: $ENCRYPTED_SHA256"

  # 删除未加密的 dump 文件
  rm -f "$DUMP_FILE"
fi

# 3. 上传（CI 模式跳过）
OBJECT_KEY="${BACKUP_ID}.dump.age"

if [[ "$CI_MODE" == "true" ]]; then
  log "CI 模式: 跳过 S3 上传，文件保留在本地"
  log "  对象 key: $OBJECT_KEY"
else
  log "上传到 S3: $S3_ENDPOINT/$S3_BUCKET/$OBJECT_KEY"

  upload_object "$ENCRYPTED_FILE" "$OBJECT_KEY"
fi

COMPLETED_AT=$(iso_now)

# 4. 生成 manifest
MANIFEST_FILE="${MANIFEST_DIR}/${BACKUP_ID}.manifest.json"
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_FILE" <<EOF
{
  "backupId": "$BACKUP_ID",
  "sourceRelease": "$SOURCE_RELEASE",
  "sourceCommit": "$SOURCE_COMMIT",
  "sourceMigration": "$SOURCE_MIGRATION",
  "startedAt": "$STARTED_AT",
  "completedAt": "$COMPLETED_AT",
  "sizeBytes": $DUMP_SIZE,
  "encryptedSizeBytes": $ENCRYPTED_SIZE,
  "sha256": "$DUMP_SHA256",
  "encryptedSha256": "$ENCRYPTED_SHA256",
  "objectKey": "$OBJECT_KEY",
  "verificationStatus": "pending",
  "verifiedAt": null,
  "format": "custom",
  "retentionClass": "daily"
}
EOF

log "manifest 已生成: $MANIFEST_FILE"
log "备份完成: $BACKUP_ID"

# 输出 manifest 路径供后续步骤使用
echo "$MANIFEST_FILE"
