-- 0080: split Episode lifecycle from processing pipeline state.
--
-- `answered_locked` was previously written into learning_episodes.status even
-- though the lifecycle CHECK intentionally allows only draft/active/completed/
-- stale/cancelled. Answer locking now advances processing_phase and leaves the
-- lifecycle status as active until a real assessment/commit transition exists.

--> statement-breakpoint

ALTER TABLE public.learning_episodes
  ADD COLUMN IF NOT EXISTS processing_phase text NOT NULL DEFAULT 'awaiting_response';

--> statement-breakpoint

UPDATE public.learning_episodes
SET processing_phase = CASE
  WHEN status = 'completed' THEN 'committed'
  WHEN status = 'cancelled' THEN 'cancelled'
  WHEN status = 'stale' THEN 'stale'
  ELSE 'awaiting_response'
END
WHERE processing_phase IS NULL
   OR processing_phase = 'awaiting_response';

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_episodes
    ADD CONSTRAINT learning_episodes_processing_phase_check
    CHECK (processing_phase IN (
      'preparing', 'scene_ready', 'awaiting_response',
      'assessment_pending', 'assessment_complete', 'commit_pending',
      'committed', 'cancelled', 'stale'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_episodes_processing_phase_idx
  ON public.learning_episodes (workspace_id, user_id, processing_phase);
