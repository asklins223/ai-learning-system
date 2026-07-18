# v0.5 验收证据索引

> 总体状态（2026-07-18）：8 个 Must 为 0 完成 / 6 部分实现 / 2 未开始；M0～M6 Gate 为 4/30 已勾、26/30 未通过；发布硬门禁为 0/15，以 checkbox 表达的 Must DoD 为 0/22。保守估计仍有约 80% 工作范围未完成；该估计不是代码行百分比或工期承诺，完整口径见实施登记册。

| Milestone | Evidence | Status |
| --- | --- | --- |
| Foundation | [Local validation 2026-07-18](foundation-local-2026-07-18.md) | Partial；Node `v22.21.1` 下 `make verify` 246/246 pass，隔离 PostgreSQL 16.14 的 7 项 integration pass；[`1d2cada` Actions 6/6 job](https://github.com/asklins223/ai-learning-system/actions/runs/29648766086) 与 Node/PostgreSQL artifact digest 已保存，正式 coverage/机器汇总/RC evidence 待补 |
| M0 | [Baseline 2026-07-18](m0-baseline-2026-07-18.md) | Partial / In progress；v0.5 分支 clean CI evidence 已保存，但 immutable v0.4 baseline 对应的原始 artifact/digest、fixture/Alpha 外部环境仍待补；独立评审要求已冻结，实际 approval 属 SEC-01 enforce/RC Gate |
| M1 | [SEC-01 expand 2026-07-18](sec01-expand-2026-07-18.md)；RLS/角色/连接池/双 Worker enforce evidence | Partial / Expand verified, enforce blocked；0019 已定义 22 表/58 policy，但 RLS/`FORCE RLS` 全部关闭；Worker 局部池复用与双 session 验证不等于 M1 Gate 通过 |
| M2 | 邀请、成员、onboarding、首次价值 E2E | Partial / Foundation only；Gate 0/3，当前仅有 token primitive/test，生产 hash/消费、成员、onboarding 与 E2E 未完成 |
| M3 | validation/review attempt/导出删除/E2E | Partial / Foundation only；Gate 0/4，已有 contract/调度 policy 底座，attempt 持久化事务、API/UI、导出删除与 E2E 未完成 |
| M4 | AIQ、SLO、故障、备份恢复 | Partial / Isolated evidence only；Gate 0/5，Worker/PostgreSQL 与 backup restore 仅覆盖局部子场景，AIQ、SLO、告警演练和完整故障矩阵未完成 |
| M5 | 全量 release-check、manifest、digest、回滚 | Partial / Release foundation only；Gate 0/4，已有版本/release-check 底座，正式 coverage/scan、manifest、镜像 digest 与完整回滚证据未完成 |
| M6 | RC 灰度与 48h/7d/14d 观察 | Not started；Gate 0/5，RLS enforce、Alpha 环境和 RC 前置门禁尚未完成 |

证据必须绑定 commit/tag、运行时间、环境和命令。`insufficient_data`、跳过项和失败不得改写为通过。
