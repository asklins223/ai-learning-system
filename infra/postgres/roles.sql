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
  IF to_regprocedure('public.ailearn_claim_jobs(integer,integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_claim_jobs(integer, integer, integer)
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

  -- Queue SECURITY DEFINER functions are created by migrations (dev uses the
  -- ailearn role), so bootstrap must converge their owner to the migrator
  -- role on every replay (the BYPASSRLS semantics depend on this).
  IF to_regprocedure('public.ailearn_queue_job_depth()') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_queue_job_depth()
      OWNER TO ailearn_migrator;
  END IF;
  IF to_regprocedure('public.ailearn_queue_oldest_pending_age()') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_queue_oldest_pending_age()
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
  IF to_regprocedure('public.ailearn_purge_tutor_nonces_ttl(integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_purge_tutor_nonces_ttl(integer, integer)
      OWNER TO ailearn_migrator;
  END IF;
  -- 0171/0172：方案 22 桌宠日记/记忆维护 SECURITY DEFINER 函数，owner 收敛到
  -- ailearn_migrator（BYPASSRLS 语义依赖；search_path 需对齐 pg_catalog, public）。
  IF to_regprocedure('public.ailearn_enqueue_companion_daily_summaries()') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_enqueue_companion_daily_summaries()
      OWNER TO ailearn_migrator;
    ALTER FUNCTION public.ailearn_enqueue_companion_daily_summaries()
      SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.ailearn_run_companion_memory_maintenance()') IS NOT NULL THEN
    ALTER FUNCTION public.ailearn_run_companion_memory_maintenance()
      OWNER TO ailearn_migrator;
    ALTER FUNCTION public.ailearn_run_companion_memory_maintenance()
      SET search_path = pg_catalog, public;
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

-- Worker read set. Keep identity/session/benchmark tables out of this list.
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
    'sources',
    'source_segments',
    'validation_events',
    'review_schedules',
    'jobs',
    'search_documents',
    'ai_artifacts',
    'review_attempts',
    'validation_questions',
    'validation_assistance_exposures',
    'learning_unit_exposure',
    'learning_exposure_dependency_ledger',
    'companion_conversations',
    'companion_messages',
    'companion_turn_runs',
    'companion_stream_events',
    'companion_action_proposals',
    -- Agent 方案：worker 读取 run 元数据（epoch/permission/settings）与审计面。
    'companion_agent_steps',
    'companion_agent_tool_calls',
    'user_companion_account_state',
    -- 0238：到点提醒表。`<here_and_now>` 里"下一条提醒"要读它，schedule/cancel
    -- 两个工具要写它。缺 SELECT 的表现不是报错给用户，而是她**看不见自己许的约**。
    'companion_reminders',
    -- 主动念头表。worker 每一轮都要读它（今日已送达几条、最近的去重向量），
    -- 也要写它（落候选、定稿文本/embedding、candidate→delivered/suppressed 状态）。
    -- 缺权限的表现不是"气泡少一条"，而是 **companion_thought job 三次重试全 dead**
    -- （permission denied 归 operational_error）——主动链在受限角色下整条静默停摆。
    -- 实机 2026-09-21：owner 工作区连着三个调度点 dead，`last_error` 全是
    -- `permission denied for table assistant_thoughts`，而 dev 库这张表此前
    -- 只对 api/migrator 授权。
    'assistant_thoughts',
    -- 0237：账号级 AI 同意与数据外发政策。`governance.ts` 现在每轮都要读它来决定
    -- 能不能出网；缺 SELECT 时 worker 不是"降级"，而是**所有 companion job 直接 dead**
    -- （permission denied 被归成 operational_error）。这张表在 roles.sql 里原本零覆盖，
    -- 是在重建容器权限后才暴露出来的——迁移里的 GRANT 会被下面的 REVOKE ALL 抹掉。
    'user_ai_settings',
    -- companion 处理器读取学习上下文与页面上下文（daily summary / grounded run）。
    'learning_runs',
    'learning_tasks',
    'learning_run_private_contracts',
    'assistant_page_contexts',
    -- 记忆提取器写投递箱后回读去重。
    'assistant_deliveries',
    -- tick / journey / sandbox / understanding 路径经 worker 角色读取的表。
    -- 与迁移授权对齐：roles.sql 是授权主源，遗漏会在 bootstrap 的 REVOKE ALL 后
    -- 变成 permission denied（例如 deterministic_structured 评估读 private solution）。
    'companion_account_invitations',
    'companion_journeys',
    'companion_sandbox_namespaces',
    'learning_artifacts',
    'learning_run_events',
    'learning_run_idempotency',
    'learning_task_presentation_history',
    'learning_task_variants',
    'understanding_change_sets',
    'understanding_projection_checkpoints',
    'understanding_route_plans',
    -- 0170/0173：桌宠人格与长期记忆上下文。
    -- 注意：0185 的 `GRANT SELECT ON companion_room_profiles TO ailearn_worker`
    -- 有意**不**镜像——该表只由 ailearn_api 的 home-projection-service 读写，
    -- worker 无任何调用点。少授权在这里是刻意的，不是遗漏。
    'pet_profiles',
    'assistant_memory_items',
    'assistant_memory_embeddings',
    'memory_links',
    'conversation_summaries',
    'memory_usage_log',
    'companion_daily_summaries'
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
    'review_schedules',
    'jobs',
    'search_documents'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT INSERT, UPDATE ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;

  IF to_regclass('public.review_attempts') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.review_attempts TO ailearn_worker;
  END IF;

  IF to_regclass('public.validation_questions') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.validation_questions TO ailearn_worker;
  END IF;

  -- 0077/0078 授予 worker 的最小写权限镜像（roles.sql 是唯一授权源；
  -- 不镜像的话 post-migration 重跑会 REVOKE 迁移授予的权限并被矩阵"判对"）。
  IF to_regclass('public.learning_unit_exposure') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.learning_unit_exposure TO ailearn_worker;
  END IF;
  IF to_regclass('public.learning_exposure_dependency_ledger') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.learning_exposure_dependency_ledger TO ailearn_worker;
  END IF;
  -- P2/P5 companion runtime：worker 读取对话/run/action 状态，写入对话
  -- 结果和事件，并更新 API 已创建的 run/proposal/sequence 投影。
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
  -- 0238：她答应下来的提醒。worker 要写（schedule_reminder / 到点兑现）也要改
  -- （cancel/missed），但不删行——fired 的提醒是"她说过做到"的凭据。
  IF to_regclass('public.companion_reminders') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_reminders TO ailearn_worker;
  END IF;
  -- 主动念头：SELECT 在上面的读集合里，这里补写侧。INSERT=落候选，
  -- UPDATE=定稿文本/embedding 与 candidate→delivered/suppressed 的状态机。
  -- 不给 DELETE：念头历史是"她说过什么"的凭据，过期行由 api 侧的 TTL 任务处理。
  IF to_regclass('public.assistant_thoughts') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.assistant_thoughts TO ailearn_worker;
  END IF;
  -- Agent 方案 §5：高风险工具由 **worker** 冻结确认 proposal（旧链路由 API 创建，
  -- 因此这里此前只有 UPDATE）。缺 INSERT 会让所有需确认的写工具在受限角色下
  -- permission denied。worker 仍不删除会话/proposal 数据。
  IF to_regclass('public.companion_action_proposals') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_action_proposals TO ailearn_worker;
  END IF;
  -- Agent 审计面：worker 写入步骤/工具调用行，并更新其终态（取消、过期回收、
  -- 确认结果回填由 API 侧更新，见 0215 的 api UPDATE 授权）。
  IF to_regclass('public.companion_agent_steps') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_agent_steps TO ailearn_worker;
  END IF;
  IF to_regclass('public.companion_agent_tool_calls') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.companion_agent_tool_calls TO ailearn_worker;
  END IF;
  -- 记忆提取器投递箱：写入后回读去重。
  IF to_regclass('public.assistant_deliveries') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.assistant_deliveries TO ailearn_worker;
  END IF;

  -- 0173：companion_dialogue read/write phase 需要读取人格并维护记忆
  -- 投影；这些授权必须与上面的 worker 白名单一起由 bootstrap 重建。
  FOREACH table_name IN ARRAY ARRAY[
    'assistant_memory_items',
    'assistant_memory_embeddings',
    'memory_links',
    'conversation_summaries',
    'memory_usage_log',
    'companion_daily_summaries'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;
  IF to_regclass('public.pet_profiles') IS NOT NULL THEN
    -- 0178：worker 在对话终态写关系状态（interaction_count/familiarity/
    -- last_active_at），并由每日维护 tick 做 >14 天衰减。只给 SELECT 会让这条
    -- UPDATE 在 bootstrap 的 REVOKE ALL 之后静默跳过（调用点按"弱事实"吞错），
    -- 关系状态因此永远停在初值。
    GRANT SELECT, INSERT, UPDATE ON TABLE public.pet_profiles TO ailearn_worker;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'ai_artifacts',
    'validation_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('GRANT INSERT ON TABLE public.%I TO ailearn_worker', table_name);
    END IF;
  END LOOP;

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

  -- companion journey / metrics 写入（迁移授权镜像）
  FOREACH table_name IN ARRAY ARRAY[
    'companion_journey_pending_events',
    'learning_metric_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;

  -- learning 任务私有/披露/安全面写入
  FOREACH table_name IN ARRAY ARRAY[
    'companion_voice_artifacts',
    'learning_task_disclosure_profiles',
    'learning_task_private_solutions',
    'learning_task_safety_reports'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;

  -- 评估与处理 outbox 更新
  FOREACH table_name IN ARRAY ARRAY[
    'learning_assessments',
    'learning_run_processing_outbox'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, UPDATE ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;

  -- V2 事件/revision/origins 追加写（迁移 0162/0166/0167 授权镜像）
  FOREACH table_name IN ARRAY ARRAY[
    'card_domain_events_v2',
    'learning_card_revisions_v2',
    'learning_objective_origins_v2'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;

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
    'card_generation_post_activation_consumptions',
    'card_generation_events_v2',
    'candidate_evidence_binding_plans_v2',
    'evidence_eligibility_states_v2',
    'card_generation_run_outbox_v2',
    -- 0249：worker 写实时进度读数（毫秒级短事务），API 只读。这张表对 runs 没有
    -- 外键，正是为了让这个写入不排在管道事务那把分钟级 FOR UPDATE 后面。
    'card_generation_run_progress_v2',
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
    'learning_objective_lineage_v2',
    'learning_exposures_v2',
    'card_candidate_quality_reports_v2',
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

-- 扩展函数（pg_trgm / pgvector / …）是安装的库代码，不是应用面：它们的 EXECUTE
-- 默认来自 PUBLIC，上面的 REVOKE 会一并清掉，若不恢复，任何调用都会
-- permission denied（例如记忆去重用的 similarity(content, $n)）。逐个列举既易漏
-- 又是打地鼠，这里按 pg_depend.deptype='e'（属于扩展）整体恢复给两个受限角色。
-- 应用自有函数仍走下面的显式白名单。
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO ailearn_api, ailearn_worker', fn.signature
    );
  END LOOP;
END
$$;

DO $$
BEGIN
  IF to_regprocedure('public.ailearn_claim_jobs(integer,integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_claim_jobs(integer, integer, integer)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION public.ailearn_claim_jobs(integer, integer, integer)
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

  -- 桌宠记忆 embedding 写入需要 vector 类型 input function
  --（`'[...]'::vector` 走 vector_in 而非 vector 函数本身）。
  -- worker 是 embeddings 写入者；api 无写路径，不授权（api 白名单校验会
  -- 拒绝非白名单 EXECUTE）。
  IF to_regprocedure('public.vector_in(cstring,oid,integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.vector_in(cstring, oid, integer)
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.vector(vector,integer,boolean)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.vector(vector, integer, boolean)
      TO ailearn_worker;
  END IF;

  -- 0171/0172/0174：方案 22 桌宠日记/记忆维护 SECURITY DEFINER 函数。
  -- roles.sql 的 REVOKE ALL ON ALL FUNCTIONS 会清掉迁移中的 GRANT EXECUTE，
  -- 必须在此重新授予，否则 worker 每分钟 tick 报 permission denied。
  IF to_regprocedure('public.ailearn_enqueue_companion_daily_summaries()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_daily_summaries()
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.ailearn_run_companion_memory_maintenance()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ailearn_run_companion_memory_maintenance()
      TO ailearn_worker;
  END IF;
  -- 0217：失效 companion 确认的定时兜底回收（方案 §5）。同样必须镜像，
  -- 否则 bootstrap 后 worker 每轮 tick 都会 permission denied，过期确认
  -- 无人回收 → run 永久停在 waiting_for_confirmation 并锁死该会话。
  IF to_regprocedure('public.ailearn_reclaim_stale_companion_proposals()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ailearn_reclaim_stale_companion_proposals()
      TO ailearn_worker;
  END IF;
  -- 0227/0231 念头批量生成入队 + 0232 孤儿 run 回收。两支都是 worker 侧定时器
  -- 调用的 SECURITY DEFINER 函数，缺授权时**不会有任何用户可见报错**：前者让
  -- assistant_thoughts 恒 0 行（"完全没感知到主动提醒"），后者让卡住的会话
  -- 永远停在"正在思考"。
  IF to_regprocedure('public.ailearn_enqueue_companion_thoughts()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_thoughts()
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.ailearn_reclaim_orphaned_companion_runs()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ailearn_reclaim_orphaned_companion_runs()
      TO ailearn_worker;
  END IF;
  -- 0238：到点提醒认领。同样必须镜像，否则 worker 每分钟 tick 都 permission
  -- denied，而它一条日志都不会暴露给用户——"她答应提醒我却没有"就这么静默着。
  IF to_regprocedure('public.ailearn_fire_due_companion_reminders(integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ailearn_fire_due_companion_reminders(integer)
      TO ailearn_worker;
  END IF;

  -- 0174：pgvector 距离函数（记忆向量检索由 worker 执行；api 检索也需调用）。
  -- vector 和 halfvec 签名均需授权。
  IF to_regprocedure('public.cosine_distance(vector,vector)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.cosine_distance(vector, vector)
      TO ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.cosine_distance(vector, vector)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.l2_distance(vector,vector)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.l2_distance(vector, vector)
      TO ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.l2_distance(vector, vector)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.inner_product(vector,vector)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.inner_product(vector, vector)
      TO ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.inner_product(vector, vector)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.cosine_distance(halfvec,halfvec)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.cosine_distance(halfvec, halfvec)
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.l2_distance(halfvec,halfvec)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.l2_distance(halfvec, halfvec)
      TO ailearn_worker;
  END IF;
  IF to_regprocedure('public.inner_product(halfvec,halfvec)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.inner_product(halfvec, halfvec)
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
  IF to_regprocedure('public.ailearn_purge_tutor_nonces_ttl(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_purge_tutor_nonces_ttl(integer, integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_purge_tutor_nonces_ttl(integer, integer)
      TO ailearn_api;
  END IF;

  -- API 侧独占的 SECURITY DEFINER 函数（跨租户批处理 / TTL 清理 / journey 查询）。
  -- 同样必须镜像：REVOKE ALL ON ALL FUNCTIONS 会清掉迁移里的 GRANT EXECUTE，
  -- 而缺一个就整条功能 permission denied（此前依次暴露为：记忆去重 similarity、
  -- learning-run 处理 tick 的 claim/mark、voice artifact 与 stream event TTL、
  -- proactive delivery 清理、ai_audit_log 保留期清理、可恢复 journey 查询）。
  -- 逐条列出而非按前缀放行：worker 专用函数必须继续保持 api 无权（见下方校验）。
  IF to_regprocedure('public.ailearn_claim_run_processing(text,integer,integer,timestamp with time zone)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_claim_run_processing(text, integer, integer, timestamp with time zone)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_claim_run_processing(text, integer, integer, timestamp with time zone)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.ailearn_mark_run_processing_processed(uuid,text,timestamp with time zone)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_mark_run_processing_processed(uuid, text, timestamp with time zone)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_mark_run_processing_processed(uuid, text, timestamp with time zone)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.ailearn_expire_pending_voice_artifacts(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_expire_pending_voice_artifacts(integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_expire_pending_voice_artifacts(integer)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.ailearn_purge_companion_stream_events_ttl(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_purge_companion_stream_events_ttl(integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_purge_companion_stream_events_ttl(integer)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.ailearn_purge_expired_proactive_deliveries(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_purge_expired_proactive_deliveries(integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_purge_expired_proactive_deliveries(integer)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.ailearn_purge_old_ai_audit_log(integer,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_purge_old_ai_audit_log(integer, integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_purge_old_ai_audit_log(integer, integer)
      TO ailearn_api;
  END IF;
  IF to_regprocedure('public.ailearn_find_resumable_companion_journey(uuid,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ailearn_find_resumable_companion_journey(uuid, uuid)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_find_resumable_companion_journey(uuid, uuid)
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
      ('sources', true, false, true, false),
      ('source_segments', true, true, false, true),
      ('validation_events', true, true, false, false),
      ('review_schedules', true, true, true, false),
      ('jobs', true, true, true, false),
      ('search_documents', true, true, true, true),
      ('ai_artifacts', true, true, false, false),
      ('review_attempts', true, false, true, false),
      ('validation_questions', true, true, false, false),
      ('validation_assistance_exposures', true, false, false, false),
      ('learning_unit_exposure', true, true, true, false),
      ('learning_exposure_dependency_ledger', true, true, true, false),
      ('companion_conversations', true, false, true, false),
      ('companion_messages', true, true, false, false),
      ('companion_turn_runs', true, false, true, false),
      ('companion_stream_events', true, true, true, false),
      -- Agent 方案 §5：worker 冻结确认 proposal（INSERT）。
      ('companion_action_proposals', true, true, true, false),
      -- Agent 方案 §6：worker 写步骤/工具调用审计行并更新其终态。
      ('companion_agent_steps', true, true, true, false),
      ('companion_agent_tool_calls', true, true, true, false),
      -- Agent run 元数据（epoch / permission / agent_settings）只读。
      ('user_companion_account_state', true, false, false, false),
      -- 0238：到点提醒。读（"下一条提醒"进 `<here_and_now>`）+ 写 + 改状态，不删行。
      ('companion_reminders', true, true, true, false),
      -- 主动念头：读（今日已送达条数、去重用的近期 embedding）+ 写候选 + 改状态/定稿。
      -- 缺任何一项都不是"少一条气泡"，而是 companion_thought job 全 dead。
      ('assistant_thoughts', true, true, true, false),
      -- 0237：AI 同意/数据政策，worker 只读（签署与修改是 api 侧的事）。
      ('user_ai_settings', true, false, false, false),
      -- companion 处理器的学习上下文读取面。
      ('learning_runs', true, false, false, false),
      ('learning_tasks', true, false, false, false),
      ('learning_run_private_contracts', true, false, false, false),
      ('assistant_page_contexts', true, false, false, false),
      -- 记忆提取器投递箱：写入后回读去重。
      ('assistant_deliveries', true, true, false, false),
      ('companion_account_invitations', true, false, false, false),
      ('companion_journeys', true, false, false, false),
      ('companion_sandbox_namespaces', true, false, false, false),
      ('learning_artifacts', true, false, false, false),
      ('learning_run_events', true, false, false, false),
      ('learning_run_idempotency', true, false, false, false),
      ('learning_task_presentation_history', true, false, false, false),
      ('learning_task_variants', true, false, false, false),
      ('understanding_change_sets', true, false, false, false),
      ('understanding_projection_checkpoints', true, false, false, false),
      ('understanding_route_plans', true, false, false, false),
      ('companion_journey_pending_events', true, true, false, false),
      ('learning_metric_events', true, true, false, false),
      ('companion_voice_artifacts', true, true, true, false),
      ('learning_task_disclosure_profiles', true, true, true, false),
      ('learning_task_private_solutions', true, true, true, false),
      ('learning_task_safety_reports', true, true, true, false),
      ('learning_assessments', true, false, true, false),
      ('learning_run_processing_outbox', true, false, true, false),
      ('card_domain_events_v2', true, true, true, true),
      ('learning_card_revisions_v2', true, true, true, true),
      ('learning_objective_origins_v2', true, true, true, true),
      -- 0170/0173 只给 SELECT；0178 补 INSERT/UPDATE（关系状态写入 + 每日衰减）。
      ('pet_profiles', true, true, true, false),
      ('assistant_memory_items', true, true, true, true),
      ('assistant_memory_embeddings', true, true, true, true),
      ('memory_links', true, true, true, true),
      ('conversation_summaries', true, true, true, true),
      ('memory_usage_log', true, true, true, true),
      ('companion_daily_summaries', true, true, true, true),
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
      ('card_generation_post_activation_consumptions', true, true, true, true),
      ('card_generation_events_v2', true, true, true, true),
      ('candidate_evidence_binding_plans_v2', true, true, true, true),
      ('evidence_eligibility_states_v2', true, true, true, true),
      ('card_generation_run_outbox_v2', true, true, true, true),
      -- 0249：与上面的授权清单同一条（worker 写实时进度读数）。
      ('card_generation_run_progress_v2', true, true, true, true),
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
      ('learning_objective_lineage_v2', true, true, false, false),
      ('learning_exposures_v2', true, true, false, false),
      ('card_candidate_quality_reports_v2', true, true, false, false),
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

  IF to_regprocedure('public.ailearn_claim_jobs(integer,integer,integer)') IS NOT NULL AND (
    NOT has_function_privilege(
      'ailearn_worker', 'public.ailearn_claim_jobs(integer,integer,integer)', 'EXECUTE'
    )
    OR has_function_privilege(
      'ailearn_api', 'public.ailearn_claim_jobs(integer,integer,integer)', 'EXECUTE'
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
      to_regprocedure('public.ailearn_claim_jobs(integer,integer,integer)'),
      to_regprocedure('public.ailearn_reap_stale_jobs(integer,integer)'),
      to_regprocedure('public.ailearn_renew_job_lease(uuid,uuid,text)'),
      to_regprocedure('public.ailearn_finish_job(uuid,uuid,text)'),
      to_regprocedure('public.ailearn_fail_job(uuid,uuid,text,text,integer)'),
      to_regprocedure('public.ailearn_queue_job_depth()'),
      to_regprocedure('public.ailearn_queue_oldest_pending_age()'),
      to_regprocedure('public.ailearn_enqueue_companion_daily_summaries()'),
      to_regprocedure('public.ailearn_run_companion_memory_maintenance()'),
      to_regprocedure('public.ailearn_purge_companion_audit_ttl(integer,integer)'),
      to_regprocedure('public.ailearn_purge_invitation_ledger_ttl(integer,integer)'),
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
      to_regprocedure('public.ailearn_claim_jobs(integer,integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_reap_stale_jobs(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_renew_job_lease(uuid,uuid,text)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_finish_job(uuid,uuid,text)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_fail_job(uuid,uuid,text,text,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_queue_job_depth()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_queue_oldest_pending_age()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.vector_in(cstring,oid,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.vector(vector,integer,boolean)')
    -- 0171/0172/0174：方案 22 桌宠日记/记忆维护 + pgvector 距离函数。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_enqueue_companion_daily_summaries()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_run_companion_memory_maintenance()')
    -- 0217：失效 companion 确认的定时兜底回收。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_reclaim_stale_companion_proposals()')
    -- 0227/0232/0238：上面 granted 的三支 worker 定时器函数必须同时出现在这份
    -- "预期权限"清单里。它们是**两份清单**：只加 GRANT 而忘了这里，role-bootstrap
    -- 会在下一次 `docker compose up` 时 exit 3，而 api 因为 depends_on 直接起不来——
    -- 容器一直活着的话这个洞完全看不见（实机 2026-09-21 就是这样埋下的）。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_enqueue_companion_thoughts()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_reclaim_orphaned_companion_runs()')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_fire_due_companion_reminders(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.cosine_distance(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.l2_distance(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.inner_product(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.cosine_distance(halfvec,halfvec)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.l2_distance(halfvec,halfvec)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.inner_product(halfvec,halfvec)')
    -- 扩展函数（pg_trgm/pgvector/…）按 deptype='e' 整体放行：它们是库代码，
    -- 上面按扩展统一恢复 EXECUTE，逐个列举会再次变成打地鼠。
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.objid = p.oid AND d.deptype = 'e'
    );
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
      to_regprocedure('public.ailearn_purge_tutor_nonces_ttl(integer,integer)')
    -- 0174：pgvector 距离函数（api 也需调用记忆向量检索）。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.cosine_distance(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.l2_distance(vector,vector)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.inner_product(vector,vector)')
    -- API 独占的 SECURITY DEFINER 函数（与上方显式白名单一一对应）。
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_claim_run_processing(text,integer,integer,timestamp with time zone)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_mark_run_processing_processed(uuid,text,timestamp with time zone)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_expire_pending_voice_artifacts(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_purge_companion_stream_events_ttl(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_purge_expired_proactive_deliveries(integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_purge_old_ai_audit_log(integer,integer)')
    AND p.oid IS DISTINCT FROM
      to_regprocedure('public.ailearn_find_resumable_companion_journey(uuid,uuid)')
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.objid = p.oid AND d.deptype = 'e'
    );
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
