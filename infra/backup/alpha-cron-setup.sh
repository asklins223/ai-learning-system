#!/usr/bin/env bash
#
# ADR-0007 §1: Alpha 环境 cron 调度器安装脚本
#
# 功能：
#   1. 生成 /etc/ailearn/backup.env 配置文件（从参数或交互式输入）
#   2. 安装 cron 条目（每 12 小时执行一次备份）
#   3. 验证所需工具（pg_dump, age, aws/mc）已安装
#   4. 输出安装结果和后续步骤
#
# 用法：
#   ./alpha-cron-setup.sh \
#     --pg-host localhost --pg-port 5432 \
#     --pg-user ailearn_migrator --pg-db ailearn \
#     --release 0.5.0-alpha.1 --commit abc1234 --migration 0028 \
#     --age-key /etc/ailearn/backup-age.pub \
#     --s3-endpoint http://minio:9000 --s3-bucket ailearn-backups \
#     --s3-access-key XXX --s3-secret-key YYY \
#     --manifest-dir /data/backups/manifests
#
# 交互式模式（省略参数则提示输入）：
#   ./alpha-cron-setup.sh --interactive
#
# 卸载：
#   ./alpha-cron-setup.sh --uninstall
#
# 退出码：
#   0 — 安装成功
#   1 — 参数错误或安装失败

set -euo pipefail

# ─── 常量 ───────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="/etc/ailearn"
CONFIG_FILE="$CONFIG_DIR/backup.env"
CRON_MARKER="# ailearn-alpha-backup"
CRON_SCHEDULE="0 */12 * * *"
CRON_COMMAND="$SCRIPT_DIR/alpha-backup-cron.sh"

# ─── 参数解析 ───────────────────────────────────────────────────────────

INTERACTIVE=false
UNINSTALL=false

# 配置变量（从参数填充）
PG_HOST=""
PG_PORT="5432"
PG_USER=""
PG_DB=""
SOURCE_RELEASE=""
SOURCE_COMMIT=""
SOURCE_MIGRATION=""
AGE_KEY_PATH=""
S3_ENDPOINT=""
S3_BUCKET=""
S3_ACCESS_KEY=""
S3_SECRET_KEY=""
MANIFEST_DIR="/data/backups/manifests"
DAILY_RETENTION="14"
WEEKLY_RETENTION="4"
FRESHNESS_MAX_AGE_HOURS="24"

usage() {
  cat <<EOF
用法: alpha-cron-setup.sh [选项]

模式:
  --interactive          交互式输入参数
  --uninstall            卸载 cron 条目和配置文件

必需参数（非交互式模式）:
  --pg-host HOST         PostgreSQL 主机名
  --pg-user USER         PostgreSQL 用户名（migrator 角色）
  --pg-db DB             PostgreSQL 数据库名
  --release VERSION      当前系统版本号
  --commit SHA           当前 Git commit SHA
  --migration NUM        当前数据库最新迁移编号
  --age-key PATH         age 公钥文件路径
  --s3-endpoint URL      S3-compatible 端点
  --s3-bucket NAME       S3 bucket 名称
  --s3-access-key KEY    S3 access key
  --s3-secret-key KEY    S3 secret key

可选:
  --pg-port PORT         PostgreSQL 端口（默认 5432）
  --manifest-dir PATH    manifest 存储目录（默认 /data/backups/manifests）
  --daily-retention N    daily 保留数量（默认 14）
  --weekly-retention N   weekly 保留数量（默认 4）
  --max-age-hours N      新鲜度阈值小时（默认 24）
  -h, --help             显示帮助
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interactive) INTERACTIVE=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    --pg-host) PG_HOST="$2"; shift 2 ;;
    --pg-port) PG_PORT="$2"; shift 2 ;;
    --pg-user) PG_USER="$2"; shift 2 ;;
    --pg-db) PG_DB="$2"; shift 2 ;;
    --release) SOURCE_RELEASE="$2"; shift 2 ;;
    --commit) SOURCE_COMMIT="$2"; shift 2 ;;
    --migration) SOURCE_MIGRATION="$2"; shift 2 ;;
    --age-key) AGE_KEY_PATH="$2"; shift 2 ;;
    --s3-endpoint) S3_ENDPOINT="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-access-key) S3_ACCESS_KEY="$2"; shift 2 ;;
    --s3-secret-key) S3_SECRET_KEY="$2"; shift 2 ;;
    --manifest-dir) MANIFEST_DIR="$2"; shift 2 ;;
    --daily-retention) DAILY_RETENTION="$2"; shift 2 ;;
    --weekly-retention) WEEKLY_RETENTION="$2"; shift 2 ;;
    --max-age-hours) FRESHNESS_MAX_AGE_HOURS="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

# ─── 工具函数 ───────────────────────────────────────────────────────────

log() { echo "[alpha-cron-setup] $*"; }
err() { echo "[alpha-cron-setup] 错误: $*" >&2; }

check_tool() {
  local tool="$1"
  if command -v "$tool" &>/dev/null; then
    log "  ✓ $tool 已安装"
    return 0
  else
    log "  ✗ $tool 未安装"
    return 1
  fi
}

prompt() {
  local var_name="$1" prompt_text="$2" default_val="${3:-}"
  local current_val="${!var_name:-}"
  if [[ -n "$current_val" ]]; then
    return
  fi
  if [[ -n "$default_val" ]]; then
    read -rp "$prompt_text [$default_val]: " input
    echo "${input:-$default_val}"
  else
    read -rp "$prompt_text: " input
    echo "$input"
  fi
}

# ─── 卸载模式 ───────────────────────────────────────────────────────────

if [[ "$UNINSTALL" == "true" ]]; then
  log "卸载 Alpha 备份 cron..."

  # 从 crontab 中移除条目
  if crontab -l 2>/dev/null | grep -q "$CRON_MARKER"; then
    crontab -l 2>/dev/null | grep -v "$CRON_MARKER" | crontab -
    log "  ✓ cron 条目已移除"
  else
    log "  - cron 条目不存在，跳过"
  fi

  # 保留配置文件（可能包含敏感信息，不自动删除）
  if [[ -f "$CONFIG_FILE" ]]; then
    log "  - 配置文件保留在 $CONFIG_FILE（如需删除请手动执行）"
    log "    rm -f $CONFIG_FILE"
  fi

  log "卸载完成"
  exit 0
fi

# ─── 交互式模式 ─────────────────────────────────────────────────────────

if [[ "$INTERACTIVE" == "true" ]]; then
  log "交互式配置"
  echo ""

  PG_HOST=$(prompt PG_HOST "PostgreSQL 主机名")
  PG_PORT=$(prompt PG_PORT "PostgreSQL 端口" "5432")
  PG_USER=$(prompt PG_USER "PostgreSQL 用户名 (migrator)")
  PG_DB=$(prompt PG_DB "PostgreSQL 数据库名" "ailearn")
  SOURCE_RELEASE=$(prompt SOURCE_RELEASE "系统版本号" "0.5.0-alpha.1")
  SOURCE_COMMIT=$(prompt SOURCE_COMMIT "Git commit SHA")
  SOURCE_MIGRATION=$(prompt SOURCE_MIGRATION "最新迁移编号" "0028")
  AGE_KEY_PATH=$(prompt AGE_KEY_PATH "age 公钥路径" "/etc/ailearn/backup-age.pub")
  S3_ENDPOINT=$(prompt S3_ENDPOINT "S3 端点" "http://minio:9000")
  S3_BUCKET=$(prompt S3_BUCKET "S3 bucket 名称" "ailearn-backups")
  S3_ACCESS_KEY=$(prompt S3_ACCESS_KEY "S3 access key")
  S3_SECRET_KEY=$(prompt S3_SECRET_KEY "S3 secret key")
  MANIFEST_DIR=$(prompt MANIFEST_DIR "manifest 目录" "/data/backups/manifests")
  DAILY_RETENTION=$(prompt DAILY_RETENTION "daily 保留数量" "14")
  WEEKLY_RETENTION=$(prompt WEEKLY_RETENTION "weekly 保留数量" "4")
  FRESHNESS_MAX_AGE_HOURS=$(prompt FRESHNESS_MAX_AGE_HOURS "新鲜度阈值 (小时)" "24")
fi

# ─── 参数校验 ───────────────────────────────────────────────────────────

REQUIRED=(
  PG_HOST PG_USER PG_DB
  SOURCE_RELEASE SOURCE_COMMIT SOURCE_MIGRATION
  AGE_KEY_PATH
  S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY
  MANIFEST_DIR
)

MISSING=()
for var in "${REQUIRED[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  err "缺少必需参数: ${MISSING[*]}"
  err "使用 --interactive 交互式输入，或提供上述参数"
  usage
fi

# ─── 依赖检查 ───────────────────────────────────────────────────────────

log "检查依赖工具..."
TOOLS_OK=true
check_tool "pg_dump" || TOOLS_OK=false
check_tool "age" || TOOLS_OK=false
if ! check_tool "aws" && ! check_tool "mc"; then
  log "  ✗ aws CLI 或 mc (MinIO Client) 至少需要一个"
  TOOLS_OK=false
fi
check_tool "python3" || TOOLS_OK=false
check_tool "crontab" || TOOLS_OK=false

if [[ "$TOOLS_OK" == "false" ]]; then
  err "缺少必需工具，请先安装"
  exit 1
fi

# ─── 生成配置文件 ───────────────────────────────────────────────────────

log "生成配置文件: $CONFIG_FILE"

sudo mkdir -p "$CONFIG_DIR"
sudo chmod 700 "$CONFIG_DIR"

sudo tee "$CONFIG_FILE" > /dev/null <<EOF
# Alpha 环境备份 cron 配置
# 由 alpha-cron-setup.sh 生成于 $(date -u +%Y-%m-%dT%H:%M:%SZ)
# 警告: 此文件包含 S3 凭据，权限应为 600

PG_HOST="$PG_HOST"
PG_PORT="$PG_PORT"
PG_USER="$PG_USER"
PG_DB="$PG_DB"
SOURCE_RELEASE="$SOURCE_RELEASE"
SOURCE_COMMIT="$SOURCE_COMMIT"
SOURCE_MIGRATION="$SOURCE_MIGRATION"
AGE_KEY_PATH="$AGE_KEY_PATH"
S3_ENDPOINT="$S3_ENDPOINT"
S3_BUCKET="$S3_BUCKET"
S3_ACCESS_KEY="$S3_ACCESS_KEY"
S3_SECRET_KEY="$S3_SECRET_KEY"
MANIFEST_DIR="$MANIFEST_DIR"
DAILY_RETENTION="$DAILY_RETENTION"
WEEKLY_RETENTION="$WEEKLY_RETENTION"
FRESHNESS_MAX_AGE_HOURS="$FRESHNESS_MAX_AGE_HOURS"
EOF

sudo chmod 600 "$CONFIG_FILE"
sudo chown root:root "$CONFIG_FILE"
log "  ✓ 配置文件已生成（权限 600）"

# 确保 manifest 目录存在
sudo mkdir -p "$MANIFEST_DIR"
sudo chmod 700 "$MANIFEST_DIR"

# 确保 age 公钥文件存在
if [[ ! -f "$AGE_KEY_PATH" ]]; then
  log "  ⚠ age 公钥文件不存在: $AGE_KEY_PATH"
  log "    请运行 setup-backup-infrastructure.sh 生成密钥对"
fi

# ─── 安装 cron 条目 ─────────────────────────────────────────────────────

log "安装 cron 条目..."

CRON_ENTRY="$CRON_SCHEDULE $CRON_COMMAND $CRON_MARKER"

# 移除旧条目（如果有）
if crontab -l 2>/dev/null | grep -q "$CRON_MARKER"; then
  crontab -l 2>/dev/null | grep -v "$CRON_MARKER" | crontab -
  log "  - 已移除旧 cron 条目"
fi

# 添加新条目
(crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -
log "  ✓ cron 条目已安装: $CRON_SCHEDULE"

# ─── 验证安装 ───────────────────────────────────────────────────────────

log ""
log "=== 安装完成 ==="
log ""
log "配置文件: $CONFIG_FILE"
log "manifest 目录: $MANIFEST_DIR"
log "cron 条目: $CRON_SCHEDULE $CRON_COMMAND"
log ""
log "后续步骤:"
log "  1. 确认 age 密钥对已生成（运行 setup-backup-infrastructure.sh）"
log "  2. 手动测试: bash $SCRIPT_DIR/alpha-backup-cron.sh"
log "  3. 检查日志: tail -f /var/log/ailearn/backup-cron.log"
log "  4. 查看 cron: crontab -l"
log ""
log "卸载: $SCRIPT_DIR/alpha-cron-setup.sh --uninstall"
