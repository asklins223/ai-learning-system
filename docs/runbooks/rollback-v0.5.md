# 回滚 Runbook：v0.5 Alpha

> 版本：1.0<br>
> 创建日期：2026-07-20<br>
> Owner：repository owner / platform Owner<br>
> 关联：ADR-0001、ADR-0007；`docs/plans/AI学习系统-v0.5-版本实施计划-2026-07-18.md` §6.8 REL-01

## 1. 目的

定义 v0.5 Alpha 环境从异常状态安全回滚到上一个已知良好版本的完整步骤。
回滚必须覆盖四个层面：

1. **应用回滚**：API、Web、Worker 镜像回到上一版本
2. **迁移兼容**：数据库 schema 前向兼容，不做破坏性 down migration
3. **Worker drain**：安全排空在途任务，避免数据不一致
4. **数据恢复**：从加密备份恢复到一致状态（仅在数据损坏时）

## 2. 触发条件

满足以下任一条件时启动回滚流程：

| 条件 | 紧急程度 | 回滚范围 |
| --- | --- | --- |
| 跨 workspace 数据泄漏 | P0 — 立即 | 全量回滚 + 数据恢复 |
| 不可恢复数据丢失 | P0 — 立即 | 全量回滚 + 数据恢复 |
| API 5xx 持续 > 5% 超过 30 分钟 | P1 — 评估 | 应用回滚 |
| 队列积压 > 30 分钟无法自愈 | P1 — 评估 | Worker 回滚 |
| 连续两次相同 P1 故障复现 | P1 — 评估 | 应用回滚 |
| 安全不变量告警 | P0 — 立即 | 全量回滚 + 安全审计 |

## 3. 前置条件

- 已知上一良好版本的 Docker 镜像 digest（从 release manifest 获取）
- 最近一次验证通过的加密备份（manifest 目录中有 `verified: true` 标记）
- Alpha 环境的 `docker-compose.yml` 和 `docker-compose.dev.yml` 可访问
- `age` 解密密钥可用
- 独立 S3 bucket / MinIO 存储可访问

## 4. 回滚步骤

### 阶段 1：决策与通知（≤ 5 分钟）

```bash
# 1. 确认触发条件并决定回滚范围
# 记录：触发原因、回滚目标版本、决策时间、决策人

# 2. 通知 Alpha 用户（如适用）
#    通过状态页或直接通知告知 "正在进行紧急维护"
```

### 阶段 2：Worker Drain（≤ 10 分钟）

在停止 Worker 之前，必须安全排空在途任务，避免：
- 事务半提交导致数据不一致
- lease 过期后旧 Handler 返回导致重复副作用

```bash
# 1. 停止接收新任务：将 Worker 的轮询间隔设为极大值或停止队列消费
#    但不立即杀死进程，让在途任务完成
docker compose exec worker sh -c 'kill -SIGUSR1 1'  # 触发 graceful drain

# 2. 等待在途任务完成（最多 5 分钟）
#    检查 jobs 表中 status='running' 的数量
docker compose exec postgres psql -U ailearn -d ailearn -c \
  "SELECT count(*) FROM jobs WHERE status = 'running'"

# 3. 如果 5 分钟后仍有 running 任务，记录 job ID 并强制停止 Worker
#    这些任务会在回滚后由 lease 过期机制重新入队
docker compose stop worker

# 4. 清理可能残留的 lease（将过期 lease 的 job 重新标记为 pending）
#    注意：此操作使用 migrator 角色执行，Worker 无直接 UPDATE 权限
docker compose exec postgres psql -U ailearn_migrator -d ailearn -c \
  "UPDATE jobs SET status = 'pending', lease_token = NULL, lease_expires_at = NULL
   WHERE status = 'running' AND lease_expires_at < NOW()"
```

### 阶段 3：应用镜像回滚（≤ 10 分钟）

```bash
# 1. 获取上一良好版本的镜像 digest
#    从 release manifest 或 CI artifact 获取
PREV_API_DIGEST="sha256:<从上一 release manifest 获取>"
PREV_WEB_DIGEST="sha256:<从上一 release manifest 获取>"
PREV_WORKER_DIGEST="sha256:<从上一 release manifest 获取>"

# 2. 拉取上一版本的镜像（如果本地没有缓存）
#    对于 ghcr.io 镜像：
docker pull ghcr.io/asklins223/ailearn/api@$PREV_API_DIGEST
docker pull ghcr.io/asklins223/ailearn/web@$PREV_WEB_DIGEST
docker pull ghcr.io/asklins223/ailearn/worker@$PREV_WORKER_DIGEST

# 3. 更新 docker-compose.yml 中的镜像引用为上一版本 digest
#    或使用环境变量覆盖：
export API_IMAGE="ghcr.io/asklins223/ailearn/api@$PREV_API_DIGEST"
export WEB_IMAGE="ghcr.io/asklins223/ailearn/web@$PREV_WEB_DIGEST"
export WORKER_IMAGE="ghcr.io/asklins223/ailearn/worker@$PREV_WORKER_DIGEST"

# 4. 停止当前服务
docker compose stop api web

# 5. 使用上一版本镜像重启
docker compose up -d --no-build api web worker

# 6. 验证服务健康
curl --fail --retry 30 --retry-delay 2 --retry-all-errors \
  http://127.0.0.1:4000/ready
curl --fail --retry 30 --retry-delay 2 --retry-all-errors \
  http://127.0.0.1:3000/
```

### 阶段 4：迁移兼容性检查（≤ 5 分钟）

v0.5 采用前向兼容迁移策略，**不做破坏性 down migration**。

```bash
# 1. 检查当前迁移版本
docker compose exec postgres psql -U ailearn -d ailearn -c \
  "SELECT count(*) FROM drizzle.__drizzle_migrations"

# 2. 如果回滚目标版本的迁移末端 < 当前迁移末端：
#    - 不需要 down migration
#    - 新增的列/表为 nullable 或有默认值，旧版本应用会忽略它们
#    - 新增的 policy/RLS 状态不影响旧版本应用（旧版本在 RLS 关闭模式下运行）

# 3. 如果回滚涉及 SEC-01 RLS 状态变化：
#    - 旧版本应用不设置 app.workspace_id 上下文
#    - 如果 RLS 已 ENABLE+FORCE，旧版本 API 会收到 42501 错误
#    - 此时需要临时禁用 RLS（仅限紧急回滚）：
docker compose exec postgres psql -U ailearn_migrator -d ailearn -c \
  "ALTER TABLE workspaces DISABLE ROW LEVEL SECURITY;
   ALTER TABLE sources DISABLE ROW LEVEL SECURITY;
   ALTER TABLE notes DISABLE ROW LEVEL SECURITY;
   -- ... 其他表（参见 0024_sec01_rls_enforce.sql 反向操作）"

#    注意：禁用 RLS 是临时措施，必须在修复后重新启用
#    记录此操作为安全例外事件
```

### 阶段 5：数据恢复（仅在数据损坏时，≤ 2 小时 RTO）

```bash
# 1. 确认需要恢复的备份
#    查找最近一次 verified=true 的备份 manifest
ls -la /backups/manifests/ | tail -5

# 2. 停止所有写入服务
docker compose stop api worker

# 3. 使用 restore.sh 恢复备份
#    restore.sh 会执行：age 解密 → SHA-256 校验 → pg_restore → 权限重放 → 完整性验证
BACKUP_FILE="/backups/encrypted/ailearn-2026-07-20-120000.sql.age"
RESTORE_DB="ailearn_restore"

bash infra/backup/restore.sh \
  --backup "$BACKUP_FILE" \
  --target-db "$RESTORE_DB" \
  --host localhost \
  --allow-db "$RESTORE_DB"

# 4. 验证恢复结果
#    restore.sh 会自动检查迁移数、核心表行数和 API readiness

# 5. 切换到恢复后的数据库
#    更新 docker-compose.yml 的 DATABASE_URL 指向恢复的数据库
#    或重命名数据库：
docker compose exec postgres psql -U ailearn -c "ALTER DATABASE ailearn RENAME TO ailearn_broken"
docker compose exec postgres psql -U ailearn -c "ALTER DATABASE $RESTORE_DB RENAME TO ailearn"

# 6. 重启服务
docker compose up -d api worker

# 7. 验证 API readiness 和核心功能
curl --fail http://127.0.0.1:4000/ready
```

### 阶段 6：验证与通知（≤ 10 分钟）

```bash
# 1. 验证 API 健康
curl -sf http://127.0.0.1:4000/ready
curl -sf http://127.0.0.1:4000/health

# 2. 验证 Web 可访问
curl -sf http://127.0.0.1:3000/

# 3. 验证 Worker 正常消费
docker compose logs worker --tail 20

# 4. 验证 metrics 端点
curl -sf http://127.0.0.1:4000/metrics | head -20

# 5. 验证备份新鲜度
bash infra/backup/freshness-check.sh

# 6. 通知 Alpha 用户服务已恢复
```

## 5. 回滚后行动

| 行动 | 负责人 | 时限 |
| --- | --- | --- |
| 记录回滚原因、时间线和影响范围 | platform Owner | 回滚后 1 小时内 |
| 创建事故 Issue 并关联 P0/P1 标签 | 发现者 | 回滚后 1 小时内 |
| 分析根因 | 相关 Owner | 回滚后 24 小时内 |
| 修复根因并重新部署 | 相关 Owner | 视严重程度 |
| 如果禁用了 RLS，重新执行 SEC-01 enforce | Security Owner | 修复后立即 |
| 验证备份完整性 | platform Owner | 回滚后 4 小时内 |
| 通知所有 Alpha 用户回滚原因和影响 | Product Owner | 回滚后 24 小时内 |

## 6. 回滚验证清单

- [ ] API `/ready` 返回 200
- [ ] API `/health` 返回 200
- [ ] Web 首页可加载
- [ ] Worker 正常消费队列任务
- [ ] 跨 workspace 隔离无泄漏（手动验证 1 条记录）
- [ ] 备份新鲜度检查通过（≤ 24 小时）
- [ ] metrics 端点可访问且无 secret 泄漏
- [ ] 日志中无 secret 或学习正文泄漏
- [ ] 回滚原因已记录
- [ ] Alpha 用户已通知

## 7. 紧急联系人

| 角色 | 职责 | 联系方式 |
| --- | --- | --- |
| platform Owner | 基础设施、备份恢复 | （部署时填充） |
| Security Owner | 安全审计、RLS 状态 | （部署时填充） |
| Product Owner | 用户通知、影响评估 | （部署时填充） |

## 8. 演练要求

- 每个 RC 发布前必须执行一次回滚演练
- 演练使用隔离环境，不影响 Alpha 用户
- 演练记录包括：起止时间、步骤完成情况、遇到的问题和改进措施
- 演练结果作为 REL-01 RC 门禁的证据之一

## 9. 注意事项

1. **不做破坏性 down migration**：v0.5 迁移设计为前向兼容，回滚时保留新 schema，旧版本应用忽略新增列/表
2. **Worker drain 优先**：在停止 Worker 前必须等待在途任务完成，否则可能产生半提交事务
3. **RLS 紧急禁用**：仅在旧版本应用因 RLS 无法运行时临时禁用，必须在修复后立即重新启用
4. **数据恢复是最后手段**：仅在数据损坏或丢失时执行，正常回滚不需要恢复备份
5. **记录一切**：所有回滚操作必须有时间戳记录，用于事后分析和 SLO 计算
