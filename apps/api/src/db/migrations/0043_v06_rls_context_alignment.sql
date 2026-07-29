-- 0043: align v0.6 RLS policies with the canonical runtime context
--
-- API and Worker transactions set app.workspace_id / app.user_id.  The
-- original v0.6 policies introduced in 0040/0041 accidentally referenced
-- app.current_workspace_id / app.current_user_id, so restricted runtime roles
-- could not see or write their own v0.6 rows.  Recreate only the eight v0.6
-- policies and keep missing/empty context fail-closed.

DROP POLICY IF EXISTS "val_submissions_user_isolation"
  ON public.validation_submissions;
CREATE POLICY "val_submissions_user_isolation"
  ON public.validation_submissions FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "val_action_cmd_user_isolation"
  ON public.validation_action_commands;
CREATE POLICY "val_action_cmd_user_isolation"
  ON public.validation_action_commands FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "val_assist_exp_user_isolation"
  ON public.validation_assistance_exposures;
CREATE POLICY "val_assist_exp_user_isolation"
  ON public.validation_assistance_exposures FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "val_point_assess_user_isolation"
  ON public.validation_point_assessments;
CREATE POLICY "val_point_assess_user_isolation"
  ON public.validation_point_assessments FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "sched_shadow_user_isolation"
  ON public.scheduling_shadow_decisions;
CREATE POLICY "sched_shadow_user_isolation"
  ON public.scheduling_shadow_decisions FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "val_quality_sig_user_isolation"
  ON public.validation_quality_signals;
CREATE POLICY "val_quality_sig_user_isolation"
  ON public.validation_quality_signals FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "vq_rubric_items_workspace_isolation"
  ON public.validation_question_rubric_items;
CREATE POLICY "vq_rubric_items_workspace_isolation"
  ON public.validation_question_rubric_items FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "val_sub_jobs_workspace_isolation"
  ON public.validation_submission_jobs;
CREATE POLICY "val_sub_jobs_workspace_isolation"
  ON public.validation_submission_jobs FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.validation_submissions AS submission
      WHERE submission.id = validation_submission_jobs.submission_id
        AND submission.user_id =
          NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.validation_submissions AS submission
      WHERE submission.id = validation_submission_jobs.submission_id
        AND submission.user_id =
          NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );
