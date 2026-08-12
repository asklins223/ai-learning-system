-- 0104: companion stream events TTL 清理 + pending voice artifact 过期。
-- 03 §7.4（终态事件 24h 后幂等删除，事件表不得无限增长）与 §7.5
-- （pending voice artifact 到期转 expired）。
-- 与 0098 同类清理一致：companion 表 RLS ENABLE+FORCE，API 连接
-- （ailearn_api，NOBYPASSRLS）裸查询会被策略拦成 0 行，因此统一经
-- SECURITY DEFINER 函数执行（migrator owner BYPASSRLS，API 仅 EXECUTE）。

CREATE OR REPLACE FUNCTION public.ailearn_purge_companion_stream_events_ttl(
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  -- companion_stream_events 无 id 列（PK = conversation_id + seq），
  -- 用行比较定位 target。
  WITH target AS (
    SELECT conversation_id, seq
    FROM public.companion_stream_events
    WHERE expires_at < now()
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.companion_stream_events
    WHERE (conversation_id, seq) IN (SELECT conversation_id, seq FROM target)
    RETURNING conversation_id, seq
  )
  SELECT count(*)::integer FROM deleted;
$function$;

CREATE OR REPLACE FUNCTION public.ailearn_expire_pending_voice_artifacts()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH target AS (
    SELECT id
    FROM public.companion_voice_artifacts
    WHERE status = 'pending' AND expires_at < now()
  ), expired AS (
    UPDATE public.companion_voice_artifacts
    SET status = 'expired'
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  )
  SELECT count(*)::integer FROM expired;
$function$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    REVOKE ALL ON FUNCTION
      public.ailearn_purge_companion_stream_events_ttl(integer),
      public.ailearn_expire_pending_voice_artifacts()
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION
      public.ailearn_purge_companion_stream_events_ttl(integer),
      public.ailearn_expire_pending_voice_artifacts()
      TO ailearn_api;
  END IF;
END $$;
