# Architecture Decision Records

此目录保存 AI Learning System 的受控架构决策。ADR 一经 `Accepted`，后续变更只能通过新 ADR 替代，不直接重写历史结论。

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [ADR-0001](0001-v05-baseline-version-and-release-provenance.md) | Accepted for development | v0.5 基线、统一版本源与发布追溯 |
| [ADR-0002](0002-private-alpha-access-and-onboarding.md) | Accepted for development | Private Alpha 邀请、成员与 onboarding |
| [ADR-0003](0003-tenant-data-classification-and-rls.md) | Accepted for development | 数据分类、事务租户上下文与 RLS |
| [ADR-0004](0004-review-attempt-and-scheduling.md) | Accepted for development | Review Attempt 与可解释离散调度 |
| [ADR-0005](0005-ai-quality-gates.md) | Accepted for development | 版本化黄金集与分层 AI 质量门禁 |
| [ADR-0006](0006-telemetry-privacy-and-slo.md) | Accepted for development | 遥测、隐私 allowlist 与 Alpha SLO |
| [ADR-0007](0007-backup-and-recovery.md) | Accepted for development | 加密备份、保留轮换与恢复演练 |
| [ADR-0008](0008-browser-acceptance-harness.md) | Accepted for development | Playwright 浏览器验收底座与矩阵 |
| ADR-0009（编号保留） | Withdrawn / locally archived | 未获批的个人工作区与多工作区 v0.6 提案；正文不进入远端仓库，编号不复用 |
| [ADR-0010](0010-v06-trusted-mastery-loop-and-roadmap-realignment.md) | Proposed | v0.6 可信掌握闭环与后续 AI 路线重排；随详细计划一并批准 |

## 状态与审批

已批准 ADR 使用 `Proposed → Accepted → Superseded`；从未批准的提案可由 `Proposed → Withdrawn`。表中的 `Accepted for development` 仍对应 ADR 的 `Accepted` 状态，但明确审批范围不是发布批准。仅 ADR-0001～ADR-0008 由 repository owner `@asklins223` 在 2026-07-18 的 Codex 任务中以“开始实施这一版本计划”批准用于开发，并在该轮兼任 Product、Security、Data、Platform 与 Quality Owner 做 development self-review；ADR-0009 已撤回并仅保留于本地归档，ADR-0010 的状态和审批证据以正文为准。独立 security/data review 仍是 SEC-01 enforce 与 RC 的门禁，不能用开发批准或 Codex 只读复核替代。
