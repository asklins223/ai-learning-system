-- 0087: repair the restricted Worker grants for the legacy validation queue.
--
-- The generate_validation_question and evaluate_rubric handlers use these
-- tables through the same workspace-bound transaction context as the newer
-- learning-session worker. Existing databases can have the roles bootstrap
-- applied before these tables were added, so make the grant repair forward
-- only and idempotent.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, UPDATE ON public.review_attempts TO ailearn_worker;
    GRANT SELECT, INSERT ON public.validation_questions TO ailearn_worker;
    GRANT SELECT, INSERT ON public.validation_question_rubric_items TO ailearn_worker;
    GRANT SELECT, UPDATE ON public.validation_submissions TO ailearn_worker;
    GRANT SELECT ON public.validation_assistance_exposures TO ailearn_worker;
    GRANT INSERT ON public.validation_point_assessments TO ailearn_worker;
    GRANT INSERT ON public.scheduling_shadow_decisions TO ailearn_worker;
  END IF;
END $$;
