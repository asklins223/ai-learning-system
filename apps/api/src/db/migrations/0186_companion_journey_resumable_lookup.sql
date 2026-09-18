-- 0186: account-level resumable journey lookup under FORCE RLS.
--
-- bootstrapJourney is scoped to the current workspace, but a paused journey
-- may belong to another workspace of the same account. A normal SELECT is
-- intentionally hidden by companion_journeys RLS, so expose only the minimal
-- contract through a locked-down SECURITY DEFINER function.

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_find_resumable_companion_journey(
  p_user_id uuid,
  p_workspace_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN p_user_id IS DISTINCT FROM NULLIF(current_setting('app.user_id', true), '')::uuid
      OR p_workspace_id IS DISTINCT FROM NULLIF(current_setting('app.workspace_id', true), '')::uuid
      THEN NULL::jsonb
    ELSE (
      SELECT jsonb_build_object(
        'version', 2,
        'journeyId', j.id,
        'userId', j.user_id,
        'workspaceId', j.workspace_id,
        'assistantSessionId', j.assistant_session_id,
        'status', j.status,
        'branch', j.branch,
        'currentStep', j.current_step,
        'stepRevision', j.step_revision,
        'dismissedNarrationSteps', j.dismissed_narration_steps,
        'refs', j.refs,
        'lastDomainEventId', j.last_domain_event_id,
        'pausedAt', j.paused_at,
        'pauseReason', j.pause_reason,
        'resumeTokenRef', j.resume_token_ref,
        'resumeExpiresAt', j.resume_expires_at,
        'completionKind', j.completion_kind,
        'error', j.error,
        'revision', j.revision
      )
      FROM public.companion_journeys AS j
      WHERE j.user_id = p_user_id
        AND j.workspace_id <> p_workspace_id
        AND j.status = 'paused'
      ORDER BY j.updated_at
      LIMIT 1
    )
  END
$function$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_find_resumable_companion_journey(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_find_resumable_companion_journey(uuid, uuid) TO ailearn_api;
