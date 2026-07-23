-- 0024_sec01_rls_enforce.sql
-- SEC-01: 启用行级安全（RLS ENABLE + FORCE）并收回 Worker 直接 UPDATE 权限
--
-- ⚠️  此迁移是 SEC-01 的 enforce 阶段，必须在以下前置条件全部满足后执行：
--     1. 0022 迁移已应用（SECURITY DEFINER 函数已创建）
--     2. 0023 迁移已应用（历史 validation_feedback input_refs.userId 已回填）
--     3. Worker 代码已更新（queue.ts / job-lease.ts 使用函数路径）
--     4. runEvaluateValidation handler 写入 input_refs.userId
--     5. 独立 security/data review 已通过
--     6. 跨 workspace RLS 集成测试在 enforce 模式下 0 泄漏
--     7. enforce 前数据库已加密备份并校验
--
-- 执行后：
-- - 所有 24 张核心表启用 RLS + FORCE RLS
-- - Worker 对 public.jobs 的直接 UPDATE 权限被收回
-- - Worker 仍通过 ailearn_renew_job_lease / ailearn_finish_job / ailearn_fail_job 操作 jobs
--
-- 回滚：见 docs/runbooks/sec01-enforce.md §回滚

-- ─── 1. 启用 RLS（ENABLE + FORCE）─────────────────────────────────

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

-- ─── 2. 收回 Worker 对 jobs 的直接 UPDATE 权限 ──────────────────

-- Worker 现在通过 SECURITY DEFINER 函数操作 jobs（0022 迁移），
-- 不再需要直接 UPDATE 权限。
-- SELECT 权限保留（用于 SELECT ... FOR UPDATE 行级锁）。
REVOKE UPDATE ON public.jobs FROM ailearn_worker;

-- ─── 3. 验证 enforce 结果 ─────────────────────────────────────────

-- 此查询在迁移执行后运行，确认所有表已启用 RLS 且强制。
-- 如果任何表未启用，将抛出异常阻止迁移完成。
DO $$
DECLARE
  unenforced_count integer;
BEGIN
  SELECT count(*)
  INTO unenforced_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'workspaces', 'workspace_members', 'invite_codes',
      'sources', 'source_segments', 'notes', 'note_versions', 'note_blocks',
      'learning_cards', 'card_key_points', 'evidences', 'validation_questions',
      'search_documents', 'ai_artifacts', 'ai_audit_log',
      'benchmark_reports', 'benchmark_labels',
      'evidence_overrides', 'validation_events', 'review_schedules',
      'understanding_events', 'jobs', 'review_attempts', 'onboarding_states'
    )
    AND (c.relrowsecurity = false OR c.relforcerowsecurity = false);

  IF unenforced_count > 0 THEN
    RAISE EXCEPTION 'SEC-01 enforce verification failed: % table(s) do not have RLS+FORCE enabled', unenforced_count
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- SEC-01 enforce: enable RLS+FORCE on all 24 core tables, revoke direct UPDATE
-- on jobs from ailearn_worker. Requires independent security/data review
-- approval before execution.
