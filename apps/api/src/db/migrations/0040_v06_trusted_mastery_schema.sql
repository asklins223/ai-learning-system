-- 0040: v0.6 可信掌握闭环 — Schema expand (计划 §6)
--
-- 新增表：
--   validation_question_rubric_items (§6.3)
--   validation_submissions (§6.4)
--   validation_submission_jobs (§6.4)
--   validation_action_commands (§6.4.1)
--   validation_assistance_exposures (§6.4.2)
--   validation_point_assessments (§6.5)
--   scheduling_shadow_decisions (§6.8)
--
-- 现有表扩展：
--   validation_questions (§6.2)
--   validation_events (§6.6)
--   review_attempts (§6.6)
--   review_schedules (§6.6)
--   ai_artifacts (§6.6)

-- ═════════════════════════════════════════════════════════════════════════
-- §6.2: validation_questions 扩展
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "artifact_id" uuid REFERENCES "ai_artifacts"("id") ON DELETE SET NULL;
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "generation_job_id" uuid;
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "generator_kind" text NOT NULL DEFAULT 'ai';
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "rubric_version" text;
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "source_fingerprint" text;
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "superseded_at" timestamptz;
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "stale_reason" text;
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "last_used_at" timestamptz;
ALTER TABLE "validation_questions" ADD COLUMN IF NOT EXISTS "use_count" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "validation_questions_user_kp_idx"
  ON "validation_questions" ("user_id", "key_point_id", "status");

-- §6.2: 每个 (workspace,user,key_point,source_fingerprint) 最多一条 active question
CREATE UNIQUE INDEX IF NOT EXISTS "validation_questions_active_unique_idx"
  ON "validation_questions" ("workspace_id", "user_id", "key_point_id", "source_fingerprint")
  WHERE "status" = 'active' AND "user_id" IS NOT NULL AND "key_point_id" IS NOT NULL AND "source_fingerprint" IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- §6.3: validation_question_rubric_items (新表)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "validation_question_rubric_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "question_id" uuid NOT NULL REFERENCES "validation_questions"("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL,
  "criterion" text NOT NULL,
  "expected_concept" text NOT NULL,
  "weight" integer NOT NULL DEFAULT 1,
  "required" boolean NOT NULL DEFAULT true,
  "evidence_id" uuid REFERENCES "evidences"("id") ON DELETE SET NULL,
  "evidence_snapshot" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "vq_rubric_items_question_idx"
  ON "validation_question_rubric_items" ("question_id", "ordinal");
CREATE INDEX IF NOT EXISTS "vq_rubric_items_workspace_idx"
  ON "validation_question_rubric_items" ("workspace_id");
CREATE UNIQUE INDEX IF NOT EXISTS "vq_rubric_items_unique_ordinal_idx"
  ON "validation_question_rubric_items" ("question_id", "ordinal");

-- ═════════════════════════════════════════════════════════════════════════
-- §6.4: validation_submissions (新表)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "validation_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "card_id" uuid NOT NULL REFERENCES "learning_cards"("id") ON DELETE CASCADE,
  "key_point_id" uuid REFERENCES "card_key_points"("id") ON DELETE SET NULL,
  "question_id" uuid,
  "context" text NOT NULL,
  "review_attempt_id" uuid,
  "input_schedule_id" uuid,
  "user_answer" text,
  "self_confidence" integer,
  "draft_revision" integer NOT NULL DEFAULT 0,
  "answer_hash" text,
  "answer_locked_at" timestamptz,
  "assistance_snapshot_exposed_at" timestamptz,
  "assistance_level" text NOT NULL DEFAULT 'none',
  "evidence_revealed_at" timestamptz,
  "source_fingerprint" text,
  "status" text NOT NULL DEFAULT 'question_preparing',
  "current_generation_job_id" uuid,
  "current_evaluation_job_id" uuid,
  "validation_event_id" uuid,
  "failure_stage" text,
  "failure_code" text,
  "terminal_reason" text,
  "start_idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "val_submissions_w_u_kp_idx"
  ON "validation_submissions" ("workspace_id", "user_id", COALESCE("key_point_id", '00000000-0000-0000-0000-000000000000'::uuid), "status");
CREATE UNIQUE INDEX IF NOT EXISTS "val_submissions_start_idem_idx"
  ON "validation_submissions" ("workspace_id", "user_id", "start_idempotency_key");
CREATE INDEX IF NOT EXISTS "val_submissions_review_attempt_idx"
  ON "validation_submissions" ("review_attempt_id");
CREATE INDEX IF NOT EXISTS "val_submissions_status_idx"
  ON "validation_submissions" ("workspace_id", "user_id", "status");

-- §6.4: 同一 (workspace,user,key_point,context) 最多一个未终态 submission
-- 终态: question_blocked, completed, stale, abandoned (计划 §6.4)
CREATE UNIQUE INDEX IF NOT EXISTS "val_submissions_active_unique_idx"
  ON "validation_submissions" ("workspace_id", "user_id", "key_point_id", "context")
  WHERE "status" NOT IN ('question_blocked', 'completed', 'stale', 'abandoned')
    AND "key_point_id" IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- §6.4: validation_submission_jobs (新表)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "validation_submission_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "submission_id" uuid NOT NULL REFERENCES "validation_submissions"("id") ON DELETE CASCADE,
  "phase" text NOT NULL,
  "phase_ordinal" integer NOT NULL DEFAULT 1,
  "job_id" uuid NOT NULL,
  "retry_of_job_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "val_sub_jobs_phase_idx"
  ON "validation_submission_jobs" ("submission_id", "phase", "phase_ordinal");
CREATE UNIQUE INDEX IF NOT EXISTS "val_sub_jobs_job_idx"
  ON "validation_submission_jobs" ("submission_id", "job_id");

-- ═════════════════════════════════════════════════════════════════════════
-- §6.4.1: validation_action_commands (新表)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "validation_action_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "submission_id" uuid,
  "action" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "response_status" text NOT NULL DEFAULT 'pending',
  "response_snapshot" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "val_action_cmd_unique_idx"
  ON "validation_action_commands" ("workspace_id", "user_id", "action", "idempotency_key");

-- ═════════════════════════════════════════════════════════════════════════
-- §6.4.2: validation_assistance_exposures (新表)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "validation_assistance_exposures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key_point_id" uuid NOT NULL REFERENCES "card_key_points"("id") ON DELETE CASCADE,
  "exposure_fingerprint" text NOT NULL,
  "last_exposure_kind" text NOT NULL,
  "first_exposed_at" timestamptz NOT NULL,
  "last_exposed_at" timestamptz NOT NULL,
  "unassisted_eligible_after" timestamptz NOT NULL,
  "last_origin_submission_id" uuid,
  "input_schedule_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "val_assist_exp_unique_idx"
  ON "validation_assistance_exposures" ("workspace_id", "user_id", "key_point_id", "exposure_fingerprint");
CREATE INDEX IF NOT EXISTS "val_assist_exp_user_kp_idx"
  ON "validation_assistance_exposures" ("user_id", "key_point_id");

-- ═════════════════════════════════════════════════════════════════════════
-- §6.5: validation_point_assessments (新表)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "validation_point_assessments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "submission_id" uuid NOT NULL REFERENCES "validation_submissions"("id") ON DELETE CASCADE,
  "rubric_item_id" uuid NOT NULL REFERENCES "validation_question_rubric_items"("id") ON DELETE CASCADE,
  "verdict" text NOT NULL,
  "assessment_source" text NOT NULL,
  "confidence" integer,
  "rationale" text,
  "answer_excerpt" text,
  "evidence_snapshot" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "val_point_assess_unique_idx"
  ON "validation_point_assessments" ("submission_id", "rubric_item_id");
CREATE INDEX IF NOT EXISTS "val_point_assess_sub_idx"
  ON "validation_point_assessments" ("submission_id");
CREATE INDEX IF NOT EXISTS "val_point_assess_u_w_idx"
  ON "validation_point_assessments" ("user_id", "workspace_id");

-- ═════════════════════════════════════════════════════════════════════════
-- §6.6: validation_events 扩展
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE "validation_events" ADD COLUMN IF NOT EXISTS "submission_id" uuid;
ALTER TABLE "validation_events" ADD COLUMN IF NOT EXISTS "note_version_id" uuid;
ALTER TABLE "validation_events" ADD COLUMN IF NOT EXISTS "rubric_version" text;
ALTER TABLE "validation_events" ADD COLUMN IF NOT EXISTS "reducer_version" text;
ALTER TABLE "validation_events" ADD COLUMN IF NOT EXISTS "source_fingerprint" text;
ALTER TABLE "validation_events" ADD COLUMN IF NOT EXISTS "source_status" text;

-- ═════════════════════════════════════════════════════════════════════════
-- §6.6: review_attempts 扩展
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE "review_attempts" ADD COLUMN IF NOT EXISTS "evaluation_artifact_id" uuid REFERENCES "ai_artifacts"("id") ON DELETE SET NULL;
ALTER TABLE "review_attempts" ADD COLUMN IF NOT EXISTS "evaluation_status" text;
ALTER TABLE "review_attempts" ADD COLUMN IF NOT EXISTS "assistance_level" text;
ALTER TABLE "review_attempts" ADD COLUMN IF NOT EXISTS "evidence_revealed_at" timestamptz;
ALTER TABLE "review_attempts" ADD COLUMN IF NOT EXISTS "policy_version" text;
ALTER TABLE "review_attempts" ADD COLUMN IF NOT EXISTS "source_fingerprint" text;

-- ═════════════════════════════════════════════════════════════════════════
-- §6.6: review_schedules 扩展
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE "review_schedules" ADD COLUMN IF NOT EXISTS "key_point_id" uuid REFERENCES "card_key_points"("id") ON DELETE SET NULL;
ALTER TABLE "review_schedules" ADD COLUMN IF NOT EXISTS "generation" integer NOT NULL DEFAULT 0;
ALTER TABLE "review_schedules" ADD COLUMN IF NOT EXISTS "policy_version" text;
ALTER TABLE "review_schedules" ADD COLUMN IF NOT EXISTS "reason_code" text;
ALTER TABLE "review_schedules" ADD COLUMN IF NOT EXISTS "supersedes_schedule_id" uuid;

CREATE INDEX IF NOT EXISTS "review_schedules_key_point_idx"
  ON "review_schedules" ("key_point_id", "status", "next_review_at");

-- §10.6: 每个 (workspace,user,key_point) 最多一条 pending schedule
CREATE UNIQUE INDEX IF NOT EXISTS "review_schedules_pending_unique_idx"
  ON "review_schedules" ("workspace_id", "user_id", "key_point_id")
  WHERE "status" = 'pending' AND "key_point_id" IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- §6.6: ai_artifacts 扩展
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE "ai_artifacts" ADD COLUMN IF NOT EXISTS "parent_artifact_id" uuid;

-- ═════════════════════════════════════════════════════════════════════════
-- §6.8: scheduling_shadow_decisions (新表)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "scheduling_shadow_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key_point_id" uuid REFERENCES "card_key_points"("id") ON DELETE SET NULL,
  "source_type" text NOT NULL,
  "source_id" uuid NOT NULL,
  "algorithm" text NOT NULL,
  "algorithm_version" text NOT NULL,
  "parameters_version" text NOT NULL,
  "input_snapshot" jsonb,
  "predicted_due_at" timestamptz NOT NULL,
  "stability" jsonb,
  "difficulty" jsonb,
  "retrievability" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "sched_shadow_unique_idx"
  ON "scheduling_shadow_decisions" ("source_type", "source_id", "algorithm", "parameters_version");
CREATE INDEX IF NOT EXISTS "sched_shadow_user_kp_idx"
  ON "scheduling_shadow_decisions" ("user_id", "key_point_id");

-- ═════════════════════════════════════════════════════════════════════════
-- §6.9: RLS policies for new tables (user-private)
-- ═════════════════════════════════════════════════════════════════════════

-- Enable RLS on all new tables
ALTER TABLE "validation_question_rubric_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "validation_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "validation_submission_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "validation_action_commands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "validation_assistance_exposures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "validation_point_assessments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduling_shadow_decisions" ENABLE ROW LEVEL SECURITY;

-- RLS policies: workspace_id-based access (same pattern as existing tables)
-- validation_submissions: user_id isolation
DO $$ BEGIN
  CREATE POLICY "val_submissions_user_isolation"
    ON "validation_submissions" FOR ALL
    USING ("user_id" = current_setting('app.current_user_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- validation_action_commands: user_id isolation
DO $$ BEGIN
  CREATE POLICY "val_action_cmd_user_isolation"
    ON "validation_action_commands" FOR ALL
    USING ("user_id" = current_setting('app.current_user_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- validation_assistance_exposures: user_id isolation
DO $$ BEGIN
  CREATE POLICY "val_assist_exp_user_isolation"
    ON "validation_assistance_exposures" FOR ALL
    USING ("user_id" = current_setting('app.current_user_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- validation_point_assessments: user_id isolation
DO $$ BEGIN
  CREATE POLICY "val_point_assess_user_isolation"
    ON "validation_point_assessments" FOR ALL
    USING ("user_id" = current_setting('app.current_user_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- scheduling_shadow_decisions: user_id isolation
DO $$ BEGIN
  CREATE POLICY "sched_shadow_user_isolation"
    ON "scheduling_shadow_decisions" FOR ALL
    USING ("user_id" = current_setting('app.current_user_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- validation_question_rubric_items: workspace-level (no user_id column)
DO $$ BEGIN
  CREATE POLICY "vq_rubric_items_workspace_isolation"
    ON "validation_question_rubric_items" FOR ALL
    USING ("workspace_id" = current_setting('app.current_workspace_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- validation_submission_jobs: workspace-level (access via submission)
DO $$ BEGIN
  CREATE POLICY "val_sub_jobs_workspace_isolation"
    ON "validation_submission_jobs" FOR ALL
    USING (EXISTS (
      SELECT 1 FROM "validation_submissions" s
      WHERE s.id = "validation_submission_jobs"."submission_id"
        AND s.user_id = current_setting('app.current_user_id', true)::uuid
    ));
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- §7.7: jobs 表扩展 — card repair state persistence
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "repair_state" text NOT NULL DEFAULT 'none';
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "repair_attempt_count" integer NOT NULL DEFAULT 0;

-- CHECK (0..1): at most one repair per job (计划 §7.7)
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_repair_attempt_count_check"
    CHECK ("repair_attempt_count" >= 0 AND "repair_attempt_count" <= 1);
EXCEPTION WHEN duplicate_object THEN null; END $$;
