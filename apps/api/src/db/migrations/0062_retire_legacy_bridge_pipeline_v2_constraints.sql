-- 0062: Retire Legacy Bridge & Pipeline V2 engine CHECK constraints
--
-- After migration 0061 dropped the v2-pipeline-only columns, the CHECK
-- constraints still allow V2-era status and kind values that the
-- supervisor_agent_v1 engine never writes.  This migration:
--
-- 1. Backfills any lingering non-terminal V2-status runs to 'superseded'
--    so the narrowed CHECK does not violate existing rows.
-- 2. Narrows card_generation_runs.status to supervisor_agent_v1 values only.
-- 3. Narrows card_generation_units.kind to supervisor_agent_v1 values only.
-- 4. Adds 'preparing' to the run status CHECK (was missing from 0052).

-- ─── 1. Backfill non-terminal V2-status runs ──────────────────────────────

UPDATE public.card_generation_runs
  SET status = 'superseded',
      error_code = COALESCE(error_code, 'engine_retired'),
      updated_at = now(),
      finished_at = COALESCE(finished_at, now())
  WHERE status IN ('planning', 'awaiting_assets', 'mapping', 'reducing', 'rendering', 'agent_running', 'verifying');

-- ─── 2. Narrow card_generation_runs.status CHECK ──────────────────────────

ALTER TABLE public.card_generation_runs
  DROP CONSTRAINT IF EXISTS card_generation_runs_status_check;

ALTER TABLE public.card_generation_runs
  ADD CONSTRAINT card_generation_runs_status_check
  CHECK (status = ANY (ARRAY[
    'queued'::text,
    'preparing'::text,
    'running'::text,
    'validating'::text,
    'publishing'::text,
    'needs_attention'::text,
    'partial_ready'::text,
    'succeeded'::text,
    'cancelled'::text,
    'superseded'::text
  ]));

-- ─── 3. Narrow card_generation_units.kind CHECK ───────────────────────────

ALTER TABLE public.card_generation_units
  DROP CONSTRAINT IF EXISTS card_generation_units_kind_check;

ALTER TABLE public.card_generation_units
  ADD CONSTRAINT card_generation_units_kind_check
  CHECK (kind = ANY (ARRAY[
    'prepare'::text,
    'agent_run'::text,
    'deterministic_verify'::text,
    'publish'::text
  ]));
