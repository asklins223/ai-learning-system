-- A2（计划 §2.2）：统一应用层与 SQL 重试策略双源。
--
-- 修改 ailearn_fail_job 返回类型，增加 is_dead / scheduled_at / last_error / finished_at，
-- 使应用层 markJobFailed / markJobDead 不再自行计算重试参数，直接消费 SQL 返回值。
--
-- 重试策略常量（backoff base 2s、max_attempts clamp 3-10）的唯一来源收敛到 SQL。
-- TS 侧保留镜像常量用于日志，测试断言两者一致。
--
-- 回滚：恢复 0031 中原始函数定义（RETURNS TABLE(status text, attempts integer, backoff_ms bigint)）。
--
-- 退避序列不变：2s → 4s（第三次失败直接 dead，无退避）。

-- PostgreSQL 不允许 CREATE OR REPLACE 改变已有函数的返回类型，
-- 必须先 DROP 再重建。
DROP FUNCTION IF EXISTS public.ailearn_fail_job(uuid, uuid, text, text, integer);

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
            secs => 2.0 * pg_catalog.power(2, job_state.attempts)
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
--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer) IS
  'SEC-01 Worker job failure transition with exponential backoff (base 2s, max_attempts clamp 3-10). Returns (status, attempts, backoff_ms, is_dead, scheduled_at, last_error, finished_at) so the application layer does not need to recompute retry parameters. Fenced by (id, workspace_id, running, lease_token).';
