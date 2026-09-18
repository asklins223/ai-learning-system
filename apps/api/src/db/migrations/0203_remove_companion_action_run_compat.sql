-- 0203: remove the unused asynchronous companion action-run path.
--
-- Current companion actions execute synchronously inside the proposal
-- transaction.  No current writer creates companion_action_runs, so keeping
-- that table and the proposal pointer only exposes a dead replay contract.

ALTER TABLE IF EXISTS public.companion_action_proposals
  ADD COLUMN IF NOT EXISTS result_ref text,
  ADD COLUMN IF NOT EXISTS result_route jsonb,
  ADD COLUMN IF NOT EXISTS result_safe_summary text;

DROP INDEX IF EXISTS public.companion_action_proposals_run_idx;

ALTER TABLE IF EXISTS public.companion_action_proposals
  DROP COLUMN IF EXISTS action_run_id;

DROP TABLE IF EXISTS public.companion_action_runs;
