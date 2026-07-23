-- AI Worker 延迟优化方案 6：缩短重试退避基数（10s → 2s）。
--
-- 瞬时错误（网络抖动、5xx）后第一次重试从 10s 降到 2s，用户不再感觉"卡住了"。
--
-- 必须同时修改 TypeScript 常量和 SQL 函数：
--   job-retry.ts:   RETRY_BACKOFF_BASE_MS 10_000 → 2_000
--   ailearn_fail_job:  10.0 * power(2, attempts) → 2.0 * power(2, attempts)
--                      (10000 * power(2, attempts-1)) → (2000 * power(2, attempts-1))
--   ailearn_reap_stale_jobs: interval '10 seconds' → interval '2 seconds'
--
-- 退避序列：2s → 4s（第三次失败直接 dead，无退避）
-- 总退避从 30s 降到 6s。

-- ─── 1. ailearn_fail_job — 退避基数 10s → 2s ─────────────────────
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
            secs => 2.0 * pg_catalog.power(2, job_state.attempts)
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
      ELSE (2000 * pg_catalog.power(2, updated.attempts - 1))::bigint
    END AS backoff_ms
  FROM updated;
$function$;
--> statement-breakpoint

-- ─── 2. ailearn_reap_stale_jobs — lease 过期退避 10s → 2s ─────────
-- 此路径仅在 Worker 崩溃 / lease 超时（120s）时触发，非正常重试路径。
-- 一并调整以保持退避基数一致。
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
        ELSE stale.reaped_at + interval '2 seconds'
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

COMMENT ON FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer) IS
  'SEC-01 Worker job failure transition with exponential backoff (base 2s); fenced by (id, workspace_id, running, lease_token)';
COMMENT ON FUNCTION public.ailearn_reap_stale_jobs(integer, integer) IS
  'SEC-01 controlled cross-workspace Worker stale-lease recovery path (backoff 2s); RLS remains disabled in expand phase';
