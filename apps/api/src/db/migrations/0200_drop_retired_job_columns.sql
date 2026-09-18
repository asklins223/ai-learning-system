-- 0200: remove legacy V1 generation/repair columns from the shared jobs table.
--
-- The current queue uses requested_by, lease_token, priority, resource_class,
-- and idempotency_key. These columns belonged to the retired generate_card /
-- card-agent and v0.6 repair paths and have no current reader or writer.

ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_repair_attempt_count_check;
ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_generation_unit_fk,
  DROP CONSTRAINT IF EXISTS jobs_generation_unit_requires_run_check,
  DROP CONSTRAINT IF EXISTS jobs_generation_run_fk;
DROP INDEX IF EXISTS public.jobs_generation_run_idx;
DROP INDEX IF EXISTS public.jobs_generation_unit_idx;

ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS generation_run_id,
  DROP COLUMN IF EXISTS generation_unit_id,
  DROP COLUMN IF EXISTS stage,
  DROP COLUMN IF EXISTS repair_state,
  DROP COLUMN IF EXISTS repair_attempt_count;
