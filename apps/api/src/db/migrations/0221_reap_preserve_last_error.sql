-- 0221: reaper 不再覆盖真实死因（last_error 保留 + 追加 lease 事实）。
--
-- 背景（2026-09-15 审计 · 稳定性 P1-9）：0018/0105 定义的 ailearn_reap_stale_jobs
-- 无条件把 last_error 写成 'lease expired — max attempts reached' /
-- 'lease expired (worker crash or timeout)'。若 job 有真实死因（handler 抛出的
-- 计费/鉴权/协议错误，已由 markJobFailed 脱敏写入 last_error），reap 会把它
-- 整条覆盖掉——只剩"租约过期"，排查时无法区分"模型欠费"与"worker 崩溃"。
--
-- 修复：原 last_error 非空时保留原文，并追加 lease 事实（' | ' 分隔）；为空时
-- 维持原语义。追加次数受 attempts ≤ max_attempts 约束（≤10 次），无无界增长。
--
-- 语义不变：status / attempts / scheduled_at / finished_at 的计算完全保留 0105
-- 的指数退避（10s * 2^attempts，封顶 60s）。CREATE OR REPLACE 保留原 owner 与
-- 权限（security contract 白名单不变：仅 ailearn_worker / ailearn_api EXECUTE）。

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
        -- 无真实死因：维持 0105 语义。
        WHEN j.last_error IS NULL OR pg_catalog.btrim(j.last_error) = '' THEN
          CASE
            WHEN stale.attempts >= stale.max_attempts - 1
              THEN 'lease expired — max attempts reached'
            ELSE 'lease expired (worker crash or timeout)'
          END
        -- 有真实死因：保留原文，追加 lease 事实（不覆盖）。
        ELSE
          j.last_error || CASE
            WHEN stale.attempts >= stale.max_attempts - 1
              THEN ' | lease expired — max attempts reached'
            ELSE ' | lease expired (worker crash or timeout)'
          END
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
'Reap stale running jobs with exponential backoff (10s * 2^attempts, cap 60s). 0221: preserve the real last_error and append the lease fact instead of overwriting it.';
