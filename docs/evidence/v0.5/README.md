# v0.5 验收证据索引

> 总体状态（2026-07-21 更新）：9 个 Must 中 PROFILE-01 已完成，其余 8 个代码层面已就绪但 DoD 未关闭（需端到端证据）；M0～M6 Gate 为 7/30 已通过、23/30 未通过（77%）；发布硬门禁为 2/15（覆盖率+skip-todo 已达标）。全仓 1922 项测试全绿（Contract 13/Shared 24/AIQ 34/API 1279/Web 145/Worker 427），coverage gate 5/5 PASS，skip-todo 0 违规。**2026-07-21 新进展**：① SEC-01 enforce 根因修复——发现 0024 启用 RLS 后 `*_runtime_access` 绕过策略和 RESTRICTIVE `tenant_guard` 策略导致隔离失效，创建 0038 迁移删除 22 个绕过策略并将 36 个 RESTRICTIVE 策略转为 PERMISSIVE，本地 14/14 验证全通过（commit `3dcd01d`）；② CI 已推送 `3dcd01d` 到 `codex/v0.5-implementation`，GitHub Actions 自动触发；③ E2E 三视口 nightly profile 运行 224 项测试，7 通过（keyboard/login 页面），217 因缺少 seed 环境变量失败，需配置 `E2E_SEED_OUTPUT` 或 `E2E_DEV_EMAIL+E2E_DEV_PASSWORD` 后完整运行。剩余阻断项为外部依赖（独立 reviewer 批准、真实 API key、Alpha 环境部署、人工审批签署）。完整口径见 [里程碑门禁跟踪](milestone-gates.md) 和实施登记册。

| Milestone | Evidence | Status |
| --- | --- | --- |
| Foundation | [Local validation 2026-07-18](foundation-local-2026-07-18.md) | ✅ `make verify` 1922/1922 pass（API 1279/Web 145/Worker 427/AIQ 34/Shared 24/Contract 13），coverage gate 5/5 PASS，skip-todo 0 违规；[`1d2cada` Actions 6/6 job](https://github.com/asklins223/ai-learning-system/actions/runs/29648766086) 与 Node/PostgreSQL artifact digest 已保存 |
| M0 | [Baseline 2026-07-18](m0-baseline-2026-07-18.md)；[Baseline evidence](baseline-evidence.md) | ✅ 5/5；v0.5 分支 clean CI evidence 已保存，immutable SHA `33efa06` 已验证，覆盖率基线已保存 |
| M1 | [SEC-01 expand 2026-07-18](sec01-expand-2026-07-18.md)；[里程碑门禁跟踪](milestone-gates.md) | 2/4；enforce 0038 修复后 14/14 本地验证通过（`3dcd01d`），CI 已集成 0024+0038+verify 步骤；待独立 security/data reviewer 审批后永久启用 |
| M2 | 邀请、成员、onboarding、首次价值 E2E；[里程碑门禁跟踪](milestone-gates.md) | 0/3；Backend+UI+E2E 代码已就绪，invite-service 38/38 + 集成测试 11/11 pass，E2E 规格已创建 |
| M3 | validation/review attempt/导出删除/E2E；[里程碑门禁跟踪](milestone-gates.md) | 0/4；attempt 服务层/API/前端 UI/导出联动已就绪，单测 141 pass + 调度策略 65/65 pass |
| M4 | AIQ、SLO、故障、备份恢复；[里程碑门禁跟踪](milestone-gates.md) | 0/5；AIQ PR 34/34 + RC dry-run 21/21 + RC smoke 通过；metrics/privacy-scan/backup 45 shell test pass |
| M5 | 全量 release-check、manifest、digest、回滚；[里程碑门禁跟踪](milestone-gates.md) | 0/4；release manifest + CI 镜像 digest 链路 + 回滚/promotion runbook 已创建；CI 已推送 `3dcd01d` 触发 GitHub Actions |
| M6 | RC 灰度与 48h/7d/14d 观察；[里程碑门禁跟踪](milestone-gates.md) | 0/5；前置门禁（M1-M5）尚未完成 |

证据必须绑定 commit/tag、运行时间、环境和命令。`insufficient_data`、跳过项和失败不得改写为通过。

## 相关文档

- [里程碑门禁跟踪](milestone-gates.md) — M0-M6 全部 30 项门禁 + 15 项 RC 硬门禁的状态与证据映射
- [Must DoD 证据跟踪](dod-evidence.md) — 各 Must 工作包 DoD checkbox 的代码层面证据映射
- [v0.4 Baseline 不可变 SHA 证据](baseline-evidence.md) — v0.4 baseline commit `33efa06` 的完整证据
