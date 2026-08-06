-- A run that needs user attention is no longer active work. A fresh request
-- must be able to supersede it after provider/model/policy settings change,
-- while request_idempotency_key still replays the original run.
DROP INDEX IF EXISTS public.card_generation_runs_active_fingerprint_unique_idx;
CREATE UNIQUE INDEX card_generation_runs_active_fingerprint_unique_idx
  ON public.card_generation_runs(workspace_id, note_version_id, generation_fingerprint)
  WHERE status NOT IN (
    'partial_ready',
    'succeeded',
    'needs_attention',
    'cancelled',
    'superseded'
  );
