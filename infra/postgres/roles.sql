-- AI Learn System v0.4 database roles and grants.
--
-- This file is intentionally a psql script, not a PostgreSQL template with
-- literal `${PASSWORD}` placeholders.  apply-roles.sh supplies the three
-- passwords through psql variables (`-v ..._password=...`).  Run it as the
-- database administrator before and after migrations:
--
--   /bin/sh infra/postgres/apply-roles.sh
--
-- The script is safe to repeat.  It does not enable row-level security.  RLS
-- requires a trusted transaction-local workspace context and policies, which
-- are not part of the v0.4 connection model yet.

\set ON_ERROR_STOP on

-- Fail early when the wrapper was bypassed without supplying secrets.  The
-- values are quoted by psql's :'name' syntax before PostgreSQL sees them, then
-- held in transaction-local custom settings for the procedural checks below.
SELECT set_config('ailearn.migrator_password', :'migrator_password', false) AS ignored \gset
SELECT set_config('ailearn.api_password', :'api_password', false) AS ignored \gset
SELECT set_config('ailearn.worker_password', :'worker_password', false) AS ignored \gset
SELECT set_config('ailearn.require_rls_disabled', :'require_rls_disabled', false) AS ignored \gset
DO $$
BEGIN
  IF length(trim(current_setting('ailearn.migrator_password'))) = 0
    OR length(trim(current_setting('ailearn.api_password'))) = 0
    OR length(trim(current_setting('ailearn.worker_password'))) = 0
  THEN
    RAISE EXCEPTION 'role passwords must be non-empty';
  END IF;
END
$$;

-- Create the roles only when absent.  ALTER ROLE below also rotates a role's
-- password when the operator intentionally changes the environment value.
SELECT format(
  'CREATE ROLE ailearn_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS PASSWORD %L',
  :'migrator_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_migrator'
)\gexec

SELECT format(
  'CREATE ROLE ailearn_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'api_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api'
)\gexec

SELECT format(
  'CREATE ROLE ailearn_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'worker_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker'
)\gexec

ALTER ROLE ailearn_migrator
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS
  PASSWORD :'migrator_password';
ALTER ROLE ailearn_api
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'api_password';
ALTER ROLE ailearn_worker
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'worker_password';

-- Drizzle always emits CREATE SCHEMA IF NOT EXISTS for its journal, and
-- PostgreSQL checks database-level CREATE even when the schema already exists.
-- Only the dedicated migrator receives that DDL capability.
SELECT format(
  'GRANT CONNECT, CREATE ON DATABASE %I TO ailearn_migrator',
  current_database()
)\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO ailearn_api, ailearn_worker',
  current_database()
)\gexec
SELECT format(
  'REVOKE CREATE ON DATABASE %I FROM ailearn_api, ailearn_worker',
  current_database()
)\gexec

-- Keep the migration tracking schema owned by the migrator.  It is created
-- before the first migration so Drizzle can use a non-superuser connection.
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION ailearn_migrator;
ALTER SCHEMA drizzle OWNER TO ailearn_migrator;
GRANT USAGE, CREATE ON SCHEMA drizzle TO ailearn_migrator;
GRANT USAGE ON SCHEMA public TO ailearn_migrator, ailearn_api, ailearn_worker;
GRANT CREATE ON SCHEMA public TO ailearn_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM ailearn_api, ailearn_worker;

-- The application database may have been created with the old `ailearn`
-- owner.  Transfer only ordinary application objects so an existing database
-- can be upgraded by the migrator role; extension-owned objects are skipped.
DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
    -- PostgreSQL requires an owned sequence and its table to have the same
    -- owner.  A plain pg_dump restore creates both as the restore role, so
    -- transfer tables first; ALTER TABLE OWNER then carries linked sequences
    -- with it, and the final sequence pass is safe and deterministic.
    ORDER BY (c.relkind = 'S'), n.nspname, c.relname
  LOOP
    IF obj.relkind = 'S' THEN
      EXECUTE format(
        'ALTER SEQUENCE %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    ELSIF obj.relkind = 'v' THEN
      EXECUTE format(
        'ALTER VIEW %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    ELSIF obj.relkind = 'm' THEN
      EXECUTE format(
        'ALTER MATERIALIZED VIEW %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    ELSIF obj.relkind = 'f' THEN
      EXECUTE format(
        'ALTER FOREIGN TABLE %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    END IF;
  END LOOP;

  -- Enum/domain ownership matters for forward migrations that replace a
  -- legacy enum.  Extension-owned types remain under their extension owner.
  FOR obj IN
    SELECT n.nspname, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass
          AND d.objid = t.oid
          AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      'ALTER TYPE %I.%I OWNER TO ailearn_migrator',
      obj.nspname, obj.typname
    );
  END LOOP;
END
$$;

-- A plain pg_dump/psql restore with --no-owner recreates application
-- functions as the restore role.  Reconcile the five audited queue
-- entrypoints before applying their exact ACLs and validating SECURITY
-- DEFINER/search_path below; extension-owned functions remain untouched.
DO $$
BEGIN
  IF to_regprocedure('public.ailearn_claim_jobs(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_claim_jobs(integer, integer)
      OWNER TO ailearn_migrator;
  END IF;

  IF to_regprocedure('public.ailearn_reap_stale_jobs(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_reap_stale_jobs(integer, integer)
      OWNER TO ailearn_migrator;
  END IF;

  IF to_regprocedure('public.ailearn_renew_job_lease(uuid,uuid,text)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_renew_job_lease(uuid, uuid, text)
      OWNER TO ailearn_migrator;
  END IF;

  IF to_regprocedure('public.ailearn_finish_job(uuid,uuid,text)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_finish_job(uuid, uuid, text)
      OWNER TO ailearn_migrator;
  END IF;

  IF to_regprocedure('public.ailearn_fail_job(uuid,uuid,text,text,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer)
      OWNER TO ailearn_migrator;
  END IF;

  -- 0098/0100：新增的 SECURITY DEFINER 函数同样由迁移（dev 用 ailearn 角色）
  -- 创建，必须把 owner 收敛到 ailearn_migrator（BYPASSRLS 语义依赖）。
  IF to_regprocedure('public.ailearn_mark_dead_jobs_under_terminal_runs()') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_mark_dead_jobs_under_terminal_runs()
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_find_reaped_generation_jobs(uuid[])') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_find_reaped_generation_jobs(uuid[])
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_latest_dead_generation_job_ids(integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_latest_dead_generation_job_ids(integer)
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_queue_job_depth()') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_queue_job_depth()
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_queue_oldest_pending_age()') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_queue_oldest_pending_age()
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_enqueue_agent_turn_job(uuid,uuid,uuid,uuid,integer,text,integer,text,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_enqueue_agent_turn_job(uuid, uuid, uuid, uuid, integer, text, integer, text, text, text)
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_find_active_turn_job(uuid,uuid,uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_find_active_turn_job(uuid, uuid, uuid)
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_purge_companion_audit_ttl(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_purge_companion_audit_ttl(integer, integer)
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_purge_invitation_ledger_ttl(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_purge_invitation_ledger_ttl(integer, integer)
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_purge_processed_outbox_ttl(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_purge_processed_outbox_ttl(integer, integer)
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_purge_tutor_nonces_ttl(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_purge_tutor_nonces_ttl(integer, integer)
      OWNER TO ailearn_migrator;
  END IF;
END
$$;

-- Reset grants before applying the explicit matrix.  This removes privileges
-- left by the old shared `ailearn` connection without touching ownership.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ailearn_api, ailearn_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ailearn_api, ailearn_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ailearn_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ailearn_migrator;

-- API is the business CRUD role.  It deliberately receives no schema DDL or
-- migration-schema access beyond the read-only readiness query below.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public TO ailearn_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ailearn_api;

-- Worker read set. Keep identity/session/benchmark tables out of this list;
-- the personal model-config table is the narrow exception required to resolve
-- the initiating user's provider without granting access to users/sessions.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces',
    'notes',
    'note_versions',
    'note_blocks',
    'note_image_assets',
    'note_image_insights',
    'note_image_evidence_units',
    'sources',
    'source_segments',
    'learning_card_sets',
    'learning_cards',
    'card_key_points',
    'evidences',
    'evidence_overrides',
    'validation_events',
    'review_schedules',
    'jobs',
    'card_generation_runs',
    'card_generation_events',
    'note_evidence_spans',
    'card_generation_units',
    'card_generation_candidates',
    'card_generation_candidate_evidence',
    'card_generation_agent_events',
    'card_generation_source_bundles',
    'card_generation_source_bundle_members',
    'card_generation_drafts',
    'card_generation_quality_reports',
    'note_evidence_embeddings',
    'card_generation_plans',
    'provisional_candidates',
    'search_documents',
    'ai_artifacts',
    'user_ai_model_configs',
    'review_attempts',
    'validation_questions',
    'validation_question_rubric_items',
    'validation_submissions',
    'validation_assistance_exposures',
    'learning_sessions',
    'learning_episodes',
    'learning_session_probes',
    'learning_response_artifacts',
    'learning_assessment_reports',
    'learning_session_processing_outbox',
    'learning_unit_exposure',
    'learning_exposure_dependency_ledger',
    'learning_outbox_events',
    'learning_tutor_detours',
    'learning_tutor_permissions',
    'learning_tutor_action_nonces',
    'companion_conversations',
    'companion_messages',
    'companion_turn_runs',
    'companion_stream_events',
    'companion_action_proposals',
    'companion_action_runs'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO ailearn_worker', table_name);
    END IF;
  END LOOP;

  -- Exact write privileges exercised by the current worker handlers.  The
  -- SELECT grants above are intentionally retained because RETURNING and
  -- conflict updates require read access to affected columns.
  FOREACH table_name IN ARRAY ARRAY[
    'learning_card_sets',
    'learning_cards',
    'review_schedules',
    'jobs',
    'search_documents',
    'card_generation_units',
    'card_generation_candidates',
    'note_image_insights',
    'card_generation_agent_events',
    'card_generation_source_bundles',
    'card_generation_source_bundle_members',
    'card_generation_quality_reports',
    'note_evidence_embeddings'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT INSERT, UPDATE ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;

  IF to_regclass('public.card_generation_runs') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.card_generation_runs TO ailearn_worker;
  END IF;

  IF to_regclass('public.review_attempts') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.review_attempts TO ailearn_worker;
  END IF;

  IF to_regclass('public.validation_questions') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.validation_questions TO ailearn_worker;
  END IF;

  IF to_regclass('public.validation_question_rubric_items') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.validation_question_rubric_items TO ailearn_worker;
  END IF;

  IF to_regclass('public.validation_submissions') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.validation_submissions TO ailearn_worker;
  END IF;

  IF to_regclass('public.validation_point_assessments') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.validation_point_assessments TO ailearn_worker;
  END IF;

  IF to_regclass('public.scheduling_shadow_decisions') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.scheduling_shadow_decisions TO ailearn_worker;
  END IF;

  IF to_regclass('public.learning_assessment_reports') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.learning_assessment_reports TO ailearn_worker;
  END IF;

  -- 0077/0078 授予 worker 的最小写权限镜像（roles.sql 是唯一授权源；
  -- 不镜像的话 post-migration 重跑会 REVOKE 迁移授予的权限并被矩阵"判对"）。
  IF to_regclass('public.learning_unit_exposure') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.learning_unit_exposure TO ailearn_worker;
  END IF;
  IF to_regclass('public.learning_exposure_dependency_ledger') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.learning_exposure_dependency_ledger TO ailearn_worker;
  END IF;
  IF to_regclass('public.learning_outbox_events') IS NOT NULL THEN
    -- 0078 语义：worker 只读 + 标记消费（UPDATE processed_at），无 INSERT。
    GRANT UPDATE ON TABLE public.learning_outbox_events TO ailearn_worker;
  END IF;

  -- P2/P5 companion runtime：worker 读取对话/run/action 状态，写入对话
  -- 结果和事件，并只更新 API 已创建的 run/proposal/sequence 投影；不授予
  -- worker 创建 action proposal/run 或删除会话数据的权限。
  IF to_regclass('public.companion_conversations') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.companion_conversations TO ailearn_worker;
  END IF;
  IF to_regclass('public.companion_messages') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.companion_messages TO ailearn_worker;
  END IF;
  IF to_regclass('public.companion_turn_runs') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.companion_turn_runs TO ailearn_worker;
  END IF;
  IF to_regclass('public.companion_stream_events') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_stream_events TO ailearn_worker;
  END IF;
  IF to_regclass('public.companion_action_proposals') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.companion_action_proposals TO ailearn_worker;
  END IF;
  IF to_regclass('public.companion_action_runs') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.companion_action_runs TO ailearn_worker;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'learning_episodes',
    'learning_response_artifacts',
    'learning_session_processing_outbox'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT UPDATE ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'ai_artifacts',
    'card_key_points',
    'evidence_overrides',
    'card_generation_events',
    'note_evidence_spans',
    'note_image_evidence_units',
    'card_generation_candidate_evidence',
    'validation_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('GRANT INSERT ON TABLE public.%I TO ailearn_worker', table_name);
    END IF;
  END LOOP;

  IF to_regclass('public.card_generation_candidate_evidence') IS NOT NULL THEN
    -- 0100：candidate-ledger 删除证据路径（与矩阵 can_delete=true 对齐，
    -- 否则 roles.sql 重跑矩阵校验 RAISE）。
    GRANT DELETE ON TABLE public.card_generation_candidate_evidence TO ailearn_worker;
  END IF;

  -- 0071 已授予 worker 的 plans/provisional 写权限（生成流程在 workspace 事务内
  -- INSERT plan / provisional candidates）；roles.sql 此前未收录这两张表，
  -- 重跑会 REVOKE 并致 worker 生成路径权限失败——此处补齐。
  IF to_regclass('public.card_generation_plans') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.card_generation_plans TO ailearn_worker;
  END IF;
  IF to_regclass('public.provisional_candidates') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.provisional_candidates TO ailearn_worker;
  END IF;

  IF to_regclass('public.evidences') IS NOT NULL THEN
    GRANT INSERT, DELETE ON TABLE public.evidences TO ailearn_worker;
  END IF;
  IF to_regclass('public.sources') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.sources TO ailearn_worker;
  END IF;
  IF to_regclass('public.source_segments') IS NOT NULL THEN
    GRANT INSERT, DELETE ON TABLE public.source_segments TO ailearn_worker;
  END IF;
  IF to_regclass('public.search_documents') IS NOT NULL THEN
    GRANT DELETE ON TABLE public.search_documents TO ailearn_worker;
  END IF;

  IF to_regclass('public.understanding_events') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.understanding_events TO ailearn_worker;
  END IF;
  IF to_regclass('public.ai_audit_log') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.ai_audit_log TO ailearn_worker;
  END IF;

  -- ─── 方案 20 V2（迁移 0135/0138；与 0142 grant repair 对齐）──────────
  -- V2 管线以 ailearn_worker（NOBYPASSRLS）直查 V2 表。roles.sql 是唯一
  -- 授权源：不镜像的话每次 bootstrap 的 REVOKE ALL 会清掉 0135/0138 的
  -- 迁移授权并导致 worker 管线 permission denied。
  -- 16 张核心表 full CRUD（outbox claim/complete、runs/plans/candidates、
  -- objectives/revisions/cards/publications/reminders/receipts/events）。
  FOREACH table_name IN ARRAY ARRAY[
    'card_generation_runs_v2',
    'card_generation_plans_v2',
    'card_generation_candidates_v2',
    'learning_objectives_v2',
    'learning_objective_revisions_v2',
    'learning_cards_v2',
    'learning_card_publication_revisions_v2',
    'card_exposure_ledger_v2',
    'initial_validation_reminders_v2',
    'card_activation_receipts_v2',
    'card_generation_events_v2',
    'legacy_target_snapshot_attachments_v2',
    'candidate_evidence_binding_plans_v2',
    'evidence_eligibility_states_v2',
    'card_generation_run_outbox_v2',
    'learning_target_snapshots_v2'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;

  -- capability state：worker 更新/读取 epoch（§18.1）
  IF to_regclass('public.card_content_capability_state') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.card_content_capability_state
      TO ailearn_worker;
  END IF;

  -- 管线写入/回读表（specs/input snapshots/evidence 域/equivalence/lineage/
  -- exposures/candidate quality+lineage+feedback）：worker SELECT + INSERT
  FOREACH table_name IN ARRAY ARRAY[
    'card_generation_semantic_specs_v2',
    'card_generation_input_snapshots_v2',
    'evidence_snapshots_v2',
    'evidence_redactions_v2',
    'semantic_support_reports_v2',
    'learning_objective_evidence_bindings_v2',
    'learning_objective_equivalence_reports_v2',
    'learning_objective_revision_equivalence_v2',
    'learning_objective_private_contracts_v2',
    'learning_objective_lineage_v2',
    'learning_exposures_v2',
    'card_candidate_quality_reports_v2',
    'card_candidate_lineage_v2',
    'card_candidate_feedback_v2'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ailearn_worker;

-- SEC-01 expand phase: the Worker may cross workspace boundaries only through
-- these fixed queue functions.  The functions are created by migrations 0018
-- and 0022;
-- the pre-migration bootstrap pass safely skips them, while the post-migration
-- pass revokes ambient access and grants the exact signatures to Worker only.
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM PUBLIC, ailearn_api, ailearn_worker;

DO $$
BEGIN
  IF to_regprocedure('public.ailearn_claim_jobs(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_claim_jobs(integer, integer)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_claim_jobs(integer, integer)
      TO ailearn_worker;
  END IF;

  IF to_regprocedure('public.ailearn_reap_stale_jobs(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_reap_stale_jobs(integer, integer)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_reap_stale_jobs(integer, integer)
      TO ailearn_worker;
  END IF;

  IF to_regprocedure('public.ailearn_renew_job_lease(uuid,uuid,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_renew_job_lease(uuid, uuid, text)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_renew_job_lease(uuid, uuid, text)
      TO ailearn_worker;
  END IF;

  IF to_regprocedure('public.ailearn_finish_job(uuid,uuid,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_finish_job(uuid, uuid, text)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_finish_job(uuid, uuid, text)
      TO ailearn_worker;
  END IF;

  IF to_regprocedure('public.ailearn_fail_job(uuid,uuid,text,text,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer)
      TO ailearn_worker;
  END IF;

  -- 0098：jobs RLS 重开后的跨 workspace 维护函数（migrator owner BYPASSRLS）。
  IF to_regprocedure('public.ailearn_mark_dead_jobs_under_terminal_runs()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_mark_dead_jobs_under_terminal_runs()
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_mark_dead_jobs_under_terminal_runs()
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.ailearn_find_reaped_generation_jobs(uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_find_reaped_generation_jobs(uuid[])
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_find_reaped_generation_jobs(uuid[])
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.ailearn_latest_dead_generation_job_ids(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_latest_dead_generation_job_ids(integer)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_latest_dead_generation_job_ids(integer)
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.ailearn_queue_job_depth()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_queue_job_depth()
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_queue_job_depth()
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.ailearn_queue_oldest_pending_age()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_queue_oldest_pending_age()
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_queue_oldest_pending_age()
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.ailearn_enqueue_agent_turn_job(uuid,uuid,uuid,uuid,integer,text,integer,text,text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_enqueue_agent_turn_job(uuid,uuid,uuid,uuid,integer,text,integer,text,text,text)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_agent_turn_job(uuid,uuid,uuid,uuid,integer,text,integer,text,text,text)
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.ailearn_find_active_turn_job(uuid,uuid,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_find_active_turn_job(uuid,uuid,uuid)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_find_active_turn_job(uuid,uuid,uuid)
      TO ailearn_worker;
  END IF;

  -- 0134（方案 16 e2e）：note_evidence_embeddings 写入需要 vector 类型
  -- input function（`'[...]'::vector` 走 vector_in 而非 vector 函数本身）。
  -- worker 是 embeddings 唯一写入者；api 无写路径，不授权（api 白名单
  -- 校验会拒绝非白名单 EXECUTE）。
  IF to_regprocedure('public.vector_in(cstring,oid,integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.vector_in(cstring, oid, integer)
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.vector(vector,integer,boolean)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.vector(vector, integer, boolean)
      TO ailearn_worker;
  END IF;

  -- 0098：TTL 清理函数经 SECURITY DEFINER（migrator owner BYPASSRLS）执行，
  -- 由 API 进程（server.ts 每 6 小时定时）调用——API 需要 EXECUTE。
  IF to_regprocedure('public.ailearn_purge_companion_audit_ttl(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_purge_companion_audit_ttl(integer, integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_purge_companion_audit_ttl(integer, integer)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.ailearn_purge_invitation_ledger_ttl(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_purge_invitation_ledger_ttl(integer, integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_purge_invitation_ledger_ttl(integer, integer)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.ailearn_purge_processed_outbox_ttl(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_purge_processed_outbox_ttl(integer, integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_purge_processed_outbox_ttl(integer, integer)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.ailearn_purge_tutor_nonces_ttl(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_purge_tutor_nonces_ttl(integer, integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_purge_tutor_nonces_ttl(integer, integer)
      TO ailearn_api;
  END IF;
END
$$;

-- Drizzle readiness only needs to inspect the journal.  The worker does not
-- need migration metadata and therefore receives no drizzle-schema grant.
DO $$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA drizzle TO ailearn_api;
    GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO ailearn_api;
    GRANT ALL PRIVILEGES ON TABLE drizzle.__drizzle_migrations TO ailearn_migrator;
  END IF;
END
$$;

-- New objects created by the migrator receive the same baseline defaults.
ALTER DEFAULT PRIVILEGES FOR ROLE ailearn_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ailearn_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ailearn_api;
ALTER DEFAULT PRIVILEGES FOR ROLE ailearn_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ailearn_api;
ALTER DEFAULT PRIVILEGES FOR ROLE ailearn_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ailearn_migrator IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Worker privileges are deliberately not granted by default.  This script is
-- re-applied after migrations, so a newly introduced table remains invisible
-- until its handler access is added to the explicit matrix above.

-- Application enums are used in query parameters and therefore need USAGE.
DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT n.nspname, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd')
  LOOP
    EXECUTE format(
      'GRANT USAGE ON TYPE %I.%I TO ailearn_api, ailearn_worker',
      obj.nspname, obj.typname
    );
    EXECUTE format(
      'GRANT USAGE ON TYPE %I.%I TO ailearn_migrator',
      obj.nspname, obj.typname
    );
  END LOOP;
END
$$;

-- Executable least-privilege verification.  Keeping this next to the grants
-- makes the production role-grants service fail before API/Worker start if a
-- future schema or grant change expands access unexpectedly.
DO $$
DECLARE
  mismatch text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'ailearn_migrator'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolinherit AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'ailearn_migrator role attributes are invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('ailearn_api', 'ailearn_worker')
      AND (
        NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolinherit OR rolbypassrls
      )
  ) OR (
    SELECT count(*) FROM pg_roles
    WHERE rolname IN ('ailearn_api', 'ailearn_worker')
  ) <> 2 THEN
    RAISE EXCEPTION 'API/Worker role attributes are invalid';
  END IF;

  IF NOT has_database_privilege(
    'ailearn_migrator', current_database(), 'CREATE'
  ) OR NOT has_schema_privilege(
    'ailearn_migrator', 'public', 'CREATE'
  ) THEN
    RAISE EXCEPTION 'migrator is missing database/schema DDL privileges';
  END IF;
  IF has_database_privilege('ailearn_api', current_database(), 'CREATE')
    OR has_database_privilege('ailearn_worker', current_database(), 'CREATE')
    OR has_schema_privilege('ailearn_api', 'public', 'CREATE')
    OR has_schema_privilege('ailearn_worker', 'public', 'CREATE')
  THEN
    RAISE EXCEPTION 'API/Worker unexpectedly have DDL privileges';
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
  INTO mismatch
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND pg_get_userbyid(c.relowner) <> 'ailearn_migrator'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend d
      WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid
        AND d.deptype = 'e'
    );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'non-migrator object owners: %', mismatch;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
  INTO mismatch
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND (
      NOT has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'SELECT'
      )
      OR NOT has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'INSERT'
      )
      OR NOT has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'UPDATE'
      )
      OR NOT has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'DELETE'
      )
      OR has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'TRUNCATE'
      )
      OR has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'REFERENCES'
      )
      OR has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'TRIGGER'
      )
    );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'API privilege matrix mismatch: %', mismatch;
  END IF;

  WITH expected(
    table_name, can_select, can_insert, can_update, can_delete
  ) AS (
    VALUES
      ('workspaces', true, false, false, false),
      ('notes', true, false, false, false),
      ('note_versions', true, false, false, false),
      ('note_blocks', true, false, false, false),
      ('note_image_assets', true, false, false, false),
      ('note_image_insights', true, true, true, false),
      ('note_image_evidence_units', true, true, false, false),
      ('sources', true, false, true, false),
      ('source_segments', true, true, false, true),
      ('learning_card_sets', true, true, true, false),
      ('learning_cards', true, true, true, false),
      ('card_key_points', true, true, false, false),
      ('evidences', true, true, false, true),
      ('evidence_overrides', true, true, false, false),
      ('validation_events', true, true, false, false),
      ('review_schedules', true, true, true, false),
      ('jobs', true, true, true, false),
      ('card_generation_runs', true, false, true, false),
      ('card_generation_events', true, true, false, false),
      ('note_evidence_spans', true, true, false, false),
      ('card_generation_units', true, true, true, false),
      ('card_generation_candidates', true, true, true, false),
      ('card_generation_candidate_evidence', true, true, false, true),
      ('card_generation_plans', true, true, false, false),
      ('provisional_candidates', true, true, true, false),
      ('card_generation_agent_events', true, true, true, false),
      ('card_generation_source_bundles', true, true, true, false),
      ('card_generation_source_bundle_members', true, true, true, false),
      ('card_generation_drafts', true, false, false, false),
      ('card_generation_quality_reports', true, true, true, false),
      ('note_evidence_embeddings', true, true, true, false),
      ('search_documents', true, true, true, true),
      ('ai_artifacts', true, true, false, false),
      ('user_ai_model_configs', true, false, false, false),
      ('review_attempts', true, false, true, false),
      ('validation_questions', true, true, false, false),
      ('validation_question_rubric_items', true, true, false, false),
      ('validation_submissions', true, false, true, false),
      ('validation_assistance_exposures', true, false, false, false),
      ('validation_point_assessments', false, true, false, false),
      ('scheduling_shadow_decisions', false, true, false, false),
      ('learning_sessions', true, false, false, false),
      ('learning_episodes', true, false, true, false),
      ('learning_session_probes', true, false, false, false),
      ('learning_response_artifacts', true, false, true, false),
      ('learning_assessment_reports', true, true, false, false),
      ('learning_session_processing_outbox', true, false, true, false),
      ('learning_unit_exposure', true, true, true, false),
      ('learning_exposure_dependency_ledger', true, true, true, false),
      ('learning_outbox_events', true, false, true, false),
      ('learning_tutor_detours', true, false, false, false),
      ('learning_tutor_permissions', true, false, false, false),
      ('learning_tutor_action_nonces', true, false, false, false),
      ('companion_conversations', true, false, true, false),
      ('companion_messages', true, true, false, false),
      ('companion_turn_runs', true, false, true, false),
      ('companion_stream_events', true, true, true, false),
      ('companion_action_proposals', true, false, true, false),
      ('companion_action_runs', true, false, true, false),
      ('understanding_events', false, true, false, false),
      ('ai_audit_log', false, true, false, false),
      -- 方案 20 V2（迁移 0135/0138；与 grant 授权镜像一致）
      ('card_generation_runs_v2', true, true, true, true),
      ('card_generation_plans_v2', true, true, true, true),
      ('card_generation_candidates_v2', true, true, true, true),
      ('learning_objectives_v2', true, true, true, true),
      ('learning_objective_revisions_v2', true, true, true, true),
      ('learning_cards_v2', true, true, true, true),
      ('learning_card_publication_revisions_v2', true, true, true, true),
      ('card_exposure_ledger_v2', true, true, true, true),
      ('initial_validation_reminders_v2', true, true, true, true),
      ('card_activation_receipts_v2', true, true, true, true),
      ('card_generation_events_v2', true, true, true, true),
      ('legacy_target_snapshot_attachments_v2', true, true, true, true),
      ('candidate_evidence_binding_plans_v2', true, true, true, true),
      ('evidence_eligibility_states_v2', true, true, true, true),
      ('card_generation_run_outbox_v2', true, true, true, true),
      ('learning_target_snapshots_v2', true, true, true, true),
      ('card_content_capability_state', true, true, true, false),
      ('card_generation_semantic_specs_v2', true, true, false, false),
      ('card_generation_input_snapshots_v2', true, true, false, false),
      ('evidence_snapshots_v2', true, true, false, false),
      ('evidence_redactions_v2', true, true, false, false),
      ('semantic_support_reports_v2', true, true, false, false),
      ('learning_objective_evidence_bindings_v2', true, true, false, false),
      ('learning_objective_equivalence_reports_v2', true, true, false, false),
      ('learning_objective_revision_equivalence_v2', true, true, false, false),
      ('learning_objective_private_contracts_v2', true, true, false, false),
      ('learning_objective_lineage_v2', true, true, false, false),
      ('learning_exposures_v2', true, true, false, false),
      ('card_candidate_quality_reports_v2', true, true, false, false),
      ('card_candidate_lineage_v2', true, true, false, false),
      ('card_candidate_feedback_v2', true, true, false, false)
  ), actual AS (
    SELECT
      c.relname AS table_name,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'SELECT'
      ) AS can_select,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'INSERT'
      ) AS can_insert,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'UPDATE'
      ) AS can_update,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'DELETE'
      ) AS can_delete,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'TRUNCATE'
      ) OR has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'REFERENCES'
      ) OR has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'TRIGGER'
      ) AS has_admin_table_privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  )
  SELECT string_agg(actual.table_name, ', ')
  INTO mismatch
  FROM actual
  LEFT JOIN expected USING (table_name)
  WHERE actual.can_select <> coalesce(expected.can_select, false)
    OR actual.can_insert <> coalesce(expected.can_insert, false)
    OR actual.can_update <> coalesce(expected.can_update, false)
    OR actual.can_delete <> coalesce(expected.can_delete, false)
    OR actual.has_admin_table_privilege;
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'Worker privilege matrix mismatch: %', mismatch;
  END IF;

  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AND (
    NOT has_schema_privilege('ailearn_api', 'drizzle', 'USAGE')
    OR NOT has_table_privilege(
      'ailearn_api', 'drizzle.__drizzle_migrations', 'SELECT'
    )
    OR has_schema_privilege('ailearn_worker', 'drizzle', 'USAGE')
  ) THEN
    RAISE EXCEPTION 'migration journal privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.ailearn_claim_jobs(integer,integer)') IS NOT NULL AND (
    NOT has_function_privilege(
      'ailearn_worker', 'public.ailearn_claim_jobs(integer,integer)', 'EXECUTE'
    )
    OR has_function_privilege(
      'ailearn_api', 'public.ailearn_claim_jobs(integer,integer)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job claim function privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.ailearn_reap_stale_jobs(integer,integer)') IS NOT NULL AND (
    NOT has_function_privilege(
      'ailearn_worker', 'public.ailearn_reap_stale_jobs(integer,integer)', 'EXECUTE'
    )
    OR has_function_privilege(
      'ailearn_api', 'public.ailearn_reap_stale_jobs(integer,integer)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job reap function privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.ailearn_renew_job_lease(uuid,uuid,text)') IS NOT NULL AND (
    NOT has_function_privilege(
      'ailearn_worker', 'public.ailearn_renew_job_lease(uuid,uuid,text)', 'EXECUTE'
    )
    OR has_function_privilege(
      'ailearn_api', 'public.ailearn_renew_job_lease(uuid,uuid,text)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job lease renewal function privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.ailearn_finish_job(uuid,uuid,text)') IS NOT NULL AND (
    NOT has_function_privilege(
      'ailearn_worker', 'public.ailearn_finish_job(uuid,uuid,text)', 'EXECUTE'
    )
    OR has_function_privilege(
      'ailearn_api', 'public.ailearn_finish_job(uuid,uuid,text)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job finish function privilege matrix mismatch';
  END IF;

  IF to_regprocedure('public.ailearn_fail_job(uuid,uuid,text,text,integer)') IS NOT NULL AND (
    NOT has_function_privilege(
      'ailearn_worker', 'public.ailearn_fail_job(uuid,uuid,text,text,integer)', 'EXECUTE'
    )
    OR has_function_privilege(
      'ailearn_api', 'public.ailearn_fail_job(uuid,uuid,text,text,integer)', 'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'job failure function privilege matrix mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid IN (
      to_regprocedure('public.ailearn_claim_jobs(integer,integer)'),
      to_regprocedure('public.ailearn_reap_stale_jobs(integer,integer)'),
      to_regprocedure('public.ailearn_renew_job_lease(uuid,uuid,text)'),
      to_regprocedure('public.ailearn_finish_job(uuid,uuid,text)'),
      to_regprocedure('public.ailearn_fail_job(uuid,uuid,text,text,integer)'),
      to_regprocedure('public.ailearn_mark_dead_jobs_under_terminal_runs()'),
      to_regprocedure('public.ailearn_find_reaped_generation_jobs(uuid[])'),
      to_regprocedure('public.ailearn_latest_dead_generation_job_ids(integer)'),
      to_regprocedure('public.ailearn_queue_job_depth()'),
      to_regprocedure('public.ailearn_queue_oldest_pending_age()'),
      to_regprocedure('public.ailearn_enqueue_agent_turn_job(uuid,uuid,uuid,uuid,integer,text,integer,text,text,text)'),
      to_regprocedure('public.ailearn_find_active_turn_job(uuid,uuid,uuid)'),
      to_regprocedure('public.ailearn_purge_companion_audit_ttl(integer,integer)'),
      to_regprocedure('public.ailearn_purge_invitation_ledger_ttl(integer,integer)'),
      to_regprocedure('public.ailearn_purge_processed_outbox_ttl(integer,integer)'),
      to_regprocedure('public.ailearn_purge_tutor_nonces_ttl(integer,integer)')
    )
      AND (
        NOT p.prosecdef
        OR p.proowner <> 'ailearn_migrator'::regrole
        OR p.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, public']::text[]
      )
  ) THEN
    RAISE EXCEPTION 'job queue function security contract mismatch';
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ')
  INTO mismatch
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND has_function_privilege('ailearn_worker', p.oid, 'EXECUTE')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_claim_jobs(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_reap_stale_jobs(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_renew_job_lease(uuid,uuid,text)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_finish_job(uuid,uuid,text)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_fail_job(uuid,uuid,text,text,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_mark_dead_jobs_under_terminal_runs()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_find_reaped_generation_jobs(uuid[])')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_latest_dead_generation_job_ids(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_queue_job_depth()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_queue_oldest_pending_age()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_enqueue_agent_turn_job(uuid,uuid,uuid,uuid,integer,text,integer,text,text,text)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_find_active_turn_job(uuid,uuid,uuid)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.vector_in(cstring,oid,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.vector(vector,integer,boolean)');
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'Worker has unexpected function EXECUTE privileges: %', mismatch;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ')
  INTO mismatch
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND has_function_privilege('ailearn_api', p.oid, 'EXECUTE')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_purge_companion_audit_ttl(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_purge_invitation_ledger_ttl(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_purge_processed_outbox_ttl(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_purge_tutor_nonces_ttl(integer,integer)');
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'API has unexpected function EXECUTE privileges: %', mismatch;
  END IF;
END
$$;

-- Explicitly document the current security posture.  Do not silently turn on
-- RLS from a bootstrap script that has no policies or workspace context.  The
-- pre-migration pass allows an older database to reach the forward migration
-- endpoint; migration 0027 restores expansion mode after 0024 was journaled
-- before runtime transaction scoping was complete.  The post-migration pass
-- fails closed when protection is incomplete.
-- 2026-08-11（第十轮修复）：原检查统计"启用了 RLS 的表数"，0111 为六张
-- card_generation 表启用 RLS 后 enabled_count>0 必然 RAISE，导致生产
-- role-grants 服务（REQUIRE_RLS_DISABLED=true）部署挂起。语义改为 fail-closed
-- 的真正意图：**有 RLS 的表必须都有 policy**（未完成保护的 RLS 表 = 裸隔离）
-- ——预迁移（全表无 RLS）与 0111 后（六表 RLS+双 policy）都通过。
DO $$
DECLARE
  unprotected_count integer;
BEGIN
  SELECT count(*) INTO unprotected_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relrowsecurity
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = c.relname
    );
  IF coalesce(current_setting('ailearn.require_rls_disabled', true), 'false')::boolean
    AND unprotected_count > 0
  THEN
    RAISE EXCEPTION
      '% public table(s) have RLS enabled without any policy; migration/policies must be completed before applications start',
      unprotected_count;
  END IF;
END
$$;
