-- 0082: Persist the deterministic assessment decision hash so a synchronous
-- API retry and an asynchronous worker retry can return the same result.

--> statement-breakpoint

ALTER TABLE public.learning_assessment_reports
  ADD COLUMN IF NOT EXISTS decision_hash text;

--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.learning_assessment_reports TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON public.learning_assessment_reports TO ailearn_worker;
  END IF;
END $$;
