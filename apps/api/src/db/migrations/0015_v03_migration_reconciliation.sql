-- Forward-only reconciliation for databases that already passed journal entry
-- 0003.  The exact SQL bytes recorded by deployed databases (SHA-256 prefix
-- 2e971def) are no longer present in the repository; editing 0003 alone would
-- never repair those installations because Drizzle does not re-run old entries.

-- ---------------------------------------------------------------------------
-- 1. Reconcile the two renamed enums, including every legacy value.
-- ---------------------------------------------------------------------------

ALTER TABLE "ai_artifacts" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ai_artifacts" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;
UPDATE "ai_artifacts"
SET "status" = CASE "status"
  WHEN 'draft' THEN 'pending'
  WHEN 'rejected' THEN 'dismissed'
  WHEN 'superseded' THEN 'stale'
  ELSE "status"
END;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "ai_artifacts"
    WHERE "status" NOT IN ('pending', 'ready', 'failed', 'stale', 'dismissed', 'accepted')
  ) THEN
    RAISE EXCEPTION 'ai_artifacts.status contains an unmapped legacy value';
  END IF;
END $$;
DROP TYPE IF EXISTS "public"."artifact_status";
CREATE TYPE "public"."artifact_status" AS ENUM('pending', 'ready', 'failed', 'stale', 'dismissed', 'accepted');
ALTER TABLE "ai_artifacts" ALTER COLUMN "status" SET DATA TYPE "public"."artifact_status" USING "status"::"public"."artifact_status";
ALTER TABLE "ai_artifacts" ALTER COLUMN "status" SET DEFAULT 'ready';
--> statement-breakpoint

ALTER TABLE "validation_events" ALTER COLUMN "outcome" SET DATA TYPE text USING "outcome"::text;
UPDATE "validation_events"
SET "outcome" = CASE "outcome"
  WHEN 'preliminary' THEN 'preliminary_understanding'
  WHEN 'validated' THEN 'preliminary_understanding'
  WHEN 'unclear' THEN 'unclear_expression'
  ELSE "outcome"
END;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "validation_events"
    WHERE "outcome" NOT IN (
      'preliminary_understanding',
      'unclear_expression',
      'misunderstanding',
      'unknown'
    )
  ) THEN
    RAISE EXCEPTION 'validation_events.outcome contains an unmapped legacy value';
  END IF;
END $$;
DROP TYPE IF EXISTS "public"."validation_outcome";
CREATE TYPE "public"."validation_outcome" AS ENUM('preliminary_understanding', 'unclear_expression', 'misunderstanding', 'unknown');
ALTER TABLE "validation_events" ALTER COLUMN "outcome" SET DATA TYPE "public"."validation_outcome" USING "outcome"::"public"."validation_outcome";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Undo the unreleased/unsafe 0014 RLS variant if it reached any database.
--    RLS stays off until API/worker roles and transaction-local context exist.
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS "sources" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "source_segments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "notes" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "note_versions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "note_blocks" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "learning_cards" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "card_key_points" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "evidences" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "evidence_overrides" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "validation_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "validation_questions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "review_schedules" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "understanding_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ai_artifacts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "jobs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ai_audit_log" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS "sources" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "source_segments" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "notes" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "note_versions" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "note_blocks" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "learning_cards" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "card_key_points" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "evidences" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "evidence_overrides" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "validation_events" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "validation_questions" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "review_schedules" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "understanding_events" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ai_artifacts" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "jobs" DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ai_audit_log" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sources_workspace_policy" ON "sources";
DROP POLICY IF EXISTS "source_segments_workspace_policy" ON "source_segments";
DROP POLICY IF EXISTS "notes_workspace_policy" ON "notes";
DROP POLICY IF EXISTS "note_versions_workspace_policy" ON "note_versions";
DROP POLICY IF EXISTS "note_blocks_workspace_policy" ON "note_blocks";
DROP POLICY IF EXISTS "learning_cards_workspace_policy" ON "learning_cards";
DROP POLICY IF EXISTS "card_key_points_workspace_policy" ON "card_key_points";
DROP POLICY IF EXISTS "evidences_workspace_policy" ON "evidences";
DROP POLICY IF EXISTS "evidence_overrides_workspace_policy" ON "evidence_overrides";
DROP POLICY IF EXISTS "validation_events_workspace_policy" ON "validation_events";
DROP POLICY IF EXISTS "validation_questions_workspace_policy" ON "validation_questions";
DROP POLICY IF EXISTS "review_schedules_workspace_policy" ON "review_schedules";
DROP POLICY IF EXISTS "understanding_events_workspace_policy" ON "understanding_events";
DROP POLICY IF EXISTS "ai_artifacts_workspace_policy" ON "ai_artifacts";
DROP POLICY IF EXISTS "jobs_workspace_policy" ON "jobs";
DROP POLICY IF EXISTS "ai_audit_log_workspace_policy" ON "ai_audit_log";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Reconcile composite SET NULL actions.  Only the nullable identifier may
--    be cleared; workspace_id is NOT NULL and must remain unchanged.
-- ---------------------------------------------------------------------------

ALTER TABLE "validation_events" DROP CONSTRAINT IF EXISTS "validation_events_keypoint_workspace_fk";
ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_keypoint_workspace_fk"
  FOREIGN KEY ("key_point_id", "workspace_id") REFERENCES "card_key_points"("id", "workspace_id")
  ON DELETE SET NULL ("key_point_id");

ALTER TABLE "validation_events" DROP CONSTRAINT IF EXISTS "validation_events_artifact_workspace_fk";
ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_artifact_workspace_fk"
  FOREIGN KEY ("artifact_id", "workspace_id") REFERENCES "ai_artifacts"("id", "workspace_id")
  ON DELETE SET NULL ("artifact_id");

ALTER TABLE "review_schedules" DROP CONSTRAINT IF EXISTS "review_schedules_event_workspace_fk";
ALTER TABLE "review_schedules" ADD CONSTRAINT "review_schedules_event_workspace_fk"
  FOREIGN KEY ("validation_event_id", "workspace_id") REFERENCES "validation_events"("id", "workspace_id")
  ON DELETE SET NULL ("validation_event_id");

ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_current_version_workspace_fk";
ALTER TABLE "notes" ADD CONSTRAINT "notes_current_version_workspace_fk"
  FOREIGN KEY ("current_version_id", "workspace_id") REFERENCES "note_versions"("id", "workspace_id")
  ON DELETE SET NULL ("current_version_id");

ALTER TABLE "learning_cards" DROP CONSTRAINT IF EXISTS "learning_cards_artifact_workspace_fk";
ALTER TABLE "learning_cards" ADD CONSTRAINT "learning_cards_artifact_workspace_fk"
  FOREIGN KEY ("artifact_id", "workspace_id") REFERENCES "ai_artifacts"("id", "workspace_id")
  ON DELETE SET NULL ("artifact_id");

ALTER TABLE "evidences" DROP CONSTRAINT IF EXISTS "evidences_block_id_note_blocks_id_fk";
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_block_id_note_blocks_id_fk"
  FOREIGN KEY ("block_id") REFERENCES "note_blocks"("id") ON DELETE SET NULL;
ALTER TABLE "evidences" DROP CONSTRAINT IF EXISTS "evidences_block_workspace_fk";
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_block_workspace_fk"
  FOREIGN KEY ("block_id", "workspace_id") REFERENCES "note_blocks"("id", "workspace_id")
  ON DELETE SET NULL ("block_id");

ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_workspace_id_workspaces_id_fk";
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;

ALTER TABLE "validation_events" DROP CONSTRAINT IF EXISTS "validation_events_job_workspace_fk";
ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_job_workspace_fk"
  FOREIGN KEY ("job_id", "workspace_id") REFERENCES "jobs"("id", "workspace_id")
  ON DELETE SET NULL ("job_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Converge historical duplicates before adding database idempotency guards.
-- ---------------------------------------------------------------------------

-- Keep the newest active card and preserve older rows as superseded history.
WITH ranked_cards AS (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY "workspace_id", "note_version_id"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS canonical_id,
    row_number() OVER (
      PARTITION BY "workspace_id", "note_version_id"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS duplicate_rank
  FROM "learning_cards"
  WHERE "status" = 'active'
)
UPDATE "learning_cards" lc
SET
  "status" = 'superseded',
  "superseded_by_card_id" = ranked_cards.canonical_id,
  "updated_at" = now()
FROM ranked_cards
WHERE lc."id" = ranked_cards."id"
  AND ranked_cards.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "learning_cards_workspace_note_version_active_unique_idx"
  ON "learning_cards" ("workspace_id", "note_version_id")
  WHERE "status" = 'active';
--> statement-breakpoint

-- Prefer an already-running generate_card job; mark the remaining active
-- duplicates dead so a concurrently executing loser is fenced by status.
WITH ranked_jobs AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "workspace_id", ("payload"->>'noteVersionId')
      ORDER BY
        CASE "status" WHEN 'running' THEN 0 ELSE 1 END,
        COALESCE("started_at", "scheduled_at") ASC,
        "id" ASC
    ) AS duplicate_rank
  FROM "jobs"
  WHERE "type" = 'generate_card'
    AND "status" IN ('pending', 'running')
    AND "payload"->>'noteVersionId' IS NOT NULL
)
UPDATE "jobs" j
SET
  "status" = 'dead',
  "finished_at" = COALESCE(j."finished_at", now()),
  "last_error" = COALESCE(j."last_error", 'deduplicated by migration 0015'),
  "lease_token" = NULL
FROM ranked_jobs
WHERE j."id" = ranked_jobs."id"
  AND ranked_jobs.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "jobs_generate_card_active_unique_idx"
  ON "jobs" ("workspace_id", (("payload"->>'noteVersionId')))
  WHERE "type" = 'generate_card'
    AND "status" IN ('pending', 'running')
    AND "payload"->>'noteVersionId' IS NOT NULL;
--> statement-breakpoint

-- Keep the newest validation event linked to each evaluate job.  Older events
-- remain as history but lose job_id, avoiding destructive deletes and preserving
-- review/understanding references.
WITH ranked_validation_events AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "job_id"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS duplicate_rank
  FROM "validation_events"
  WHERE "job_id" IS NOT NULL
)
UPDATE "validation_events" ve
SET "job_id" = NULL
FROM ranked_validation_events
WHERE ve."id" = ranked_validation_events."id"
  AND ranked_validation_events.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "validation_events_job_unique_idx"
  ON "validation_events" ("job_id")
  WHERE "job_id" IS NOT NULL;
