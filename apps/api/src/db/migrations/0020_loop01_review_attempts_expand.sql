-- LOOP-01 / LOOP-02 expand phase: persistent review attempt model.
--
-- ADR-0004 requires a review_attempts table that records every recall/answer,
-- outcome, confidence, skip reason and schedule transition in one auditable
-- row.  This migration only adds the table, its indexes and expand-phase RLS
-- policies; relrowsecurity remains false until the independently reviewed
-- SEC-01 enforce migration activates it.
--
-- Design notes:
--   * Version references (validation_question_id, key_point_id, evidence_id,
--     note_version_id) are nullable because "later" and "unable" attempts may
--     not carry a full question/evidence snapshot.
--   * answer_text is nullable because recall/self_grade outcomes may omit a
--     free-text answer, and "later" attempts never carry one.
--   * The (workspace_id, user_id, idempotency_key) unique index is the
--     idempotency boundary defined by ADR-0004 point 6.
--   * schedule_before_* / schedule_after_* columns persist the exact scheduling
--     decision so users can explain "why now, why this interval" from history
--     without reconstructing it from side effects.

CREATE TABLE IF NOT EXISTS "review_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "review_schedule_id" uuid NOT NULL REFERENCES "review_schedules"("id") ON DELETE CASCADE,
  "subject_type" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "validation_event_id" uuid REFERENCES "validation_events"("id") ON DELETE SET NULL,
  "validation_question_id" uuid,
  "key_point_id" uuid REFERENCES "card_key_points"("id") ON DELETE SET NULL,
  "evidence_id" uuid REFERENCES "evidences"("id") ON DELETE SET NULL,
  "note_version_id" uuid,
  "answer_type" text,
  "answer_text" text,
  "outcome" text,
  "confidence" integer,
  "skip_reason" text,
  "schedule_before_interval_days" integer,
  "schedule_after_interval_days" integer,
  "schedule_reason_code" text,
  "understanding_effect" text,
  "next_review_at" timestamp with time zone,
  "idempotency_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'started',
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- History is the dominant read path: paginate by user within a workspace.
CREATE INDEX IF NOT EXISTS "review_attempts_workspace_user_created_idx"
  ON "review_attempts" ("workspace_id", "user_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint

-- Schedule lookup during start/submit/later.
CREATE INDEX IF NOT EXISTS "review_attempts_schedule_idx"
  ON "review_attempts" ("review_schedule_id", "created_at" DESC);
--> statement-breakpoint

-- Idempotency boundary: one final attempt per (workspace, user, key).
CREATE UNIQUE INDEX IF NOT EXISTS "review_attempts_idempotency_unique_idx"
  ON "review_attempts" ("workspace_id", "user_id", "idempotency_key");
--> statement-breakpoint

-- Subject-level audit trail (card / validation).
CREATE INDEX IF NOT EXISTS "review_attempts_subject_idx"
  ON "review_attempts" ("workspace_id", "subject_type", "subject_id", "created_at" DESC);
--> statement-breakpoint

-- LOOP-01 expand-phase RLS policy catalog.  Mirrors the user-private pattern
-- from 0019: tenant guard + actor guard + runtime access.  relrowsecurity
-- remains false here; enforcement is a later, independently reviewed migration.
DROP POLICY IF EXISTS "sec01_v1_review_attempts_tenant_guard" ON "review_attempts";
CREATE POLICY "sec01_v1_review_attempts_tenant_guard"
  ON "review_attempts"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "sec01_v1_review_attempts_actor_guard" ON "review_attempts";
CREATE POLICY "sec01_v1_review_attempts_actor_guard"
  ON "review_attempts"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "sec01_v1_review_attempts_runtime_access" ON "review_attempts";
CREATE POLICY "sec01_v1_review_attempts_runtime_access"
  ON "review_attempts"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
--> statement-breakpoint

-- Expand-phase invariant: policy creation must never silently become enforce.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'review_attempts'
      AND (c.relrowsecurity OR c.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION
      'LOOP-01 review_attempts expand migration refuses pre-activated RLS';
  END IF;
END
$migration$;
