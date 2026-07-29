-- A partial result is a terminal, immutable generation outcome. It must not
-- occupy the active-fingerprint slot or block a later explicit derivation.
DROP INDEX IF EXISTS public.card_generation_runs_active_fingerprint_unique_idx;
CREATE UNIQUE INDEX card_generation_runs_active_fingerprint_unique_idx
  ON public.card_generation_runs(workspace_id, note_version_id, generation_fingerprint)
  WHERE status NOT IN ('partial_ready', 'succeeded', 'cancelled', 'superseded');
