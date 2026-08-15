-- 0156: ai_audit_log 保留策略——超保留期分批清理函数。
--
-- 背景（PERF-W5 / 审计发现）：ai_audit_log 为纯 append-only（每次 AI 调用
-- 写一条），全库无保留/清理/分区，随使用量线性膨胀。此处提供 SECURITY
-- DEFINER 清理函数（90 天保留、分批执行避免长事务），由
-- learning-sessions/ttl-maintenance.ts 的 runLearningTtlMaintenance 周期调用。
--
-- ai_audit_log 无 RLS（0011 建表未启用），但保持与其他清理函数一致的
-- SECURITY DEFINER + search_path 模式与权限授予。

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_purge_old_ai_audit_log(
  p_retention_days integer DEFAULT 90,
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
  -- 分批删除：每批 p_batch 行，某批不足 p_batch 或达到轮次上限即停止，
  -- 避免单事务锁窗过长。
  LOOP
    v_round := v_round + 1;
    IF v_round > 200 THEN
      EXIT;
    END IF;
    WITH target AS (
      SELECT id
      FROM public.ai_audit_log
      WHERE created_at < now() - make_interval(days => p_retention_days)
      LIMIT p_batch
      FOR UPDATE SKIP LOCKED
    ), deleted AS (
      DELETE FROM public.ai_audit_log
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
      public.ailearn_purge_old_ai_audit_log(integer, integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION
      public.ailearn_purge_old_ai_audit_log(integer, integer)
      TO ailearn_api;
  END IF;
END $$;
