# 当前运维入口

> 状态：Active<br>
> 适用版本：v0.5 Private Alpha

本文件只保留当前可执行入口。已完成的 ADR、证据、评审、详细 Runbook 和测试
设计记录保存在本地 `project-archive`，不作为远端发布证据。实际发布审批必须
引用外部不可变证据或 CI artifact，不能引用本地归档。

## 基础验证

```bash
make verify
make release-check
```

`make verify` 中的覆盖率为 report-only；只有 `make release-check` 的阻断模式
通过后，覆盖率才可记为发布门禁通过。

## Alpha 环境

```bash
make alpha-up
make alpha-status
make alpha-metrics
make alpha-down
```

环境编排入口是 `scripts/alpha-env-setup.sh`，Prometheus 和 Alertmanager 配置位于
`infra/prometheus/`。

## Alerts

收到告警后先执行 `make alpha-status` 和 `make alpha-metrics`，再按告警 labels
定位 API、Worker、Provider、数据库或备份组件。不得把密钥、Cookie、正文或
Provider 原始响应粘贴到告警记录。

- API/Worker 不可用、5xx 或高延迟：检查服务日志、数据库连通性和最近部署；
- Job backlog、stale、dead 或 lease lost：检查 Worker 存活、队列深度和租约指标；
- Provider 错误、延迟、schema failure 或 quota：暂停相关扩量并检查 Provider 状态；
- transaction failure 或 RLS denial：停止发布操作，核对角色和事务上下文；
- backup stale：立即执行备份与恢复验证；
- 漏斗或卡片生成异常：保留版本、模型 revision 和匿名聚合指标后再分析。

## 备份与恢复

```bash
make alpha-backup
make alpha-restore-verify
```

实现入口位于 `infra/backup/`。备份必须加密、校验 digest、写入 manifest，并在
隔离目标数据库完成恢复验证；不得把恢复目标指向生产数据库。

## RLS 安全门禁

永久启用前必须取得独立 security/data reviewer 的明确批准，并在目标环境完成：

1. 目标数据库加密备份；
2. 受限 API/Worker 角色验证；
3. 执行 RLS enforce 前向迁移；
4. 运行 `.github/scripts/sec01-enforce-verify.mjs`；
5. 保存执行人、审批人、环境、迁移末端和全部验证输出。

若任一验证失败，停止发布并使用前向修复迁移恢复到已知安全状态。

## Rollback

1. 停止扩量并暂停新 Worker 领取任务；
2. 等待在途任务有界 drain；
3. 将 API/Web/Worker 固定到上一已接受镜像 digest；
4. 运行 readiness、核心旅程和迁移兼容性检查；
5. 只有数据损坏时才从已验证加密备份恢复；
6. 保存时间线、影响范围、执行人、验证结果和后续修复项。

## Promotion and approvals

RC manifest 的 owner 与 security/data reviewer 必须分别批准，并引用 CI artifact、
镜像 digest、AIQ RC 报告、恢复报告和观察期记录。48 小时、7 日和 14 日任一
阶段失败时，立即停止扩量并执行上面的回滚流程。
