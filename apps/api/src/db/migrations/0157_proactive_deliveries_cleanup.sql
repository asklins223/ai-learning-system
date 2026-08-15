-- 0157: companion_proactive_deliveries 过期清理函数。
--
-- 背景（PERF-WN-4 / 审计发现）：companion_proactive_deliveries 有 expires_at
-- 与 status IN ('pending','shown','suppressed','dismissed','expired')，但
-- ttl-maintenance 的 6 类清理均不含此表——expired/pending 终端行只增不删。
-- 此处提供 SECURITY DEFINER 分批清理函数（表 RLS ENABLE+FORCE，API 连接
-- NOBYPASSRLS 需经函数执行），由 runLearningTtlMaintenance 周期调用。

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_purge_expired_proactive_deliveries(
  p_batch integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_deleted integer := 0;
  v_round integer := 0;
  v_rows integer;
BEGIN
  LOOP
    v_round := v_round + 1;
    IF v_round > 200 THEN
      EXIT;
    END IF;
    WITH target AS (
      SELECT id
      FROM public.companion_proactive_deliveries
      WHERE expires_at < now()
      LIMIT p_batch
      FOR UPDATE SKIP LOCKED
    ), deleted AS (
      DELETE FROM public.companion_proactive_deliveries
      WHERE id IN (SELECT id FROM target)
      RETURNING id
    )
    SELECT count(*)::integer INTO v_rows FROM deleted;
    v_deleted := v_deleted + v_rows;
    EXIT WHEN v_rows < p_batch;
  END LOOP;
  RETURN v_deleted;
END;
$function$;

--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    REVOKE ALL ON FUNCTION
      public.ailearn_purge_expired_proactive_deliveries(integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION
      public.ailearn_purge_expired_proactive_deliveries(integer)
      TO ailearn_api;
  END IF;
END $$;
