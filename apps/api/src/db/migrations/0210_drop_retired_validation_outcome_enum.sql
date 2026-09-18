-- 0210: remove the enum left behind after the validation event tables were dropped.
-- No current table or runtime contract uses validation_outcome.

DROP TYPE IF EXISTS public.validation_outcome;
