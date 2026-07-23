-- AI Worker 延迟优化方案 5：为 ailearn_claim_jobs 增加队列优先级。
--
-- 用户实时等待的 evaluate_validation 优先于后台 align_evidence 任务，
-- 避免批量入队的 align_evidence job 堵塞用户验证请求。
--
-- 优先级设计：
--   evaluate_validation → 10  (用户实时等待，最敏感)
--   parse_source        →  8  (用户刚提交来源，等待解析)
--   generate_card       →  5  (用户等待但可容忍较长延迟)
--   align_evidence      →  1  (后台任务，无 AI 调用)
--   其他                 →  5  (默认)
--
-- 仅修改 ORDER BY，函数签名和 SECURITY DEFINER 配置保持不变。

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
    ORDER BY
      CASE j.type
        WHEN 'evaluate_validation' THEN 10
        WHEN 'parse_source' THEN 8
        WHEN 'generate_card' THEN 5
        WHEN 'align_evidence' THEN 1
        ELSE 5
      END DESC,
      j.scheduled_at,
      j.id
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

COMMENT ON FUNCTION public.ailearn_claim_jobs(integer, integer) IS
  'SEC-01 controlled cross-workspace Worker claim path with job-type priority; RLS remains disabled in expand phase';
