-- SEC-01 expand phase: trusted job actor attribution and narrowly scoped
-- cross-workspace Worker queue operations.  This migration intentionally does
-- NOT create or enable any row-level-security policy.  RLS enforcement follows
-- only after every API/Worker access path is context-aware and integration-tested.

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "requested_by" uuid;
--> statement-breakpoint

-- Only trust the legacy payload actor when it is a syntactically valid UUID and
-- is currently a member of the job's workspace.  Invalid, stale, or missing
-- payload attribution remains NULL so the Worker can fail closed for job types
-- that require a user actor.
UPDATE "jobs" AS j
SET "requested_by" = CASE
  WHEN (j."payload"->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (j."payload"->>'userId')::uuid
  ELSE NULL
END
WHERE j."requested_by" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "workspace_members" AS wm
    WHERE wm."workspace_id" = j."workspace_id"
      AND wm."user_id" = CASE
        WHEN (j."payload"->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (j."payload"->>'userId')::uuid
        ELSE NULL
      END
  );
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_requested_by_users_id_fk"
    FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "jobs_workspace_requested_by_idx"
  ON "jobs" ("workspace_id", "requested_by")
  WHERE "requested_by" IS NOT NULL;
--> statement-breakpoint

-- Claim is the only intentionally cross-workspace read path.  SECURITY DEFINER
-- is safe here only because the function exposes a fixed statement, clamps all
-- caller-controlled limits, fixes search_path, and returns only the claimed rows.
-- gen_random_uuid() is evaluated per updated row, yielding an independent lease
-- token even if concurrency is raised above one in a later release.
CREATE OR REPLACE FUNCTION public.ailearn_claim_jobs(
  p_limit integer,
  p_max_attempts integer
)
RETURNS TABLE (
  id uuid,
  type text,
  payload jsonb,
  workspace_id uuid,
  requested_by uuid,
  attempts integer,
  lease_token text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH claim_parameters AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 1), 32)) AS claim_limit,
      greatest(1, least(coalesce(p_max_attempts, 3), 10)) AS max_attempts,
      clock_timestamp() AS claimed_at
  ), candidates AS MATERIALIZED (
    SELECT j.id
    FROM public.jobs AS j
    CROSS JOIN claim_parameters AS parameters
    WHERE j.status = 'pending'
      AND j.attempts < parameters.max_attempts
      AND j.scheduled_at <= parameters.claimed_at
    ORDER BY j.scheduled_at, j.id
    LIMIT (SELECT claim_limit FROM claim_parameters)
    FOR UPDATE OF j SKIP LOCKED
  ), claimed AS (
    UPDATE public.jobs AS j
    SET
      status = 'running',
      started_at = parameters.claimed_at,
      finished_at = NULL,
      lease_token = pg_catalog.gen_random_uuid()::text
    FROM candidates
    CROSS JOIN claim_parameters AS parameters
    WHERE j.id = candidates.id
      AND j.status = 'pending'
    RETURNING
      j.id,
      j.type,
      j.payload,
      j.workspace_id,
      j.requested_by,
      j.attempts,
      j.lease_token
  )
  SELECT
    claimed.id,
    claimed.type,
    claimed.payload,
    claimed.workspace_id,
    claimed.requested_by,
    claimed.attempts,
    claimed.lease_token
  FROM claimed;
$function$;
--> statement-breakpoint

-- Reaping is the second and final cross-workspace queue path.  Concurrent
-- reapers skip rows already locked by a handler/renewal transaction.  Timeout
-- and attempt inputs are bounded so EXECUTE permission cannot be used to reap
-- fresh work or create an unbounded retry horizon.
CREATE OR REPLACE FUNCTION public.ailearn_reap_stale_jobs(
  p_lease_timeout_ms integer,
  p_max_attempts integer
)
RETURNS TABLE (
  id uuid,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH reap_parameters AS (
    SELECT
      greatest(120000, least(coalesce(p_lease_timeout_ms, 120000), 3600000)) AS lease_timeout_ms,
      greatest(1, least(coalesce(p_max_attempts, 3), 10)) AS max_attempts,
      clock_timestamp() AS reaped_at
  ), stale AS MATERIALIZED (
    SELECT
      j.id,
      j.attempts,
      parameters.max_attempts,
      parameters.reaped_at
    FROM public.jobs AS j
    CROSS JOIN reap_parameters AS parameters
    WHERE j.status = 'running'
      AND j.started_at < parameters.reaped_at
        - pg_catalog.make_interval(secs => parameters.lease_timeout_ms / 1000.0)
    ORDER BY j.started_at, j.id
    FOR UPDATE OF j SKIP LOCKED
  ), reaped AS (
    UPDATE public.jobs AS j
    SET
      status = CASE
        WHEN stale.attempts >= stale.max_attempts - 1 THEN 'dead'::public.job_status
        ELSE 'pending'::public.job_status
      END,
      attempts = stale.attempts + 1,
      started_at = NULL,
      lease_token = NULL,
      last_error = CASE
        WHEN stale.attempts >= stale.max_attempts - 1
          THEN 'lease expired — max attempts reached'
        ELSE 'lease expired (worker crash or timeout)'
      END,
      scheduled_at = CASE
        WHEN stale.attempts >= stale.max_attempts - 1 THEN j.scheduled_at
        ELSE stale.reaped_at + interval '10 seconds'
      END,
      finished_at = CASE
        WHEN stale.attempts >= stale.max_attempts - 1 THEN stale.reaped_at
        ELSE NULL
      END
    FROM stale
    WHERE j.id = stale.id
      AND j.status = 'running'
    RETURNING j.id, j.status::text
  )
  SELECT reaped.id, reaped.status
  FROM reaped;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_claim_jobs(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ailearn_reap_stale_jobs(integer, integer) FROM PUBLIC;
--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_claim_jobs(integer, integer) IS
  'SEC-01 controlled cross-workspace Worker claim path; RLS remains disabled in expand phase';
COMMENT ON FUNCTION public.ailearn_reap_stale_jobs(integer, integer) IS
  'SEC-01 controlled cross-workspace Worker stale-lease recovery path; RLS remains disabled in expand phase';
