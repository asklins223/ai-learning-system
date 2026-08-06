-- 0061: Card-generation schema drift after removing legacy_bridge + pipeline_v2 engines
--
-- The Drizzle schema removed the v2-pipeline-only columns (0044/0045 created them)
-- and refreshed the engine defaults set by 0052. This migration brings an already
-- migrated database in line with the supervisor_agent_v1-only schema.

-- 1. Drop v2-pipeline-only columns from card_generation_runs
ALTER TABLE public.card_generation_runs
  DROP COLUMN IF EXISTS pipeline_version,
  DROP COLUMN IF EXISTS prompt_bundle_version,
  DROP COLUMN IF EXISTS legacy_job_id,
  DROP COLUMN IF EXISTS exclusion_policy;

-- 2. supervisor_agent_v1 is the only engine; refresh the 0052 defaults
ALTER TABLE public.card_generation_runs
  ALTER COLUMN engine_mode SET DEFAULT 'supervisor_agent_v1';
ALTER TABLE public.card_generation_runs
  ALTER COLUMN result_contract_version SET DEFAULT 'result-contract-v1';

-- 3. card_generation_units: drop pipeline_version (0045 created it) and narrow
--    the identity unique index to (run_id, kind, level, ordinal).
--    DROP COLUMN implicitly drops the old 5-column unique index; recreate it
--    without pipeline_version.
ALTER TABLE public.card_generation_units
  DROP COLUMN IF EXISTS pipeline_version;

DROP INDEX IF EXISTS card_generation_units_identity_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_units_identity_unique_idx
  ON public.card_generation_units(run_id, kind, level, ordinal);
