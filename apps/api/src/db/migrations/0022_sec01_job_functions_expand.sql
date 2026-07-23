-- SEC-01 expand phase: job-specific SECURITY DEFINER functions for lease
-- renewal, success, and failure transitions.
--
-- ADR-0003 requires that Worker jobs be "收口为 job-specific renew/finish/fail
-- 函数" rather than granting blanket UPDATE on the jobs table.  These three
-- functions give the Worker a narrow, fenced interface that:
--
--   * Accepts only (job_id, workspace_id, lease_token) as the identity fence,
--     matching the immutable token assigned by ailearn_claim_jobs.
--   * Performs the state transition and derived fields (attempts, backoff,
--     finished_at, scheduled_at) inside the function so the Worker cannot set
--     arbitrary column values.
--   * Clamps caller-controlled inputs (max_attempts) the same way
--     ailearn_claim_jobs and ailearn_reap_stale_jobs do.
--   * Returns enough information for the Worker to report the transition
--     without reading the row back separately.
--
-- Like 0018/0019/0020/0021, this is expand phase only: it creates functions
-- and leaves RLS disabled.  The enforce migration will REVOKE direct UPDATE
-- on jobs from the Worker role and rely on these functions instead.

-- ─── 1. ailearn_renew_job_lease ────────────────────────────────────
-- Called by lockJobLease() while the Worker holds the business transaction
-- row lock.  Refreshes started_at so the reaper cannot release a lease that
-- is still actively committing side effects.
CREATE OR REPLACE FUNCTION public.ailearn_renew_job_lease(
  p_job_id uuid,
  p_workspace_id uuid,
  p_lease_token text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH updated AS (
    UPDATE public.jobs AS j
    SET started_at = clock_timestamp()
    WHERE j.id = p_job_id
      AND j.workspace_id = p_workspace_id
      AND j.status = 'running'
      AND j.lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$function$;
--> statement-breakpoint

-- ─── 2. ailearn_finish_job ─────────────────────────────────────────
-- Marks a job as succeeded.  The fence (id + workspace_id + status='running'
-- + lease_token) prevents a reaped or re-claimed job from being finished by
-- a stale Worker.
CREATE OR REPLACE FUNCTION public.ailearn_finish_job(
  p_job_id uuid,
  p_workspace_id uuid,
  p_lease_token text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH updated AS (
    UPDATE public.jobs AS j
    SET
      status = 'succeeded',
      finished_at = clock_timestamp(),
      lease_token = NULL
    WHERE j.id = p_job_id
      AND j.workspace_id = p_workspace_id
      AND j.status = 'running'
      AND j.lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$function$;
--> statement-breakpoint

-- ─── 3. ailearn_fail_job ───────────────────────────────────────────
-- Marks a job as failed and either returns it to pending (with exponential
-- backoff) or transitions it to dead when max_attempts is reached.
--
-- The backoff formula mirrors workers/ai-worker/src/lib/job-retry.ts:
--   base_ms = 10_000
--   delay_ms = base_ms * 2^attempts_before_failure
--
-- Returns (status, attempts, backoff_ms) so the Worker can report the
-- transition without a separate read.  backoff_ms is 0 for dead jobs.
CREATE OR REPLACE FUNCTION public.ailearn_fail_job(
  p_job_id uuid,
  p_workspace_id uuid,
  p_lease_token text,
  p_error_message text,
  p_max_attempts integer
)
RETURNS TABLE (
  status text,
  attempts integer,
  backoff_ms bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH params AS (
    SELECT
      greatest(1, least(coalesce(p_max_attempts, 3), 10)) AS max_attempts,
      clock_timestamp() AS failed_at
  ), job_state AS MATERIALIZED (
    SELECT j.id, j.attempts
    FROM public.jobs AS j
    CROSS JOIN params
    WHERE j.id = p_job_id
      AND j.workspace_id = p_workspace_id
      AND j.status = 'running'
      AND j.lease_token = p_lease_token
    FOR UPDATE
  ), updated AS (
    UPDATE public.jobs AS j
    SET
      status = CASE
        WHEN job_state.attempts + 1 >= params.max_attempts
          THEN 'dead'::public.job_status
        ELSE 'pending'::public.job_status
      END,
      attempts = job_state.attempts + 1,
      last_error = p_error_message,
      started_at = NULL,
      lease_token = NULL,
      finished_at = CASE
        WHEN job_state.attempts + 1 >= params.max_attempts
          THEN params.failed_at
        ELSE NULL
      END,
      scheduled_at = CASE
        WHEN job_state.attempts + 1 >= params.max_attempts
          THEN j.scheduled_at
        ELSE params.failed_at
          + pg_catalog.make_interval(
            secs => 10.0 * pg_catalog.power(2, job_state.attempts)
          )
      END
    FROM job_state, params
    WHERE j.id = job_state.id
      AND j.status = 'running'
    RETURNING
      j.id,
      j.status::text,
      j.attempts
  )
  SELECT
    updated.status,
    updated.attempts,
    CASE
      WHEN updated.status = 'dead' THEN 0
      ELSE (10000 * pg_catalog.power(2, updated.attempts - 1))::bigint
    END AS backoff_ms
  FROM updated;
$function$;
--> statement-breakpoint

-- ─── 4. Revoke and grant EXECUTE ──────────────────────────────────
-- Only the Worker role may call these functions.  API and migrator retain
-- their existing privileges; PUBLIC is revoked so any future role does not
-- inherit queue mutation paths by default.
REVOKE ALL ON FUNCTION public.ailearn_renew_job_lease(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ailearn_finish_job(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_renew_job_lease(uuid, uuid, text) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.ailearn_finish_job(uuid, uuid, text) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer) TO ailearn_worker;
--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_renew_job_lease(uuid, uuid, text) IS
  'SEC-01 Worker lease renewal; fenced by (id, workspace_id, running, lease_token)';
COMMENT ON FUNCTION public.ailearn_finish_job(uuid, uuid, text) IS
  'SEC-01 Worker job success transition; fenced by (id, workspace_id, running, lease_token)';
COMMENT ON FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer) IS
  'SEC-01 Worker job failure transition with exponential backoff; fenced by (id, workspace_id, running, lease_token)';
