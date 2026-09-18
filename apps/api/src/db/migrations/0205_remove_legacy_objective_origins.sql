-- Objective origins are current-only. Remove the retired migrated-origin rows
-- and storage fields before tightening the table contract.
DELETE FROM public.learning_objective_origins_v2
WHERE origin_kind = 'legacy_migrated';

ALTER TABLE public.learning_objective_origins_v2
  DROP CONSTRAINT IF EXISTS loo_v2_kind_fields_chk,
  DROP CONSTRAINT IF EXISTS loo_v2_kind_chk;

ALTER TABLE public.learning_objective_origins_v2
  DROP COLUMN IF EXISTS legacy_card_id,
  DROP COLUMN IF EXISTS legacy_key_point_id;

ALTER TABLE public.learning_objective_origins_v2
  ADD CONSTRAINT loo_v2_kind_chk
    CHECK (origin_kind IN ('note', 'manual', 'imported')),
  ADD CONSTRAINT loo_v2_kind_fields_chk
    CHECK (
      (origin_kind = 'note' AND note_id IS NOT NULL AND note_version_id IS NOT NULL
        AND import_batch_ref IS NULL)
      OR (origin_kind = 'manual' AND note_id IS NULL AND note_version_id IS NULL
        AND import_batch_ref IS NULL)
      OR (origin_kind = 'imported' AND import_batch_ref IS NOT NULL
        AND note_id IS NULL AND note_version_id IS NULL)
    );
