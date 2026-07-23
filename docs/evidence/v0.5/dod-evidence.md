# v0.5 Must DoD 证据跟踪

> 创建日期：2026-07-21
> 分支：`codex/v0.5-implementation`
> 最新 commit：`3dcd01d`（2026-07-21 SEC-01 enforce 0038 修复）
> 本地验证：`make verify` 1922 项测试全绿（0 fail / 0 skip / 0 todo）
> SEC-01 enforce：14/14 本地验证通过（0038 迁移修复后）

## 总览

| 工作包 | DoD 项数 | 代码就绪 | 端到端验证 | 阻断原因 |
| --- | --- | --- | --- | --- |
| SEC-01 | 5 | ✅ | ⏳ | 独立 reviewer 审批 + RLS enforce |
| SEC-02 / ALPHA-01 | 6 | ✅ | ⏳ | E2E 旅程需真实浏览器 |
| LOOP-01 / LOOP-02 | 5 | ✅ | ⏳ | 集成测试需真实 PostgreSQL + E2E |
| OPS-01 | 6 | ✅ | ⏳ | Alpha 环境实际部署 |
| PROFILE-01 | — | ✅ | ✅ | 已完成 |
| AIQ-01 | — | ✅ | ⏳ | 真实 API key |
| QLT-01 / QLT-02 | — | ✅ | ⏳ | 三视口 E2E 实际运行 |
| FDN-01 | — | ✅ | ⏳ | CI 实际运行证据 |
| REL-01 | — | ✅ | ⏳ | 人工审批 + AIQ 指标填充 |

> **注**：代码层面已全部就绪（1922 项测试全绿），DoD checkbox 要求端到端证据（CI 实际运行截图、人工审批签署、真实 API 调用结果）。

---

## SEC-01：RLS 与受限角色闭环

### DoD-1: API 与 Worker 在真实受限账号下完成核心闭环

**代码证据**：
- 0024 enforce 迁移：`0024_sec01_rls_enforce.sql` — 24 表 ENABLE+FORCE RLS + REVOKE Worker UPDATE on jobs
- **0038 policy fix 迁移**：`0038_sec01_rls_enforce_policy_fix.sql` — 删除 22 个 `*_runtime_access` 绕过策略 + 将 36 个 RESTRICTIVE 策略转为 PERMISSIVE
  - 根因修复：0024 启用 RLS 后，expand 模式的 runtime_access PERMISSIVE 策略以 OR 语义绕过 tenant_guard 隔离；删除后 tenant_guard 为 RESTRICTIVE 且无 PERMISSIVE 策略，导致所有行不可见
  - 修复方式：删除所有 runtime_access 绕过策略 + 将所有 RESTRICTIVE tenant_guard/actor_guard 转为 PERMISSIVE
- sec01-enforce-verify.mjs：5 类 14 项验证全部通过（使用 ailearn_api/ailearn_worker/ailearn_migrator 受限角色，commit `3dcd01d`）
  - 24 表 RLS 启用+强制
  - Worker UPDATE 权限收回 + SELECT 保留
  - 3 个 SECURITY DEFINER 函数（`ailearn_renew_job_lease`/`ailearn_finish_job`/`ailearn_fail_job`）
  - 跨 workspace 隔离 A 看到 B 不可见 + 空 context 0 行 + 写入拒绝 42501
  - Worker 直接 UPDATE jobs 拒绝 42501
- Worker `queue.ts`：默认 updater 已改用 `createSqlFunctionQueueJobUpdater`
- Worker `job-lease.ts`：`lockJobLease` 续租已改用 `ailearn_renew_job_lease`
- CI fresh-migrations job 已集成 0024+0038+verify 步骤

**阻断原因**：enforce 状态仍为 expand 模式（0027 fail-safe），待独立 security/data reviewer 审批后永久启用（跳过 0027，执行 0024+0038）

### DoD-2: 连接池复用 1,000 次 workspace 交替请求无上下文串线

**代码证据**：
- `withWorkspaceTransaction` 事务 helper：transaction-local `app.workspace_id` + `app.user_id`
- queue-postgres.integration.ts：Worker `max: 1` 连接池 1,000 次事务通过（expand 模式）

**阻断原因**：需在 RLS enforce 模式下重新验证

### DoD-3: 两个 workspace 的跨域 ID 猜测、关联写入和批量接口全部被拒绝

**代码证据**：
- sec01-cross-workspace-isolation.test.ts：静态分析全部 service 文件验证 workspaceId 过滤
- enforce 验证脚本（0038 修复后）：跨 workspace 隔离 A 看到 B 不可见 + 写入拒绝 42501 + 空 context 0 行

**状态**：✅ 本地验证通过（`3dcd01d`），待 RLS enforce 永久启用后端到端确认

### DoD-4: Worker claim、续租、提交和回收通过 RLS/lease 双重约束

**代码证据**：
- 0022 迁移：3 个 SECURITY DEFINER 函数 + GRANT EXECUTE TO ailearn_worker
- Worker `queue.ts`：`createSqlFunctionQueueJobUpdater` 调用上述函数
- Worker `job-lease.ts`：`lockJobLease` 续租已改用 `ailearn_renew_job_lease`
- queue-postgres.integration.ts：双 Worker queue 5/5 通过

**阻断原因**：需在 RLS enforce 模式下重新验证

### DoD-5: 迁移、回滚/前向修复和故障恢复 runbook 完成

**代码证据**：
- `docs/runbooks/sec01-enforce.md`：ENABLE+FORCE RLS、REVOKE Worker 直接 UPDATE、验证清单和回滚步骤
- `docs/runbooks/sec01-independent-review-request.md`：正式 review 请求文档
- `docs/runbooks/rollback-v0.5.md`：6 阶段回滚流程 + RLS 紧急禁用安全例外流程
- 0027 fail-safe 迁移：恢复 expand 模式

**状态**：✅ 已完成

---

## SEC-02 / ALPHA-01：邀请、成员与 onboarding

### DoD-1: Owner 能创建、复制、查看状态、撤销邀请

**代码证据**：
- `invite-service.ts`：create/list/revoke/consume（hash 存储 + 行锁 + 稳定错误码）
- API 路由：`POST /invites`、`GET /invites`、`DELETE /invites/:id`
- 前端 `InviteMemberSettings.tsx`：创建/列表/撤销邀请 UI
- invite-service-logic.test.ts：38/38 pass
- sec02-invites-onboarding-postgres.integration.ts：11/11 pass

**阻断原因**：E2E 旅程需真实浏览器运行

### DoD-2: 过期、撤销、已消费和并发消费均有明确结果

**代码证据**：
- `computeStatus` 状态优先级：`revoked > consumed > expired > active`
- `ConsumeInviteError` 6 种错误码
- `consumeInvite` FOR UPDATE 行锁

**阻断原因**：E2E 旅程需真实浏览器运行

### DoD-3: 成员不能执行 Owner 操作

**代码证据**：
- `isWorkspaceOwner` 纯函数：`membership.role === 'owner' || workspace.ownerId === userId`
- `requireOwner` 中间件
- permission-guard.test.ts：72/72 pass，15 个 owner-only 路由验证

**阻断原因**：E2E 旅程需真实浏览器运行

### DoD-4: Owner 与 member 两条 onboarding 分支均通过

**代码证据**：
- `ONBOARDING_STEPS` 6 步：ai_consent→provider_config→first_content→first_card→evidence_review→first_validation
- `OnboardingGuide.tsx`：合并服务端 onboarding state 和前端推断状态
- API 路由：`GET /onboarding/state`、`POST /onboarding/steps`

**阻断原因**：E2E 旅程需真实浏览器运行

### DoD-5: 被移除成员的 session 失效且无法继续读取 workspace

**代码证据**：
- `removeMember`：session 撤销 + 软删除 + last-owner 保护
- sec02-invite-concurrent-session.test.ts：consumeInvite FOR UPDATE 行锁 + removeMember session 撤销

**阻断原因**：E2E 旅程需真实浏览器运行

### DoD-6: 首次价值旅程在桌面和移动视口 E2E 通过

**代码证据**：
- E2E harness：Playwright + seed CLI + fixtures + 7 个 spec
- pr-smoke.spec.ts：3/3 pass
- a11y 扫描：@axe-core/playwright + 4 个扫描测试

**阻断原因**：三视口（390/768/1440）E2E 需真实浏览器运行

---

## LOOP-01 / LOOP-02：验证与复习

### DoD-1: 重复提交、超时重试和双击不产生重复 attempt/schedule/event

**代码证据**：
- 幂等键：`(workspace_id, user_id, idempotency_key)` 唯一索引
- `onConflictDoNothing` + `findAttemptByIdempotencyKey` 竞争处理
- `FOR UPDATE` 行锁：schedule 和 attempt 均加锁
- review-attempt-postgres.integration.ts：幂等唯一索引验证
- review-attempt-db-extra.test.ts：幂等返回相同 attemptId

**阻断原因**：集成测试需真实 PostgreSQL

### DoD-2: 用户可从历史中解释"为什么现在复习、为什么安排到这个时间"

**代码证据**：
- `listReviewAttemptHistory`：游标分页，排除 answer_text（隐私边界）
- `ReviewAttemptHistory.tsx`：展示 outcome/置信度/回答方式/调度变化（before→after）/调度原因/理解影响/下次复习时间
- `review-attempt-format.ts`：`formatRelativeTime`/`formatScheduleChange`/`getOutcomeMeta`/`getReasonCodeLabel`
- review-attempt-format.test.ts：31/31 pass

**状态**：✅ 代码已完成

### DoD-3: 错误理解只有新的有效验证才能关闭

**代码证据**：
- `calculateReviewSchedule`：`hasHardEvidence` 检查
- `keyPointHasHardEvidence` 函数：检查 key point 是否有 aligned (hard) evidence
- 调度策略：无硬证据时不能升级理解状态
- review-scheduling-policy-extra.test.ts：65/65 pass

**阻断原因**：集成测试需真实 PostgreSQL

### DoD-4: 导出和删除覆盖 review attempt

**代码证据**：
- 导出/导入模块已包含 `review_attempts`（FK 顺序校验 + dry-run 计数）
- loop-deletion-cascade.test.ts：deleteNote 级联路径覆盖 review_schedules/review_attempts
- review-attempt-postgres.integration.ts：FK cascade 验证

**阻断原因**：集成测试需真实 PostgreSQL

### DoD-5: 真实浏览器完成验证 → 到期复习 → 再验证闭环

**代码证据**：
- review-attempt.spec.ts：5 项 E2E 旅程
- 前端 review page 已接入新 attempt API（start→submit/later + outcome/confidence/answer 表单）

**阻断原因**：E2E 需真实浏览器 + seed 数据

---

## OPS-01：最小运维、可观测性与备份

### DoD-1: 4.2 所需查询、最小 Dashboard、告警阈值和 Owner 可用

**代码证据**：
- `metrics.ts`：HTTP/Job/Provider/Database/Funnel/Release 6 类指标 + label allowlist + normalizeRouteTemplate/categorizeError
- `/metrics` 端点 + `onResponse` hook
- `alerts.yml`：6 大类 19 条告警规则
- `slo-alerts.md`：6 个 SLO 目标 + 17 个告警响应流程
- ops01-graceful-shutdown-metrics-boundary.test.ts：57/57 pass

**阻断原因**：Alpha 环境实际部署

### DoD-2: 定时加密备份、独立存储、保留轮换和失败告警可用

**代码证据**：
- `backup.sh`：pg_dump custom-format + SHA-256 + age 加密 + S3 上传 + manifest JSON
- `rotate.sh`：14 daily + 4 weekly 保留 + 未验证备份不删除 + dry-run
- `freshness-check.sh`：扫描 manifest 查找最近已验证备份 + 超时告警
- 45 shell 测试 pass

**阻断原因**：Alpha 环境实际部署

### DoD-3: RC 恢复演练在 2 小时内完成并通过权限/完整性校验

**代码证据**：
- `restore.sh`：host/db allowlist + age 解密 + SHA-256 校验 + 恢复后验证
- `rc-restore-verify.sh`：RC 恢复验证脚本
- `alpha-backup-infrastructure.md`：部署 Runbook

**阻断原因**：Alpha 环境实际部署 + 每个 RC 实际运行

### DoD-4: 演练 Provider 超时、Worker 停止、queue 堆积、数据库不可用和迁移不匹配

**代码证据**：
- handler-failure-matrix.test.ts：17/17 pass（Provider 延迟返回、事务崩溃、幂等、死信收敛等）
- queue-postgres.integration.ts：5/5 pass（双 Worker 竞争、lease 过期、连接池复用）
- alerts.yml：Provider 错误/延迟/队列积压/死信/lease 丢失告警

**阻断原因**：Alpha 环境实际演练

### DoD-5: 每个演练都能在目标时间内告警并定位

**代码证据**：
- alerts.yml：critical/warning/info 三级告警
- slo-alerts.md：详细响应流程、根本原因分析、恢复操作和预防措施

**阻断原因**：Alpha 环境实际演练

### DoD-6: 日志/指标自动扫描不发现 secret 或学习正文

**代码证据**：
- `privacy-scan.ts`：10 类 Canary pattern 检测（API key/密码/Cookie/Authorization/CSRF/URL query/lease token/笔记正文/Provider 响应/连接字符串）
- privacy-scan.test.ts：20/20 pass
- ops01-graceful-shutdown-metrics-boundary.test.ts：指标隐私边界 13 项不含敏感数据验证

**阻断原因**：Alpha 环境实际运行验证

---

## 代码层面已完成的关键指标

| 指标 | 值 | 验证方式 |
| --- | --- | --- |
| 全仓测试 | 1922 pass / 0 fail / 0 skip / 0 todo | `make verify` |
| Contract | 13 pass | `node --test *.test.mjs` |
| Shared | 24 pass | `npm test` |
| AI-Quality | 34 pass | `npm test` |
| API | 1279 pass | `npm test` |
| Web | 145 pass | `npm test` |
| Worker | 427 pass | `npm test` |
| 覆盖率门禁 | 5/5 PASS | `coverage-gate.mjs` |
| Skip-todo 门禁 | 0 违规 | `skip-todo-gate.mjs` |
| Typecheck | 全部通过 | 各包 `tsc --noEmit` |
| SEC-01 enforce | 14/14 通过 | `sec01-enforce-verify.mjs`（0038 修复后，`3dcd01d`） |
| AIQ RC dry-run | 21/21 通过 | `rc-dry-run.ts` |
| E2E PR smoke | 3 passed 0 failed | Playwright @pr 套件 |
| Release manifest | RC 生成成功 | `--rc --skip-tests` 模式 |
| Shell 备份测试 | 45 pass | `backup-scripts.test.sh` |
