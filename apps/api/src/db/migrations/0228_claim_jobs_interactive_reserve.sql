-- 0228: claim 按队列资源类限流——为交互车道（interactive_ai）保留槽位。
--
-- 背景（2026-09-19 伴星回复慢排查）：后台 job 的 handler 超时可达 110s
-- （companion_thought / companion_memory_embedding_rebuild），而 worker 的并发
-- 槽位只有一个池子。后台把槽位占满时，用户的伴星对话（interactive_ai）只能
-- 排在后面——表现为"有时候回复要等很久"。
--
-- 修复：函数新增 `p_background_limit` 参数（worker 计算并传入）：
--   * 交互 job（resource_class = 'interactive_ai'）最多认领 `p_limit` 个；
--   * 后台 job 最多认领 `p_background_limit` 个；
--   * 总数仍不超过 `p_limit`。
-- worker 侧的名额推导见 workers/ai-worker/src/lib/worker-concurrency.ts
-- （computeClaimLimits：后台名额 = 并发 - 保留槽 - 在跑后台数）。两者合起来
-- 保证后台永远拿不到最后一个空槽，交互 job 一入队就有槽可领。
--
-- 同时 RETURNS TABLE 增列 `resource_class`：worker 需要按类别统计在跑 job
-- （在跑后台数决定下一次的 background 名额）。
--
-- 旧签名 (integer, integer) 直接删除——全仓唯一调用方是同批次的 queue.ts，
-- 本项目未上线，不留兼容层（AGENTS.md 清理原则）。部署顺序：先应用本迁移，
-- 再重启 worker；旧 worker 进程在迁移后调用会因函数不存在而报错。
--
-- 排序键与 0044 完全一致（interactive_ai 常驻第一梯队 + 旧 producer 的
-- 类型优先级兜底），本迁移只增加准入过滤，不改变相对顺序。

--> statement-breakpoint

DROP FUNCTION IF EXISTS public.ailearn_claim_jobs(integer, integer);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_claim_jobs(
  p_limit integer,
  p_background_limit integer,
  p_max_attempts integer
)
RETURNS TABLE (
  id uuid,
  type text,
  payload jsonb,
  workspace_id uuid,
  requested_by uuid,
  attempts integer,
  lease_token text,
  resource_class text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH claim_parameters AS (
    SELECT
      -- 0 = 没有空闲槽位（worker 传 0 时不认领任何 job）；NULL 仍按 1 处理。
      greatest(0, least(coalesce(p_limit, 1), 32)) AS claim_limit,
      -- 后台名额：NULL 视为不限（与 claim_limit 同额度），并夹取到 claim_limit。
      least(
        greatest(0, coalesce(p_background_limit, 32)),
        greatest(0, least(coalesce(p_limit, 1), 32))
      ) AS background_limit,
      greatest(1, least(coalesce(p_max_attempts, 3), 10)) AS max_attempts,
      clock_timestamp() AS claimed_at
  ), candidates AS MATERIALIZED (
    SELECT
      j.id,
      j.type,
      j.priority,
      j.scheduled_at,
      (j.resource_class = 'interactive_ai') AS is_interactive
    FROM public.jobs AS j
    CROSS JOIN claim_parameters AS parameters
    WHERE j.status = 'pending'
      AND j.attempts < parameters.max_attempts
      AND j.scheduled_at <= parameters.claimed_at
    ORDER BY
      CASE
        WHEN j.resource_class = 'interactive_ai' THEN 1000
        ELSE 0
      END
      + greatest(
          j.priority,
          CASE j.type
            WHEN 'evaluate_validation' THEN 100
            WHEN 'generate_validation_question' THEN 100
            WHEN 'parse_source' THEN 70
            WHEN 'generate_card' THEN 50
            WHEN 'align_evidence' THEN 10
            ELSE 50
          END
        ) DESC,
      j.scheduled_at,
      j.id
    LIMIT (SELECT claim_limit FROM claim_parameters)
    FOR UPDATE OF j SKIP LOCKED
  ), admitted AS MATERIALIZED (
    -- 类别内排名后放行：交互 job 全数放行，后台只放行前 background_limit 个
    -- （窗口函数不能出现在带 FOR UPDATE 的 CTE 里，所以先锁候选、再在这里排名）。
    SELECT ranked.id
    FROM (
      SELECT
        candidates.id,
        candidates.is_interactive,
        row_number() OVER (
          PARTITION BY candidates.is_interactive
          ORDER BY
            CASE WHEN candidates.is_interactive THEN 1000 ELSE 0 END
            + greatest(
                candidates.priority,
                CASE candidates.type
                  WHEN 'evaluate_validation' THEN 100
                  WHEN 'generate_validation_question' THEN 100
                  WHEN 'parse_source' THEN 70
                  WHEN 'generate_card' THEN 50
                  WHEN 'align_evidence' THEN 10
                  ELSE 50
                END
              ) DESC,
            candidates.scheduled_at,
            candidates.id
        ) AS class_rank
      FROM candidates
    ) AS ranked
    CROSS JOIN claim_parameters AS parameters
    WHERE ranked.is_interactive
      OR ranked.class_rank <= parameters.background_limit
  ), claimed AS (
    UPDATE public.jobs AS j
    SET
      status = 'running',
      started_at = parameters.claimed_at,
      finished_at = NULL,
      lease_token = pg_catalog.gen_random_uuid()::text
    FROM admitted
    CROSS JOIN claim_parameters AS parameters
    WHERE j.id = admitted.id
      AND j.status = 'pending'
    RETURNING
      j.id,
      j.type,
      j.payload,
      j.workspace_id,
      j.requested_by,
      j.attempts,
      j.lease_token,
      j.resource_class
  )
  SELECT
    claimed.id,
    claimed.type,
    claimed.payload,
    claimed.workspace_id,
    claimed.requested_by,
    claimed.attempts,
    claimed.lease_token,
    claimed.resource_class
  FROM claimed;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_claim_jobs(integer, integer, integer) FROM PUBLIC;
--> statement-breakpoint

-- 授权与 roles.sql 的队列入口矩阵一致：worker 可执行、api 不可执行。
-- 带存在性守卫：本迁移可能先于 roles.sql 在部分环境（测试库）执行。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT EXECUTE ON FUNCTION public.ailearn_claim_jobs(integer, integer, integer)
      TO ailearn_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    REVOKE ALL ON FUNCTION public.ailearn_claim_jobs(integer, integer, integer)
      FROM ailearn_api;
  END IF;
END
$$;
--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_claim_jobs(integer, integer, integer) IS
  'SEC-01 controlled cross-workspace Worker claim path; p_background_limit reserves the interactive_ai lane (see 0228)';
