# Alpha 环境备份基础设施部署 Runbook

> OPS-01: Alpha 环境 12h 定时加密备份配置指南（ADR-0007）
>
> 维护者：Platform Owner
>
> 最后更新：2026-07-20

## 概览

本文档描述如何在 Alpha 环境中配置 12 小时定时加密备份、独立存储和恢复验证。所有脚本位于 `infra/backup/` 目录。

ADR-0007 要求：
- Alpha 数据库至少每 12 小时自动生成一致性备份
- 备份在传输和静态存储时加密
- 备份保存在与主数据库故障域独立的位置
- 保留最近 14 个 daily + 4 个 weekly 备份
- 备份失败或超过 24 小时无已验证备份必须告警

## 前置条件

### 必需工具

| 工具 | 用途 | 安装方法 |
| --- | --- | --- |
| `pg_dump` / `pg_restore` | PostgreSQL 备份/恢复 | PostgreSQL 客户端包 |
| `age` | 加密/解密 | `brew install age` / `apt-get install age` |
| `aws` CLI 或 `mc` | S3 上传/下载 | AWS CLI 或 MinIO Client |
| `python3` | JSON 解析 | 系统自带 |
| `crontab` | 定时调度 | 系统自带 |

### Alpha 环境要求

1. PostgreSQL 16+ 运行中，migrator 角色已创建
2. S3-compatible 对象存储可用（MinIO 或 AWS S3）
3. 独立的安全域用于存储 age 私钥（不同主机或离线介质）

## 部署步骤

### 步骤 1: 生成 age 密钥对 + 创建 S3 bucket

```bash
# 交互式执行（会提示确认）
sudo ./infra/backup/setup-backup-infrastructure.sh \
  --key-dir /etc/ailearn \
  --key-name backup-age \
  --s3-endpoint http://minio:9000 \
  --s3-bucket ailearn-backups \
  --s3-access-key YOUR_ACCESS_KEY \
  --s3-secret-key YOUR_SECRET_KEY
```

或分步执行：

```bash
# 仅生成 age 密钥对
sudo ./infra/backup/setup-backup-infrastructure.sh \
  --keys-only --key-dir /etc/ailearn

# 仅创建 S3 bucket
./infra/backup/setup-backup-infrastructure.sh \
  --bucket-only \
  --s3-endpoint http://minio:9000 \
  --s3-bucket ailearn-backups \
  --s3-access-key YOUR_ACCESS_KEY \
  --s3-secret-key YOUR_SECRET_KEY
```

**安全要求**：
- 公钥 `/etc/ailearn/backup-age.pub` 可放在备份服务器上（权限 644）
- 私钥 `/etc/ailearn/backup-age.key` 必须权限 600、owner root:root
- **私钥必须复制到独立安全位置**（不同主机或 USB 加密盘）
- 切勿将私钥提交到版本控制系统

### 步骤 2: 安装 cron 调度器

```bash
sudo ./infra/backup/alpha-cron-setup.sh \
  --pg-host localhost \
  --pg-port 5432 \
  --pg-user ailearn_migrator \
  --pg-db ailearn \
  --release 0.5.0-alpha.1 \
  --commit $(git rev-parse --short HEAD) \
  --migration 0028 \
  --age-key /etc/ailearn/backup-age.pub \
  --s3-endpoint http://minio:9000 \
  --s3-bucket ailearn-backups \
  --s3-access-key YOUR_ACCESS_KEY \
  --s3-secret-key YOUR_SECRET_KEY \
  --manifest-dir /data/backups/manifests
```

或交互式模式：

```bash
sudo ./infra/backup/alpha-cron-setup.sh --interactive
```

此脚本会：
1. 生成 `/etc/ailearn/backup.env` 配置文件（权限 600）
2. 安装 cron 条目（每 12 小时执行：`0 */12 * * *`）
3. 验证所需工具已安装
4. 输出安装结果和后续步骤

### 步骤 3: 手动测试首次备份

```bash
# 运行完整的 cron 包装脚本
sudo bash /opt/ailearn/infra/backup/alpha-backup-cron.sh

# 或仅测试备份步骤
sudo ./infra/backup/backup.sh \
  --pg-host localhost --pg-user ailearn_migrator --pg-db ailearn \
  --release 0.5.0-alpha.1 --commit abc1234 --migration 0028 \
  --age-key /etc/ailearn/backup-age.pub \
  --s3-endpoint http://minio:9000 --s3-bucket ailearn-backups \
  --s3-access-key YOUR_ACCESS_KEY --s3-secret-key YOUR_SECRET_KEY \
  --manifest-dir /data/backups/manifests
```

### 步骤 4: 验证备份新鲜度

```bash
./infra/backup/freshness-check.sh \
  --manifest-dir /data/backups/manifests \
  --max-age-hours 24
```

如果最近 24 小时内有已验证备份，退出码为 0；否则退出码为 1（触发告警）。

### 步骤 5: RC 恢复验证

在每次 RC 发布前，执行完整的恢复验证：

```bash
sudo ./infra/backup/rc-restore-verify.sh \
  --source-host localhost \
  --source-user ailearn_migrator \
  --source-db ailearn \
  --target-host restore-db.local \
  --target-user ailearn_restore \
  --target-db ailearn_restore \
  --age-key /etc/ailearn/backup-age.key \
  --s3-endpoint http://minio:9000 \
  --s3-bucket ailearn-backups \
  --s3-access-key YOUR_ACCESS_KEY \
  --s3-secret-key YOUR_SECRET_KEY \
  --release 0.5.0-rc.1 \
  --commit $(git rev-parse --short HEAD) \
  --migration 0028 \
  --report-dir /data/backups/rc-reports \
  --force
```

此脚本会：
1. 从源数据库创建一致性备份
2. 恢复到隔离的恢复数据库（通过安全 allowlist 检查）
3. 验证：迁移版本末端、核心表行数、FK 完整性、RLS 策略、SECURITY DEFINER 函数、角色/权限
4. 可选：检查 API readiness
5. 生成 JSON 恢复报告（含 RTO 计时）
6. 报告中包含 2 小时 RTO 门禁结果

**ADR-0007 DoD 要求**：RC 恢复演练在 2 小时内完成并通过权限/完整性校验。

## 日常运维

### 查看备份日志

```bash
tail -f /var/log/ailearn/backup-cron.log
```

### 查看现有备份

```bash
ls -la /data/backups/manifests/
# 查看最新 manifest
cat $(ls -t /data/backups/manifests/*.manifest.json | head -1) | python3 -m json.tool
```

### 手动触发备份

```bash
sudo bash /opt/ailearn/infra/backup/alpha-backup-cron.sh
```

### 手动触发保留轮换

```bash
./infra/backup/rotate.sh \
  --manifest-dir /data/backups/manifests \
  --s3-endpoint http://minio:9000 \
  --s3-bucket ailearn-backups \
  --s3-access-key YOUR_ACCESS_KEY \
  --s3-secret-key YOUR_SECRET_KEY \
  --dry-run  # 先预览，确认后去掉 --dry-run 执行
```

### 检查备份新鲜度

```bash
./infra/backup/freshness-check.sh \
  --manifest-dir /data/backups/manifests
```

可集成到 Prometheus 告警：如果退出码非 0，触发 `BackupFreshnessAlert`。

## 卸载

```bash
# 移除 cron 条目（保留配置文件）
sudo ./infra/backup/alpha-cron-setup.sh --uninstall

# 手动清理（可选）
sudo rm -f /etc/ailearn/backup.env
sudo rm -rf /data/backups/manifests/
```

## 脚本一览

| 脚本 | 用途 |
| --- | --- |
| `backup.sh` | 执行单次加密备份（pg_dump + SHA-256 + age 加密 + S3 上传） |
| `restore.sh` | 从备份恢复到隔离数据库（安全 allowlist + 解密 + 校验 + 恢复后验证） |
| `rotate.sh` | 保留轮换（14 daily + 4 weekly，只删除已验证备份） |
| `freshness-check.sh` | 备份新鲜度告警检查（24h 阈值） |
| `alpha-backup-cron.sh` | cron 包装脚本（backup → rotate → freshness-check） |
| `alpha-cron-setup.sh` | cron 安装脚本（生成配置 + 安装 crontab + 依赖检查） |
| `setup-backup-infrastructure.sh` | 基础设施初始化（age 密钥对 + S3 bucket 创建） |
| `rc-restore-verify.sh` | RC 恢复验证（备份 → 恢复 → 完整性/权限验证 → JSON 报告） |
| `backup-scripts.test.sh` | 全部脚本的 shell 测试（45 项断言） |

## 故障排查

### 备份失败

1. 检查日志：`tail -50 /var/log/ailearn/backup-cron.log`
2. 验证数据库连接：`psql -h localhost -U ailearn_migrator -d ailearn -c 'SELECT 1'`
3. 验证 S3 连接：`aws s3 ls s3://ailearn-backups --endpoint-url http://minio:9000`
4. 验证 age 公钥：`cat /etc/ailearn/backup-age.pub`
5. 手动重试：`sudo bash alpha-backup-cron.sh`

### 恢复失败

1. 检查目标数据库是否在 allowlist 中（localhost/restore-*/ci-*）
2. 检查目标数据库名不是禁止的生产库名（study/ailearn/production/prod）
3. 验证 age 私钥权限：`ls -la /etc/ailearn/backup-age.key`（应为 600）
4. 验证 S3 中备份文件存在：`aws s3 ls s3://ailearn-backups/`
5. 检查恢复报告：`cat /data/backups/rc-reports/rc-restore-*.json | python3 -m json.tool`

### 新鲜度告警

1. 检查最新 manifest：`ls -lt /data/backups/manifests/`
2. 检查 cron 是否运行：`crontab -l | grep ailearn`
3. 检查 cron 日志：`grep CRON /var/log/syslog | grep ailearn`
4. 手动触发备份并验证
