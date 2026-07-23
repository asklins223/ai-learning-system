# ADR-0007：加密备份、保留轮换与恢复演练

- Status: Accepted
- Owner: Platform Owner
- Approver: repository owner
- Date: 2026-07-18

## Context

v0.4 CI 能执行 PostgreSQL 备份恢复 smoke，但 Alpha 需要定时、加密、独立故障域、轮换、失败告警和每个 RC 的定时恢复证据。

## Decision

1. Alpha PostgreSQL 每 12 小时做一次一致性 custom-format `pg_dump`，生成 SHA-256 校验后使用 `age`/等价 envelope encryption 加密，再上传到与主数据库不同故障域的 S3-compatible bucket。
2. 加密私钥与备份对象分开管理；备份 job 只持有公钥和上传凭据，恢复身份按需取得私钥。
3. 保留最近 14 个周期备份和 4 个周备份。删除只由显式轮换脚本按已验证清单执行。
4. 每份备份记录 source release、commit、migration、开始/结束时间、大小、checksum、object key 和验证状态。超过 24 小时无已校验备份、上传/校验失败都告警。
5. 每个 RC 在隔离数据库恢复最新备份，重放角色/policy，核对迁移末端、核心表计数与关联、API readiness 和最小闭环 fixture；RTO 从宣布恢复开始计时，目标不超过 2 小时。
6. 恢复脚本默认拒绝生产主机/数据库名，目标必须是显式 allowlist 的隔离环境。

## Alternatives

- 只依赖云盘快照：拒绝，缺少可移植逻辑备份和权限重放证据。
- 在主数据库同一主机保留 dump：拒绝，不满足独立故障域。
- 自动执行破坏性 schema down migration：拒绝，采用应用兼容和前向修复。

## Consequences

Alpha 部署必须提供独立对象存储、备份公钥和恢复身份。CI smoke 仍可用临时 key/bucket，但不能被当作生产备份证据。

## Migration

先提交 backup/verify/restore/rotate 脚本和 manifest schema，在本地/CI fixture 演练；再配置 Alpha scheduler、独立 bucket、告警和首份恢复报告。

## Rollback / Forward-fix

新脚本故障时保留所有现有备份，不运行轮换；修复后补做备份并验证。任何恢复都先在隔离环境验证，除非事件指挥明确授权，不覆盖生产库。

## Evidence

- v0.4 CI 已有一次性 dump/restore 门禁。
- v0.5 计划规定 12 小时周期、14+4 保留和 RPO/RTO。
