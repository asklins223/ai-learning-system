-- SEC-01 verify preparation: install the tenant policy catalog without
-- activating it.  This is still an expand-phase migration: every table must
-- remain relrowsecurity=false and relforcerowsecurity=false after it runs.
-- Enforcement is a later, independently reviewed migration.

-- A missing setting yields NULL, and an explicitly empty transaction-local
-- setting is converted to NULL.  Both therefore make USING/WITH CHECK false.
-- A malformed non-empty UUID raises instead of widening access.

-- Workspace roots use `id`; the remaining workspace-owned tables use their
-- direct `workspace_id`.  PUBLIC is intentional here: RLS never grants table
-- privileges, while avoiding a migration dependency on runtime roles keeps the
-- policy catalog installable in the single-role development stack.
DROP POLICY IF EXISTS "sec01_v1_workspaces_tenant_guard" ON "workspaces";
CREATE POLICY "sec01_v1_workspaces_tenant_guard"
  ON "workspaces"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_workspaces_runtime_access" ON "workspaces";
CREATE POLICY "sec01_v1_workspaces_runtime_access"
  ON "workspaces"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
--> statement-breakpoint

DO $migration$
DECLARE
  table_name text;
  guard_name text;
  access_name text;
  runtime_role_predicate text;
BEGIN
  -- Runtime predicates mirror roles.sql: identity/membership and benchmark
  -- tables are API-only; Worker is admitted only on its explicit business set.
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
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', guard_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (workspace_id = NULLIF(pg_catalog.current_setting(''app.workspace_id'', true), '''')::uuid) '
      || 'WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting(''app.workspace_id'', true), '''')::uuid)',
      guard_name,
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', access_name, table_name);
    EXECUTE format(
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

-- User-private rows require both dimensions.  Workspace owners do not receive
-- an implicit exception; any administrative access must use a separate,
-- narrowly scoped function instead of broadening these policies.
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
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tenant_guard_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (workspace_id = NULLIF(pg_catalog.current_setting(''app.workspace_id'', true), '''')::uuid) '
      || 'WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting(''app.workspace_id'', true), '''')::uuid)',
      tenant_guard_name,
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', actor_guard_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
      || 'USING (user_id = NULLIF(pg_catalog.current_setting(''app.user_id'', true), '''')::uuid) '
      || 'WITH CHECK (user_id = NULLIF(pg_catalog.current_setting(''app.user_id'', true), '''')::uuid)',
      actor_guard_name,
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', access_name, table_name);
    EXECUTE format(
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

-- Validation questions belong to their creator, not to every workspace
-- member.  The schema uses created_by rather than user_id, so keep this policy
-- separate from the uniform user-private tables above.
DROP POLICY IF EXISTS "sec01_v1_validation_questions_tenant_guard"
  ON "validation_questions";
CREATE POLICY "sec01_v1_validation_questions_tenant_guard"
  ON "validation_questions"
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
  ON "validation_questions";
CREATE POLICY "sec01_v1_validation_questions_creator_guard"
  ON "validation_questions"
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
  ON "validation_questions";
CREATE POLICY "sec01_v1_validation_questions_api_access"
  ON "validation_questions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER = 'ailearn_api')
  WITH CHECK (CURRENT_USER = 'ailearn_api');
--> statement-breakpoint

-- AI artifacts have mixed ownership. Workspace-derived artifacts are shared;
-- validation feedback is actor-private and must carry an exact canonical
-- input_refs.userId binding. Current Worker writes and historical rows do not
-- all satisfy that contract yet, which is an explicit blocker for the later
-- enforce migration rather than a reason to weaken this catalog.
DROP POLICY IF EXISTS "sec01_v1_ai_artifacts_tenant_guard" ON "ai_artifacts";
CREATE POLICY "sec01_v1_ai_artifacts_tenant_guard"
  ON "ai_artifacts"
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
  ON "ai_artifacts";
CREATE POLICY "sec01_v1_ai_artifacts_validation_actor_guard"
  ON "ai_artifacts"
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

DROP POLICY IF EXISTS "sec01_v1_ai_artifacts_runtime_access" ON "ai_artifacts";
CREATE POLICY "sec01_v1_ai_artifacts_runtime_access"
  ON "ai_artifacts"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
--> statement-breakpoint

-- AI audit is append-only. Restrictive guards fix tenant and insert actor;
-- permissive command policies admit API owner reads and API/Worker appends.
-- No runtime UPDATE or DELETE permissive policy exists.
DROP POLICY IF EXISTS "sec01_v1_ai_audit_tenant_guard" ON "ai_audit_log";
CREATE POLICY "sec01_v1_ai_audit_tenant_guard"
  ON "ai_audit_log"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_ai_audit_insert_actor_guard" ON "ai_audit_log";
CREATE POLICY "sec01_v1_ai_audit_insert_actor_guard"
  ON "ai_audit_log"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_ai_audit_api_owner_read" ON "ai_audit_log";
CREATE POLICY "sec01_v1_ai_audit_api_owner_read"
  ON "ai_audit_log"
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

DROP POLICY IF EXISTS "sec01_v1_ai_audit_runtime_insert" ON "ai_audit_log";
CREATE POLICY "sec01_v1_ai_audit_runtime_insert"
  ON "ai_audit_log"
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (
    CURRENT_USER IN ('ailearn_api', 'ailearn_worker')
  );
--> statement-breakpoint

-- Jobs have two deliberately different runtime surfaces:
--   * API may read/delete within its workspace and may create a job only when
--     requested_by is the transaction's authenticated actor. It has no direct
--     UPDATE policy because no API path updates a queued job.
--   * Worker may read/update a claimed job only inside its workspace handler
--     transaction. It receives no direct INSERT policy.
-- Cross-workspace claim/reap remains exclusively in the fixed SECURITY DEFINER
-- functions created by 0018; this migration does not replace either function.
DROP POLICY IF EXISTS "sec01_v1_jobs_tenant_guard" ON "jobs";
CREATE POLICY "sec01_v1_jobs_tenant_guard"
  ON "jobs"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS "sec01_v1_jobs_insert_actor_guard" ON "jobs";
CREATE POLICY "sec01_v1_jobs_insert_actor_guard"
  ON "jobs"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (
    "requested_by" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

-- A Worker may update only the actor-scoped job it is handling and may never
-- rewrite requested_by. IS NOT DISTINCT FROM intentionally preserves the
-- failure-finalization path for a legacy actor-less job under an empty actor
-- context; the separate tenant guard still requires a valid workspace.
DROP POLICY IF EXISTS "sec01_v1_jobs_worker_update_actor_guard" ON "jobs";
CREATE POLICY "sec01_v1_jobs_worker_update_actor_guard"
  ON "jobs"
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

DROP POLICY IF EXISTS "sec01_v1_jobs_api_workspace_select_policy" ON "jobs";
CREATE POLICY "sec01_v1_jobs_api_workspace_select_policy"
  ON "jobs" AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (CURRENT_USER = 'ailearn_api');

DROP POLICY IF EXISTS "sec01_v1_jobs_api_workspace_insert_actor_policy" ON "jobs";
CREATE POLICY "sec01_v1_jobs_api_workspace_insert_actor_policy"
  ON "jobs" AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (CURRENT_USER = 'ailearn_api');

DROP POLICY IF EXISTS "sec01_v1_jobs_api_workspace_delete_policy" ON "jobs";
CREATE POLICY "sec01_v1_jobs_api_workspace_delete_policy"
  ON "jobs" AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (CURRENT_USER = 'ailearn_api');

DROP POLICY IF EXISTS "sec01_v1_jobs_worker_workspace_select_policy" ON "jobs";
CREATE POLICY "sec01_v1_jobs_worker_workspace_select_policy"
  ON "jobs" AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (CURRENT_USER = 'ailearn_worker');

DROP POLICY IF EXISTS "sec01_v1_jobs_worker_workspace_update_policy" ON "jobs";
CREATE POLICY "sec01_v1_jobs_worker_workspace_update_policy"
  ON "jobs" AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (CURRENT_USER = 'ailearn_worker')
  WITH CHECK (CURRENT_USER = 'ailearn_worker');
--> statement-breakpoint

-- Expand-phase invariant: policy creation must never silently become enforce.
DO $migration$
DECLARE
  activated_tables text;
BEGIN
  SELECT pg_catalog.string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO activated_tables
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'workspaces', 'workspace_members', 'invite_codes',
      'sources', 'source_segments', 'notes', 'note_versions', 'note_blocks',
      'learning_cards', 'card_key_points', 'evidences', 'validation_questions',
      'search_documents', 'ai_artifacts', 'ai_audit_log',
      'benchmark_reports', 'benchmark_labels',
      'evidence_overrides', 'validation_events', 'review_schedules',
      'understanding_events', 'jobs'
    )
    AND (c.relrowsecurity OR c.relforcerowsecurity);

  IF activated_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'SEC-01 policy expand migration refuses pre-activated RLS tables: %',
      activated_tables;
  END IF;
END
$migration$;
