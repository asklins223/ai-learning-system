-- 0160: card_generation_agent_events 保留策略清理函数。
--
-- 背景（第四轮 F5）：card_generation_agent_events 为纯 append-only（每 tool
-- call 写 ~2 行，dev 环境已是最大 public 表之一），全仓无任何保留/清理逻辑。
-- 提供 SECURITY DEFINER 分批清理函数（默认 90 天保留），由 ttl-maintenance 的
-- runLearningTtlMaintenance 周期调用（与 0156/0157 同模式：单批 + TS 外层循环）。
-- 表有 RLS（0111 启用），函数按 SECURITY DEFINER owner 语义执行。

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_purge_old_agent_events(
  p_retention_days integer DEFAULT 90,
  p_batch integer DEFAULT 1000
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH target AS (
    SELECT id
    FROM public.card_generation_agent_events
    WHERE created_at < now() - make_interval(days => p_retention_days)
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.card_generation_agent_events
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  )
  SELECT count(*)::integer FROM deleted;
$function$;

--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    REVOKE ALL ON FUNCTION
      public.ailearn_purge_old_agent_events(integer, integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION
      public.ailearn_purge_old_agent_events(integer, integer)
      TO ailearn_api;
  END IF;
END $$;
