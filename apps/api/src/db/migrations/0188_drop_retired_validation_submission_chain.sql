-- 0188: remove the retired validation question/submission chain.
--
-- The current product writes learning-run assessments and keeps only the
-- validation action ledger / assistance cooldown tables.  No runtime producer
-- or consumer remains for the rubric, submission, submission-job, point
-- assessment, FSRS-shadow, or quality-signal tables; retaining them only made
-- exports, grants, and RLS checks pretend that the deleted worker/API chain
-- still existed.
--
-- Historical migrations remain immutable.  This forward migration makes an
-- existing development database match the current runtime contract.

DROP TABLE IF EXISTS public.validation_point_assessments;
DROP TABLE IF EXISTS public.validation_submission_jobs;
DROP TABLE IF EXISTS public.validation_quality_signals;
DROP TABLE IF EXISTS public.validation_submissions;
DROP TABLE IF EXISTS public.validation_question_rubric_items;
DROP TABLE IF EXISTS public.scheduling_shadow_decisions;
