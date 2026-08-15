-- 0116: LearningRun V1 数据底座（docs/plans/learning-companion/16 §16.1）。
--
-- 把 Session/Episode 语言演进为 LearningRun 四对象语言的新表集：
-- learning_runs（phase/budget/activeTask/revision/checkpoint）、
-- learning_run_private_contracts（private target/scheduling/epoch/planHash）、
-- learning_tasks / learning_task_variants（intent + Public Variant）、
-- learning_task_private_solutions / learning_task_safety_reports /
-- learning_task_disclosure_profiles（server-private，公共 API 账号无 SELECT 路径）、
-- learning_artifacts / learning_assessments（discriminated payload / task-artifact 绑定）、
-- learning_task_drafts / learning_run_events / learning_run_action_ledger /
-- learning_activity_leases / learning_task_presentation_history / learning_run_idempotency、
-- canonical_learning_event_outbox / practice_trail_event_outbox。
--
-- 与旧 learning_sessions 系列表并存（不双写：新 writer 只写新表，旧 writer
-- 只写旧表，P3 capability 原子切流后删除旧表）。旧表不物理 rename。
--
-- 权限契约：
-- - 全部表 RLS：workspace+user 双条件（app.workspace_id / app.user_id setting）
--   + ailearn_worker 豁免（与 0081 模式一致）；
-- - private 三表：ailearn_api 仅 INSERT（Planner 写入），无 SELECT/UPDATE/DELETE
--   ——公共 API 账号无读取路径（§16.1）；ailearn_worker 读写（评估/激活服务）；
-- - learning_task_drafts：ailearn_worker 显式 REVOKE ALL（§12.7 服务端草稿
--   不可被模型/Tutor/Assessment/主动策略读取）。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  assistant_session_id uuid,
  origin jsonb NOT NULL,
  return_target jsonb NOT NULL,
  key_point_id uuid NOT NULL REFERENCES public.card_key_points(id) ON DELETE CASCADE,
  target_fingerprint text NOT NULL,
  goal text NOT NULL,
  phase text NOT NULL DEFAULT 'preparing',
  time_budget_seconds integer NOT NULL DEFAULT 180,
  planned_active_seconds integer NOT NULL DEFAULT 180,
  active_seconds_used integer NOT NULL DEFAULT 0,
  planning_closes_at_active_second integer NOT NULL DEFAULT 150,
  active_task_id uuid,
  checkpoint jsonb,
  failure jsonb,
  projection_status text NOT NULL DEFAULT 'not_requested',
  projection_baseline_checkpoint_token text,
  terminal_reason_code text,
  event_cursor integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1,
  runtime_epoch integer NOT NULL DEFAULT 0,
  result jsonb,
  legacy_session_id uuid,
  legacy_episode_id uuid,
  legacy_ordinal integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_runs_phase_check CHECK (phase IN (
    'preparing', 'active', 'assessing', 'checkpoint', 'committing', 'paused',
    'completed', 'ended', 'skipped', 'cancelled', 'stale', 'recoverable_error'
  )),
  CONSTRAINT learning_runs_budget_check CHECK (
    time_budget_seconds >= 30 AND time_budget_seconds <= 180
    AND planned_active_seconds >= 0 AND planned_active_seconds <= 180
  ),
  CONSTRAINT learning_runs_goal_check CHECK (goal IN (
    'stabilize', 'clarify', 'repair', 'transfer', 'explore'
  ))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_runs_workspace_user_created_idx
  ON public.learning_runs (workspace_id, user_id, created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_runs_workspace_user_phase_idx
  ON public.learning_runs (workspace_id, user_id, phase);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_runs_key_point_idx
  ON public.learning_runs (workspace_id, user_id, key_point_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_runs_active_task_idx
  ON public.learning_runs (active_task_id)
  WHERE active_task_id IS NOT NULL;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_run_private_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  key_point_id uuid NOT NULL REFERENCES public.card_key_points(id) ON DELETE CASCADE,
  target_fingerprint text NOT NULL,
  runtime_epoch integer NOT NULL,
  time_budget_seconds integer NOT NULL,
  planning_closes_at_active_second integer NOT NULL,
  scheduling_authorization jsonb NOT NULL,
  task_plan_hash text NOT NULL,
  projection_baseline_checkpoint_token text,
  contract_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_run_private_contracts_run_unique UNIQUE (run_id),
  CONSTRAINT learning_run_private_contracts_hash_unique UNIQUE (contract_hash)
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  intent text NOT NULL,
  prompt text NOT NULL,
  target_summary text NOT NULL,
  hint_levels integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  revision integer NOT NULL DEFAULT 1,
  presented_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_tasks_run_sequence_unique UNIQUE (run_id, sequence),
  CONSTRAINT learning_tasks_status_check CHECK (status IN (
    'pending', 'active', 'answered', 'skipped', 'completed', 'stale'
  )),
  CONSTRAINT learning_tasks_intent_check CHECK (intent IN (
    'recall', 'paraphrase', 'explain', 'example', 'apply', 'boundary',
    'procedure', 'relate', 'repair'
  ))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_tasks_run_status_idx
  ON public.learning_tasks (run_id, status);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_tasks_workspace_user_idx
  ON public.learning_tasks (workspace_id, user_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_task_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.learning_tasks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  template_trust_ceiling text NOT NULL,
  estimated_active_seconds integer NOT NULL,
  interaction jsonb NOT NULL,
  public_payload_hash text NOT NULL,
  input_schema_hash text NOT NULL,
  disclosure_profile_hash text NOT NULL,
  alternatives jsonb NOT NULL DEFAULT '[]',
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_task_variants_task_revision_unique UNIQUE (task_id, revision),
  CONSTRAINT learning_task_variants_purpose_check CHECK (purpose IN (
    'formal', 'facet', 'diagnostic', 'practice'
  )),
  CONSTRAINT learning_task_variants_status_check CHECK (status IN (
    'active', 'superseded', 'abandoned'
  ))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_task_variants_task_status_idx
  ON public.learning_task_variants (task_id, status);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_task_private_solutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.learning_task_variants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  solution jsonb NOT NULL,
  private_solution_hash text NOT NULL,
  run_plan_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_task_private_solutions_variant_unique UNIQUE (variant_id)
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_task_safety_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.learning_tasks(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES public.learning_task_variants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  public_payload_hash text NOT NULL,
  input_schema_hash text NOT NULL,
  private_solution_hash text NOT NULL,
  disclosure_profile_hash text NOT NULL,
  qualification_profile_hash text,
  run_plan_hash text NOT NULL,
  injection_scan text NOT NULL,
  private_leakage_scan text NOT NULL,
  schema_validation text NOT NULL,
  accessibility_profile text NOT NULL,
  activation_decision text NOT NULL,
  report_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_task_safety_reports_hash_unique UNIQUE (workspace_id, report_hash)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_task_safety_reports_variant_idx
  ON public.learning_task_safety_reports (variant_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_task_disclosure_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.learning_task_variants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  disclosed_field_paths jsonb NOT NULL,
  hidden_field_paths jsonb NOT NULL,
  answer_bearing_fields_hidden boolean NOT NULL DEFAULT true,
  profile_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_task_disclosure_profiles_hash_unique UNIQUE (workspace_id, profile_hash)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_task_disclosure_profiles_variant_idx
  ON public.learning_task_disclosure_profiles (variant_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.learning_tasks(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES public.learning_task_variants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  public_payload_hash text NOT NULL,
  input_schema_hash text NOT NULL,
  private_solution_hash text NOT NULL,
  safety_report_hash text NOT NULL,
  disclosure_profile_hash text NOT NULL,
  assistance_snapshot_hash text NOT NULL,
  qualification_profile_hash text,
  status text NOT NULL DEFAULT 'locked',
  supersedes_artifact_id uuid REFERENCES public.learning_artifacts(id) ON DELETE SET NULL,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_artifacts_task_revision_unique UNIQUE (task_id, revision),
  CONSTRAINT learning_artifacts_status_check CHECK (status IN ('locked', 'superseded', 'abandoned')),
  CONSTRAINT learning_artifacts_locked_immutable_check CHECK (
    status <> 'locked' OR locked_at IS NOT NULL
  )
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS learning_artifacts_task_locked_unique_idx
  ON public.learning_artifacts (task_id)
  WHERE status = 'locked';

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_artifacts_run_task_idx
  ON public.learning_artifacts (run_id, task_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.learning_tasks(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES public.learning_artifacts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  rubric_results jsonb NOT NULL DEFAULT '[]',
  trust_class text,
  report_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_assessments_artifact_unique UNIQUE (artifact_id),
  CONSTRAINT learning_assessments_status_check CHECK (status IN (
    'queued', 'running', 'completed', 'not_assessable', 'failed'
  )),
  CONSTRAINT learning_assessments_source_check CHECK (source IN (
    'assessment_critic', 'deterministic_declared_unable'
  )),
  CONSTRAINT learning_assessments_terminal_report_check CHECK (
    status NOT IN ('completed', 'not_assessable') OR report_hash IS NOT NULL
  )
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_assessments_run_idx
  ON public.learning_assessments (run_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_assessments_run_status_idx
  ON public.learning_assessments (run_id, status);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_task_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.learning_tasks(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES public.learning_task_variants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_revision integer NOT NULL,
  draft_revision integer NOT NULL DEFAULT 1,
  payload jsonb,
  renderer_state jsonb NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_task_drafts_task_unique UNIQUE (task_id)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_task_drafts_workspace_user_idx
  ON public.learning_task_drafts (workspace_id, user_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_run_events_run_sequence_unique UNIQUE (run_id, sequence),
  CONSTRAINT learning_run_events_type_check CHECK (event_type IN (
    'learning_run.created', 'learning_run.prepared', 'learning_run.started',
    'learning_run.paused', 'learning_run.resumed', 'learning_run.completed',
    'learning_run.ended', 'learning_run.skipped', 'learning_run.stale',
    'learning_run.cancelled', 'learning_run.recoverable_error',
    'learning_task.presented', 'learning_task.variant_switched',
    'learning_task.hint_requested', 'learning_task.skipped',
    'learning_task.declared_unable',
    'learning_artifact.started', 'learning_artifact.draft_saved',
    'learning_artifact.locked', 'learning_artifact.superseded',
    'learning_assessment.queued', 'learning_assessment.started',
    'learning_assessment.completed', 'learning_assessment.not_assessable',
    'learning_assessment.failed',
    'learning_commit.completed', 'learning_commit.failed',
    'learning_result.viewed'
  ))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_run_events_run_idx
  ON public.learning_run_events (run_id, occurred_at);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_run_action_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  action_kind text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status text NOT NULL DEFAULT 'pending',
  response_snapshot jsonb,
  accepted_action_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_run_action_ledger_run_idem_unique UNIQUE (run_id, idempotency_key),
  CONSTRAINT learning_run_action_ledger_accepted_unique UNIQUE (accepted_action_id)
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_activity_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_session_id text NOT NULL,
  lease_started_at timestamptz NOT NULL,
  lease_ended_at timestamptz NOT NULL,
  credited_seconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_activity_leases_unique UNIQUE (run_id, device_session_id, lease_started_at)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_activity_leases_run_idx
  ON public.learning_activity_leases (run_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_task_presentation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  key_point_id uuid NOT NULL REFERENCES public.card_key_points(id) ON DELETE CASCADE,
  intent text NOT NULL,
  public_payload_hash text NOT NULL,
  interaction_family text NOT NULL,
  presented_at timestamptz NOT NULL,
  outcome text NOT NULL DEFAULT 'not_answered',
  exposed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_task_pres_hist_user_kp_intent_idx
  ON public.learning_task_presentation_history (workspace_id, user_id, key_point_id, intent, presented_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_task_pres_hist_payload_hash_idx
  ON public.learning_task_presentation_history (workspace_id, user_id, key_point_id, public_payload_hash);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.canonical_learning_event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_id uuid NOT NULL,
  canonical_event_id text NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  key_point_id uuid NOT NULL REFERENCES public.card_key_points(id) ON DELETE CASCADE,
  envelope jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_learning_event_outbox_commit_unique UNIQUE (commit_id),
  CONSTRAINT canonical_learning_event_outbox_event_unique UNIQUE (canonical_event_id)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS canonical_learning_event_outbox_status_idx
  ON public.canonical_learning_event_outbox (status, created_at)
  WHERE status <> 'published';

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS canonical_learning_event_outbox_w_u_run_idx
  ON public.canonical_learning_event_outbox (workspace_id, user_id, run_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.practice_trail_event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_event_id text NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  key_point_id uuid NOT NULL REFERENCES public.card_key_points(id) ON DELETE CASCADE,
  scope text NOT NULL,
  event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT practice_trail_event_outbox_run_scope_unique UNIQUE (run_id, scope),
  CONSTRAINT practice_trail_event_outbox_scope_check CHECK (scope IN ('official_user', 'sandbox'))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS practice_trail_event_outbox_status_idx
  ON public.practice_trail_event_outbox (status, created_at)
  WHERE status <> 'published';

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_run_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  client_request_id text NOT NULL,
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_run_idempotency_key_unique UNIQUE (workspace_id, user_id, idempotency_key)
);

--> statement-breakpoint

-- ── RLS：workspace+user 双条件隔离 + ailearn_worker 豁免 ────────────────

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'learning_runs',
    'learning_run_private_contracts',
    'learning_tasks',
    'learning_task_variants',
    'learning_task_private_solutions',
    'learning_task_safety_reports',
    'learning_task_disclosure_profiles',
    'learning_artifacts',
    'learning_assessments',
    'learning_task_drafts',
    'learning_run_events',
    'learning_run_action_ledger',
    'learning_activity_leases',
    'learning_task_presentation_history',
    'canonical_learning_event_outbox',
    'practice_trail_event_outbox',
    'learning_run_idempotency'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS %I_workspace_user_isolation ON public.%I
    $p$, t, t);
    EXECUTE format($p$
      CREATE POLICY %I_workspace_user_isolation
        ON public.%I AS PERMISSIVE FOR ALL
        USING (
          CURRENT_USER = 'ailearn_worker'
          OR (
            workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
            AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
          )
        )
        WITH CHECK (
          CURRENT_USER = 'ailearn_worker'
          OR (
            workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
            AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
          )
        )
    $p$, t, t);
  END LOOP;
END $$;

--> statement-breakpoint

-- ── 表级权限契约 ────────────────────────────────────────────────────────
-- ailearn_api：业务读写（行级由 RLS 收口）。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_runs TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_run_private_contracts TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_tasks TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_task_variants TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_artifacts TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_assessments TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_task_drafts TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_run_events TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_run_action_ledger TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_activity_leases TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_task_presentation_history TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canonical_learning_event_outbox TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.practice_trail_event_outbox TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_run_idempotency TO ailearn_api;

-- private 三表：ailearn_api 仅 INSERT（Planner 写入），无 SELECT/UPDATE/DELETE。
-- 公共 API 账号无读取路径（§16.1）。
REVOKE SELECT, UPDATE, DELETE ON public.learning_task_private_solutions FROM ailearn_api;
REVOKE SELECT, UPDATE, DELETE ON public.learning_task_safety_reports FROM ailearn_api;
REVOKE SELECT, UPDATE, DELETE ON public.learning_task_disclosure_profiles FROM ailearn_api;
GRANT INSERT ON public.learning_task_private_solutions TO ailearn_api;
GRANT INSERT ON public.learning_task_safety_reports TO ailearn_api;
GRANT INSERT ON public.learning_task_disclosure_profiles TO ailearn_api;

-- ailearn_worker：评估/激活服务读 private 三表与 evidence 链；其余表只读诊断。
GRANT SELECT, INSERT, UPDATE ON public.learning_task_private_solutions TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.learning_task_safety_reports TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.learning_task_disclosure_profiles TO ailearn_worker;
GRANT SELECT ON public.learning_runs TO ailearn_worker;
GRANT SELECT ON public.learning_run_private_contracts TO ailearn_worker;
GRANT SELECT ON public.learning_tasks TO ailearn_worker;
GRANT SELECT ON public.learning_task_variants TO ailearn_worker;
GRANT SELECT ON public.learning_artifacts TO ailearn_worker;
GRANT SELECT, UPDATE ON public.learning_assessments TO ailearn_worker;
GRANT SELECT ON public.learning_run_events TO ailearn_worker;
GRANT SELECT ON public.learning_task_presentation_history TO ailearn_worker;
GRANT SELECT ON public.learning_run_idempotency TO ailearn_worker;

-- §12.7：draft 不可被模型/Tutor/Assessment/主动策略读取——worker 无任何权限
-- （显式 REVOKE 防御 roles.sql 全表矩阵放大）。
REVOKE ALL ON public.learning_task_drafts FROM ailearn_worker;
