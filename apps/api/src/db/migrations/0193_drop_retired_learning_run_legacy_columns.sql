-- 0193: remove the unused legacy Session/Episode provenance columns.
--
-- The E17 legacy backfill is not part of the current runtime and no active
-- reader or writer uses these nullable columns.  The associated partial
-- unique index was only an idempotency guard for that retired backfill.

DROP INDEX IF EXISTS public.learning_runs_legacy_episode_unique_idx;

ALTER TABLE public.learning_runs
  DROP COLUMN IF EXISTS legacy_session_id;
ALTER TABLE public.learning_runs
  DROP COLUMN IF EXISTS legacy_episode_id;
ALTER TABLE public.learning_runs
  DROP COLUMN IF EXISTS legacy_ordinal;
