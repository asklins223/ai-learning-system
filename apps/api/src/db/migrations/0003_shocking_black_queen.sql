-- Fresh-install repair for the v0.3 baseline.
--
-- IMPORTANT: an already deployed database records a different SHA-256 for the
-- migration at this journal position (2e971def...).  That exact historical SQL
-- is no longer present in the repository, so its immutable bytes cannot be
-- recovered here.  Existing installations do not re-run this file; migration
-- 0015 performs the forward-only, idempotent reconciliation for those databases.

CREATE TYPE "public"."artifact_type" AS ENUM('learning_card', 'summary', 'code_explanation', 'pitfall', 'question', 'validation_feedback', 'tag_suggestion');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'accepted', 'dismissed', 'completed', 'superseded', 'cancelled');--> statement-breakpoint

DROP INDEX IF EXISTS "review_schedules_next_idx";--> statement-breakpoint

-- Rebuild artifact_status in a data-preserving order.  The old enum does not
-- contain `ready`, therefore the old migration's early SET DEFAULT failed on a
-- fresh database.  Defaults must be removed before the old enum can be dropped.
ALTER TABLE "ai_artifacts" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ai_artifacts" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
UPDATE "ai_artifacts"
SET "status" = CASE "status"
  WHEN 'draft' THEN 'pending'
  WHEN 'rejected' THEN 'dismissed'
  WHEN 'superseded' THEN 'stale'
  ELSE "status"
END;--> statement-breakpoint
DROP TYPE "public"."artifact_status";--> statement-breakpoint
CREATE TYPE "public"."artifact_status" AS ENUM('pending', 'ready', 'failed', 'stale', 'dismissed', 'accepted');--> statement-breakpoint
ALTER TABLE "ai_artifacts" ALTER COLUMN "status" SET DATA TYPE "public"."artifact_status" USING "status"::"public"."artifact_status";--> statement-breakpoint
ALTER TABLE "ai_artifacts" ALTER COLUMN "status" SET DEFAULT 'ready';--> statement-breakpoint

-- validation_events.outcome started as text.  Map every legacy value before
-- introducing the narrower v0.3 enum so upgrades with historical rows succeed.
ALTER TABLE "validation_events" ALTER COLUMN "outcome" SET DATA TYPE text USING "outcome"::text;--> statement-breakpoint
UPDATE "validation_events"
SET "outcome" = CASE "outcome"
  WHEN 'preliminary' THEN 'preliminary_understanding'
  WHEN 'validated' THEN 'preliminary_understanding'
  WHEN 'unclear' THEN 'unclear_expression'
  ELSE "outcome"
END;--> statement-breakpoint
DROP TYPE "public"."validation_outcome";--> statement-breakpoint
CREATE TYPE "public"."validation_outcome" AS ENUM('preliminary_understanding', 'unclear_expression', 'misunderstanding', 'unknown');--> statement-breakpoint
ALTER TABLE "validation_events" ALTER COLUMN "outcome" SET DATA TYPE "public"."validation_outcome" USING "outcome"::"public"."validation_outcome";--> statement-breakpoint

ALTER TABLE "ai_artifacts" ALTER COLUMN "type" SET DATA TYPE "public"."artifact_type" USING "type"::"public"."artifact_type";--> statement-breakpoint

-- Add identity columns as nullable, backfill with the owning workspace user,
-- then enforce NOT NULL.  Random UUID defaults create invalid foreign keys on
-- databases that already contain reviews or validation events.
ALTER TABLE "review_schedules" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "review_schedules" ADD COLUMN "validation_event_id" uuid;--> statement-breakpoint
ALTER TABLE "review_schedules" ADD COLUMN "status" "review_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "validation_events" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "validation_events" ADD COLUMN "key_point_id" uuid;--> statement-breakpoint
ALTER TABLE "validation_events" ADD COLUMN "artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "validation_events" ADD COLUMN "question_type" text NOT NULL DEFAULT 'explain';--> statement-breakpoint
ALTER TABLE "validation_events" ADD COLUMN "feedback" jsonb;--> statement-breakpoint
ALTER TABLE "ai_artifacts" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "ai_artifacts" ADD COLUMN "cost_tokens" integer;--> statement-breakpoint

UPDATE "review_schedules" rs
SET "user_id" = w."owner_id"
FROM "workspaces" w
WHERE rs."workspace_id" = w."id"
  AND rs."user_id" IS NULL;--> statement-breakpoint

UPDATE "validation_events" ve
SET "user_id" = w."owner_id"
FROM "workspaces" w
WHERE ve."workspace_id" = w."id"
  AND ve."user_id" IS NULL;--> statement-breakpoint

ALTER TABLE "review_schedules" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "validation_events" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "review_schedules" ADD CONSTRAINT "review_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_schedules" ADD CONSTRAINT "review_schedules_validation_event_id_validation_events_id_fk" FOREIGN KEY ("validation_event_id") REFERENCES "public"."validation_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "understanding_events" ADD CONSTRAINT "understanding_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_card_id_learning_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."learning_cards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_key_point_id_card_key_points_id_fk" FOREIGN KEY ("key_point_id") REFERENCES "public"."card_key_points"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_artifact_id_ai_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."ai_artifacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "review_schedules_user_status_idx" ON "review_schedules" USING btree ("user_id","status","next_review_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "understanding_events_subject_idx" ON "understanding_events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "validation_events_user_idx" ON "validation_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_artifacts_input_hash_idx" ON "ai_artifacts" USING btree ("input_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_schedules_next_idx" ON "review_schedules" USING btree ("next_review_at","status");
