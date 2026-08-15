-- 0159: TTL 清理函数改单批（消除双层分批长事务）+ 补两张表索引。
--
-- 背景（第三轮 W#4）：0152/0156/0157 的函数体内自带 200 轮循环（单事务内最多
-- 200×batch 行），TS 侧 ttl-maintenance 外层又循环调用——双层分批歧义：单次
-- 函数调用可能在一个事务里删除数十万行（长事务/锁窗）。修复：函数只做**单批**
-- （一次 LIMIT p_batch），TS 侧外层循环每次调用一个独立事务，批间提交。
-- TS 侧循环逻辑本就以「返回 < batch 即停」退出，无需改动。
--
-- 背景（第三轮 Y9/Y12）：sessions.expires_at 缺索引（清理/查询全表扫）；
-- learning_metric_events 缺 (workspace_id, user_id, ...) 用户维度索引。

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_expire_pending_voice_artifacts(
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH target AS (
    SELECT id
    FROM public.companion_voice_artifacts
    WHERE status = 'pending' AND expires_at < now()
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), expired AS (
    UPDATE public.companion_voice_artifacts
    SET status = 'expired'
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  )
  SELECT count(*)::integer FROM expired;
$function$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_purge_old_ai_audit_log(
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
    FROM public.ai_audit_log
    WHERE created_at < now() - make_interval(days => p_retention_days)
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.ai_audit_log
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  )
  SELECT count(*)::integer FROM deleted;
$function$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_purge_expired_proactive_deliveries(
  p_batch integer DEFAULT 1000
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
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
  SELECT count(*)::integer FROM deleted;
$function$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
  ON public.sessions (expires_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_metric_events_ws_user_time_idx
  ON public.learning_metric_events (workspace_id, user_id, occurred_at DESC);
