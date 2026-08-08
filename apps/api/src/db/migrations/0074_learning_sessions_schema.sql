-- 0074: 阶段 02（W1）任务 02-1 —— AI 学习伴侣学习过程对象 schema（§12.2）
--
-- 对应冻结记录 01-2（Session/Scene/Artifact/Trust 合同）与 01-3（数据对象清单）：
-- - learning_sessions / learning_episodes / learning_session_probes /
--   learning_response_artifacts / learning_assessment_reports：workspace-scoped
--   过程对象，正式 outcome/attempt/schedule 仍落入现有 validation/review 域。
-- - user_companion_onboarding / user_companion_account_state /
--   user_learning_preferences：account-scoped，跨设备同步，不使用 workspace RLS。
--
-- RLS：workspace-scoped 表使用 0070 模式（ENABLE + FORCE +
-- workspace_isolation policy, app.workspace_id）；account-scoped 表使用
-- user_id isolation（app.user_id，参照 0043）。GRANT 参照 0071 模式按角色存在性授权。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  origin text NOT NULL,
  origin_ref jsonb NOT NULL,
  intent text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_sessions
    ADD CONSTRAINT learning_sessions_status_check
    CHECK (status IN ('active', 'ended', 'cancelled', 'stale'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_sessions_workspace_user_created_idx
  ON public.learning_sessions (workspace_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS learning_sessions_status_idx
  ON public.learning_sessions (workspace_id, user_id, status);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  key_point_id uuid NOT NULL,
  origin text NOT NULL,
  origin_ref jsonb NOT NULL,
  intent text NOT NULL,
  formal_eligibility_kind text NOT NULL,
  formal_plan jsonb NOT NULL,
  scheduling_decision jsonb NOT NULL,
  episode_target_fingerprint text NOT NULL,
  content_exposure_key text NOT NULL,
  rubric_targets jsonb NOT NULL,
  allowed_modalities text[] NOT NULL DEFAULT '{}',
  max_turns integer NOT NULL,
  assistance_policy_version text NOT NULL,
  rubric_policy_version text NOT NULL,
  scene_policy_version text NOT NULL,
  assessment_policy_version text NOT NULL,
  mastery_policy_version text NOT NULL,
  scheduler_policy_version text NOT NULL,
  provider_policy_version text NOT NULL,
  commit_policy_version text NOT NULL,
  provider_config_id text NOT NULL,
  model_id text NOT NULL,
  required_capability_ids text[] NOT NULL DEFAULT '{}',
  capability_snapshot_hash text NOT NULL,
  runtime_epoch_snapshot integer NOT NULL,
  episode_epoch integer NOT NULL,
  budget_envelope_ref text NOT NULL,
  budget_envelope_hash text NOT NULL,
  plan_hash text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  commit_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_episodes
    ADD CONSTRAINT learning_episodes_status_check
    CHECK (status IN ('draft', 'active', 'completed', 'stale', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.learning_episodes
    ADD CONSTRAINT learning_episodes_plan_hash_check
    CHECK (length(trim(plan_hash)) > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_episodes_session_idx
  ON public.learning_episodes (session_id);
CREATE INDEX IF NOT EXISTS learning_episodes_workspace_user_keypoint_idx
  ON public.learning_episodes (workspace_id, user_id, key_point_id, created_at);
CREATE INDEX IF NOT EXISTS learning_episodes_status_idx
  ON public.learning_episodes (workspace_id, user_id, status);
-- 同一 Session 至多一个未终态 Episode（单 Key Point target 语义，参照 0037）。
CREATE UNIQUE INDEX IF NOT EXISTS learning_episodes_session_active_unique_idx
  ON public.learning_episodes (session_id)
  WHERE status NOT IN ('completed', 'stale', 'cancelled');
-- COMMIT 幂等兜底（01-3 §12.5）。
CREATE UNIQUE INDEX IF NOT EXISTS learning_episodes_commit_key_unique_idx
  ON public.learning_episodes (workspace_id, commit_key)
  WHERE commit_key IS NOT NULL;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_session_probes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.learning_episodes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  sequence integer NOT NULL,
  public_scene_contract_id text NOT NULL,
  public_payload_hash text NOT NULL,
  private_solution_id text NOT NULL,
  private_solution_hash text NOT NULL,
  scene_safety_report_id text NOT NULL,
  scene_safety_report_hash text NOT NULL,
  template_trust_ceiling text NOT NULL,
  disclosure_profile_hash text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_session_probes
    ADD CONSTRAINT learning_session_probes_status_check
    CHECK (status IN ('draft', 'safety_check', 'active', 'locked', 'superseded', 'stale'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.learning_session_probes
    ADD CONSTRAINT learning_session_probes_ceiling_check
    CHECK (template_trust_ceiling IN
      ('mastery_eligible', 'facet_eligible', 'diagnostic_only', 'practice_only', 'not_assessable'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS learning_session_probes_episode_sequence_unique_idx
  ON public.learning_session_probes (episode_id, sequence);
CREATE INDEX IF NOT EXISTS learning_session_probes_episode_status_idx
  ON public.learning_session_probes (episode_id, status);
CREATE INDEX IF NOT EXISTS learning_session_probes_workspace_user_idx
  ON public.learning_session_probes (workspace_id, user_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_response_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.learning_episodes(id) ON DELETE CASCADE,
  key_point_id uuid NOT NULL,
  probe_id uuid NOT NULL REFERENCES public.learning_session_probes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  public_scene_contract_id text NOT NULL,
  public_payload_hash text NOT NULL,
  private_solution_id text NOT NULL,
  private_solution_hash text NOT NULL,
  scene_safety_report_hash text NOT NULL,
  disclosure_profile_hash text NOT NULL,
  input_schema_hash text NOT NULL,
  modality text NOT NULL,
  content_hash text NOT NULL,
  payload jsonb NOT NULL,
  captured_at timestamptz,
  answer_locked_at timestamptz,
  assistance_snapshot jsonb NOT NULL,
  episode_target_fingerprint text NOT NULL,
  content_exposure_key text NOT NULL,
  requested_trust_class text NOT NULL,
  template_trust_ceiling text NOT NULL,
  effective_trust_class text,
  trust_policy_version text NOT NULL,
  trust_reason_codes text[] NOT NULL DEFAULT '{}',
  correction_method text,
  status text NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 0,
  supersedes_artifact_id uuid REFERENCES public.learning_response_artifacts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_response_artifacts
    ADD CONSTRAINT learning_response_artifacts_status_check
    CHECK (status IN (
      'draft', 'capturing', 'transcribed', 'awaiting_confirmation',
      'locked', 'superseded', 'stale', 'redacted'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.learning_response_artifacts
    ADD CONSTRAINT learning_response_artifacts_modality_check
    CHECK (modality IN (
      'voice', 'text_or_mixed', 'drag_graph', 'ordering', 'repair', 'scenario'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- 不可变约束：locked/redacted 的已哈希行必须带 answer_locked_at（01-2 §6.2）。
DO $$ BEGIN
  ALTER TABLE public.learning_response_artifacts
    ADD CONSTRAINT learning_response_artifacts_locked_immutable_check
    CHECK (
      (status <> 'locked' AND status <> 'redacted')
      OR answer_locked_at IS NOT NULL
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS learning_response_artifacts_probe_revision_unique_idx
  ON public.learning_response_artifacts (workspace_id, probe_id, revision);
CREATE INDEX IF NOT EXISTS learning_response_artifacts_episode_idx
  ON public.learning_response_artifacts (episode_id);
CREATE INDEX IF NOT EXISTS learning_response_artifacts_content_hash_idx
  ON public.learning_response_artifacts (workspace_id, content_hash);
CREATE INDEX IF NOT EXISTS learning_response_artifacts_probe_status_idx
  ON public.learning_response_artifacts (probe_id, status);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_assessment_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.learning_episodes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  critic_version text NOT NULL,
  reducer_version text,
  assessment_source text NOT NULL DEFAULT 'critic',
  rubric_assessments jsonb NOT NULL,
  report_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_assessment_reports
    ADD CONSTRAINT learning_assessment_reports_source_check
    CHECK (assessment_source IN ('deterministic', 'critic', 'user_declared_unable'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_assessment_reports_episode_idx
  ON public.learning_assessment_reports (episode_id);
CREATE UNIQUE INDEX IF NOT EXISTS learning_assessment_reports_episode_report_hash_unique_idx
  ON public.learning_assessment_reports (workspace_id, episode_id, report_hash);
CREATE INDEX IF NOT EXISTS learning_assessment_reports_workspace_user_idx
  ON public.learning_assessment_reports (workspace_id, user_id);

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- account-scoped Companion 表（不使用 workspace RLS，跨设备同步）
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.user_companion_onboarding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  onboarding_version text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  offer_status text NOT NULL DEFAULT 'not_offered',
  offer_disposition text,
  active_run jsonb,
  last_run jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.user_companion_onboarding
    ADD CONSTRAINT user_companion_onboarding_offer_status_check
    CHECK (offer_status IN ('not_offered', 'offered', 'consumed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.user_companion_onboarding
    ADD CONSTRAINT user_companion_onboarding_disposition_check
    CHECK (offer_disposition IS NULL OR offer_disposition IN ('completed', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.user_companion_onboarding
    ADD CONSTRAINT user_companion_onboarding_revision_check
    CHECK (revision >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS user_companion_onboarding_user_version_unique_idx
  ON public.user_companion_onboarding (user_id, onboarding_version);
CREATE INDEX IF NOT EXISTS user_companion_onboarding_offer_status_idx
  ON public.user_companion_onboarding (user_id, offer_status);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.user_companion_account_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0,
  epoch integer NOT NULL DEFAULT 0,
  global_enabled boolean NOT NULL DEFAULT true,
  presence jsonb,
  suggestion_pause jsonb,
  suppression jsonb,
  animation_voice_off jsonb,
  notification_boundary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.user_companion_account_state
    ADD CONSTRAINT user_companion_account_state_epoch_check
    CHECK (epoch >= 0 AND revision >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS user_companion_account_state_user_unique_idx
  ON public.user_companion_account_state (user_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.user_learning_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id uuid,
  explicit_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  suggested_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- account 级一行（workspace_id IS NULL）与 workspace 级行（IS NOT NULL）分列唯一。
CREATE UNIQUE INDEX IF NOT EXISTS user_learning_preferences_user_account_unique_idx
  ON public.user_learning_preferences (user_id)
  WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_learning_preferences_user_workspace_unique_idx
  ON public.user_learning_preferences (user_id, workspace_id)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_learning_preferences_workspace_idx
  ON public.user_learning_preferences (workspace_id);

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- RLS：workspace-scoped 学习表（ENABLE + FORCE + workspace_isolation，0070 模式）
-- 双条件 user_id 收紧属任务 02-2 的 RLS 矩阵范围。
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.learning_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.learning_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_episodes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.learning_session_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_session_probes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.learning_response_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_response_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.learning_assessment_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_assessment_reports FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

DROP POLICY IF EXISTS learning_sessions_workspace_isolation
  ON public.learning_sessions;
CREATE POLICY learning_sessions_workspace_isolation
  ON public.learning_sessions FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS learning_episodes_workspace_isolation
  ON public.learning_episodes;
CREATE POLICY learning_episodes_workspace_isolation
  ON public.learning_episodes FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS learning_session_probes_workspace_isolation
  ON public.learning_session_probes;
CREATE POLICY learning_session_probes_workspace_isolation
  ON public.learning_session_probes FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS learning_response_artifacts_workspace_isolation
  ON public.learning_response_artifacts;
CREATE POLICY learning_response_artifacts_workspace_isolation
  ON public.learning_response_artifacts FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS learning_assessment_reports_workspace_isolation
  ON public.learning_assessment_reports;
CREATE POLICY learning_assessment_reports_workspace_isolation
  ON public.learning_assessment_reports FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- RLS：account-scoped 表（user_id isolation，app.user_id，参照 0043）
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_companion_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_companion_onboarding FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_companion_account_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_companion_account_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_learning_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_learning_preferences FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

DROP POLICY IF EXISTS user_companion_onboarding_user_isolation
  ON public.user_companion_onboarding;
CREATE POLICY user_companion_onboarding_user_isolation
  ON public.user_companion_onboarding FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS user_companion_account_state_user_isolation
  ON public.user_companion_account_state;
CREATE POLICY user_companion_account_state_user_isolation
  ON public.user_companion_account_state FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS user_learning_preferences_user_isolation
  ON public.user_learning_preferences;
CREATE POLICY user_learning_preferences_user_isolation
  ON public.user_learning_preferences FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- least-privilege GRANT（0071 模式：按角色存在性授权）
-- ailearn_api：全部新表读写；ailearn_worker：学习过程表读写（评估/commit 流程），
-- account-scoped Companion 状态表不授权（worker 无权限读取 account 状态）。
-- ════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_sessions TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_episodes TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_session_probes TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_response_artifacts TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_assessment_reports TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_companion_onboarding TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_companion_account_state TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_learning_preferences TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON public.learning_sessions TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.learning_episodes TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.learning_session_probes TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.learning_response_artifacts TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.learning_assessment_reports TO ailearn_worker;
  END IF;
END $$;
