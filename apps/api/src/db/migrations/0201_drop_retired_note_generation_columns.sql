-- 0201: remove the retired V1 generation bridge columns from notes.
--
-- V2 generation runs own their identity in card_generation_runs_v2 and do not
-- use the old note epoch/latest-run bridge.

ALTER TABLE public.notes
  DROP CONSTRAINT IF EXISTS notes_latest_generation_run_fk;

ALTER TABLE public.notes
  DROP COLUMN IF EXISTS card_generation_epoch,
  DROP COLUMN IF EXISTS latest_generation_run_id;
