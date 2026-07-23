# SEC-01 独立 Security/Data Review 请求

> 状态：PENDING REVIEW<br>
> 请求日期：2026-07-20<br>
> 请求人：repository owner `@asklins223`（以 development self-review 身份）<br>
> 审查范围：SEC-01 RLS enforce 迁移（`0024_sec01_rls_enforce.sql`）及相关 policy/函数/权限变更<br>
> 关联文档：ADR-0003、`docs/runbooks/sec01-enforce.md`、`docs/plans/AI学习系统-v0.5-版本实施计划-2026-07-18.md` §6.1

## 1. 请求背景

v0.5 实施计划要求在 SEC-01 enforce 执行前必须有独立 security/data reviewer 的明确批准（§10.2 D-03）。当前 repository owner 以 development self-review 身份完成了 expand/verify 阶段的全部代码和测试工作，但**独立发布审批**必须由非代码作者的审查者完成。

本文件是正式的 review 请求，列出了审查者需要检查的全部 artifact、验证清单和接受标准。

## 2. 审查范围

### 2.1 迁移文件

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `0019_sec01_rls_policies_expand.sql` | 已应用 | 定义 22 表/58 policy（tenant guard + actor guard + runtime access） |
| `0020_loop01_review_attempts_expand.sql` | 已应用 | `review_attempts` 表 + 3 个 RLS policy |
| `0021_sec02_invites_onboarding_expand.sql` | 已应用 | `invite_codes` 扩展列 + `onboarding_states` 表 + RLS policy |
| `0022_sec01_job_functions.sql` | 已应用 | `ailearn_renew_job_lease`/`ailearn_finish_job`/`ailearn_fail_job` 三个 SECURITY DEFINER 函数 |
| `0023_sec01_validation_feedback_backfill.sql` | 已应用 | 回填历史 `validation_feedback` artifacts 的 `input_refs.userId` |
| `0024_sec01_rls_enforce.sql` | **待审查** | ENABLE+FORCE RLS 24 表 + REVOKE Worker UPDATE on jobs + DO 验证块 |

### 2.2 代码变更

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `workers/ai-worker/src/lib/queue.ts` | Worker updater 改用函数路径 | `createSqlFunctionQueueJobUpdater` 调用 `ailearn_finish_job`/`ailearn_fail_job` |
| `workers/ai-worker/src/lib/job-lease.ts` | `lockJobLease` 改用函数 | 调用 `ailearn_renew_job_lease` 而非直接 UPDATE |
| `workers/ai-worker/src/handlers/index.ts` | `input_refs.userId` 写入 | `runEvaluateValidation` 写入 `validation_feedback` artifact 时包含 `userId` |

### 2.3 数据分类

| 分类 | 表 | RLS 策略 |
| --- | --- | --- |
| Workspace-owned | workspaces, workspace_members, invite_codes, sources, source_segments, notes, note_versions, note_blocks, learning_cards, card_key_points, evidences, search_documents, benchmark_reports, benchmark_labels | tenant_guard (workspace_id) + runtime_access |
| User-private | evidence_overrides, validation_events, review_schedules, understanding_events, review_attempts | tenant_guard (workspace_id) + actor_guard (user_id) + runtime_access |
| 全局身份 | users, sessions, auth_rate_limits | 最小授权 + 受控函数（不在本次 enforce 范围） |
| 跨租户运维 | jobs | tenant_guard + insert_actor_guard + worker_update_actor_guard + API/Worker 分命令 policy |
| AI 产物 | ai_artifacts, ai_audit_log | tenant_guard + validation_actor_guard（validation_feedback 类型限制 input_refs.userId）+ owner_read/insert_actor |

## 3. 审查者需要检查的 Artifact

### 3.1 代码与迁移

1. **`0024_sec01_rls_enforce.sql`** — 确认 24 表 ENABLE+FORCE RLS、REVOKE Worker UPDATE、DO 验证块逻辑正确
2. **`0019_sec01_rls_policies_expand.sql`** — 确认 58 条 policy 的 USING/CHECK 表达式正确引用 `app.workspace_id` 和 `app.user_id`
3. **`0022_sec01_job_functions.sql`** — 确认三个 SECURITY DEFINER 函数的 `search_path` 设置为 `pg_catalog, public`，且 GRANT EXECUTE 仅授予 `ailearn_worker`
4. **`workers/ai-worker/src/lib/queue.ts`** — 确认 Worker updater 不再直接 UPDATE jobs
5. **`workers/ai-worker/src/lib/job-lease.ts`** — 确认 `lockJobLease` 调用 `ailearn_renew_job_lease`
6. **`workers/ai-worker/src/handlers/index.ts`** — 确认 `validation_feedback` artifact 写入 `input_refs.userId`

### 3.2 集成测试

1. **`apps/api/src/integration-tests/rls-policies-postgres.integration.ts`** — 跨 workspace 读写/关联/写入隔离、Worker claim/renew/update 权限边界、API 直接 UPDATE jobs 被拒绝
2. **`apps/api/src/integration-tests/review-attempt-postgres.integration.ts`** — `review_attempts` 表结构、幂等索引、FK 级联、RLS policy 存在性、隐私边界（history 查询排除 answer_text）
3. **`.github/scripts/sec01-enforce-verify.mjs`** — enforce 后的 5 类 12 项自动验证脚本

### 3.3 运行时验证证据

1. **API 356 tests pass** — 全部单元测试通过
2. **Worker 183 tests pass** — 全部单元测试通过
3. **PG16.14 受限角色 RLS gate** — 22 表 policy catalog 验证通过
4. **Worker max:1 连接池 1,000 次事务** — 无上下文串线
5. **双 Worker queue 5 项** — claim/renew/finish/fail/reap 全部通过

## 4. 验证清单

审查者应逐项确认以下内容。每项标记 ✓（通过）或 ✗（未通过+原因）。

### 4.1 Policy 正确性

- [ ] 所有 24 张表的 `tenant_guard` policy 正确引用 `app.workspace_id`，USING 和 CHECK 表达式均包含 workspace 约束
- [ ] User-private 表（evidence_overrides, validation_events, review_schedules, understanding_events, review_attempts）的 `actor_guard` policy 正确引用 `app.user_id`
- [ ] `ai_artifacts` 表的 `validation_actor_guard` policy 正确约束 `validation_feedback` 类型的 `input_refs->>'userId'` 与 `app.user_id` 一致
- [ ] `ai_audit_log` 表的 `owner_read` policy 仅允许 workspace owner 读取（非所有 member 可见）
- [ ] `jobs` 表的 `worker_update_actor_guard` policy 使用 `requested_by IS NOT DISTINCT FROM app.user_id` 防止 Worker 修改其他用户的 job
- [ ] 所有 RESTRICTIVE policy 与 PERMISSIVE policy 的组合不会产生意外放行

### 4.2 函数安全

- [ ] `ailearn_renew_job_lease(uuid, uuid, text)` — SECURITY DEFINER、search_path = pg_catalog,public、仅校验 lease_token 匹配后更新 lease_expires_at
- [ ] `ailearn_finish_job(uuid, uuid, text)` — SECURITY DEFINER、search_path = pg_catalog,public、仅校验 lease_token 后更新 status='succeeded'
- [ ] `ailearn_fail_job(uuid, uuid, text, text, integer)` — SECURITY DEFINER、search_path = pg_catalog,public、仅校验 lease_token 后更新 status='dead' 并记录错误
- [ ] 三个函数的 GRANT EXECUTE 仅授予 `ailearn_worker`，不授予 `ailearn_api`
- [ ] 函数内部不设置 `app.workspace_id` 或 `app.user_id`（由调用方在事务中设置）

### 4.3 权限收回

- [ ] `0024_sec01_rls_enforce.sql` 中 `REVOKE UPDATE ON public.jobs FROM ailearn_worker` 生效
- [ ] Worker 仍保留对 jobs 的 SELECT 权限（用于 `SELECT ... FOR UPDATE`）
- [ ] Worker 通过 SECURITY DEFINER 函数仍可操作 jobs（claim/renew/finish/fail）
- [ ] API 角色对 jobs 无 UPDATE 权限（已由 0019 policy 保证）

### 4.4 上下文隔离

- [ ] API 在事务内设置 `app.workspace_id` 和 `app.user_id`（transaction-local，非 session-local）
- [ ] 事务结束后上下文自动失效，连接归还连接池后不残留
- [ ] 空字符串 workspace_id 上下文返回 0 行（fail-closed）
- [ ] 连接池复用 1,000 次 workspace 交替请求无上下文串线

### 4.5 隐私边界

- [ ] `review_attempts` 的 history 查询不返回 `answer_text`（隐私约束）
- [ ] `ai_audit_log` 的 `owner_read` policy 不允许 member 读取其他 member 的审计记录
- [ ] `validation_feedback` 类型的 `ai_artifacts` 仅允许 `input_refs.userId` 对应的用户读取

## 5. 接受标准

Review 通过的判定条件：

1. 上述验证清单全部标记 ✓
2. 审查者在 PR 或 ADR 中记录明确的 approval 语句
3. 审查者确认 `0024_sec01_rls_enforce.sql` 可以安全执行
4. 审查者确认回滚方案（`docs/runbooks/sec01-enforce.md` §回滚）可操作

## 6. 审查者信息

| 字段 | 值 |
| --- | --- |
| 审查者姓名 | （待填充） |
| 审查者角色 | security/data reviewer |
| 审查日期 | （待填充） |
| 审查结论 | Approved / Rejected / Changes Requested |
| 审查证据 | （PR 链接 / ADR 编号 / 评论 ID） |
| 备注 | （如有条件批准，列出条件） |

---

## 附录 A：回滚演练证据模板

enforce 执行后和每个 RC 发布前，必须执行一次回滚演练并记录以下证据。

### A.1 演练环境

| 字段 | 值 |
| --- | --- |
| 演练日期 | （待填充） |
| 环境类型 | 隔离测试环境 / Alpha 环境 |
| 数据库版本 | PostgreSQL 16.x |
| 执行人 | （待填充） |
| 演练目标 | 验证 SEC-01 enforce 后的回滚流程可操作 |

### A.2 演练步骤记录

| 步骤 | 开始时间 | 结束时间 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| 1. 执行 enforce（0024 迁移） | | | ✓ / ✗ | |
| 2. 运行 `sec01-enforce-verify.mjs` | | | ✓ / ✗ | 12 项验证全部通过 |
| 3. 模拟故障：禁用 RLS（回滚） | | | ✓ / ✗ | 记录执行 SQL |
| 4. 验证回滚后系统可用 | | | ✓ / ✗ | API /ready 返回 200 |
| 5. 重新执行 enforce | | | ✓ / ✗ | |
| 6. 再次运行验证脚本 | | | ✓ / ✗ | 12 项验证全部通过 |

### A.3 演练结论

- [ ] 回滚流程可在 5 分钟内完成
- [ ] 回滚后系统恢复到 expand 阶段的安全状态
- [ ] 重新 enforce 后验证全部通过
- [ ] 演练过程中无数据丢失或不可恢复状态

### A.4 改进措施

（如演练中发现问题，记录改进措施和负责人的跟进计划）

---

## 附录 B：相关文档索引

| 文档 | 路径 | 说明 |
| --- | --- | --- |
| SEC-01 enforce runbook | `docs/runbooks/sec01-enforce.md` | enforce 执行步骤和回滚方案 |
| SEC-01 enforce 验证脚本 | `.github/scripts/sec01-enforce-verify.mjs` | 5 类 12 项自动验证 |
| RLS policy 集成测试 | `apps/api/src/integration-tests/rls-policies-postgres.integration.ts` | 跨 workspace 隔离测试 |
| Review attempt 集成测试 | `apps/api/src/integration-tests/review-attempt-postgres.integration.ts` | review_attempts 表结构和隐私边界 |
| 回滚 runbook（v0.5） | `docs/runbooks/rollback-v0.5.md` | 6 阶段回滚流程 |
| ADR-0003 | `docs/adr/0003-data-classification-and-rls.md` | 数据分类与 RLS 设计决策 |
| 实施计划 §6.1 | `docs/plans/AI学习系统-v0.5-版本实施计划-2026-07-18.md` | SEC-01 工作包定义和 DoD |
