-- 0042: v0.6 artifact enum + persisted-error/data-integrity repair
--
-- 0040/0041 introduced three new ArtifactType values at the TypeScript layer,
-- but the deployed PostgreSQL enum still only accepted the legacy values.
-- Keep this as a forward-only migration because existing environments may
-- already have recorded 0040/0041 as applied.

ALTER TYPE public.artifact_type
  ADD VALUE IF NOT EXISTS 'validation_question';
--> statement-breakpoint

ALTER TYPE public.artifact_type
  ADD VALUE IF NOT EXISTS 'rubric_evaluation';
--> statement-breakpoint

ALTER TYPE public.artifact_type
  ADD VALUE IF NOT EXISTS 'deterministic_question';
--> statement-breakpoint

-- A failed Drizzle write could persist its rendered SQL parameters in
-- jobs.last_error.  Limit the cleanup to the v0.6 question/evaluation job
-- types and to messages that are recognisably Drizzle query errors with a
-- params section; unrelated operational errors remain untouched.
UPDATE public.jobs
SET last_error = 'database_error_redacted'
WHERE type IN ('generate_validation_question', 'evaluate_validation')
  AND last_error IS NOT NULL
  AND last_error ~* '(DrizzleQueryError|Failed query:)'
  AND last_error ~* 'params[[:space:]]*:';
--> statement-breakpoint

-- Plan §6.6 requires review_attempts.next_schedule_id to retain referential
-- integrity.  Clear only pre-existing orphan references, then install the FK.
UPDATE public.review_attempts AS attempt
SET next_schedule_id = NULL
WHERE next_schedule_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.review_schedules AS schedule
    WHERE schedule.id = attempt.next_schedule_id
  );
--> statement-breakpoint

DO $migration$
BEGIN
  ALTER TABLE public.review_attempts
    ADD CONSTRAINT review_attempts_next_schedule_id_review_schedules_id_fk
    FOREIGN KEY (next_schedule_id)
    REFERENCES public.review_schedules(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$migration$;
