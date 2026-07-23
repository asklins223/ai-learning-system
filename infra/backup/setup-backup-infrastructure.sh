#!/usr/bin/env bash
#
# ADR-0007 §1-2: 备份基础设施初始化脚本
#
# 功能：
#   1. 生成 age 加密密钥对（公钥用于备份加密，私钥用于恢复解密）
#   2. 创建 S3-compatible 备份 bucket（独立故障域）
#   3. 验证 bucket 访问权限和加密配置
#   4. 输出后续集成步骤
#
# 安全要求（ADR-0007 §2）：
#   - 私钥生成后必须立即设置严格权限并安全存储
#   - 公钥可放在备份服务器上
#   - 私钥与备份必须分开存储（不同主机或不同安全域）
#   - 生成过程不记录私钥内容
#
# 用法：
#   ./setup-backup-infrastructure.sh \
#     --s3-endpoint http://minio:9000 \
#     --s3-bucket ailearn-backups \
#     --s3-access-key XXX --s3-secret-key YYY \
#     --key-dir /etc/ailearn
#
# 仅生成密钥（不创建 bucket）：
#   ./setup-backup-infrastructure.sh --keys-only --key-dir /etc/ailearn
#
# 仅创建 bucket（已有密钥）：
#   ./setup-backup-infrastructure.sh --bucket-only \
#     --s3-endpoint http://minio:9000 --s3-bucket ailearn-backups \
#     --s3-access-key XXX --s3-secret-key YYY
#
# 退出码：
#   0 — 初始化成功
#   1 — 参数错误或初始化失败

set -euo pipefail

# ─── 参数解析 ───────────────────────────────────────────────────────────

KEYS_ONLY=false
BUCKET_ONLY=false
KEY_DIR="/etc/ailearn"
S3_ENDPOINT=""
S3_BUCKET=""
S3_ACCESS_KEY=""
S3_SECRET_KEY=""
KEY_NAME="backup-age"

usage() {
  cat <<EOF
用法: setup-backup-infrastructure.sh [选项]

模式:
  --keys-only            仅生成 age 密钥对
  --bucket-only          仅创建 S3 bucket

必需参数（密钥生成）:
  --key-dir PATH         密钥存储目录（默认 /etc/ailearn）
  --key-name NAME        密钥名称前缀（默认 backup-age）

必需参数（bucket 创建）:
  --s3-endpoint URL      S3-compatible 端点
  --s3-bucket NAME       S3 bucket 名称
  --s3-access-key KEY    S3 access key
  --s3-secret-key KEY    S3 secret key

可选:
  -h, --help             显示帮助
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keys-only) KEYS_ONLY=true; shift ;;
    --bucket-only) BUCKET_ONLY=true; shift ;;
    --key-dir) KEY_DIR="$2"; shift 2 ;;
    --key-name) KEY_NAME="$2"; shift 2 ;;
    --s3-endpoint) S3_ENDPOINT="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-access-key) S3_ACCESS_KEY="$2"; shift 2 ;;
    --s3-secret-key) S3_SECRET_KEY="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

log() { echo "[setup-infra] $*"; }
err() { echo "[setup-infra] 错误: $*" >&2; }

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo &>/dev/null; then
    sudo "$@"
  else
    err "操作 $1 需要 root 权限，且系统未安装 sudo"
    return 1
  fi
}

# ─── 步骤 1: 生成 age 密钥对 ────────────────────────────────────────────

generate_keys() {
  local pub_key_file="$KEY_DIR/${KEY_NAME}.pub"
  local priv_key_file="$KEY_DIR/${KEY_NAME}.key"

  log "=== 生成 age 加密密钥对 ==="
  log "  密钥目录: $KEY_DIR"
  log "  密钥名称: $KEY_NAME"

  # 检查 age 是否安装
  if ! command -v age &>/dev/null; then
    err "age 命令未安装"
    err "安装方法:"
    err "  macOS:  brew install age"
    err "  Ubuntu: apt-get install age"
    err "  手动:   https://github.com/FiloSottile/age/releases"
    exit 1
  fi

  # 完整密钥对存在时保持幂等；只存在一半则 fail-closed，避免用错密钥。
  if [[ -f "$pub_key_file" && -f "$priv_key_file" ]]; then
    if grep -Eq '^age1[0-9a-z]+$' "$pub_key_file" \
      && grep -q '^AGE-SECRET-KEY-' "$priv_key_file"; then
      as_root chmod 644 "$pub_key_file"
      as_root chmod 600 "$priv_key_file"
      log "  - 已存在有效密钥对，跳过生成"
      return 0
    fi
    err "现有 age 密钥对格式无效，拒绝覆盖"
    exit 1
  elif [[ -f "$pub_key_file" || -f "$priv_key_file" ]]; then
    err "只找到一半 age 密钥对，拒绝覆盖"
    err "  公钥: $pub_key_file"
    err "  私钥: $priv_key_file"
    exit 1
  fi

  # 创建密钥目录
  as_root mkdir -p "$KEY_DIR"
  as_root chmod 700 "$KEY_DIR"

  log "  生成密钥对..."

  # 生成密钥对到临时文件
  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf $tmp_dir" EXIT

  age-keygen -o "$tmp_dir/key.txt" 2>/dev/null

  # 提取公钥和私钥
  # age-keygen 输出格式:
  #   # created: ...
  #   # public key: age1...
  #   AGE-SECRET-KEY-...
  local pub_key
  pub_key=$(grep "^# public key:" "$tmp_dir/key.txt" | awk '{print $4}')

  if [[ -z "$pub_key" ]]; then
    err "无法从 age-keygen 输出中提取公钥"
    exit 1
  fi

  # 写入公钥文件
  printf '%s\n' "$pub_key" > "$tmp_dir/public.txt"
  as_root cp "$tmp_dir/public.txt" "$pub_key_file"
  as_root chmod 644 "$pub_key_file"
  log "  ✓ 公钥已生成: $pub_key_file"
  log "    内容: $pub_key"

  # 写入私钥文件（包含完整 age-keygen 输出）
  as_root cp "$tmp_dir/key.txt" "$priv_key_file"
  as_root chmod 600 "$priv_key_file"
  as_root chown root:root "$priv_key_file"
  log "  ✓ 私钥已生成: $priv_key_file"
  log "    权限: 600 owner:root:root"

  # 安全清理临时文件
  shred -u "$tmp_dir/key.txt" 2>/dev/null || rm -f "$tmp_dir/key.txt"

  log ""
  log "  ⚠ 安全提示:"
  log "    1. 私钥文件 $priv_key_file 必须与备份存储在不同安全域"
  log "    2. 建议将私钥备份到离线介质（如 USB 加密盘）"
  log "    3. 切勿将私钥提交到版本控制系统"
  log "    4. 公钥文件可安全放在备份服务器上"
  log ""
}

# ─── 步骤 2: 创建 S3 bucket ─────────────────────────────────────────────

create_bucket() {
  log "=== 创建 S3 备份 bucket ==="
  log "  端点: $S3_ENDPOINT"
  log "  bucket: $S3_BUCKET"

  # 参数校验
  if [[ -z "$S3_ENDPOINT" || -z "$S3_BUCKET" || -z "$S3_ACCESS_KEY" || -z "$S3_SECRET_KEY" ]]; then
    err "创建 bucket 需要全部 S3 参数"
    exit 1
  fi

  # 选择 S3 客户端
  local s3_client=""
  if command -v aws &>/dev/null; then
    s3_client="aws"
  elif command -v mc &>/dev/null; then
    s3_client="mc"
  else
    err "需要 aws CLI 或 mc (MinIO Client)"
    err "安装方法:"
    err "  aws:  pip install awscli 或 https://aws.amazon.com/cli/"
    err "  mc:   https://min.io/docs/minio/linux/reference/minio-mc.html"
    exit 1
  fi

  if [[ "$s3_client" == "aws" ]]; then
    export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
    export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"

    # 检查 bucket 是否已存在
    if aws s3 ls "s3://$S3_BUCKET" --endpoint-url "$S3_ENDPOINT" 2>/dev/null; then
      log "  - bucket 已存在，跳过创建"
    else
      log "  创建 bucket..."
      aws s3 mb "s3://$S3_BUCKET" --endpoint-url "$S3_ENDPOINT"
      log "  ✓ bucket 已创建"
    fi

    # 设置 bucket 策略：禁止公共访问
    log "  配置 bucket 访问控制..."
    aws s3api put-public-access-block \
      --bucket "$S3_BUCKET" \
      --endpoint-url "$S3_ENDPOINT" \
      --public-access-block-configuration \
        BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
      2>/dev/null || log "  ⚠ 无法设置公共访问阻断（可能不支持此 API）"

    # 启用版本控制（防止意外删除）
    log "  启用版本控制..."
    aws s3api put-bucket-versioning \
      --bucket "$S3_BUCKET" \
      --endpoint-url "$S3_ENDPOINT" \
      --versioning-configuration Status=Enabled \
      2>/dev/null || log "  ⚠ 无法启用版本控制（可能不支持此 API）"

    # 验证写入权限
    log "  验证写入权限..."
    echo "setup-verify-$(date -u +%s)" | \
      aws s3 cp - "s3://$S3_BUCKET/.setup-verify" --endpoint-url "$S3_ENDPOINT"
    aws s3 rm "s3://$S3_BUCKET/.setup-verify" --endpoint-url "$S3_ENDPOINT"
    log "  ✓ 写入权限验证通过"

  elif [[ "$s3_client" == "mc" ]]; then
    # MinIO mc 客户端
    mc alias set ailearn-backup "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"

    # 检查 bucket 是否已存在
    if mc ls "ailearn-backup/$S3_BUCKET" 2>/dev/null; then
      log "  - bucket 已存在，跳过创建"
    else
      log "  创建 bucket..."
      mc mb "ailearn-backup/$S3_BUCKET"
      log "  ✓ bucket 已创建"
    fi

    # 设置匿名访问为 none
    mc anonymous set none "ailearn-backup/$S3_BUCKET" 2>/dev/null || true

    # 启用版本控制
    log "  启用版本控制..."
    mc version enable "ailearn-backup/$S3_BUCKET" 2>/dev/null || log "  ⚠ 无法启用版本控制"

    # 验证写入权限
    log "  验证写入权限..."
    echo "setup-verify-$(date -u +%s)" | \
      mc pipe "ailearn-backup/$S3_BUCKET/.setup-verify"
    mc rm "ailearn-backup/$S3_BUCKET/.setup-verify"
    log "  ✓ 写入权限验证通过"
  fi

  log ""
  log "  S3 bucket 配置完成:"
  log "    端点: $S3_ENDPOINT"
  log "    bucket: $S3_BUCKET"
  log "    匿名访问: 已禁用"
  log "    版本控制: 已启用"
  log ""
}

# ─── 主流程 ─────────────────────────────────────────────────────────────

if [[ "$KEYS_ONLY" == "false" && "$BUCKET_ONLY" == "false" ]]; then
  # 默认：两个步骤都执行
  generate_keys
  create_bucket
elif [[ "$KEYS_ONLY" == "true" ]]; then
  generate_keys
elif [[ "$BUCKET_ONLY" == "true" ]]; then
  create_bucket
fi

# ─── 后续步骤提示 ───────────────────────────────────────────────────────

log "=== 后续步骤 ==="
log ""
if [[ "$KEYS_ONLY" == "false" || "$BUCKET_ONLY" == "false" ]]; then
  log "1. 将公钥路径配置到 alpha-cron-setup.sh 的 --age-key 参数"
  log "2. 将 S3 参数配置到 alpha-cron-setup.sh 的 --s3-* 参数"
  log "3. 运行 alpha-cron-setup.sh 安装 cron 调度器"
  log "4. 手动测试首次备份: bash alpha-backup-cron.sh"
  log ""
  log "恢复时需要私钥文件: $KEY_DIR/${KEY_NAME}.key"
  log "请将私钥安全存储到独立位置（不同主机或离线介质）"
fi
