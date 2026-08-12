-- 0105: Worker reaper 指数退避（重试风暴防护）。
-- 2026-08-11：ailearn_reap_stale_jobs 此前把被 reap 的 running job 的
-- scheduled_at 固定为 reaped_at + 10 秒（0018 定义）。连续崩溃/超时场景下
-- 同一 job 每 10s 重跑一次直至 max_attempts，形成重试风暴（且与 fail_job
-- 的 2s→4s 退避语义不一致）。改为按 attempts 指数退避：10s * 2^attempts，
-- 封顶 60s。
-- CREATE OR REPLACE 保留原 owner/权限（security contract 白名单不变）。

--> statement-breakpoint

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
        ELSE stale.reaped_at
          + pg_catalog.make_interval(secs => least(60, 10 * power(2, stale.attempts)))
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

COMMENT ON FUNCTION public.ailearn_reap_stale_jobs(integer, integer) IS
'Reap stale running jobs with exponential backoff: scheduled_at = reaped_at + 10s * 2^attempts (cap 60s). 0105 修复重试风暴。';
