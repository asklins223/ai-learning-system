#!/usr/bin/env bash
#
# OPS-01: Alpha 环境一键部署与验证脚本（ADR-0006, ADR-0007）
#
# 使用 Docker Compose 搭建完整 Alpha 环境，包括：
#   1. 生产级应用栈（PostgreSQL + API + Worker + Web + MinIO）
#   2. 监控栈（Prometheus + Alertmanager）
#   3. 备份基础设施（age 密钥 + S3 bucket + cron）
#
# 用法：
#   ./scripts/alpha-env-setup.sh up          # 启动 Alpha 环境
#   ./scripts/alpha-env-setup.sh init       # 初始化备份基础设施（密钥+bucket）
#   ./scripts/alpha-env-setup.sh backup     # 执行一次备份
#   ./scripts/alpha-env-setup.sh restore-verify  # 验证恢复
#   ./scripts/alpha-env-setup.sh freshness  # 检查备份新鲜度
#   ./scripts/alpha-env-setup.sh status     # 查看服务状态
#   ./scripts/alpha-env-setup.sh metrics    # 查看 Prometheus 指标
#   ./scripts/alpha-env-setup.sh down       # 停止 Alpha 环境
#
# 环境变量：
#   MINIO_ROOT_USER     — MinIO 管理员用户名（默认 ailearn）
#   MINIO_ROOT_PASSWORD — MinIO 管理员密码（必须设置）
#   POSTGRES_PASSWORD   — PostgreSQL 管理员密码（必须设置）
#   MIGRATOR_PASSWORD   — migrator 角色密码（必须设置）
#   API_PASSWORD        — API 角色密码（必须设置）
#   WORKER_PASSWORD     — Worker 角色密码（必须设置）
#   DATABASE_URL_MIGRATOR — 迁移角色连接串（必须设置，密码需 URL 编码）
#   DATABASE_URL_API      — API 角色连接串（必须设置，密码需 URL 编码）
#   DATABASE_URL_WORKER   — Worker 角色连接串（必须设置，密码需 URL 编码）
#   BACKUP_BUCKET       — 备份 bucket 名称（默认 ailearn-backups）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091 -- operator-owned repository environment file
  source "$REPO_ROOT/.env"
  set +a
fi

COMPOSE=(
  docker compose
  --project-directory "$REPO_ROOT"
  -f "$REPO_ROOT/docker-compose.yml"
  -f "$REPO_ROOT/docker-compose.alpha.yml"
  --profile storage
)
BACKUP_BUCKET="${BACKUP_BUCKET:-ailearn-backups}"
RESTORE_DB="ailearn_restore_verify"

# ─── 颜色输出 ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[alpha]${NC} $*"; }
warn() { echo -e "${YELLOW}[alpha]${NC} $*"; }
err()  { echo -e "${RED}[alpha]${NC} $*" >&2; }

# ─── 环境检查 ──────────────────────────────────────────────────────────
check_env() {
  local missing=()
  [[ -z "${MINIO_ROOT_PASSWORD:-}" ]] && missing+=("MINIO_ROOT_PASSWORD")
  [[ -z "${POSTGRES_PASSWORD:-}" ]] && missing+=("POSTGRES_PASSWORD")
  [[ -z "${MIGRATOR_PASSWORD:-}" ]] && missing+=("MIGRATOR_PASSWORD")
  [[ -z "${API_PASSWORD:-}" ]] && missing+=("API_PASSWORD")
  [[ -z "${WORKER_PASSWORD:-}" ]] && missing+=("WORKER_PASSWORD")
  [[ -z "${DATABASE_URL_MIGRATOR:-}" ]] && missing+=("DATABASE_URL_MIGRATOR")
  [[ -z "${DATABASE_URL_API:-}" ]] && missing+=("DATABASE_URL_API")
  [[ -z "${DATABASE_URL_WORKER:-}" ]] && missing+=("DATABASE_URL_WORKER")

  if [[ ${#missing[@]} -gt 0 ]]; then
    err "缺少必需的环境变量: ${missing[*]}"
    err ""
    err "请创建 .env 文件或导出环境变量："
    err "  export MINIO_ROOT_PASSWORD=your-secret"
    err "  export POSTGRES_PASSWORD=your-secret"
    err "  export MIGRATOR_PASSWORD=your-secret"
    err "  export API_PASSWORD=your-secret"
    err "  export WORKER_PASSWORD=your-secret"
    err "  export DATABASE_URL_MIGRATOR=postgres://ailearn_migrator:...@postgres:5432/ailearn"
    err "  export DATABASE_URL_API=postgres://ailearn_api:...@postgres:5432/ailearn"
    err "  export DATABASE_URL_WORKER=postgres://ailearn_worker:...@postgres:5432/ailearn"
    exit 1
  fi
}

# `docker compose ps/down` still parses required interpolation variables even
# though neither operation connects to application services. Supply inert
# placeholders so operators can inspect or stop a broken stack when the secret
# file is unavailable; mutating/start commands continue to use check_env.
prepare_compose_control_env() {
  export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-control-only-placeholder}"
  export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-control-only-placeholder}"
  export MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:-control-only-placeholder}"
  export API_PASSWORD="${API_PASSWORD:-control-only-placeholder}"
  export WORKER_PASSWORD="${WORKER_PASSWORD:-control-only-placeholder}"
  export DATABASE_URL_MIGRATOR="${DATABASE_URL_MIGRATOR:-postgres://control:control@postgres:5432/control}"
  export DATABASE_URL_API="${DATABASE_URL_API:-postgres://control:control@postgres:5432/control}"
  export DATABASE_URL_WORKER="${DATABASE_URL_WORKER:-postgres://control:control@postgres:5432/control}"
}

wait_http() {
  local name="$1" url="$2" attempts="${3:-30}"
  for ((i = 1; i <= attempts; i++)); do
    if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      log "$name 就绪"
      return 0
    fi
    sleep 2
  done
  err "$name 未在 $((attempts * 2)) 秒内就绪: $url"
  return 1
}

run_one_shot() {
  local service="$1"
  "${COMPOSE[@]}" rm -f "$service" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" up -d "$service"
  # Docker Compose v5 changed `compose wait` to reject already-exited
  # one-shot containers ("no containers for project").  Fall back to the
  # stable `docker wait <container-id>` which handles exited containers.
  local cid
  cid="$("${COMPOSE[@]}" ps -aq "$service" | head -n1)"
  if [[ -z "$cid" ]]; then
    err "Missing required init service: $service"
    return 1
  fi
  docker wait "$cid" >/dev/null
}

# ─── 启动 Alpha 环境 ──────────────────────────────────────────────────
cmd_up() {
  check_env
  log "启动 Alpha 环境..."

  # Start core services first
  "${COMPOSE[@]}" up -d postgres minio alpha-ops-sidecar

  # Wait for PostgreSQL
  log "等待 PostgreSQL 就绪..."
  for i in $(seq 1 30); do
    if "${COMPOSE[@]}" exec -T postgres pg_isready -U "${POSTGRES_USER:-ailearn}" >/dev/null 2>&1; then
      log "PostgreSQL 就绪"
      break
    fi
    if [[ "$i" -eq 30 ]]; then
      err "PostgreSQL 未在 60 秒内就绪"
      return 1
    fi
    sleep 2
  done

  run_one_shot minio-init
  run_one_shot role-bootstrap
  run_one_shot migrate
  run_one_shot role-grants

  # Start application and monitoring services.
  "${COMPOSE[@]}" up -d api worker prometheus alertmanager

  # Wait for API readiness
  log "等待 API 就绪..."
  wait_http "API" "http://127.0.0.1:${API_PORT:-4000}/ready"
  wait_http "Worker metrics" "http://127.0.0.1:${WORKER_METRICS_PORT:-9100}/metrics"
  wait_http "Prometheus" "http://127.0.0.1:${PROMETHEUS_PORT:-9090}/-/healthy"
  wait_http "Alertmanager" "http://127.0.0.1:${ALERTMANAGER_PORT:-9093}/-/healthy"

  log "Alpha 环境已启动"
  cmd_status
}

# ─── 初始化备份基础设施 ───────────────────────────────────────────────
cmd_init() {
  check_env
  log "初始化备份基础设施..."

  # Run setup-backup-infrastructure.sh inside the backup-runner container
  "${COMPOSE[@]}" run --rm backup-runner \
    /scripts/setup-backup-infrastructure.sh \
      --s3-endpoint http://minio:9000 \
      --s3-bucket "$BACKUP_BUCKET" \
      --s3-access-key "${MINIO_ROOT_USER:-ailearn}" \
      --s3-secret-key "$MINIO_ROOT_PASSWORD" \
      --key-dir /etc/ailearn

  log "备份基础设施初始化完成"
  log "  age 公钥: backup-runner:/etc/ailearn/backup-age.pub"
  log "  age 私钥: backup-runner:/etc/ailearn/backup-age.key（安全存储）"
  log "  S3 bucket: minio:$BACKUP_BUCKET"
}

# ─── 执行备份 ─────────────────────────────────────────────────────────
cmd_backup() {
  check_env
  log "执行加密备份..."

  local commit
  commit=$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")

  # 2026-08-11：迁移号动态取最新（见 cmd_restore_verify）
  local migration_tag
  migration_tag=$(node -e "const j=require(process.argv[1]);process.stdout.write((j.entries[j.entries.length-1]||{}).tag||'')" "$REPO_ROOT/apps/api/src/db/migrations/meta/_journal.json" 2>/dev/null || echo "unknown")

  "${COMPOSE[@]}" run --rm backup-runner \
    /scripts/backup.sh \
      --pg-host postgres \
      --pg-user "${POSTGRES_USER:-ailearn}" \
      --pg-db "${POSTGRES_DB:-ailearn}" \
      --release "${SOURCE_RELEASE:-0.5.0-alpha}" \
      --commit "$commit" \
      --migration "${SOURCE_MIGRATION:-${migration_tag:-unknown}}" \
      --age-key /etc/ailearn/backup-age.pub \
      --s3-endpoint http://minio:9000 \
      --s3-bucket "$BACKUP_BUCKET" \
      --s3-access-key "${MINIO_ROOT_USER:-ailearn}" \
      --s3-secret-key "$MINIO_ROOT_PASSWORD" \
      --manifest-dir /var/lib/ailearn/manifests

  log "备份完成"
}

# ─── 验证恢复 ─────────────────────────────────────────────────────────
cmd_restore_verify() {
  check_env
  log "执行 RC 恢复验证..."

  local commit
  commit=$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo "unknown")

  # 2026-08-11：迁移号不再硬编码 0039（已过期到 0103+），从 _journal.json 动态取最新。
  local migration_tag
  migration_tag=$(node -e "const j=require(process.argv[1]);process.stdout.write((j.entries[j.entries.length-1]||{}).tag||'')" "$REPO_ROOT/apps/api/src/db/migrations/meta/_journal.json" 2>/dev/null || echo "unknown")

  # This command only replaces the named isolated verification database.
  "${COMPOSE[@]}" exec -T postgres psql \
    -U "${POSTGRES_USER:-ailearn}" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)" \
    -c "CREATE DATABASE ${RESTORE_DB}"

  "${COMPOSE[@]}" run --rm backup-runner \
    /scripts/rc-restore-verify.sh \
      --source-host postgres \
      --source-user "${POSTGRES_USER:-ailearn}" \
      --source-db "${POSTGRES_DB:-ailearn}" \
      --target-host restore-postgres \
      --target-user "${POSTGRES_USER:-ailearn}" \
      --target-db "$RESTORE_DB" \
      --release "${SOURCE_RELEASE:-0.5.0-alpha}" \
      --commit "$commit" \
      --migration "${SOURCE_MIGRATION:-${migration_tag:-unknown}}" \
      --s3-endpoint http://minio:9000 \
      --s3-bucket "$BACKUP_BUCKET" \
      --s3-access-key "${MINIO_ROOT_USER:-ailearn}" \
      --s3-secret-key "$MINIO_ROOT_PASSWORD" \
      --age-key /etc/ailearn/backup-age.key \
      --manifest-dir /var/lib/ailearn/manifests \
      --report-dir /var/lib/ailearn/manifests/rc-reports \
      --role-script /opt/ailearn/roles.sql \
      --force

  log "恢复验证完成"
}

# ─── 检查备份新鲜度 ───────────────────────────────────────────────────
cmd_freshness() {
  check_env
  log "检查备份新鲜度..."

  "${COMPOSE[@]}" run --rm backup-runner \
    /scripts/freshness-check.sh \
      --manifest-dir /var/lib/ailearn/manifests \
      --max-age-hours 24
}

# ─── 查看服务状态 ─────────────────────────────────────────────────────
cmd_status() {
  prepare_compose_control_env
  log "Alpha 环境服务状态："
  "${COMPOSE[@]}" ps

  echo ""
  log "端点："
  echo "  API:          http://localhost:4000"
  echo "  API metrics:  http://localhost:4000/metrics"
  echo "  Prometheus:   http://localhost:9090"
  echo "  Alertmanager: http://localhost:9093"
  echo "  MinIO:        http://localhost:9001"

  echo ""
  log "Prometheus 告警状态："
  curl -sf http://localhost:9090/api/v1/alerts 2>/dev/null | \
    jq '.data.alerts[] | {state: .state, labels: .labels}' 2>/dev/null || \
    echo "  (Prometheus 未就绪)"

  echo ""
  log "Prometheus scrape 目标："
  curl -sf http://localhost:9090/api/v1/targets 2>/dev/null | \
    jq '.data.activeTargets[] | {job: .labels.job, health: .health, lastError: .lastError}' 2>/dev/null || \
    echo "  (Prometheus 未就绪)"
}

# ─── 查看 Prometheus 指标 ─────────────────────────────────────────────
cmd_metrics() {
  log "API 指标摘要："
  curl -sf http://localhost:4000/metrics 2>/dev/null | \
    grep -E "^ailearn_" | head -20 || \
    echo "  (API 未就绪)"

  echo ""
  log "Worker 指标摘要："
  # Worker metrics are on internal network, use Prometheus query
  curl -sf "http://localhost:9090/api/v1/query?query=ailearn_job_queue_depth" 2>/dev/null | \
    jq '.data.result' 2>/dev/null || \
    echo "  (Prometheus 未就绪)"
}

# ─── 停止 Alpha 环境 ─────────────────────────────────────────────────
cmd_down() {
  prepare_compose_control_env
  log "停止 Alpha 环境..."
  "${COMPOSE[@]}" down --remove-orphans
  log "Alpha 环境已停止"
}

# ─── 主入口 ───────────────────────────────────────────────────────────
case "${1:-status}" in
  up)             cmd_up ;;
  init)           cmd_init ;;
  backup)         cmd_backup ;;
  restore-verify) cmd_restore_verify ;;
  freshness)      cmd_freshness ;;
  status)         cmd_status ;;
  metrics)        cmd_metrics ;;
  down)           cmd_down ;;
  *)
    echo "用法: $0 {up|init|backup|restore-verify|freshness|status|metrics|down}"
    exit 1
    ;;
esac
