-- The pre-launch validation/question artifact variants have no current writer.
-- Remove their storage values so the database enum matches the application
-- contract instead of preserving an unused compatibility surface.
DROP POLICY IF EXISTS sec01_v1_ai_artifacts_tenant_guard
  ON public.ai_artifacts;
DROP POLICY IF EXISTS sec01_v1_ai_artifacts_validation_actor_guard
  ON public.ai_artifacts;
DROP POLICY IF EXISTS sec01_v1_ai_artifacts_runtime_access
  ON public.ai_artifacts;
--> statement-breakpoint

DELETE FROM public.ai_artifacts
WHERE type::text IN (
  'validation_feedback',
  'tag_suggestion',
  'validation_question',
  'rubric_evaluation',
  'deterministic_question'
);
--> statement-breakpoint

ALTER TABLE public.ai_artifacts
  ALTER COLUMN type SET DATA TYPE text USING type::text;
--> statement-breakpoint

DROP TYPE public.artifact_type;
--> statement-breakpoint

CREATE TYPE public.artifact_type AS ENUM (
  'learning_card',
  'summary',
  'code_explanation',
  'pitfall',
  'question'
);
--> statement-breakpoint

ALTER TABLE public.ai_artifacts
  ALTER COLUMN type SET DATA TYPE public.artifact_type USING type::public.artifact_type;
--> statement-breakpoint

CREATE POLICY sec01_v1_ai_artifacts_tenant_guard
  ON public.ai_artifacts
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint

CREATE POLICY sec01_v1_ai_artifacts_runtime_access
  ON public.ai_artifacts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
