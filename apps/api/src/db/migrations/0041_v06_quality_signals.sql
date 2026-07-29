-- 0041: v0.6 Quality Signals — 轻量质量信号 (计划 §8.4 Should)
--
-- 新增表：
--   validation_quality_signals (§8.4)
--
-- v0.6 只保存 user-private 信号、关联版本并避免有争议结果继续被当作高可信样本；
-- 完整分流、修正提案和处理后台进入 v0.7。

-- ═════════════════════════════════════════════════════════════════════════
-- §8.4: validation_quality_signals (新表)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "validation_quality_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "validation_event_id" uuid NOT NULL REFERENCES "validation_events"("id") ON DELETE CASCADE,
  "submission_id" uuid,
  "reason" text NOT NULL,
  "comment" text,
  "source_fingerprint" text,
  "rubric_version" text,
  "reducer_version" text,
  "policy_version" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "val_quality_sig_event_idx"
  ON "validation_quality_signals" ("validation_event_id");
CREATE INDEX IF NOT EXISTS "val_quality_sig_user_event_idx"
  ON "validation_quality_signals" ("user_id", "validation_event_id");

-- ═════════════════════════════════════════════════════════════════════════
-- §8.4: RLS policies for quality signals (user-private)
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE "validation_quality_signals" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "val_quality_sig_user_isolation"
    ON "validation_quality_signals" FOR ALL
    USING ("user_id" = current_setting('app.current_user_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- §12.3: Legacy data marking — mark old unrubriced questions
-- ═════════════════════════════════════════════════════════════════════════

-- Mark existing validation_questions that have no rubric items as legacy_unrubriced.
-- These questions can be displayed as history but cannot produce new upgrades (计划 §12.3).
UPDATE "validation_questions"
SET "status" = 'legacy_unrubriced'
WHERE "status" = 'active'
  AND "generator_kind" = 'ai'
  AND NOT EXISTS (
    SELECT 1 FROM "validation_question_rubric_items" ri
    WHERE ri.question_id = "validation_questions"."id"
  )
  AND "user_id" IS NULL;
