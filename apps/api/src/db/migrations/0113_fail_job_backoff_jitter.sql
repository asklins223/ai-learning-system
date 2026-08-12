-- 0113_fail_job_backoff_jitter.sql
-- 2026-08-11（第十轮遗留修复）：ailearn_fail_job 的 scheduled_at 退避为
-- 确定性公式（2s * 2^attempts，0064 版）——同批失败 job 会在同一时刻再次
-- 打 DB（惊群）。在**实际调度**处加 ±15% 随机 jitter：
--   secs = 2 * 2^attempts * (0.85 + random() * 0.3)
-- 返回的 backoff_ms 保持原公式（确定性镜像，worker 仅用于日志与
-- retry-strategy-contract 断言；真实调度以 scheduled_at 为准）。
-- 照 0064 返回结构（7 列）完整重定义，仅 scheduled_at 一行变化。

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
  backoff_ms bigint,
  is_dead boolean,
  scheduled_at timestamptz,
  last_error text,
  finished_at timestamptz
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
            -- 0113：±15% 随机 jitter（0.85..1.15）——同批失败 job 错峰重试，
            -- 避免确定性指数退避下的重试惊群。
            secs => 2.0 * pg_catalog.power(2, job_state.attempts)
              * (0.85 + random() * 0.3)
          )
      END
    FROM job_state, params
    WHERE j.id = job_state.id
      AND j.status = 'running'
    RETURNING
      j.status::text,
      j.attempts,
      CASE
        WHEN j.status = 'dead' THEN true
        ELSE false
      END AS is_dead,
      j.scheduled_at,
      j.last_error,
      j.finished_at
  )
  SELECT
    updated.status,
    updated.attempts,
    CASE
      WHEN updated.status = 'dead' THEN 0
      ELSE (2000 * pg_catalog.power(2, updated.attempts - 1))::bigint
    END AS backoff_ms,
    updated.is_dead AS is_dead,
    updated.scheduled_at,
    updated.last_error,
    updated.finished_at
  FROM updated;
$function$;
