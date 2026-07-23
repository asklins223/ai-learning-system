# v0.5 里程碑门禁跟踪

> 创建日期：2026-07-21
> 分支：`codex/v0.5-implementation`
> 最新 commit：`3dcd01d`（2026-07-21 SEC-01 enforce 0038 修复）
> 本地验证：`make verify` 1922 项测试全绿（0 fail / 0 skip / 0 todo）
> SEC-01 enforce：14/14 本地验证通过（0038 迁移修复后，使用 ailearn_api/ailearn_worker/ailearn_migrator 受限角色）

## 1. 总览

| 里程碑 | Gate 项数 | 已通过 | 阻断原因 |
| --- | --- | --- | --- |
| M0 基线冻结 | 5 | 5 ✅ | 无（2 项有补救措施但不阻塞决策冻结） |
| M1 租户隔离 | 4 | 2 | 独立 security/data reviewer 审批后永久启用 enforce |
| M2 邀请与首次使用 | 3 | 0 | E2E 旅程需 seed 数据 + 真实浏览器运行 |
| M3 验证与复习 | 4 | 0 | 集成测试需真实 PostgreSQL + E2E 闭环 |
| M4 质量与运维 | 5 | 0 | AIQ RC 需真实 API key + Alpha 环境部署 |
| M5 发布工程 | 4 | 0 | CI 已推送触发，待确认全部 job 通过 + 人工审批 |
| M6 RC 灰度 | 5 | 0 | 前置门禁（M1-M5）尚未完成 |
| **合计** | **30** | **7** | **23 项待完成（77%）** |

## 2. M0 Gate：基线冻结与设计决策

| # | Gate 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| M0-1 | 基线 clean 且可从 Git 复现 | ✅ | `33efa06` 已 push 到 canonical `main`，`codex/v0.5-implementation` 从正确基线创建 |
| M0-2 | 所有 Must 开放决策均有 development 结论 | ✅ | ADR-0001～0009 Accepted for development |
| M0-3 | 数据迁移和回滚/前向修复方案通过 Owner review | ✅ | ADR-0002～0004；SEC-01 enforce 前补独立 security/data review（`docs/runbooks/sec01-independent-review-request.md`） |
| M0-4 | 隐私事件 allowlist 通过 Owner review | ✅ | ADR-0006；Owner development review 完成，RC 前补独立 security/data review |
| M0-5 | 本文已从 Draft 转为 Approved for development | ✅ | 实施计划状态行已更新 |

**补充说明**：v0.4 CI 原始 artifact 未保存（已实施补救措施：覆盖率基线保存脚本 + CI artifact 上传 + Alpha 基础设施证据上传）；Alpha 环境 Docker 方案已创建但未实际运行。两项不阻塞 M0 决策冻结。

## 3. M1 Gate：租户隔离与多用户安全底座

| # | Gate 项 | 状态 | 代码证据 | 阻断原因 |
| --- | --- | --- | --- | --- |
| M1-1 | 真实受限角色完成核心闭环 | ⏳ | 0024 enforce + 0038 policy fix + sec01-enforce-verify.mjs 14/14 本地验证通过（commit `3dcd01d`） | 独立 security/data reviewer 审批后永久启用 |
| M1-2 | 跨 workspace 测试 0 泄漏 | ✅ | 0038 修复后跨 workspace 隔离验证全通过：A 只见自己、B 不可见、写入拒绝 42501、空 context 0 行 | RLS enforce 状态仍为 expand 模式（0027 fail-safe），审批后永久启用 |
| M1-3 | 双 Worker 在 RLS 下可领取和完成任务 | ⏳ | queue-postgres.integration.ts 5/5 通过（expand 模式）+ 3 个 SECURITY DEFINER 函数 | RLS enforce 后需重新验证 |
| M1-4 | 代表性 v0.4 数据可无损升级 | ⏳ | 迁移 0019-0038 全部 expand/forward-compatible | 需真实 v0.4 数据库验证 |

**已完成的代码证据**：
- 0024 enforce 迁移：24 表 ENABLE+FORCE RLS + REVOKE Worker UPDATE on jobs
- **0038 policy fix 迁移（2026-07-21 新增）**：删除 22 个 `*_runtime_access` 绕过策略 + 将 36 个 RESTRICTIVE `tenant_guard` 策略转为 PERMISSIVE
  - 根因：0024 启用 RLS 后未删除 expand 模式的 runtime_access 绕过策略，且 tenant_guard 为 RESTRICTIVE 需配 PERMISSIVE 才能生效
  - 修复后 sec01-enforce-verify.mjs 14/14 全通过（使用 ailearn_api/ailearn_worker/ailearn_migrator 受限角色）
- sec01-enforce-verify.mjs：5 类 14 项验证全部通过（RLS 状态/权限收回/函数存在/跨 workspace 隔离/Worker UPDATE 拒绝）
- 0027 fail-safe 迁移：恢复 expand 模式
- CI fresh-migrations job 已集成 0024+0038+verify 步骤
- permission-guard.test.ts：72/72 pass
- SEC-01 独立 review 请求文档已创建

## 4. M2 Gate：邀请制 Alpha 与首次使用

| # | Gate 项 | 状态 | 代码证据 | 阻断原因 |
| --- | --- | --- | --- | --- |
| M2-1 | 新用户在 Mock Provider 下独立完成首次价值旅程 | ⏳ | OnboardingGuide.tsx 6 步引导 + seed CLI PR profile + pr-smoke.spec.ts 3/3 pass | 完整 E2E 旅程需真实浏览器环境 |
| M2-2 | 邀请生命周期和角色矩阵全绿 | ⏳ | invite-service.ts（create/list/revoke/consume）+ invite-service-logic.test.ts 38/38 + sec02-invites-onboarding-postgres.integration.ts 11/11 | E2E 旅程需 seed 数据 |
| M2-3 | 移动、平板和桌面均无阻断问题 | ⏳ | WCAG 2.2 AA 扫描工具已落地 + 4 个 a11y E2E 测试 | 三视口 E2E 需真实浏览器运行 |

**已完成的代码证据**：
- 邀请系统：token_hash 存储 + 行锁 + 稳定错误码 + 角色 member/owner
- 成员管理：list/remove + session 撤销 + last-owner 保护
- Onboarding：6 步 server-driven 状态 + 前端引导 UI
- 注册页面：`app/(auth)/register` 已创建
- 导出/导入：包含 onboarding_states 和 invite_codes 新列
- 集成测试：11/11 通过

## 5. M3 Gate：可信验证与复习

| # | Gate 项 | 状态 | 代码证据 | 阻断原因 |
| --- | --- | --- | --- | --- |
| M3-1 | 完整闭环所有状态都来自真实业务对象 | ⏳ | attempt-service.ts start/submit/later/history/abandon/active 全实现 | 需真实 PostgreSQL + E2E 闭环 |
| M3-2 | 无硬证据时不能提升理解状态 | ⏳ | calculateReviewSchedule 中 hasHardEvidence 检查 + keyPointHasHardEvidence 函数 | 集成测试需真实 PostgreSQL |
| M3-3 | attempt/event/schedule 幂等且事务一致 | ⏳ | 幂等键 + FOR UPDATE 行锁 + onConflictDoNothing + withWorkspaceTransaction | review-attempt-postgres.integration.ts 需真实 PostgreSQL |
| M3-4 | 导出、删除和恢复包含 review attempt | ⏳ | 导出/导入模块已包含 review_attempts + loop-deletion-cascade.test.ts | 需真实 PostgreSQL 验证级联 |

**已完成的代码证据**：
- review_attempts 表迁移（0020 expand + 0037 active unique）
- attempt-service.ts：完整的 start→submit/later→history 生命周期
- scheduling-policy.ts：ADR-0004 可解释离散调度
- review-scheduling-policy-extra.test.ts：65/65 pass
- review-attempt-format.ts：前端历史格式化 + 31/31 pass
- ReviewAttemptHistory.tsx：历史视图 UI
- 旧 complete/dismiss 端点已物理退场
- 导出/导入包含 review_attempts 联动

## 6. M4 Gate：质量基准、最小运维与故障测试

| # | Gate 项 | 状态 | 代码证据 | 阻断原因 |
| --- | --- | --- | --- | --- |
| M4-1 | 黄金集阈值通过 | ⏳ | AIQ PR 层 34/34 pass + RC dry-run 21/21 + RC smoke test 通过 | 完整 RC gate 需真实 API key（预计 $0.25） |
| M4-2 | 故障注入无重复副作用或不可恢复状态 | ⏳ | handler-failure-matrix.test.ts 17/17 pass + queue-postgres.integration.ts 5/5 | 需真实 PostgreSQL 双 Worker 验证 |
| M4-3 | SLO 与告警演练通过 | ⏳ | metrics.ts 6 类指标 + alerts.yml 19 条规则 + slo-alerts.md runbook | Alpha 环境实际部署 |
| M4-4 | 最新备份可恢复并完成权限/核心数据校验 | ⏳ | backup.sh/restore.sh/rotate.sh/freshness-check.sh 45 shell test pass | Alpha 环境实际部署 + RC 恢复演练 |
| M4-5 | 指标与日志不含 secret/学习正文 | ⏳ | privacy-scan.ts 20/20 pass + ops01-graceful-shutdown-metrics-boundary.test.ts 57/57 pass | Alpha 环境实际运行验证 |

**已完成的代码证据**：
- AIQ-01：固定黄金数据集（30 篇）+ 标签（102 key point）+ 评分器 + PR Mock runner + RC 框架
- OPS-01：Prometheus metrics + /metrics 端点 + 隐私扫描 + 加密备份/轮换/恢复 + 告警规则 + SLO runbook
- Worker metrics：job/provider 指标 + HTTP metrics server :9100
- Alpha Docker 方案：docker-compose.alpha.yml + Prometheus + Alertmanager + backup-runner

## 7. M5 Gate：浏览器全量回归与发布工程

| # | Gate 项 | 状态 | 代码证据 | 阻断原因 |
| --- | --- | --- | --- | --- |
| M5-1 | clean checkout 全门禁通过 | ⏳ | make verify 1922/1922 pass + coverage gate 5/5 + skip-todo 0 | CI `3dcd01d` 已推送触发，待确认全 job 通过 |
| M5-2 | 三视口核心流程通过 | ⏳ | E2E harness + 7 个 spec + a11y 扫描 | nightly profile 224 项测试运行，7 通过/217 失败（缺 seed 环境变量），需配置后重跑 |
| M5-3 | 发布清单完整且可机器校验 | ⏳ | release-manifest-generate.mjs + contract test 13/13 + --rc 模式 | AIQ 指标 + 人工审批填充 |
| M5-4 | 回滚、备份恢复和 Worker drain 演练通过 | ⏳ | rollback-v0.5.md + promotion-evidence.md + alpha-backup-infrastructure.md | Alpha 环境实际演练 |

**已完成的代码证据**：
- release-manifest-generate.mjs：12 顶层字段 + --rc 模式 + --images 参数 + --skip-tests
- CI 镜像 digest 链路：capture-image-digests.mjs → release-evidence job
- 覆盖率基线保存脚本 + 比较模式
- skip-todo allowlist 门禁
- Gitleaks secret scan + Trivy 镜像漏洞扫描
- 回滚 runbook + promotion evidence 模板

## 8. M6 Gate：v0.5 RC、灰度与观察

| # | Gate 项 | 状态 | 阻断原因 |
| --- | --- | --- | --- |
| M6-1 | 灰度期间无跨 workspace、数据丢失或不可恢复任务 | ⏳ | 前置门禁（M1-M5）尚未完成 |
| M6-2 | SLO 达标且告警没有系统性噪声 | ⏳ | Alpha 环境未部署 |
| M6-3 | 已知限制和支持方式已对 Alpha 用户说明 | ⏳ | Alpha 用户尚未接入 |
| M6-4 | release manifest 与线上实际 digest 一致 | ⏳ | RC 尚未创建 |
| M6-5 | 观察结论记录是否进入 V1 Private Alpha | ⏳ | 灰度观察期未开始 |

## 9. RC 硬门禁（§4.1，15 项）

| # | 硬门禁项 | 状态 | 代码证据 | 阻断原因 |
| --- | --- | --- | --- | --- |
| RC-1 | canonical main 与目标 SHA 已确认，工作区 clean | ⏳ | `33efa06` 已验证 | RC tag 创建时确认 |
| RC-2 | 所有 package、README、tag 和 release manifest 版本一致 | ⏳ | version-contract.test.mjs | RC tag 创建时验证 |
| RC-3 | 空库、v0.4 代表性旧库、重复迁移和备份恢复通过 | ⏳ | CI fresh-migrations job | v0.4 旧库迁移需真实数据 |
| RC-4 | API/Worker/migrator 受限角色和 RLS 权限矩阵全绿 | ⏳ | sec01-enforce-verify.mjs 14/14（0038 修复后，`3dcd01d`） | 独立 reviewer 审批后永久启用 |
| RC-5 | 跨 workspace 读写、关联、导出、删除测试为 0 泄漏 | ✅ | 0038 修复后跨 workspace 隔离验证全通过 | RLS enforce 审批后永久启用 |
| RC-6 | 双 Worker 竞争及故障注入无重复副作用 | ⏳ | handler-failure-matrix.test.ts 17/17 + queue-postgres 5/5 | RLS enforce 后验证 |
| RC-7 | 关键浏览器 E2E 在 390/768/1440 三档视口通过 | ⏳ | E2E harness + 7 spec | 三视口实际运行 |
| RC-8 | E2E 无未允许的 console.error、page error、未处理 Promise 或阻断性无障碍错误 | ⏳ | console-allowlist.ts + a11y 扫描 | E2E 实际运行 |
| RC-9 | 固定黄金集 ≥30 篇，Precision ≥90%，覆盖 ≥85% | ⏳ | AIQ PR 34/34 + RC dry-run 21/21 | 真实 API key（预计 $0.25） |
| RC-10 | 覆盖率达到：全仓 lines ≥70%/branches ≥60%；关键模块 lines ≥85%/branches ≥75% | ✅ | coverage gate 5/5 PASS | 已达到（shared 83%/ai-quality 88%/api 87%/web 89%/worker 87%） |
| RC-11 | 测试报告不存在未允许的 skip/todo | ✅ | skip-todo-gate.mjs 0 违规 | 已达到 |
| RC-12 | 生产依赖和镜像无 high/critical 漏洞，secret scan 通过 | ⏳ | Gitleaks + Trivy CI 集成 | CI 实际运行 |
| RC-13 | 发布清单包含 commit、tag、迁移版本、镜像 digest 和测试摘要 | ⏳ | release-manifest-generate.mjs --rc 模式 | 真实镜像 digest 填充 |
| RC-14 | Alpha 环境定时加密备份、独立存储、保留轮换、失败告警和恢复演练通过 | ⏳ | backup.sh/restore.sh 45 shell test | Alpha 环境实际部署 |
| RC-15 | 无未关闭 P0/P1，已知 P2 均有 Owner、影响和规避方案 | ⏳ | — | RC 前最终确认 |

## 10. 阻断项分类

### 10.1 需外部环境/人工审批（不可在代码中解决）

| 阻断项 | 影响的 Gate | 解决方式 |
| --- | --- | --- |
| 独立 security/data reviewer 审批 | M1-1～M1-4, RC-4, RC-5 | 用户作为独立 reviewer 审查 `docs/runbooks/sec01-independent-review-request.md` 后批准 |
| 真实 Provider API key | M4-1, RC-9 | 设置 `DASHSCOPE_API_KEY` 环境变量后运行 `npm run rc-gate`（预计 $0.25） |
| Alpha 环境实际部署 | M4-3～M4-5, RC-14 | 在 Alpha 服务器执行 `make alpha-up && make alpha-backup && make alpha-restore-verify` |
| CI 实际运行证据 | M5-1, RC-12 | Push 到 GitHub 触发 CI workflow（`3dcd01d` 已推送，待确认全 job 通过） |
| 三视口 E2E 实际运行 | M2-3, M5-2, RC-7, RC-8 | 配置 `E2E_SEED_OUTPUT` 或 `E2E_DEV_EMAIL+E2E_DEV_PASSWORD` 后运行 Playwright E2E |
| 人工审批签署 | RC-13, RC-15 | Owner 和 securityDataReviewer 填充 release manifest approvals |
| RC tag 创建与灰度 | M6-1～M6-5 | 前置门禁全部通过后创建 `v0.5.0-rc.1` |

### 10.2 代码层面已完成（待端到端验证）

| 已完成项 | 证据 |
| --- | --- |
| 全仓 1922 项测试全绿 | API 1279/Web 145/Worker 427/AIQ 34/Shared 24/Contract 13 |
| 全仓 typecheck 零错误 | API/Web/Worker/AIQ/Shared/DB/E2E |
| 覆盖率门禁 5/5 PASS | shared 83%/ai-quality 88%/api 87%/web 89%/worker 87% |
| skip-todo gate 0 违规 | 全仓 0 skip 0 todo |
| SEC-01 enforce 14/14 本地验证 | 24 表 RLS+FORCE/Worker UPDATE 收回/3 函数/跨 workspace 隔离（0038 修复后，`3dcd01d`） |
| E2E PR smoke 3 passed | seed CLI PR profile + Playwright @pr 套件 |
| AIQ RC dry-run 21/21 | 数据集完整性+评分器+预算+证据对齐+评分流程+Manifest |
| Release manifest RC 生成 | --rc --skip-tests 模式生成 contract-compliant manifest |
| Alpha Docker 方案 | docker-compose.alpha.yml + Prometheus + Alertmanager + backup-runner |

## 11. 下一步行动建议

按优先级排序的行动项，均为需用户在本地/Alpha 环境执行的操作：

1. **SEC-01 enforce 永久启用**：独立 reviewer 审查 `docs/runbooks/sec01-independent-review-request.md` → 批准后跳过 0027、执行 0024+0038 → 运行 sec01-enforce-verify.mjs 确认 14/14
2. **E2E 三视口完整运行**：配置 `E2E_SEED_OUTPUT` 或 `E2E_DEV_EMAIL+E2E_DEV_PASSWORD` → 运行 `E2E_PROFILE=nightly npx playwright test --grep @pr`
3. **Alpha 环境部署**：执行 `make alpha-up` → `make alpha-backup` → `make alpha-restore-verify` → 配置 Prometheus 告警
4. **AIQ RC gate 运行**：设置 `DASHSCOPE_API_KEY` → 运行 `npm run rc-gate`（预计 $0.25）→ 填充 release manifest aiQuality 字段
5. **CI 结果确认**：查看 GitHub Actions `3dcd01d` 运行结果 → 保存 CI artifact 证据
6. **RC tag 创建**：前置门禁通过后 → 创建 `v0.5.0-rc.1` → 从 tag clean checkout 运行 `make release-check`
