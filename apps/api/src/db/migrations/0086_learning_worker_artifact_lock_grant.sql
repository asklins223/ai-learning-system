-- 0086: SELECT ... FOR UPDATE on an immutable answer artifact still requires
-- UPDATE privilege in PostgreSQL. The worker never mutates the artifact; this
-- grant only permits the row lock used to make assessment persistence atomic.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, UPDATE ON public.learning_response_artifacts TO ailearn_worker;
  END IF;
END $$;
