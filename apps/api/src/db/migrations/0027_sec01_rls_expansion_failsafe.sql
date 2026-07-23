-- 0027_sec01_rls_expansion_failsafe.sql
-- SEC-01 forward-only fail-safe: return the policy catalog to expansion mode.
--
-- Migration 0024 was placed in the automatic Drizzle journal before every API
-- and Worker workspace-owned query had been moved into a transaction carrying
-- transaction-local app.workspace_id/app.user_id context.  Production compose
-- simultaneously requires REQUIRE_RLS_DISABLED=true during the post-migration
-- role-grants pass.  Leaving 0024 as the migration endpoint therefore makes a
-- fresh production deployment either fail role-grants or start with broken
-- authentication, workspace, export, review, queue, and Worker paths.
--
-- Do not edit or remove 0024: deployed databases need a forward migration.
-- Policies remain installed for review and verification, but RLS enforcement
-- stays disabled until all runtime access is transaction-scoped and the SEC-01
-- enforce prerequisites can be satisfied together.  A future reviewed forward
-- migration may enable and force RLS again.

-- ─── 1. Return all 0024 tables to expansion mode ───────────────────

ALTER TABLE public.workspaces NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.workspace_members NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.invite_codes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invite_codes DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.sources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sources DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.source_segments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.source_segments DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.notes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.notes DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.note_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.note_versions DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.note_blocks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.note_blocks DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.learning_cards NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.learning_cards DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.card_key_points NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.card_key_points DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.evidences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.evidences DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.validation_questions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.validation_questions DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.search_documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.search_documents DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.ai_artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_artifacts DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.ai_audit_log NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_audit_log DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.benchmark_reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.benchmark_reports DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.benchmark_labels NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.benchmark_labels DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.evidence_overrides NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_overrides DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.validation_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.validation_events DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.review_schedules NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.review_schedules DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.understanding_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.understanding_events DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.jobs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.jobs DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.review_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.review_attempts DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.onboarding_states NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_states DISABLE ROW LEVEL SECURITY;

-- ─── 2. Restore the expansion-phase Worker table privilege ─────────

-- Restore the expansion-phase privilege matrix used by roles.sql.  It remains
-- available until every runtime path is verified against the narrower 0022
-- SECURITY DEFINER interface and RLS enforcement is approved again.
GRANT UPDATE ON TABLE public.jobs TO ailearn_worker;

-- ─── 3. Verify the forward fix atomically ───────────────────────────

DO $$
DECLARE
  enabled_count integer;
BEGIN
  SELECT count(*)
  INTO enabled_count
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
    AND (c.relrowsecurity OR c.relforcerowsecurity);

  IF enabled_count > 0 THEN
    RAISE EXCEPTION
      'SEC-01 expansion fail-safe verification failed: % table(s) still have RLS enabled or forced',
      enabled_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT has_table_privilege('ailearn_worker', 'public.jobs', 'UPDATE') THEN
    RAISE EXCEPTION
      'SEC-01 expansion fail-safe verification failed: ailearn_worker lacks jobs UPDATE'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;
