# SLO 与告警 Runbook

> OPS-01: SLO 告警规则与响应流程（ADR-0006 §2）
>
> 维护者：Platform Owner
>
> 最后更新：2026-07-20

## 概览

本文档定义 AI Learning System v0.5 的服务等级目标（SLO）和对应告警的响应流程。所有告警规则部署在 Prometheus 中，通过 Alertmanager 路由到合适的告警渠道。

### SLO 目标（Alpha 阶段）

| 指标 | SLO 目标 | 测量窗口 | 告警阈值 |
| --- | --- | --- | --- |
| HTTP 可用性 | 99.5% | 滚动 5 分钟 | 错误率 > 0.5% (warning) |
| HTTP p95 延迟 | 1 秒 | 滚动 5 分钟 | > 1s (warning) |
| Job 完成率 | 99% | 滚动 10 分钟 | 死信率 > 1% (warning) |
| 最老 pending job | 5 分钟 | 实时 | > 5 分钟 (critical) |
| Provider 错误率 | < 5% | 滚动 5 分钟 | > 5% (warning) |
| 备份新鲜度 | 24 小时 | 实时 | > 24 小时 (critical) |

---

## 告警分类与响应

### Critical 告警（需要立即响应）

#### API 不可用 (`AILearnAPIDown`)

**触发条件**：`ailearn_readiness_status != 1` 持续 1 分钟

**影响范围**：所有用户无法访问 API

**立即响应**：
1. 检查 API 进程是否运行：`docker ps -a | grep api`
2. 查看容器日志：`docker logs ailearn-api-1 --tail 100`
3. 检查数据库连接：`docker exec ailearn-api-1 sh -c "PGDATABASE=$DATABASE_URL psql -c 'SELECT 1'"`
4. 检查内存/CPU 使用：`docker stats ailearn-api-1`

**根本原因分析**：
- 进程崩溃：查看启动日志和错误堆栈
- 数据库不可达：检查 PostgreSQL 状态
- 内存不足：查看 OOM killer 日志
- 健康检查失败：检查依赖服务（Worker、S3）

**恢复操作**：
- 进程崩溃：重启容器 `docker restart ailearn-api-1`
- 数据库问题：按数据库 runbook 处理
- 依赖问题：修复依赖服务后重启

**预防措施**：
- 配置自动重启策略
- 监控进程退出事件
- 增加日志保留时间

---

#### 超时 pending job (`AILearnStalePendingJob`)

**触发条件**：最老的 pending job 等待超过 5 分钟，持续 2 分钟

**影响范围**：用户生成的 AI 任务积压，卡片生成/验证延迟

**立即响应**：
1. 检查 Worker 状态：`docker ps | grep worker`
2. 查看 Worker 日志：`docker logs ailearn-worker-1 --tail 100`
3. 检查 job 队列状态：
   ```bash
   docker exec ailearn-postgres-1 psql -U ailearn_worker -d ailearn \
     -c "SELECT status, COUNT(*) FROM jobs GROUP BY status;"
   ```
4. 检查是否有死锁：`docker exec ailearn-postgres-1 psql -U ailearn_worker -d ailearn -c "SELECT * FROM pg_stat_activity WHERE state = 'idle in transaction';"`

**根本原因分析**：
- Worker 进程挂起/崩溃
- 数据库连接池耗尽
- 事务死锁
- Provider API 超时或返回错误
- Job payload 异常导致 handler 崩溃

**恢复操作**：
- Worker 挂起：重启 Worker `docker restart ailearn-worker-1`
- 连接池问题：增加连接池大小或检查长连接泄漏
- 死锁：杀死死锁事务 `SELECT pg_terminate_backend(pid)`
- Provider 问题：检查 Provider 状态和配额
- 异常 job：查询异常 job 类型，修复或手动标记为 dead

**预防措施**：
- 配置双 Worker（已在 v0.5 计划中）
- 实现健康检查和自动重启
- 监控 Worker 进程资源使用

---

#### Provider 配额不足 (`AILearnProviderQuotaExceeded`)

**触发条件**：检测到 `quota_exceeded` 错误

**影响范围**：无法生成新的 AI 卡片和验证

**立即响应**：
1. 检查当前 Provider 配额使用情况（登录 Provider 控制台）
2. 查看最近的错误日志：`docker logs ailearn-worker-1 | grep quota_exceeded`
3. 检查是否有异常批量任务导致配额耗尽

**根本原因分析**：
- 配额限制达到
- 异常请求循环
- 缓存失效导致重复调用

**恢复操作**：
- 临时措施：切换到备用 API key 或降低调用频率
- 长期措施：增加配额或优化调用逻辑

**预防措施**：
- 实现配额监控和预警
- 添加调用频率限制
- 实现请求去重

---

#### 数据库备份过期 (`AILearnBackupStale`)

**触发条件**：距离上次成功备份超过 24 小时

**影响范围**：数据丢失风险（RPO > 24 小时）

**立即响应**：
1. 检查备份脚本运行状态：`docker logs ailearn-backup-1`
2. 手动触发备份：按备份 runbook 操作
3. 检查 S3 存储空间和权限

**根本原因分析**：
- 备份脚本失败
- S3 存储问题
- 网络连接问题
- Cron/scheduler 配置错误

**恢复操作**：
- 手动执行备份：`bash infra/backup/backup.sh`
- 修复失败原因
- 验证备份完整性：`bash infra/backup/restore.sh --dry-run`

**预防措施**：
- 配置备份失败告警
- 实现备份新鲜度监控（已配置）
- 定期演练恢复流程

---

#### 版本回滚检测 (`AILearnReleaseRolledBack`)

**触发条件**：检测到 `release_rolled_back` 事件

**影响范围**：新版本问题导致回滚

**立即响应**：
1. 检查回滚日志：按回滚 runbook 分析
2. 通知团队回滚事件

**根本原因分析**：
- 新版本引入 bug
- 数据迁移失败
- 性能问题
- 安全问题

**恢复操作**：
- 按 `docs/runbooks/rollback-v0.5.md` 执行完整回滚流程

**预防措施**：
- 加强 RC 测试
- 实现灰度发布
- 添加性能回归检测

---

### Warning 告警（需要关注但非紧急）

#### HTTP 5xx 错误率过高 (`AILearnHighHTTP5xxRate`)

**触发条件**：5xx 错误率 > 0.5%，持续 5 分钟

**影响范围**：部分用户请求失败

**响应流程**：
1. 检查错误日志：`docker logs ailearn-api-1 | grep "5xx"`
2. 分析错误分布：按路由和状态码统计
3. 检查下游服务状态

**常见原因**：
- 数据库查询超时
- Worker 不可用
- Provider 错误
- 内存不足

---

#### HTTP p95 延迟过高 (`AILearnHighHTTPLatency`)

**触发条件**：p95 延迟 > 1 秒，持续 5 分钟

**影响范围**：用户体验下降

**响应流程**：
1. 检查数据库查询慢日志
2. 检查 Worker 队列深度
3. 检查 Provider 调用延迟

**常见原因**：
- 数据库查询慢
- 缺少缓存
- Worker 积压
- Provider 响应慢

---

#### Job 队列堆积 (`AILearnJobQueueBacklog`)

**触发条件**：pending 队列深度 > 100，持续 5 分钟

**影响范围**：任务处理延迟

**响应流程**：
1. 检查 Worker 数量和处理速度
2. 分析 job 类型分布
3. 考虑临时增加 Worker 实例

**常见原因**：
- Worker 数量不足
- 单个 job 处理时间过长
- 批量任务激增

---

#### Provider 错误率过高 (`AILearnHighProviderErrorRate`)

**触发条件**：Provider 错误率 > 5%，持续 5 分钟

**影响范围**：AI 功能降级

**响应流程**：
1. 检查 Provider 控制台状态页面
2. 分析错误类型分布
3. 检查 API key 配置

**常见原因**：
- Provider 服务中断
- API key 问题
- 请求格式问题

---

#### 数据库连接池接近耗尽 (`AILearnDatabasePoolExhaustion`)

**触发条件**：活跃连接 > 90% 池大小，持续 5 分钟

**影响范围**：新请求等待或被拒绝

**响应流程**：
1. 检查连接池配置
2. 查看长连接：`SELECT * FROM pg_stat_activity WHERE state != 'idle';`
3. 检查慢查询

**常见原因**：
- 连接泄漏
- 长事务
- 并发请求增加

---

#### RLS 拒绝率激增 (`AILearnHighRLSDenialRate`)

**触发条件**：RLS 拒绝 > 10 次/秒，持续 5 分钟

**影响范围**：可能表明安全配置问题

**响应流程**：
1. 检查最近的 RLS 拒绝日志
2. 分析被拒绝的查询模式
3. 检查 workspace/user 上下文设置

**常见原因**：
- RLS policy 配置问题
- Session 上下文设置错误
- 异常访问模式

---

### Info 告警（信息性通知）

#### 新版本部署 (`AILearnReleaseDeployed`)

**触发条件**：检测到 `release_deployed` 事件

**响应流程**：
1. 确认部署计划
2. 监控后续关键指标
3. 准备回滚方案（如果需要）

---

## 告警路由配置

Alertmanager 应按以下规则路由告警：

```yaml
# 示例 Alertmanager 配置
routes:
  # Critical 告警 -> PagerDuty / 紧急通道
  - match:
      severity: critical
    receiver: pagerduty-critical
    continue: false

  # Warning 告警 -> Slack / 邮件
  - match:
      severity: warning
    receiver: slack-warning
    continue: false

  # Info 告警 -> 仅 Slack
  - match:
      severity: info
    receiver: slack-info
```

---

## SLO 测量与报告

### 数据收集

- 所有指标从 `/metrics` 端点实时采集
- Prometheus 存储 30 天历史数据
- 每日自动生成 SLO 报告（TBD）

### SLO 违规处理

1. **记录**：将 SLO 违规记录到事故日志
2. **分析**：分析根本原因并记录到 ADR
3. **改进**：更新测试和监控，防止复发

### SLO 调整

- SLO 调整需要 Platform Owner 批准
- 调整必须记录到本文档和 ADR-0006

---

## 相关文档

- [ADR-0006: 指标与隐私](../adr/ADR-0006.md)
- [OPS-01 脚本](../../infra/)
- [回滚 Runbook](./rollback-v0.5.md)
- [Alpha 环境准备](./alpha-environment-readiness.md)

---

## 变更记录

| 日期 | 变更 | 作者 |
| --- | --- | --- |
| 2026-07-20 | 初始版本，定义 6 大类告警规则和响应流程 | Platform Owner |