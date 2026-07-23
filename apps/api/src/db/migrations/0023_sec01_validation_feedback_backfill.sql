-- SEC-01 expand phase: backfill input_refs.userId on historical
-- validation_feedback artifacts so the RLS actor guard
-- (sec01_v1_ai_artifacts_validation_actor_guard) will not lock them out once
-- ROW LEVEL SECURITY is activated.
--
-- The Worker started writing input_refs.userId in the same commit that
-- introduced this migration.  Rows created before that change have
-- input_refs that only contain { cardId, keyPointId }.  Without a backfill,
-- those rows would become unreadable after enforce because
-- NULLIF(input_refs->>'userId', '')::uuid would be NULL and therefore not
-- equal to any app.user_id setting.
--
-- Strategy:
--   1. Copy user_id from the validation_events row that references the
--      artifact via artifact_id.  This is the authoritative source because
--      every validation_feedback artifact is created in the same transaction
--      as its validation_event.
--   2. Rows that still have no userId after step 1 are orphaned artifacts
--      (handler crashed between artifact insert and validation_event insert).
--      They are marked with a quarantine flag in input_refs so a data review
--      can decide whether to delete or manually attribute them before enforce.
--
-- This migration is idempotent: running it twice is safe because the WHERE
-- clause only touches rows where input_refs->>'userId' IS NULL.

UPDATE "ai_artifacts" AS a
SET "input_refs" = jsonb_set(
  a."input_refs",
  '{userId}',
  to_jsonb(ve."user_id"::text)
)
FROM "validation_events" AS ve
WHERE a."type" = 'validation_feedback'
  AND a."id" = ve."artifact_id"
  AND NULLIF(a."input_refs"->>'userId', '') IS NULL;
--> statement-breakpoint

-- Quarantine orphaned validation_feedback artifacts that have no matching
-- validation_event.  These rows cannot be auto-attributed and must be
-- reviewed before enforce.  The quarantine flag is read by the data review
-- checklist; it does not affect runtime behavior while RLS is disabled.
UPDATE "ai_artifacts" AS a
SET "input_refs" = jsonb_set(
  a."input_refs",
  '{quarantineNoActor}',
  'true'::jsonb
)
WHERE a."type" = 'validation_feedback'
  AND NULLIF(a."input_refs"->>'userId', '') IS NULL;
--> statement-breakpoint

-- Report the backfill result so the migration log serves as evidence for the
-- independent security/data review required before SEC-01 enforce.
DO $migration$
DECLARE
  backfilled_count integer;
  quarantined_count integer;
BEGIN
  SELECT count(*) INTO backfilled_count
  FROM "ai_artifacts"
  WHERE "type" = 'validation_feedback'
    AND NULLIF("input_refs"->>'userId', '') IS NOT NULL;

  SELECT count(*) INTO quarantined_count
  FROM "ai_artifacts"
  WHERE "type" = 'validation_feedback'
    AND "input_refs" ? 'quarantineNoActor';

  RAISE NOTICE
    'SEC-01 backfill: % validation_feedback artifacts have userId, % quarantined orphans',
    backfilled_count, quarantined_count;
END
$migration$;
