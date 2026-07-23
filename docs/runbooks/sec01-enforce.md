# SEC-01 RLS Enforce Runbook

> **状态：PENDING INDEPENDENT SECURITY/DATA REVIEW**
>
> 本文档是 SEC-01 RLS enforce 的操作手册。enforce 迁移**不放在 migrations 目录中**，
> 以免被自动执行。独立 security/data review 通过后，将本文档中的 SQL 作为正式迁移
> 文件 `0024_sec01_rls_enforce.sql` 落地，并添加到 migration journal。

## 前置条件

在执行 enforce 之前，以下条件必须全部满足：

1. **0022 迁移已应用** — `ailearn_renew_job_lease`、`ailearn_finish_job`、
   `ailearn_fail_job` 三个 SECURITY DEFINER 函数已创建并 GRANT EXECUTE TO
   `ailearn_worker`。
2. **0023 迁移已应用** — 历史 `validation_feedback` artifacts 的
   `input_refs.userId` 已回填；孤立记录已标记 `quarantineNoActor`。
3. **Worker 代码已更新** — `queue.ts` 默认使用
   `createSqlFunctionQueueJobUpdater`；`job-lease.ts` 的 `lockJobLease` 使用
   `ailearn_renew_job_lease`。
4. **`runEvaluateValidation` handler 已更新** — 写入 `validation_feedback`
   artifact 时 `inputRefs` 包含 `userId`。
5. **独立 security/data review 已完成** — review 报告记录在 PR 或 ADR 中，
   明确确认 policy catalog、函数权限和数据分类正确。
6. **跨 workspace RLS 集成测试已通过** — `rls-policies-postgres.integration.ts`
   在 enforce 模式下 0 泄漏。
7. **备份已完成** — enforce 前的数据库已加密备份并校验。

## Enforce SQL

### 1. 启用 RLS（ENABLE + FORCE）

对所有已安装 policy 的表启用行级安全：

```sql
-- 22 张核心表（0019 覆盖）
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members FORCE ROW LEVEL SECURITY;

ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_codes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sources FORCE ROW LEVEL SECURITY;

ALTER TABLE public.source_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_segments FORCE ROW LEVEL SECURITY;

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.note_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_versions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.note_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_blocks FORCE ROW LEVEL SECURITY;

ALTER TABLE public.learning_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_cards FORCE ROW LEVEL SECURITY;

ALTER TABLE public.card_key_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_key_points FORCE ROW LEVEL SECURITY;

ALTER TABLE public.evidences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidences FORCE ROW LEVEL SECURITY;

ALTER TABLE public.validation_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.validation_questions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_documents FORCE ROW LEVEL SECURITY;

ALTER TABLE public.ai_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_artifacts FORCE ROW LEVEL SECURITY;

ALTER TABLE public.ai_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_audit_log FORCE ROW LEVEL SECURITY;

ALTER TABLE public.benchmark_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.benchmark_reports FORCE ROW LEVEL SECURITY;

ALTER TABLE public.benchmark_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.benchmark_labels FORCE ROW LEVEL SECURITY;

ALTER TABLE public.evidence_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_overrides FORCE ROW LEVEL SECURITY;

ALTER TABLE public.validation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.validation_events FORCE ROW LEVEL SECURITY;

ALTER TABLE public.review_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_schedules FORCE ROW LEVEL SECURITY;

ALTER TABLE public.understanding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.understanding_events FORCE ROW LEVEL SECURITY;

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

-- 0020 新增表
ALTER TABLE public.review_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_attempts FORCE ROW LEVEL SECURITY;

-- 0021 新增表
ALTER TABLE public.onboarding_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_states FORCE ROW LEVEL SECURITY;
```

### 2. 收回 Worker 对 jobs 的直接 UPDATE 权限

Worker 现在通过 `ailearn_renew_job_lease`/`ailearn_finish_job`/
`ailearn_fail_job` 三个 SECURITY DEFINER 函数操作 jobs，不再需要直接
UPDATE 权限：

```sql
REVOKE UPDATE ON public.jobs FROM ailearn_worker;
```

> **注意**：Worker 仍保留对 jobs 的 SELECT 权限（用于 `assertJobLease` 中的
> `SELECT ... FOR UPDATE` 行级锁）。SELECT FOR UPDATE 不需要 UPDATE 权限。

### 3. 验证 enforce 结果

```sql
-- 确认所有表已启用 RLS 且强制
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
WHERE pg_namespace.nspname = 'public'
  AND relname IN (
    'workspaces', 'workspace_members', 'invite_codes',
    'sources', 'source_segments', 'notes', 'note_versions', 'note_blocks',
    'learning_cards', 'card_key_points', 'evidences', 'validation_questions',
    'search_documents', 'ai_artifacts', 'ai_audit_log',
    'benchmark_reports', 'benchmark_labels',
    'evidence_overrides', 'validation_events', 'review_schedules',
    'understanding_events', 'jobs', 'review_attempts', 'onboarding_states'
  )
ORDER BY relname;
-- 预期：所有行的 relrowsecurity = true, relforcerowsecurity = true
```

## 回滚

如果 enforce 后发现严重问题，可以回滚：

```sql
-- 恢复 Worker 的直接 UPDATE 权限
GRANT UPDATE ON public.jobs TO ailearn_worker;

-- 禁用所有表的 RLS
ALTER TABLE public.workspaces NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces DISABLE ROW LEVEL SECURITY;
-- ... 对所有表重复
```

回滚后应立即排查问题，修复后重新执行 enforce。回滚期间系统恢复到
expand 阶段的安全状态（RLS 关闭，但 policy 和函数仍存在）。

## Enforce 后的验证清单

- [ ] API 在受限角色下完成核心闭环（创建笔记 → 生成卡 → 验证 → 复习）
- [ ] 跨 workspace 读取返回 0 行（workspace A 用户看不到 workspace B 数据）
- [ ] 跨 workspace 写入被 RLS 拒绝（42501 错误）
- [ ] Worker 通过函数完成 job 的 claim → renew → finish/fail 闭环
- [ ] Worker 直接 UPDATE jobs 被拒绝（REVOKE 生效）
- [ ] `validation_feedback` artifact 只能被 `input_refs.userId` 对应的用户读取
- [ ] 连接池复用 1,000 次 workspace 交替请求无上下文串线
- [ ] 双 Worker 在 RLS 下可领取和完成任务
```
