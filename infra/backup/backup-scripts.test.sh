#!/usr/bin/env bash
#
# 备份脚本测试
#
# 验证 ADR-0007 要求：
#   1. backup.sh 生成正确的 manifest
#   2. rotate.sh 正确执行保留轮换
#   3. restore.sh 安全检查拒绝生产主机/库名
#   4. manifest.schema.json 校验通过
#
# 用法：bash backup-scripts.test.sh

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR"
TEMP_DIR=$(mktemp -d)
PASS=0
FAIL=0

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

log() { echo "[test] $*"; }
pass() { log "PASS: $1"; PASS=$((PASS + 1)); }
fail() { log "FAIL: $1"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name (expected=$expected)"
  else
    fail "$name (expected=$expected, actual=$actual)"
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$name"
  else
    fail "$name (missing: $needle)"
  fi
}

# 安全调用外部脚本（不会因 set -e 退出）
run_script() {
  "$@" 2>&1 || true
}

# ─── 测试 1: manifest.schema.json 有效性 ───────────────────────────────

log "测试 1: manifest.schema.json 有效性"

if python3 -c "import json; json.load(open('$BACKUP_DIR/manifest.schema.json'))" 2>/dev/null; then
  pass "manifest.schema.json 是有效 JSON"
else
  fail "manifest.schema.json 不是有效 JSON"
fi

SCHEMA_REQUIRED=$(python3 -c "
import json
with open('$BACKUP_DIR/manifest.schema.json') as f:
    schema = json.load(f)
required = schema.get('required', [])
print(' '.join(required))
" 2>/dev/null || echo "")

for field in backupId sourceRelease sourceCommit sourceMigration startedAt completedAt sizeBytes sha256 objectKey verificationStatus format; do
  assert_contains "schema 包含 $field" "$SCHEMA_REQUIRED" "$field"
done

# ─── 测试 2: backup.sh 参数校验 ─────────────────────────────────────────

log ""
log "测试 2: backup.sh 参数校验"

OUTPUT=$(run_script bash "$BACKUP_DIR/backup.sh" --ci-mode)
if echo "$OUTPUT" | grep -q "必需参数"; then
  pass "backup.sh 缺少参数时提示必需参数"
else
  fail "backup.sh 缺少参数时未提示必需参数"
fi

# 生成测试用 manifest
MOCK_BACKUP_ID="20260719T120000-a1b2c3d4"
MOCK_MANIFEST_DIR="$TEMP_DIR/manifests"
mkdir -p "$MOCK_MANIFEST_DIR"

cat > "$MOCK_MANIFEST_DIR/${MOCK_BACKUP_ID}.manifest.json" <<EOF
{
  "backupId": "$MOCK_BACKUP_ID",
  "sourceRelease": "0.5.0-test",
  "sourceCommit": "abc1234",
  "sourceMigration": "0021",
  "startedAt": "2026-07-19T12:00:00Z",
  "completedAt": "2026-07-19T12:01:00Z",
  "sizeBytes": 1024,
  "encryptedSizeBytes": 2048,
  "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
  "encryptedSha256": "b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef1234567",
  "objectKey": "${MOCK_BACKUP_ID}.dump.age",
  "verificationStatus": "pending",
  "verifiedAt": null,
  "format": "custom",
  "retentionClass": "daily"
}
EOF

# 验证 manifest 包含所有必需字段
python3 -c "
import json
with open('$MOCK_MANIFEST_DIR/${MOCK_BACKUP_ID}.manifest.json') as f:
    data = json.load(f)
required = ['backupId', 'sourceRelease', 'sourceCommit', 'sourceMigration', 'startedAt', 'completedAt', 'sizeBytes', 'sha256', 'objectKey', 'verificationStatus', 'format']
for field in required:
    assert field in data, f'Missing field: {field}'
print('valid')
" 2>/dev/null && pass "manifest 包含所有必需字段" || fail "manifest 缺少必需字段"

# ─── 测试 3: rotate.sh 保留轮换逻辑 ─────────────────────────────────────

log ""
log "测试 3: rotate.sh 保留轮换"

# 创建 20 个 daily manifest（超过默认保留 14）
# 清理测试 2 的残留 manifest
rm -f "$MOCK_MANIFEST_DIR"/*.manifest.json
for i in $(seq -w 1 20); do
  TS="202607${i:0:2}T120000-$(printf '%08x' $((10#$i)))"
  cat > "$MOCK_MANIFEST_DIR/${TS}.manifest.json" <<EOF
{
  "backupId": "$TS",
  "sourceRelease": "0.5.0-test",
  "sourceCommit": "abc1234",
  "sourceMigration": "0021",
  "startedAt": "2026-07-${i:0:2}T12:00:00Z",
  "completedAt": "2026-07-${i:0:2}T12:01:00Z",
  "sizeBytes": 1024,
  "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
  "objectKey": "${TS}.dump.age",
  "verificationStatus": "verified",
  "format": "custom",
  "retentionClass": "daily"
}
EOF
done

# 运行 rotate.sh dry-run
ROTATE_OUTPUT=$(run_script bash "$BACKUP_DIR/rotate.sh" \
  --manifest-dir "$MOCK_MANIFEST_DIR" \
  --ci-mode \
  --dry-run)
assert_contains "rotate.sh 标记超期备份" "$ROTATE_OUTPUT" "需要删除"

# 运行实际轮换
run_script bash "$BACKUP_DIR/rotate.sh" \
  --manifest-dir "$MOCK_MANIFEST_DIR" \
  --ci-mode > /dev/null

# 验证剩余 manifest 数量
REMAINING=$(find "$MOCK_MANIFEST_DIR" -name '*.manifest.json' | wc -l | tr -d ' ')
assert_eq "轮换后剩余 14 个 daily 备份" "14" "$REMAINING"

# ─── 测试 4: rotate.sh 不删除未验证备份 ─────────────────────────────────

log ""
log "测试 4: rotate.sh 不删除未验证备份"

MOCK_DIR2="$TEMP_DIR/unverified"
mkdir -p "$MOCK_DIR2"

for i in $(seq -w 1 20); do
  TS="202607${i:0:2}T130000-$(printf '%08x' $((10#$i)))"
  STATUS="verified"
  if [[ "$i" == "01" || "$i" == "02" ]]; then
    STATUS="pending"
  fi
  cat > "$MOCK_DIR2/${TS}.manifest.json" <<EOF
{
  "backupId": "$TS",
  "sourceRelease": "0.5.0-test",
  "sourceCommit": "abc1234",
  "sourceMigration": "0021",
  "startedAt": "2026-07-${i:0:2}T13:00:00Z",
  "completedAt": "2026-07-${i:0:2}T13:01:00Z",
  "sizeBytes": 1024,
  "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
  "objectKey": "${TS}.dump.age",
  "verificationStatus": "$STATUS",
  "format": "custom",
  "retentionClass": "daily"
}
EOF
done

run_script bash "$BACKUP_DIR/rotate.sh" \
  --manifest-dir "$MOCK_DIR2" \
  --ci-mode > /dev/null

REMAINING2=$(find "$MOCK_DIR2" -name '*.manifest.json' | wc -l | tr -d ' ')
# 20 个中，2 个是 pending（不会被删除），18 个 verified 中删除 4 个（18-14=4）
# 剩余：2 pending + 14 verified = 16
assert_eq "未验证备份不被删除" "16" "$REMAINING2"

# ─── 测试 5: restore.sh 安全检查拒绝生产主机 ────────────────────────────

log ""
log "测试 5: restore.sh 安全检查"

# 测试拒绝生产主机名
RESTORE_OUTPUT=$(run_script bash "$BACKUP_DIR/restore.sh" \
  --backup-id "test" \
  --target-host "production-db.example.com" \
  --target-user "study" \
  --target-db "study_restore" \
  --manifest-dir "$MOCK_MANIFEST_DIR" \
  --ci-mode)

assert_contains "restore.sh 拒绝生产主机" "$RESTORE_OUTPUT" "不在 allowlist"

# 测试拒绝生产数据库名
RESTORE_OUTPUT2=$(run_script bash "$BACKUP_DIR/restore.sh" \
  --backup-id "test" \
  --target-host "localhost" \
  --target-user "study" \
  --target-db "study" \
  --manifest-dir "$MOCK_MANIFEST_DIR" \
  --ci-mode)

assert_contains "restore.sh 拒绝生产库名" "$RESTORE_OUTPUT2" "禁止的生产库名"

# 测试允许隔离环境主机
RESTORE_OUTPUT3=$(run_script bash "$BACKUP_DIR/restore.sh" \
  --backup-id "test" \
  --target-host "restore-db.local" \
  --target-user "study_restore" \
  --target-db "study_restore" \
  --manifest-dir "$MOCK_MANIFEST_DIR" \
  --ci-mode)

assert_contains "restore.sh 允许隔离主机" "$RESTORE_OUTPUT3" "安全检查通过"

# ─── 测试 6: restore.sh --force 跳过确认 ───────────────────────────────

log ""
log "测试 6: restore.sh --force"

RESTORE_OUTPUT4=$(run_script bash "$BACKUP_DIR/restore.sh" \
  --backup-id "test" \
  --target-host "ci-restore-db" \
  --target-user "study_restore" \
  --target-db "study_restore" \
  --manifest-dir "$MOCK_MANIFEST_DIR" \
  --ci-mode \
  --force)

assert_contains "restore.sh --force 跳过确认" "$RESTORE_OUTPUT4" "manifest 文件不存在"

# ─── 测试 7: freshness-check.sh 新鲜度正常 ─────────────────────────

log ""
log "测试 7: freshness-check.sh 新鲜度正常"

FRESH_DIR="$TEMP_DIR/freshness-ok"
mkdir -p "$FRESH_DIR"

# 创建一个 2 小时前的已验证备份
cat > "$FRESH_DIR/20260720T100000-aaaabbbb.manifest.json" <<EOF
{
  "backupId": "20260720T100000-aaaabbbb",
  "sourceRelease": "0.5.0-test",
  "sourceCommit": "abc1234",
  "sourceMigration": "0023",
  "startedAt": "2026-07-20T10:00:00Z",
  "completedAt": "2026-07-20T10:01:00Z",
  "sizeBytes": 1024,
  "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
  "objectKey": "20260720T100000-aaaabbbb.dump.age",
  "verificationStatus": "verified",
  "verifiedAt": "2026-07-20T10:05:00Z",
  "format": "custom",
  "retentionClass": "daily"
}
EOF

FRESH_OUTPUT=$(bash "$BACKUP_DIR/freshness-check.sh" \
  --manifest-dir "$FRESH_DIR" \
  --ci-mode \
  --now "2026-07-20T12:00:00Z" 2>&1) && FRESH_EXIT=0 || FRESH_EXIT=$?
assert_eq "freshness 正常时退出码为 0" "0" "$FRESH_EXIT"
assert_contains "freshness 正常时输出 ok" "$FRESH_OUTPUT" "backup_freshness_status=ok"

# ─── 测试 8: freshness-check.sh 备份过期 ─────────────────────────────

log ""
log "测试 8: freshness-check.sh 备份过期"

STALE_DIR="$TEMP_DIR/freshness-stale"
mkdir -p "$STALE_DIR"

# 创建一个 48 小时前的已验证备份（超过 24h 阈值）
cat > "$STALE_DIR/20260718T120000-ccccdddd.manifest.json" <<EOF
{
  "backupId": "20260718T120000-ccccdddd",
  "sourceRelease": "0.5.0-test",
  "sourceCommit": "abc1234",
  "sourceMigration": "0023",
  "startedAt": "2026-07-18T12:00:00Z",
  "completedAt": "2026-07-18T12:01:00Z",
  "sizeBytes": 1024,
  "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
  "objectKey": "20260718T120000-ccccdddd.dump.age",
  "verificationStatus": "verified",
  "verifiedAt": "2026-07-18T12:05:00Z",
  "format": "custom",
  "retentionClass": "daily"
}
EOF

STALE_OUTPUT=$(bash "$BACKUP_DIR/freshness-check.sh" \
  --manifest-dir "$STALE_DIR" \
  --ci-mode \
  --now "2026-07-20T12:00:00Z" 2>&1) && STALE_EXIT=0 || STALE_EXIT=$?
assert_eq "freshness 过期时退出码为 1" "1" "$STALE_EXIT"
assert_contains "freshness 过期时输出 warning" "$STALE_OUTPUT" "backup_freshness_status=warning"
assert_contains "freshness 过期时输出 stale" "$STALE_OUTPUT" "backup_freshness_reason=stale"

# ─── 测试 9: freshness-check.sh 无已验证备份 ─────────────────────────

log ""
log "测试 9: freshness-check.sh 无已验证备份"

NO_VERIFIED_DIR="$TEMP_DIR/freshness-no-verified"
mkdir -p "$NO_VERIFIED_DIR"

# 创建一个 pending 备份（未验证）
cat > "$NO_VERIFIED_DIR/20260720T100000-eeeeffff.manifest.json" <<EOF
{
  "backupId": "20260720T100000-eeeeffff",
  "sourceRelease": "0.5.0-test",
  "sourceCommit": "abc1234",
  "sourceMigration": "0023",
  "startedAt": "2026-07-20T10:00:00Z",
  "completedAt": "2026-07-20T10:01:00Z",
  "sizeBytes": 1024,
  "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
  "objectKey": "20260720T100000-eeeeffff.dump.age",
  "verificationStatus": "pending",
  "verifiedAt": null,
  "format": "custom",
  "retentionClass": "daily"
}
EOF

NO_VERIFIED_OUTPUT=$(bash "$BACKUP_DIR/freshness-check.sh" \
  --manifest-dir "$NO_VERIFIED_DIR" \
  --ci-mode \
  --now "2026-07-20T12:00:00Z" 2>&1) && NO_VERIFIED_EXIT=0 || NO_VERIFIED_EXIT=$?
assert_eq "无已验证备份时退出码为 1" "1" "$NO_VERIFIED_EXIT"
assert_contains "无已验证备份时输出 critical" "$NO_VERIFIED_OUTPUT" "backup_freshness_status=critical"
assert_contains "无已验证备份时输出 no_verified" "$NO_VERIFIED_OUTPUT" "backup_freshness_reason=no_verified_backup"

# ─── 测试 10: freshness-check.sh 空目录告警 ──────────────────────────

log ""
log "测试 10: freshness-check.sh 空目录告警"

EMPTY_DIR="$TEMP_DIR/freshness-empty"
mkdir -p "$EMPTY_DIR"

EMPTY_OUTPUT=$(bash "$BACKUP_DIR/freshness-check.sh" \
  --manifest-dir "$EMPTY_DIR" \
  --ci-mode \
  --now "2026-07-20T12:00:00Z" 2>&1) && EMPTY_EXIT=0 || EMPTY_EXIT=$?
assert_eq "空目录时退出码为 1" "1" "$EMPTY_EXIT"
assert_contains "空目录时输出 critical" "$EMPTY_OUTPUT" "backup_freshness_status=critical"
assert_contains "空目录时输出 no_backups" "$EMPTY_OUTPUT" "backup_freshness_reason=no_backups"

# ─── 测试 11: freshness-check.sh 自定义阈值 ──────────────────────────

log ""
log "测试 11: freshness-check.sh 自定义阈值"

# 使用测试 7 的数据（2 小时前），但设置阈值为 1 小时
CUSTOM_OUTPUT=$(bash "$BACKUP_DIR/freshness-check.sh" \
  --manifest-dir "$FRESH_DIR" \
  --max-age-hours 1 \
  --ci-mode \
  --now "2026-07-20T12:00:00Z" 2>&1) && CUSTOM_EXIT=0 || CUSTOM_EXIT=$?
assert_eq "自定义阈值过期时退出码为 1" "1" "$CUSTOM_EXIT"
assert_contains "自定义阈值过期时输出 warning" "$CUSTOM_OUTPUT" "backup_freshness_status=warning"

# ─── 测试 12: freshness-check.sh 跳过未验证选择最近的已验证 ─────────

log ""
log "测试 12: freshness-check.sh 跳过未验证选择最近的已验证"

MIXED_DIR="$TEMP_DIR/freshness-mixed"
mkdir -p "$MIXED_DIR"

# pending（最近但未验证）
cat > "$MIXED_DIR/20260720T110000-11111111.manifest.json" <<EOF
{
  "backupId": "20260720T110000-11111111",
  "sourceRelease": "0.5.0-test",
  "sourceCommit": "abc1234",
  "sourceMigration": "0023",
  "startedAt": "2026-07-20T11:00:00Z",
  "completedAt": "2026-07-20T11:01:00Z",
  "sizeBytes": 1024,
  "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
  "objectKey": "20260720T110000-11111111.dump.age",
  "verificationStatus": "pending",
  "verifiedAt": null,
  "format": "custom",
  "retentionClass": "daily"
}
EOF

# verified（较早但已验证）
cat > "$MIXED_DIR/20260720T100000-22222222.manifest.json" <<EOF
{
  "backupId": "20260720T100000-22222222",
  "sourceRelease": "0.5.0-test",
  "sourceCommit": "abc1234",
  "sourceMigration": "0023",
  "startedAt": "2026-07-20T10:00:00Z",
  "completedAt": "2026-07-20T10:01:00Z",
  "sizeBytes": 1024,
  "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
  "objectKey": "20260720T100000-22222222.dump.age",
  "verificationStatus": "verified",
  "verifiedAt": "2026-07-20T10:05:00Z",
  "format": "custom",
  "retentionClass": "daily"
}
EOF

MIXED_OUTPUT=$(bash "$BACKUP_DIR/freshness-check.sh" \
  --manifest-dir "$MIXED_DIR" \
  --ci-mode \
  --now "2026-07-20T12:00:00Z" 2>&1) && MIXED_EXIT=0 || MIXED_EXIT=$?
assert_eq "混合目录正常时退出码为 0" "0" "$MIXED_EXIT"
assert_contains "混合目录选择已验证备份" "$MIXED_OUTPUT" "backup_freshness_status=ok"

# ─── 测试 13: alpha-backup-cron.sh 缺少配置文件 ─────────────────────────

log ""
log "测试 13: alpha-backup-cron.sh 缺少配置文件"

CRON_OUTPUT=$(BACKUP_CONFIG_FILE="/nonexistent/backup.env" \
  run_script bash "$BACKUP_DIR/alpha-backup-cron.sh")
assert_contains "alpha-backup-cron.sh 报告配置文件不存在" "$CRON_OUTPUT" "配置文件不存在"

# ─── 测试 14: alpha-cron-setup.sh 参数校验 ──────────────────────────────

log ""
log "测试 14: alpha-cron-setup.sh 参数校验"

SETUP_OUTPUT=$(run_script bash "$BACKUP_DIR/alpha-cron-setup.sh")
assert_contains "alpha-cron-setup.sh 缺少参数时提示" "$SETUP_OUTPUT" "缺少必需参数"

# ─── 测试 15: rc-restore-verify.sh 参数校验 ─────────────────────────────

log ""
log "测试 15: rc-restore-verify.sh 参数校验"

RESTORE_VERIFY_OUTPUT=$(run_script bash "$BACKUP_DIR/rc-restore-verify.sh")
assert_contains "rc-restore-verify.sh 缺少参数时提示" "$RESTORE_VERIFY_OUTPUT" "必需"

# ─── 测试 16: rc-restore-verify.sh 安全检查拒绝生产主机 ─────────────────

log ""
log "测试 16: rc-restore-verify.sh 安全检查"

RC_SECURITY_OUTPUT=$(run_script bash "$BACKUP_DIR/rc-restore-verify.sh" \
  --source-host localhost --source-user study --source-db study \
  --target-host "production-db.example.com" \
  --target-user study_restore --target-db study_restore \
  --ci-mode --release test --commit abc --migration 0028 \
  --report-dir "$TEMP_DIR/rc-reports" --force)
assert_contains "rc-restore-verify.sh 拒绝生产主机" "$RC_SECURITY_OUTPUT" "不在 allowlist"

# ─── 测试 17: rc-restore-verify.sh 安全检查拒绝生产库名 ─────────────────

log ""
log "测试 17: rc-restore-verify.sh 拒绝生产库名"

RC_DB_OUTPUT=$(run_script bash "$BACKUP_DIR/rc-restore-verify.sh" \
  --source-host localhost --source-user study --source-db study \
  --target-host localhost \
  --target-user study --target-db ailearn \
  --ci-mode --release test --commit abc --migration 0028 \
  --report-dir "$TEMP_DIR/rc-reports" --force)
assert_contains "rc-restore-verify.sh 拒绝生产库名" "$RC_DB_OUTPUT" "禁止的生产库名"

# ─── 测试 18: rc-restore-verify.sh 非 CI 模式要求 age-key ───────────────

log ""
log "测试 18: rc-restore-verify.sh 非 CI 模式要求 age-key"

RC_AGE_OUTPUT=$(run_script bash "$BACKUP_DIR/rc-restore-verify.sh" \
  --source-host localhost --source-user study --source-db study \
  --target-host localhost \
  --target-user study --target-db study_restore \
  --release test --commit abc --migration 0028 \
  --report-dir "$TEMP_DIR/rc-reports" --force \
  --s3-endpoint http://minio:9000 --s3-bucket test \
  --s3-access-key X --s3-secret-key Y)
assert_contains "rc-restore-verify.sh 非 CI 模式要求 age-key" "$RC_AGE_OUTPUT" "age-key"

# ─── 测试 19: setup-backup-infrastructure.sh 参数校验 ────────────────────

log ""
log "测试 19: setup-backup-infrastructure.sh 参数校验"

# --keys-only 模式需要 key-dir，但不需要 S3 参数
SETUP_KEYS_OUTPUT=$(run_script bash "$BACKUP_DIR/setup-backup-infrastructure.sh" \
  --keys-only --key-dir "$TEMP_DIR/test-keys")
# 应该执行到 age 检查（age 可能未安装，但不应因参数缺失退出）
if echo "$SETUP_KEYS_OUTPUT" | grep -q "age 命令未安装"; then
  pass "setup-backup-infrastructure.sh --keys-only 检查 age 依赖"
else
  # 如果 age 已安装，检查密钥是否生成
  if [[ -f "$TEMP_DIR/test-keys/backup-age.pub" ]]; then
    pass "setup-backup-infrastructure.sh --keys-only 生成密钥对"
    # 验证权限
    PUB_PERMS=$(stat -f%Lp "$TEMP_DIR/test-keys/backup-age.pub" 2>/dev/null || stat -c%a "$TEMP_DIR/test-keys/backup-age.pub" 2>/dev/null)
    assert_contains "公钥权限为 644" "$PUB_PERMS" "644"
  else
    fail "setup-backup-infrastructure.sh --keys-only 未生成密钥"
  fi
fi

# ─── 测试 20: setup-backup-infrastructure.sh --bucket-only 参数校验 ──────

log ""
log "测试 20: setup-backup-infrastructure.sh --bucket-only 参数校验"

SETUP_BUCKET_OUTPUT=$(run_script bash "$BACKUP_DIR/setup-backup-infrastructure.sh" \
  --bucket-only)
# --bucket-only 没有提供 S3 参数应报错
assert_contains "setup-backup-infrastructure.sh --bucket-only 缺少 S3 参数" "$SETUP_BUCKET_OUTPUT" "S3 参数"

# ─── 测试 21: alpha-backup-cron.sh 配置文件缺少必需变量 ─────────────────

log ""
log "测试 21: alpha-backup-cron.sh 配置文件缺少必需变量"

INCOMPLETE_CONFIG="$TEMP_DIR/incomplete-backup.env"
cat > "$INCOMPLETE_CONFIG" <<EOF
PG_HOST=localhost
# 缺少其他必需变量
EOF

CRON_OUTPUT2=$(BACKUP_CONFIG_FILE="$INCOMPLETE_CONFIG" \
  BACKUP_LOG_DIR="$TEMP_DIR" \
  run_script bash "$BACKUP_DIR/alpha-backup-cron.sh")
assert_contains "alpha-backup-cron.sh 报告缺少变量" "$CRON_OUTPUT2" "缺少必需变量"

# ─── 测试 22: alpha-backup-cron.sh 后续步骤失败保持非零 ────────────────

log ""
log "测试 22: alpha-backup-cron.sh 后续步骤失败保持非零"

CRON_SANDBOX="$TEMP_DIR/cron-sandbox"
CRON_MANIFEST_DIR="$TEMP_DIR/cron-manifests"
CRON_CONFIG="$TEMP_DIR/cron-backup.env"
mkdir -p "$CRON_SANDBOX" "$CRON_MANIFEST_DIR"
cp "$BACKUP_DIR/alpha-backup-cron.sh" "$CRON_SANDBOX/alpha-backup-cron.sh"

cat > "$CRON_SANDBOX/backup.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${CRON_BACKUP_EXIT:-0}" != "0" ]]; then
  exit "$CRON_BACKUP_EXIT"
fi
manifest_dir=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--manifest-dir" ]]; then
    manifest_dir="$2"
    shift 2
  else
    shift
  fi
done
mkdir -p "$manifest_dir"
manifest="$manifest_dir/mock.manifest.json"
printf '{"backupId":"mock"}\n' > "$manifest"
printf '%s\n' "$manifest"
EOF
cat > "$CRON_SANDBOX/rotate.sh" <<'EOF'
#!/usr/bin/env bash
exit "${CRON_ROTATE_EXIT:-0}"
EOF
cat > "$CRON_SANDBOX/freshness-check.sh" <<'EOF'
#!/usr/bin/env bash
exit "${CRON_FRESHNESS_EXIT:-0}"
EOF

cat > "$CRON_CONFIG" <<EOF
PG_HOST=localhost
PG_USER=ailearn_migrator
PG_DB=ailearn
SOURCE_RELEASE=0.5.0-test
SOURCE_COMMIT=abc1234
SOURCE_MIGRATION=0038
AGE_KEY_PATH=$TEMP_DIR/backup-age.pub
S3_ENDPOINT=http://minio:9000
S3_BUCKET=ailearn-backups
S3_ACCESS_KEY=test-access
S3_SECRET_KEY=test-secret
MANIFEST_DIR=$CRON_MANIFEST_DIR
EOF

set +e
CRON_BACKUP_OUTPUT=$(CRON_BACKUP_EXIT=1 \
  BACKUP_CONFIG_FILE="$CRON_CONFIG" \
  BACKUP_LOG_DIR="$TEMP_DIR/cron-logs-backup" \
  bash "$CRON_SANDBOX/alpha-backup-cron.sh" 2>&1)
CRON_BACKUP_STATUS=$?
CRON_ROTATE_OUTPUT=$(CRON_ROTATE_EXIT=1 \
  BACKUP_CONFIG_FILE="$CRON_CONFIG" \
  BACKUP_LOG_DIR="$TEMP_DIR/cron-logs-rotate" \
  bash "$CRON_SANDBOX/alpha-backup-cron.sh" 2>&1)
CRON_ROTATE_STATUS=$?
CRON_FRESHNESS_OUTPUT=$(CRON_FRESHNESS_EXIT=1 \
  BACKUP_CONFIG_FILE="$CRON_CONFIG" \
  BACKUP_LOG_DIR="$TEMP_DIR/cron-logs-freshness" \
  bash "$CRON_SANDBOX/alpha-backup-cron.sh" 2>&1)
CRON_FRESHNESS_STATUS=$?
CRON_SUCCESS_OUTPUT=$(BACKUP_CONFIG_FILE="$CRON_CONFIG" \
  BACKUP_LOG_DIR="$TEMP_DIR/cron-logs-success" \
  bash "$CRON_SANDBOX/alpha-backup-cron.sh" 2>&1)
CRON_SUCCESS_STATUS=$?
set -e

assert_eq "alpha-backup-cron.sh 备份失败退出码" "1" "$CRON_BACKUP_STATUS"
assert_contains "alpha-backup-cron.sh 备份失败告警" "$CRON_BACKUP_OUTPUT" "备份失败"
assert_eq "alpha-backup-cron.sh 轮换失败退出码" "2" "$CRON_ROTATE_STATUS"
assert_contains "alpha-backup-cron.sh 轮换失败告警" "$CRON_ROTATE_OUTPUT" "保留轮换失败"
assert_eq "alpha-backup-cron.sh 新鲜度失败退出码" "3" "$CRON_FRESHNESS_STATUS"
assert_contains "alpha-backup-cron.sh 新鲜度失败告警" "$CRON_FRESHNESS_OUTPUT" "新鲜度检查失败"
assert_eq "alpha-backup-cron.sh 全成功退出码" "0" "$CRON_SUCCESS_STATUS"
assert_contains "alpha-backup-cron.sh 全成功完成日志" "$CRON_SUCCESS_OUTPUT" "Alpha 备份 cron 完成"

# ─── 总结 ───────────────────────────────────────────────────────────────

log ""
log "========================================="
log "  测试结果: $PASS 通过, $FAIL 失败"
log "========================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
