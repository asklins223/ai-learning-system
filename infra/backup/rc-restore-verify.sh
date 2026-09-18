#!/usr/bin/env bash
#
# ADR-0007 §5: RC 备份恢复验证脚本
#
# 功能：
#   1. 从源数据库创建一致性备份
#   2. 恢复到隔离的恢复数据库（必须通过安全 allowlist 检查）
#   3. 验证恢复结果：
#      a. 迁移版本末端匹配
#      b. 核心表行数对比
#      c. 对象关联完整性（FK 约束）
#      d. 角色/权限重放验证
#      e. API readiness 检查（可选）
#   4. 生成机器可读恢复报告（JSON）
#   5. 清理恢复数据库中的临时数据
#
# 用法：
#   ./rc-restore-verify.sh \
#     --source-host localhost --source-port 5432 \
#     --source-user ailearn_migrator --source-db ailearn \
#     --target-host restore-db.local --target-port 5432 \
#     --target-user ailearn_restore --target-db ailearn_restore \
#     --age-key /etc/ailearn/backup-age.key \
#     --s3-endpoint http://minio:9000 --s3-bucket ailearn-backups \
#     --s3-access-key XXX --s3-secret-key YYY \
#     --release 0.5.0-rc.1 --commit abc1234 --migration 0028 \
#     --report-dir /data/backups/rc-reports
#
# CI 模式（不使用加密和 S3）：
#   ./rc-restore-verify.sh \
#     --source-host localhost --source-user study --source-db study \
#     --target-host localhost --target-user study --target-db study_restore \
#     --ci-mode --release 0.5.0-ci --commit abc1234 --migration 0028 \
#     --report-dir /tmp/rc-reports
#
# 退出码：
#   0 — 恢复验证全部通过
#   1 — 参数错误或恢复失败
#   2 — 验证失败（恢复成功但数据/权限校验不通过）

set -euo pipefail

# ─── 参数解析 ───────────────────────────────────────────────────────────

SOURCE_HOST=""
SOURCE_PORT="5432"
SOURCE_USER=""
SOURCE_DB=""
TARGET_HOST=""
TARGET_PORT="5432"
TARGET_USER=""
TARGET_DB=""
AGE_KEY=""
S3_ENDPOINT=""
S3_BUCKET=""
S3_ACCESS_KEY=""
S3_SECRET_KEY=""
SOURCE_RELEASE="unknown"
SOURCE_COMMIT="unknown"
SOURCE_MIGRATION="unknown"
REPORT_DIR="/tmp/rc-restore-reports"
MANIFEST_DIR=""
ROLE_SCRIPT=""
CI_MODE=false
FORCE=false
API_URL=""  # 可选：恢复后检查 API readiness

usage() {
  cat <<EOF
用法: rc-restore-verify.sh [选项]

必需参数:
  --source-host HOST     源 PostgreSQL 主机
  --source-user USER     源 PostgreSQL 用户名（migrator 角色）
  --source-db DB         源 PostgreSQL 数据库名
  --target-host HOST     目标恢复主机（必须通过 allowlist 检查）
  --target-user USER     目标 PostgreSQL 用户名
  --target-db DB         目标 PostgreSQL 数据库名（不能是生产库名）
  --release VERSION      当前系统版本号
  --commit SHA           当前 Git commit SHA
  --migration NUM        当前数据库最新迁移编号

加密选项（CI 模式可省略）:
  --age-key PATH         age 私钥文件路径

S3 选项（CI 模式可省略）:
  --s3-endpoint URL      S3-compatible 端点
  --s3-bucket NAME       S3 bucket 名称
  --s3-access-key KEY    S3 access key
  --s3-secret-key KEY    S3 secret key

可选:
  --source-port PORT     源 PostgreSQL 端口（默认 5432）
  --target-port PORT     目标 PostgreSQL 端口（默认 5432）
  --report-dir PATH      恢复报告输出目录
  --manifest-dir PATH    持久化 manifest 目录（默认使用临时目录）
  --role-script PATH     恢复后重放角色/权限的 roles.sql
  --api-url URL          恢复后检查 API readiness 的 URL
  --ci-mode              CI 模式（跳过加密和 S3）
  --force                跳过安全确认提示
  -h, --help             显示帮助
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-host) SOURCE_HOST="$2"; shift 2 ;;
    --source-port) SOURCE_PORT="$2"; shift 2 ;;
    --source-user) SOURCE_USER="$2"; shift 2 ;;
    --source-db) SOURCE_DB="$2"; shift 2 ;;
    --target-host) TARGET_HOST="$2"; shift 2 ;;
    --target-port) TARGET_PORT="$2"; shift 2 ;;
    --target-user) TARGET_USER="$2"; shift 2 ;;
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --age-key) AGE_KEY="$2"; shift 2 ;;
    --s3-endpoint) S3_ENDPOINT="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-access-key) S3_ACCESS_KEY="$2"; shift 2 ;;
    --s3-secret-key) S3_SECRET_KEY="$2"; shift 2 ;;
    --release) SOURCE_RELEASE="$2"; shift 2 ;;
    --commit) SOURCE_COMMIT="$2"; shift 2 ;;
    --migration) SOURCE_MIGRATION="$2"; shift 2 ;;
    --report-dir) REPORT_DIR="$2"; shift 2 ;;
    --manifest-dir) MANIFEST_DIR="$2"; shift 2 ;;
    --role-script) ROLE_SCRIPT="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --ci-mode) CI_MODE=true; shift ;;
    --force) FORCE=true; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

# ─── 参数校验 ───────────────────────────────────────────────────────────

if [[ -z "$SOURCE_HOST" || -z "$SOURCE_USER" || -z "$SOURCE_DB" || \
      -z "$TARGET_HOST" || -z "$TARGET_USER" || -z "$TARGET_DB" ]]; then
  echo "[rc-restore] 错误: 源和目标数据库参数为必需" >&2
  usage
fi

if [[ "$CI_MODE" == "false" ]]; then
  if [[ -z "$AGE_KEY" ]]; then
    echo "[rc-restore] 错误: 非 CI 模式下 --age-key 为必需参数" >&2
    exit 1
  fi
  if [[ -z "$S3_ENDPOINT" || -z "$S3_BUCKET" || -z "$S3_ACCESS_KEY" || -z "$S3_SECRET_KEY" ]]; then
    echo "[rc-restore] 错误: 非 CI 模式下 S3 参数全部必需" >&2
    exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$REPORT_DIR"

# ─── 安全 allowlist ─────────────────────────────────────────────────────

ALLOWED_HOST_PATTERNS=(
  "^localhost$" "^127\.0\.0\.1$"
  "^restore-.*$" "^.*-restore$"
  "^ci-.*$" "^.*-ci$"
  "^staging-.*$"
)

FORBIDDEN_DB_NAMES=("study" "ailearn" "production" "prod")

check_host_allowed() {
  local host="$1"
  for pattern in "${ALLOWED_HOST_PATTERNS[@]}"; do
    if [[ "$host" =~ $pattern ]]; then return 0; fi
  done
  return 1
}

check_db_not_forbidden() {
  local db="$1"
  for forbidden in "${FORBIDDEN_DB_NAMES[@]}"; do
    if [[ "$db" == "$forbidden" ]]; then return 1; fi
  done
  return 0
}

log() { echo "[rc-restore] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }

# ─── 安全检查 ───────────────────────────────────────────────────────────

log "安全检查..."
if ! check_host_allowed "$TARGET_HOST"; then
  log "错误: 目标主机 '$TARGET_HOST' 不在 allowlist 中" >&2
  exit 1
fi
if ! check_db_not_forbidden "$TARGET_DB"; then
  log "错误: 目标数据库名 '$TARGET_DB' 是禁止的生产库名" >&2
  exit 1
fi
log "  安全检查通过"

if [[ "$FORCE" != "true" ]]; then
  echo ""
  echo "========================================="
  echo "  RC 恢复验证"
  echo "========================================="
  echo "  源: $SOURCE_HOST:$SOURCE_PORT/$SOURCE_DB"
  echo "  目标: $TARGET_HOST:$TARGET_PORT/$TARGET_DB"
  echo "  版本: $SOURCE_RELEASE ($SOURCE_COMMIT)"
  echo "  迁移: $SOURCE_MIGRATION"
  echo "========================================="
  echo ""
  read -rp "确认执行恢复验证？(yes/no): " confirm
  if [[ "$confirm" != "yes" ]]; then
    log "已取消"
    exit 0
  fi
fi

# ─── 计时开始 ───────────────────────────────────────────────────────────

RTO_START=$(date -u +%s)
RTO_START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log "RTO 计时开始: $RTO_START_ISO"

VERIFICATION_RESULTS=()
VERIFICATION_PASS=0
VERIFICATION_FAIL=0
ANOMALIES=()

record_result() {
  local name="$1" passed="$2" detail="${3:-}"
  local result_json
  result_json=$(RESULT_NAME="$name" RESULT_PASSED="$passed" RESULT_DETAIL="$detail" python3 - <<'PY'
import json
import os

print(json.dumps({
    "name": os.environ["RESULT_NAME"],
    "passed": os.environ["RESULT_PASSED"] == "true",
    "detail": os.environ["RESULT_DETAIL"],
}, ensure_ascii=False))
PY
  )
  VERIFICATION_RESULTS+=("$result_json")
  if [[ "$passed" == "true" ]]; then
    VERIFICATION_PASS=$((VERIFICATION_PASS + 1))
    log "  ✓ $name${detail:+ — $detail}"
  else
    VERIFICATION_FAIL=$((VERIFICATION_FAIL + 1))
    log "  ✗ $name${detail:+ — $detail}"
    ANOMALIES+=("$name: $detail")
  fi
}

# ─── 步骤 1: 创建备份 ───────────────────────────────────────────────────

log ""
log "步骤 1/5: 创建备份"

BACKUP_ID="rc-verify-$(date -u +%Y%m%dT%H%M%S)"
BACKUP_OUTPUT_DIR=$(mktemp -d)
if [[ -z "$MANIFEST_DIR" ]]; then
  MANIFEST_DIR="$BACKUP_OUTPUT_DIR/manifests"
fi
mkdir -p "$MANIFEST_DIR"

BACKUP_ARGS=(
  --pg-host "$SOURCE_HOST"
  --pg-port "$SOURCE_PORT"
  --pg-user "$SOURCE_USER"
  --pg-db "$SOURCE_DB"
  --release "$SOURCE_RELEASE"
  --commit "$SOURCE_COMMIT"
  --migration "$SOURCE_MIGRATION"
  --manifest-dir "$MANIFEST_DIR"
)

if [[ "$CI_MODE" == "true" ]]; then
  BACKUP_ARGS+=(--ci-mode --output-dir "$BACKUP_OUTPUT_DIR")
else
  BACKUP_ARGS+=(
    --age-key "$AGE_KEY"
    --s3-endpoint "$S3_ENDPOINT"
    --s3-bucket "$S3_BUCKET"
    --s3-access-key "$S3_ACCESS_KEY"
    --s3-secret-key "$S3_SECRET_KEY"
  )
fi

BACKUP_MANIFEST=""
if BACKUP_OUTPUT=$(bash "$SCRIPT_DIR/backup.sh" "${BACKUP_ARGS[@]}" 2>&1); then
  BACKUP_MANIFEST=$(echo "$BACKUP_OUTPUT" | tail -1)
  if [[ -f "$BACKUP_MANIFEST" ]]; then
    record_result "备份创建" "true" "$(basename "$BACKUP_MANIFEST")"
  else
    record_result "备份创建" "false" "manifest 文件未找到"
  fi
else
  record_result "备份创建" "false" "backup.sh 执行失败"
  log "$BACKUP_OUTPUT" >&2
fi

if [[ -z "$BACKUP_MANIFEST" || ! -f "$BACKUP_MANIFEST" ]]; then
  log "备份失败，无法继续恢复验证"
  exit 1
fi

# 从 manifest 中提取信息
BACKUP_ID=$(python3 -c "import json; print(json.load(open('$BACKUP_MANIFEST')).get('backupId','unknown'))" 2>/dev/null || echo "unknown")
DUMP_SHA256=$(python3 -c "import json; print(json.load(open('$BACKUP_MANIFEST')).get('sha256',''))" 2>/dev/null || echo "")
DUMP_SIZE=$(python3 -c "import json; print(json.load(open('$BACKUP_MANIFEST')).get('sizeBytes',0))" 2>/dev/null || echo "0")
OBJECT_KEY=$(python3 -c "import json; print(json.load(open('$BACKUP_MANIFEST')).get('objectKey',''))" 2>/dev/null || echo "")

log "  备份 ID: $BACKUP_ID"
log "  大小: $DUMP_SIZE bytes"
log "  SHA-256: $DUMP_SHA256"

# ─── 步骤 2: 恢复到隔离数据库 ───────────────────────────────────────────

log ""
log "步骤 2/5: 恢复到隔离数据库"

RESTORE_ARGS=(
  --backup-id "$BACKUP_ID"
  --target-host "$TARGET_HOST"
  --target-port "$TARGET_PORT"
  --target-user "$TARGET_USER"
  --target-db "$TARGET_DB"
  --manifest-dir "$MANIFEST_DIR"
  --force
)

if [[ "$CI_MODE" == "true" ]]; then
  RESTORE_ARGS+=(--ci-mode --backup-dir "$BACKUP_OUTPUT_DIR")
else
  RESTORE_ARGS+=(
    --age-key "$AGE_KEY"
    --s3-endpoint "$S3_ENDPOINT"
    --s3-bucket "$S3_BUCKET"
    --s3-access-key "$S3_ACCESS_KEY"
    --s3-secret-key "$S3_SECRET_KEY"
  )
fi

if bash "$SCRIPT_DIR/restore.sh" "${RESTORE_ARGS[@]}" 2>&1; then
  record_result "备份恢复" "true" "$TARGET_HOST/$TARGET_DB"
else
  record_result "备份恢复" "false" "restore.sh 执行失败"
  log "恢复失败，无法继续验证"
  exit 2
fi

if [[ -n "$ROLE_SCRIPT" ]]; then
  if [[ ! -f "$ROLE_SCRIPT" ]]; then
    record_result "角色/权限重放" "false" "脚本不存在: $ROLE_SCRIPT"
  elif [[ -z "${MIGRATOR_PASSWORD:-}" || -z "${API_PASSWORD:-}" || -z "${WORKER_PASSWORD:-}" ]]; then
    record_result "角色/权限重放" "false" "缺少 MIGRATOR_PASSWORD/API_PASSWORD/WORKER_PASSWORD"
  elif PGPASSWORD="${PGPASSWORD:-}" psql \
      -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" \
      -v ON_ERROR_STOP=1 \
      -v migrator_password="$MIGRATOR_PASSWORD" \
      -v api_password="$API_PASSWORD" \
      -v worker_password="$WORKER_PASSWORD" \
      -v require_rls_disabled=true \
      -f "$ROLE_SCRIPT" >/dev/null; then
    record_result "角色/权限重放" "true" "$(basename "$ROLE_SCRIPT")"
  else
    record_result "角色/权限重放" "false" "roles.sql 执行失败"
  fi
else
  log "  未提供 --role-script；后续权限检查仍会 fail-closed"
fi

# ─── 步骤 3: 数据完整性验证 ─────────────────────────────────────────────

log ""
log "步骤 3/5: 数据完整性验证"

# psql 辅助函数
psql_source() {
  PGPASSWORD="${PGPASSWORD:-}" psql \
    -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d "$SOURCE_DB" \
    -t -A -c "$1" 2>/dev/null
}

psql_target() {
  PGPASSWORD="${PGPASSWORD:-}" psql \
    -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$TARGET_USER" -d "$TARGET_DB" \
    -t -A -c "$1" 2>/dev/null
}

# 3a. 迁移版本末端匹配
SOURCE_MIGRATION_END=$(psql_source \
  "SELECT max(created_at)::text FROM drizzle.__drizzle_migrations" || echo "unknown")
TARGET_MIGRATION_END=$(psql_target \
  "SELECT max(created_at)::text FROM drizzle.__drizzle_migrations" || echo "unknown")

if [[ "$SOURCE_MIGRATION_END" == "$TARGET_MIGRATION_END" && "$SOURCE_MIGRATION_END" != "unknown" ]]; then
  record_result "迁移版本末端匹配" "true" "$TARGET_MIGRATION_END"
else
  record_result "迁移版本末端匹配" "false" "源=$SOURCE_MIGRATION_END 目标=$TARGET_MIGRATION_END"
fi

# 3b. 核心表行数对比
CORE_TABLES=("users" "workspaces" "workspace_members" "sources" "notes" "note_versions" "validation_questions" "validation_events" "review_schedules" "review_attempts" "jobs" "onboarding_states" "learning_objectives_v2" "learning_cards_v2" "evidence_snapshots_v2")

TABLE_COUNT_MISMATCH=0
TABLE_COUNT_DETAILS=""
for table in "${CORE_TABLES[@]}"; do
  SOURCE_COUNT=$(psql_source "SELECT count(*) FROM $table" 2>/dev/null || echo "N/A")
  TARGET_COUNT=$(psql_target "SELECT count(*) FROM $table" 2>/dev/null || echo "N/A")

  if [[ "$SOURCE_COUNT" == "$TARGET_COUNT" ]]; then
    TABLE_COUNT_DETAILS="$TABLE_COUNT_DETAILS$table=$SOURCE_COUNT "
  else
    TABLE_COUNT_MISMATCH=$((TABLE_COUNT_MISMATCH + 1))
    TABLE_COUNT_DETAILS="$TABLE_COUNT_DETAILS$table=(src:$SOURCE_COUNT,tgt:$TARGET_COUNT) "
  fi
done

if [[ "$TABLE_COUNT_MISMATCH" -eq 0 ]]; then
  record_result "核心表行数对比" "true" "全部 ${#CORE_TABLES[@]} 张表匹配"
else
  record_result "核心表行数对比" "false" "$TABLE_COUNT_MISMATCH 张表不匹配: $TABLE_COUNT_DETAILS"
fi

# 3c. 对象关联完整性：custom-format restore 会在数据加载后重建 FK；
# 因此约束数量必须与源库一致，且目标库不得存在 NOT VALID 约束。
SOURCE_FK_COUNT=$(psql_source \
  "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.contype='f' AND n.nspname='public'" || echo "0")
TARGET_FK_COUNT=$(psql_target \
  "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.contype='f' AND n.nspname='public'" || echo "0")
TARGET_UNVALIDATED_FK_COUNT=$(psql_target \
  "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.contype='f' AND n.nspname='public' AND NOT c.convalidated" || echo "1")

if [[ "$SOURCE_FK_COUNT" -gt 0 && "$SOURCE_FK_COUNT" == "$TARGET_FK_COUNT" && "$TARGET_UNVALIDATED_FK_COUNT" == "0" ]]; then
  record_result "对象关联完整性" "true" "$TARGET_FK_COUNT 项已验证 FK 与源库一致"
else
  record_result "对象关联完整性" "false" "源=$SOURCE_FK_COUNT 目标=$TARGET_FK_COUNT 未验证=$TARGET_UNVALIDATED_FK_COUNT"
fi

# 3d. RLS 策略数量验证（确保恢复后策略仍存在）
SOURCE_RLS_POLICY_COUNT=$(psql_source \
  "SELECT count(*) FROM pg_policy p JOIN pg_class c ON p.polrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid WHERE n.nspname = 'public'" 2>/dev/null || echo "0")
RLS_POLICY_COUNT=$(psql_target \
  "SELECT count(*) FROM pg_policy p JOIN pg_class c ON p.polrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid WHERE n.nspname = 'public'" 2>/dev/null || echo "0")

if [[ "$SOURCE_RLS_POLICY_COUNT" -gt 0 && "$RLS_POLICY_COUNT" == "$SOURCE_RLS_POLICY_COUNT" ]]; then
  record_result "RLS 策略保留" "true" "$RLS_POLICY_COUNT 条 policy 与源库一致"
else
  record_result "RLS 策略保留" "false" "源=$SOURCE_RLS_POLICY_COUNT 目标=$RLS_POLICY_COUNT"
fi

# 3e. SECURITY DEFINER 函数存在
SEC_DEF_COUNT=$(psql_target \
  "SELECT count(*) FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name LIKE 'ailearn_%' AND security_type = 'DEFINER'" 2>/dev/null || echo "0")

if [[ "$SEC_DEF_COUNT" -ge 3 ]]; then
  record_result "SECURITY DEFINER 函数" "true" "$SEC_DEF_COUNT 个函数"
else
  record_result "SECURITY DEFINER 函数" "false" "期望 >=3，实际 $SEC_DEF_COUNT"
fi

# ─── 步骤 4: 角色/权限验证 ──────────────────────────────────────────────

log ""
log "步骤 4/5: 角色/权限验证"

# 检查受限角色是否存在
API_ROLE_EXISTS=$(psql_target \
  "SELECT count(*) FROM pg_roles WHERE rolname = 'ailearn_api'" 2>/dev/null || echo "0")
WORKER_ROLE_EXISTS=$(psql_target \
  "SELECT count(*) FROM pg_roles WHERE rolname = 'ailearn_worker'" 2>/dev/null || echo "0")
MIGRATOR_ROLE_EXISTS=$(psql_target \
  "SELECT count(*) FROM pg_roles WHERE rolname = 'ailearn_migrator'" 2>/dev/null || echo "0")

if [[ "$API_ROLE_EXISTS" == "1" && "$WORKER_ROLE_EXISTS" == "1" && "$MIGRATOR_ROLE_EXISTS" == "1" ]]; then
  record_result "受限角色存在" "true" "api/worker/migrator 角色均存在"
else
  record_result "受限角色存在" "false" "api=$API_ROLE_EXISTS worker=$WORKER_ROLE_EXISTS migrator=$MIGRATOR_ROLE_EXISTS"
fi

# 检查核心表权限
TABLES_WITH_API_SELECT=0
TABLES_WITH_WORKER_SELECT=0
for table in "${CORE_TABLES[@]}"; do
  API_HAS_SELECT=$(psql_target \
    "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'ailearn_api' AND table_name = '$table' AND privilege_type = 'SELECT'" 2>/dev/null || echo "0")
  WORKER_HAS_SELECT=$(psql_target \
    "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'ailearn_worker' AND table_name = '$table' AND privilege_type = 'SELECT'" 2>/dev/null || echo "0")
  if [[ "$API_HAS_SELECT" == "1" ]]; then TABLES_WITH_API_SELECT=$((TABLES_WITH_API_SELECT + 1)); fi
  if [[ "$WORKER_HAS_SELECT" == "1" ]]; then TABLES_WITH_WORKER_SELECT=$((TABLES_WITH_WORKER_SELECT + 1)); fi
done

TOTAL_TABLES=${#CORE_TABLES[@]}
if [[ "$TABLES_WITH_API_SELECT" -eq "$TOTAL_TABLES" ]]; then
  record_result "API 角色 SELECT 权限" "true" "$TABLES_WITH_API_SELECT/$TOTAL_TABLES 表"
else
  record_result "API 角色 SELECT 权限" "false" "$TABLES_WITH_API_SELECT/$TOTAL_TABLES 表"
fi

if [[ "$TABLES_WITH_WORKER_SELECT" -ge 1 ]]; then
  record_result "Worker 角色 SELECT 权限" "true" "$TABLES_WITH_WORKER_SELECT 表（含 jobs）"
else
  record_result "Worker 角色 SELECT 权限" "false" "Worker 缺少 SELECT 权限"
fi

# ─── 步骤 5: API readiness 检查（可选）──────────────────────────────────

log ""
log "步骤 5/5: API readiness 检查"

if [[ -n "$API_URL" ]]; then
  log "  检查 API readiness: $API_URL"
  if HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$API_URL" 2>/dev/null); then
    if [[ "$HTTP_STATUS" == "200" ]]; then
      record_result "API readiness" "true" "HTTP 200"
    else
      record_result "API readiness" "false" "HTTP $HTTP_STATUS"
    fi
  else
    record_result "API readiness" "false" "连接超时或失败"
  fi
else
  log "  跳过（未提供 --api-url 参数）"
fi

# ─── 计时结束 ───────────────────────────────────────────────────────────

RTO_END=$(date -u +%s)
RTO_END_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RTO_SECONDS=$((RTO_END - RTO_START))
RTO_MINUTES=$((RTO_SECONDS / 60))
RTO_SECONDS_REMAINDER=$((RTO_SECONDS % 60))

log ""
log "RTO 计时结束: $RTO_END_ISO"
log "RTO 总耗时: ${RTO_MINUTES}m ${RTO_SECONDS_REMAINDER}s"

# ─── 生成恢复报告 ───────────────────────────────────────────────────────

REPORT_FILE="$REPORT_DIR/rc-restore-${BACKUP_ID}.json"

log ""
log "生成恢复报告: $REPORT_FILE"

# 构建 verification results JSON 数组
VERIFICATION_JSON=$(printf '%s,' "${VERIFICATION_RESULTS[@]}")
VERIFICATION_JSON="[${VERIFICATION_JSON%,}]"

# 构建异常列表
ANOMALIES_JSON="[]"
if [[ ${#ANOMALIES[@]} -gt 0 ]]; then
  ANOMALIES_JSON=$(printf '%s\n' "${ANOMALIES[@]}" | python3 -c 'import json, sys; print(json.dumps([line.rstrip("\n") for line in sys.stdin], ensure_ascii=False))')
fi

TOTAL_CHECKS=$((VERIFICATION_PASS + VERIFICATION_FAIL))
OVERALL_PASSED="true"
if [[ "$VERIFICATION_FAIL" -gt 0 ]]; then
  OVERALL_PASSED="false"
fi

# 2 小时 RTO 门禁
RTO_WITHIN_2H="true"
if [[ "$RTO_SECONDS" -gt 7200 ]]; then
  RTO_WITHIN_2H="false"
fi

cat > "$REPORT_FILE" <<EOF
{
  "reportId": "rc-restore-$BACKUP_ID",
  "backupId": "$BACKUP_ID",
  "sourceRelease": "$SOURCE_RELEASE",
  "sourceCommit": "$SOURCE_COMMIT",
  "sourceMigration": "$SOURCE_MIGRATION",
  "sourceDatabase": {
    "host": "$SOURCE_HOST",
    "port": $SOURCE_PORT,
    "user": "$SOURCE_USER",
    "db": "$SOURCE_DB"
  },
  "targetDatabase": {
    "host": "$TARGET_HOST",
    "port": $TARGET_PORT,
    "user": "$TARGET_USER",
    "db": "$TARGET_DB"
  },
  "backup": {
    "sizeBytes": $DUMP_SIZE,
    "sha256": "$DUMP_SHA256",
    "objectKey": "$OBJECT_KEY",
    "format": "custom"
  },
  "timing": {
    "startedAt": "$RTO_START_ISO",
    "completedAt": "$RTO_END_ISO",
    "durationSeconds": $RTO_SECONDS,
    "rtoWithin2Hours": $RTO_WITHIN_2H
  },
  "verification": {
    "totalChecks": $TOTAL_CHECKS,
    "passed": $VERIFICATION_PASS,
    "failed": $VERIFICATION_FAIL,
    "results": $VERIFICATION_JSON
  },
  "anomalies": $ANOMALIES_JSON,
  "overallPassed": $OVERALL_PASSED,
  "ciMode": $CI_MODE
}
EOF

MANIFEST_STATUS="failed"
MANIFEST_VERIFIED_AT=""
if [[ "$OVERALL_PASSED" == "true" && "$RTO_WITHIN_2H" == "true" ]]; then
  MANIFEST_STATUS="verified"
  MANIFEST_VERIFIED_AT="$RTO_END_ISO"
fi

MANIFEST_PATH="$BACKUP_MANIFEST" \
MANIFEST_STATUS="$MANIFEST_STATUS" \
MANIFEST_VERIFIED_AT="$MANIFEST_VERIFIED_AT" \
MANIFEST_REPORT="$REPORT_FILE" \
python3 - <<'PY'
import json
import os

path = os.environ["MANIFEST_PATH"]
with open(path, encoding="utf-8") as handle:
    manifest = json.load(handle)
manifest["verificationStatus"] = os.environ["MANIFEST_STATUS"]
manifest["verifiedAt"] = os.environ["MANIFEST_VERIFIED_AT"] or None
manifest["verificationReport"] = os.environ["MANIFEST_REPORT"]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

log ""
log "========================================="
log "  恢复验证报告摘要"
log "========================================="
log "  备份 ID: $BACKUP_ID"
log "  RTO: ${RTO_MINUTES}m ${RTO_SECONDS_REMAINDER}s (2h 门禁: $RTO_WITHIN_2H)"
log "  验证: $VERIFICATION_PASS 通过 / $VERIFICATION_FAIL 失败 / $TOTAL_CHECKS 总计"
log "  整体结果: $OVERALL_PASSED"
log "  报告: $REPORT_FILE"
log "========================================="

# ─── 清理 ───────────────────────────────────────────────────────────────

if [[ "$CI_MODE" != "true" ]]; then
  rm -rf "$BACKUP_OUTPUT_DIR"
  log "临时文件已清理"
fi

# ─── 退出 ───────────────────────────────────────────────────────────────

if [[ "$VERIFICATION_FAIL" -gt 0 ]]; then
  log "恢复验证失败: $VERIFICATION_FAIL 项验证未通过"
  exit 2
fi

log "恢复验证全部通过"
exit 0
