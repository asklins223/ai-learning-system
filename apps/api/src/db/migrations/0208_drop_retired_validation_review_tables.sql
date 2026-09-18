-- 0208: remove the pre-launch validation/review-attempt stack.
--
-- The current product submits learning-run commands and commits canonical
-- learning facts directly. No runtime route, worker job, exporter, or
-- onboarding step reads or writes the old question/event/attempt tables.
-- Development databases are disposable, so remove the dead storage instead
-- of carrying a compatibility read path forever.

DELETE FROM public.review_schedules
WHERE subject_type <> 'card';

ALTER TABLE public.review_schedules
  DROP COLUMN IF EXISTS validation_event_id,
  DROP CONSTRAINT IF EXISTS review_schedules_subject_type_check;

ALTER TABLE public.review_schedules
  ADD CONSTRAINT review_schedules_subject_type_check
  CHECK (subject_type = 'card');

DROP TABLE IF EXISTS public.review_attempts;
DROP TABLE IF EXISTS public.validation_events;
DROP TABLE IF EXISTS public.validation_questions;
DROP TABLE IF EXISTS public.understanding_events;
DROP TABLE IF EXISTS public.validation_action_commands;
