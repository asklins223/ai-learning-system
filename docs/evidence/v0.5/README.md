# v0.5 验收证据索引

| Milestone | Evidence | Status |
| --- | --- | --- |
| Foundation | [Local validation 2026-07-18](foundation-local-2026-07-18.md) | Partial / Development evidence only；Node 22 `make verify` 233 pass + PostgreSQL integration 1 pass，clean CI/RC evidence 待补 |
| M0 | [Baseline 2026-07-18](m0-baseline-2026-07-18.md) | Partial / In progress；本地 immutable-SHA 基线已复核，Node 22 Actions artifact 与 clean tracked evidence 待补；独立评审要求已冻结，实际 approval 属 SEC-01 enforce/RC Gate |
| M1 | [SEC-01 expand 2026-07-18](sec01-expand-2026-07-18.md)；RLS/角色/连接池/双 Worker enforce evidence | Partial / Gate pending |
| M2 | 邀请、成员、onboarding、首次价值 E2E | Pending |
| M3 | validation/review attempt/导出删除/E2E | Pending |
| M4 | AIQ、SLO、故障、备份恢复 | Pending |
| M5 | 全量 release-check、manifest、digest、回滚 | Pending |
| M6 | RC 灰度与 48h/7d/14d 观察 | Pending |

证据必须绑定 commit/tag、运行时间、环境和命令。`insufficient_data`、跳过项和失败不得改写为通过。
