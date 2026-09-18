-- The project has no production users. Remove values that only existed in
-- pre-launch compatibility paths and make the current contracts database-level
-- invariants.

DELETE FROM public.assistant_memory_items
WHERE source_type = 'legacy';

ALTER TABLE public.assistant_memory_items
  DROP CONSTRAINT IF EXISTS assistant_memory_items_source_type_check;

ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_items_source_type_check
  CHECK (source_type IN ('user_stated', 'model_inferred', 'confirmed', 'summary'));

UPDATE public.companion_account_invitations
SET status = 'offered',
    offered_at = COALESCE(offered_at, created_at, now()),
    revision = GREATEST(revision, 1),
    updated_at = now()
WHERE status = 'not_offered';

ALTER TABLE public.companion_account_invitations
  DROP CONSTRAINT IF EXISTS companion_account_invitations_status_check;

ALTER TABLE public.companion_account_invitations
  ADD CONSTRAINT companion_account_invitations_status_check
  CHECK (status IN ('offered', 'deferred', 'accepted', 'skipped'));

ALTER TABLE public.companion_account_invitations
  ALTER COLUMN status SET DEFAULT 'offered';
