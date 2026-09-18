-- 0199: remove the last current-schema artifact of the retired V1 generate_card job.
--
-- The worker only accepts parse_source and companion_* jobs now. The old
-- generate_card handler and enqueue path were removed, so this partial index
-- no longer protects a live contract and must not remain in the database.

DROP INDEX IF EXISTS public.jobs_generate_card_active_unique_idx;
