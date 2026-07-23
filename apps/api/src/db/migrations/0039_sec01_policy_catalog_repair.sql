-- SEC-01 expansion-only forward repair.
--
-- 0038 accidentally treated restrictive guards and permissive admission
-- policies as alternatives. PostgreSQL ORs permissive policies together, then
-- ANDs that result with every restrictive policy, so both policy classes are
-- required. Rebuild only the catalog installed by 0019, 0020, and 0021.
--
-- This migration intentionally does not enable or force RLS. It refuses to run
-- if any target table is already enforcing RLS and leaves unrelated policies,
-- schemas, and tables untouched.

DO $migration$
DECLARE
  target_tables constant text[] := ARRAY[
    'workspaces',
    'workspace_members',
    'invite_codes',
    'sources',
    'source_segments',
    'notes',
    'note_versions',
    'note_blocks',
    'learning_cards',
    'card_key_points',
    'evidences',
    'validation_questions',
    'search_documents',
    'ai_artifacts',
    'ai_audit_log',
    'benchmark_reports',
    'benchmark_labels',
    'evidence_overrides',
    'validation_events',
    'review_schedules',
    'understanding_events',
    'jobs',
    'review_attempts',
    'onboarding_states'
  ];
  invalid_tables text;
  activated_tables text;
BEGIN
  SELECT pg_catalog.string_agg(expected.table_name, ', ' ORDER BY expected.table_name)
  INTO invalid_tables
  FROM pg_catalog.unnest(target_tables) AS expected(table_name)
  LEFT JOIN pg_catalog.pg_class AS class
    ON class.oid = pg_catalog.to_regclass(
      pg_catalog.format('public.%I', expected.table_name)
    )
  WHERE class.oid IS NULL
    OR class.relkind NOT IN ('r', 'p');

  IF invalid_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'SEC-01 policy catalog repair requires all target tables in public: %',
      invalid_tables
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT pg_catalog.string_agg(class.relname, ', ' ORDER BY class.relname)
  INTO activated_tables
  FROM pg_catalog.pg_class AS class
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'public'
    AND class.relname = ANY(target_tables)
    AND (class.relrowsecurity OR class.relforcerowsecurity);

  IF activated_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'SEC-01 expansion repair refuses active RLS target tables: %',
      activated_tables
      USING ERRCODE = 'check_violation';
  END IF;
END
$migration$;
--> statement-breakpoint

-- Workspace root.
DROP POLICY IF EXISTS "sec01_v1_workspaces_tenant_guard" ON public."workspaces";
CREATE POLICY "sec01_v1_workspaces_tenant_guard"
  ON public."workspaces"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_workspaces_runtime_access" ON public."workspaces";
CREATE POLICY "sec01_v1_workspaces_runtime_access"
  ON public."workspaces"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
--> statement-breakpoint

-- Uniform workspace-owned rows. Identity/membership and benchmark tables are
-- API-only; the remaining tables also admit the Worker role.
DO $migration$
DECLARE
  table_name text;
  guard_name text;
  access_name text;
  runtime_role_predicate text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_members',
    'invite_codes',
    'sources',
    'source_segments',
    'notes',
    'note_versions',
    'note_blocks',
    'learning_cards',
    'card_key_points',
    'evidences',
    'search_documents',
    'benchmark_reports',
    'benchmark_labels'
  ]
  LOOP
    guard_name := 'sec01_v1_' || table_name || '_tenant_guard';
    access_name := 'sec01_v1_' || table_name || '_runtime_access';
    runtime_role_predicate := CASE
      WHEN table_name IN (
        'workspace_members', 'invite_codes', 'benchmark_reports', 'benchmark_labels'
      ) THEN 'CURRENT_USER = ''ailearn_api'''
      ELSE 'CURRENT_USER IN (''ailearn_api'', ''ailearn_worker'')'
    END;

    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      guard_name,
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (workspace_id = NULLIF(pg_catalog.current_setting(''app.workspace_id'', true), '''')::uuid) '
      || 'WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting(''app.workspace_id'', true), '''')::uuid)',
      guard_name,
      table_name
    );

    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      access_name,
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      || 'USING (%s) WITH CHECK (%s)',
      access_name,
      table_name,
      runtime_role_predicate,
      runtime_role_predicate
    );
  END LOOP;
END
$migration$;
--> statement-breakpoint

-- User-private rows require both tenant and actor guards.
DO $migration$
DECLARE
  table_name text;
  tenant_guard_name text;
  actor_guard_name text;
  access_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'evidence_overrides',
    'validation_events',
    'review_schedules',
    'understanding_events'
  ]
  LOOP
    tenant_guard_name := 'sec01_v1_' || table_name || '_tenant_guard';
    actor_guard_name := 'sec01_v1_' || table_name || '_actor_guard';
    access_name := 'sec01_v1_' || table_name || '_runtime_access';

    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      tenant_guard_name,
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (workspace_id = NULLIF(pg_catalog.current_setting(''app.workspace_id'', true), '''')::uuid) '
      || 'WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting(''app.workspace_id'', true), '''')::uuid)',
      tenant_guard_name,
      table_name
    );

    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      actor_guard_name,
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (user_id = NULLIF(pg_catalog.current_setting(''app.user_id'', true), '''')::uuid) '
      || 'WITH CHECK (user_id = NULLIF(pg_catalog.current_setting(''app.user_id'', true), '''')::uuid)',
      actor_guard_name,
      table_name
    );

    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      access_name,
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      || 'USING (CURRENT_USER IN (''ailearn_api'', ''ailearn_worker'')) '
      || 'WITH CHECK (CURRENT_USER IN (''ailearn_api'', ''ailearn_worker''))',
      access_name,
      table_name
    );
  END LOOP;
END
$migration$;
--> statement-breakpoint

-- Validation questions are private to created_by.
DROP POLICY IF EXISTS "sec01_v1_validation_questions_tenant_guard"
  ON public."validation_questions";
CREATE POLICY "sec01_v1_validation_questions_tenant_guard"
  ON public."validation_questions"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_validation_questions_creator_guard"
  ON public."validation_questions";
CREATE POLICY "sec01_v1_validation_questions_creator_guard"
  ON public."validation_questions"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "created_by" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    "created_by" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_validation_questions_api_access"
  ON public."validation_questions";
CREATE POLICY "sec01_v1_validation_questions_api_access"
  ON public."validation_questions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER = 'ailearn_api')
  WITH CHECK (CURRENT_USER = 'ailearn_api');
--> statement-breakpoint

-- Validation feedback artifacts add an actor guard; other artifact types are
-- workspace-shared.
DROP POLICY IF EXISTS "sec01_v1_ai_artifacts_tenant_guard"
  ON public."ai_artifacts";
CREATE POLICY "sec01_v1_ai_artifacts_tenant_guard"
  ON public."ai_artifacts"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_ai_artifacts_validation_actor_guard"
  ON public."ai_artifacts";
CREATE POLICY "sec01_v1_ai_artifacts_validation_actor_guard"
  ON public."ai_artifacts"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "type" <> 'validation_feedback'
    OR NULLIF("input_refs"->>'userId', '')::uuid
      = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    "type" <> 'validation_feedback'
    OR NULLIF("input_refs"->>'userId', '')::uuid
      = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_ai_artifacts_runtime_access"
  ON public."ai_artifacts";
CREATE POLICY "sec01_v1_ai_artifacts_runtime_access"
  ON public."ai_artifacts"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
--> statement-breakpoint

-- Audit log: tenant and insert-actor guards, owner read, API/Worker append.
DROP POLICY IF EXISTS "sec01_v1_ai_audit_tenant_guard"
  ON public."ai_audit_log";
CREATE POLICY "sec01_v1_ai_audit_tenant_guard"
  ON public."ai_audit_log"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_ai_audit_insert_actor_guard"
  ON public."ai_audit_log";
CREATE POLICY "sec01_v1_ai_audit_insert_actor_guard"
  ON public."ai_audit_log"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_ai_audit_api_owner_read"
  ON public."ai_audit_log";
CREATE POLICY "sec01_v1_ai_audit_api_owner_read"
  ON public."ai_audit_log"
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (
    CURRENT_USER = 'ailearn_api'
    AND "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM public."workspaces" AS workspace
      WHERE workspace."id" = "ai_audit_log"."workspace_id"
        AND workspace."owner_id"
          = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS "sec01_v1_ai_audit_runtime_insert"
  ON public."ai_audit_log";
CREATE POLICY "sec01_v1_ai_audit_runtime_insert"
  ON public."ai_audit_log"
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
--> statement-breakpoint

-- Jobs retain command-specific admission and actor guards.
DROP POLICY IF EXISTS "sec01_v1_jobs_tenant_guard" ON public."jobs";
CREATE POLICY "sec01_v1_jobs_tenant_guard"
  ON public."jobs"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_jobs_insert_actor_guard" ON public."jobs";
CREATE POLICY "sec01_v1_jobs_insert_actor_guard"
  ON public."jobs"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (
    "requested_by" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_jobs_worker_update_actor_guard" ON public."jobs";
CREATE POLICY "sec01_v1_jobs_worker_update_actor_guard"
  ON public."jobs"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING (
    "requested_by" IS NOT DISTINCT FROM
      NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    "requested_by" IS NOT DISTINCT FROM
      NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_jobs_api_workspace_select_policy" ON public."jobs";
CREATE POLICY "sec01_v1_jobs_api_workspace_select_policy"
  ON public."jobs" AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (CURRENT_USER = 'ailearn_api');

DROP POLICY IF EXISTS "sec01_v1_jobs_api_workspace_insert_actor_policy" ON public."jobs";
CREATE POLICY "sec01_v1_jobs_api_workspace_insert_actor_policy"
  ON public."jobs" AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (CURRENT_USER = 'ailearn_api');

DROP POLICY IF EXISTS "sec01_v1_jobs_api_workspace_delete_policy" ON public."jobs";
CREATE POLICY "sec01_v1_jobs_api_workspace_delete_policy"
  ON public."jobs" AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (CURRENT_USER = 'ailearn_api');

DROP POLICY IF EXISTS "sec01_v1_jobs_worker_workspace_select_policy" ON public."jobs";
CREATE POLICY "sec01_v1_jobs_worker_workspace_select_policy"
  ON public."jobs" AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (CURRENT_USER = 'ailearn_worker');

DROP POLICY IF EXISTS "sec01_v1_jobs_worker_workspace_update_policy" ON public."jobs";
CREATE POLICY "sec01_v1_jobs_worker_workspace_update_policy"
  ON public."jobs" AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (CURRENT_USER = 'ailearn_worker')
  WITH CHECK (CURRENT_USER = 'ailearn_worker');
--> statement-breakpoint

-- review_attempts uses the same tenant + actor + role admission pattern as
-- other user-private rows.
DROP POLICY IF EXISTS "sec01_v1_review_attempts_tenant_guard"
  ON public."review_attempts";
CREATE POLICY "sec01_v1_review_attempts_tenant_guard"
  ON public."review_attempts"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_review_attempts_actor_guard"
  ON public."review_attempts";
CREATE POLICY "sec01_v1_review_attempts_actor_guard"
  ON public."review_attempts"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_review_attempts_runtime_access"
  ON public."review_attempts";
CREATE POLICY "sec01_v1_review_attempts_runtime_access"
  ON public."review_attempts"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
--> statement-breakpoint

-- SEC-02 invite and onboarding policies are part of the catalog damaged by
-- 0038 and are restored with their original roles and commands.
DROP POLICY IF EXISTS "sec02_v1_invite_codes_tenant_guard"
  ON public."invite_codes";
CREATE POLICY "sec02_v1_invite_codes_tenant_guard"
  ON public."invite_codes"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec02_v1_invite_codes_runtime_access"
  ON public."invite_codes";
CREATE POLICY "sec02_v1_invite_codes_runtime_access"
  ON public."invite_codes"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));

DROP POLICY IF EXISTS "sec02_v1_onboarding_states_tenant_guard"
  ON public."onboarding_states";
CREATE POLICY "sec02_v1_onboarding_states_tenant_guard"
  ON public."onboarding_states"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec02_v1_onboarding_states_actor_guard"
  ON public."onboarding_states";
CREATE POLICY "sec02_v1_onboarding_states_actor_guard"
  ON public."onboarding_states"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec02_v1_onboarding_states_runtime_access"
  ON public."onboarding_states";
CREATE POLICY "sec02_v1_onboarding_states_runtime_access"
  ON public."onboarding_states"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
--> statement-breakpoint

-- Verify the exact known catalog shape. Unknown policies outside the explicit
-- public target set are deliberately ignored and never mutated.
DO $migration$
DECLARE
  target_tables constant text[] := ARRAY[
    'workspaces',
    'workspace_members',
    'invite_codes',
    'sources',
    'source_segments',
    'notes',
    'note_versions',
    'note_blocks',
    'learning_cards',
    'card_key_points',
    'evidences',
    'validation_questions',
    'search_documents',
    'ai_artifacts',
    'ai_audit_log',
    'benchmark_reports',
    'benchmark_labels',
    'evidence_overrides',
    'validation_events',
    'review_schedules',
    'understanding_events',
    'jobs',
    'review_attempts',
    'onboarding_states'
  ];
  expected_policy_keys constant text[] := ARRAY[
    'workspaces.sec01_v1_workspaces_tenant_guard',
    'workspaces.sec01_v1_workspaces_runtime_access',
    'workspace_members.sec01_v1_workspace_members_tenant_guard',
    'workspace_members.sec01_v1_workspace_members_runtime_access',
    'invite_codes.sec01_v1_invite_codes_tenant_guard',
    'invite_codes.sec01_v1_invite_codes_runtime_access',
    'sources.sec01_v1_sources_tenant_guard',
    'sources.sec01_v1_sources_runtime_access',
    'source_segments.sec01_v1_source_segments_tenant_guard',
    'source_segments.sec01_v1_source_segments_runtime_access',
    'notes.sec01_v1_notes_tenant_guard',
    'notes.sec01_v1_notes_runtime_access',
    'note_versions.sec01_v1_note_versions_tenant_guard',
    'note_versions.sec01_v1_note_versions_runtime_access',
    'note_blocks.sec01_v1_note_blocks_tenant_guard',
    'note_blocks.sec01_v1_note_blocks_runtime_access',
    'learning_cards.sec01_v1_learning_cards_tenant_guard',
    'learning_cards.sec01_v1_learning_cards_runtime_access',
    'card_key_points.sec01_v1_card_key_points_tenant_guard',
    'card_key_points.sec01_v1_card_key_points_runtime_access',
    'evidences.sec01_v1_evidences_tenant_guard',
    'evidences.sec01_v1_evidences_runtime_access',
    'validation_questions.sec01_v1_validation_questions_tenant_guard',
    'validation_questions.sec01_v1_validation_questions_creator_guard',
    'validation_questions.sec01_v1_validation_questions_api_access',
    'search_documents.sec01_v1_search_documents_tenant_guard',
    'search_documents.sec01_v1_search_documents_runtime_access',
    'ai_artifacts.sec01_v1_ai_artifacts_tenant_guard',
    'ai_artifacts.sec01_v1_ai_artifacts_validation_actor_guard',
    'ai_artifacts.sec01_v1_ai_artifacts_runtime_access',
    'ai_audit_log.sec01_v1_ai_audit_tenant_guard',
    'ai_audit_log.sec01_v1_ai_audit_insert_actor_guard',
    'ai_audit_log.sec01_v1_ai_audit_api_owner_read',
    'ai_audit_log.sec01_v1_ai_audit_runtime_insert',
    'benchmark_reports.sec01_v1_benchmark_reports_tenant_guard',
    'benchmark_reports.sec01_v1_benchmark_reports_runtime_access',
    'benchmark_labels.sec01_v1_benchmark_labels_tenant_guard',
    'benchmark_labels.sec01_v1_benchmark_labels_runtime_access',
    'evidence_overrides.sec01_v1_evidence_overrides_tenant_guard',
    'evidence_overrides.sec01_v1_evidence_overrides_actor_guard',
    'evidence_overrides.sec01_v1_evidence_overrides_runtime_access',
    'validation_events.sec01_v1_validation_events_tenant_guard',
    'validation_events.sec01_v1_validation_events_actor_guard',
    'validation_events.sec01_v1_validation_events_runtime_access',
    'review_schedules.sec01_v1_review_schedules_tenant_guard',
    'review_schedules.sec01_v1_review_schedules_actor_guard',
    'review_schedules.sec01_v1_review_schedules_runtime_access',
    'understanding_events.sec01_v1_understanding_events_tenant_guard',
    'understanding_events.sec01_v1_understanding_events_actor_guard',
    'understanding_events.sec01_v1_understanding_events_runtime_access',
    'jobs.sec01_v1_jobs_tenant_guard',
    'jobs.sec01_v1_jobs_insert_actor_guard',
    'jobs.sec01_v1_jobs_worker_update_actor_guard',
    'jobs.sec01_v1_jobs_api_workspace_select_policy',
    'jobs.sec01_v1_jobs_api_workspace_insert_actor_policy',
    'jobs.sec01_v1_jobs_api_workspace_delete_policy',
    'jobs.sec01_v1_jobs_worker_workspace_select_policy',
    'jobs.sec01_v1_jobs_worker_workspace_update_policy',
    'review_attempts.sec01_v1_review_attempts_tenant_guard',
    'review_attempts.sec01_v1_review_attempts_actor_guard',
    'review_attempts.sec01_v1_review_attempts_runtime_access',
    'invite_codes.sec02_v1_invite_codes_tenant_guard',
    'invite_codes.sec02_v1_invite_codes_runtime_access',
    'onboarding_states.sec02_v1_onboarding_states_tenant_guard',
    'onboarding_states.sec02_v1_onboarding_states_actor_guard',
    'onboarding_states.sec02_v1_onboarding_states_runtime_access'
  ];
  missing_policies text;
  unexpected_policies text;
  invalid_policies text;
  guard_count integer;
  admission_count integer;
  activated_tables text;
BEGIN
  IF pg_catalog.array_length(expected_policy_keys, 1) <> 66 THEN
    RAISE EXCEPTION 'SEC-01 policy manifest must contain 66 known policies'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT pg_catalog.string_agg(expected.policy_key, ', ' ORDER BY expected.policy_key)
  INTO missing_policies
  FROM pg_catalog.unnest(expected_policy_keys) AS expected(policy_key)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies AS policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename || '.' || policy.policyname = expected.policy_key
  );

  IF missing_policies IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-01 repair is missing known policies: %', missing_policies
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT pg_catalog.string_agg(
    policy.tablename || '.' || policy.policyname,
    ', ' ORDER BY policy.tablename, policy.policyname
  )
  INTO unexpected_policies
  FROM pg_catalog.pg_policies AS policy
  WHERE policy.schemaname = 'public'
    AND policy.tablename = ANY(target_tables)
    AND pg_catalog.left(policy.policyname, 9) IN ('sec01_v1_', 'sec02_v1_')
    AND policy.tablename || '.' || policy.policyname <> ALL(expected_policy_keys);

  IF unexpected_policies IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-01 repair found unexpected versioned policies: %',
      unexpected_policies
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT pg_catalog.string_agg(
    policy.tablename || '.' || policy.policyname,
    ', ' ORDER BY policy.tablename, policy.policyname
  )
  INTO invalid_policies
  FROM pg_catalog.pg_policies AS policy
  WHERE policy.schemaname = 'public'
    AND policy.tablename || '.' || policy.policyname = ANY(expected_policy_keys)
    AND (
      policy.roles IS DISTINCT FROM ARRAY['public']::name[]
      OR policy.permissive <> CASE
        WHEN pg_catalog.right(policy.policyname, 6) = '_guard'
          THEN 'RESTRICTIVE'
        ELSE 'PERMISSIVE'
      END
      OR policy.cmd <> CASE policy.policyname
        WHEN 'sec01_v1_ai_audit_insert_actor_guard' THEN 'INSERT'
        WHEN 'sec01_v1_ai_audit_api_owner_read' THEN 'SELECT'
        WHEN 'sec01_v1_ai_audit_runtime_insert' THEN 'INSERT'
        WHEN 'sec01_v1_jobs_insert_actor_guard' THEN 'INSERT'
        WHEN 'sec01_v1_jobs_worker_update_actor_guard' THEN 'UPDATE'
        WHEN 'sec01_v1_jobs_api_workspace_select_policy' THEN 'SELECT'
        WHEN 'sec01_v1_jobs_api_workspace_insert_actor_policy' THEN 'INSERT'
        WHEN 'sec01_v1_jobs_api_workspace_delete_policy' THEN 'DELETE'
        WHEN 'sec01_v1_jobs_worker_workspace_select_policy' THEN 'SELECT'
        WHEN 'sec01_v1_jobs_worker_workspace_update_policy' THEN 'UPDATE'
        ELSE 'ALL'
      END
    );

  IF invalid_policies IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-01 repair produced invalid policy metadata: %',
      invalid_policies
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (WHERE policy.permissive = 'RESTRICTIVE')::integer,
    pg_catalog.count(*) FILTER (WHERE policy.permissive = 'PERMISSIVE')::integer
  INTO guard_count, admission_count
  FROM pg_catalog.pg_policies AS policy
  WHERE policy.schemaname = 'public'
    AND policy.tablename || '.' || policy.policyname = ANY(expected_policy_keys);

  IF guard_count <> 36 OR admission_count <> 30 THEN
    RAISE EXCEPTION
      'SEC-01 repair expected 36 restrictive guards and 30 permissive admissions; got % and %',
      guard_count,
      admission_count
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT pg_catalog.string_agg(class.relname, ', ' ORDER BY class.relname)
  INTO activated_tables
  FROM pg_catalog.pg_class AS class
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'public'
    AND class.relname = ANY(target_tables)
    AND (class.relrowsecurity OR class.relforcerowsecurity);

  IF activated_tables IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-01 repair unexpectedly activated RLS on: %', activated_tables
      USING ERRCODE = 'check_violation';
  END IF;
END
$migration$;
