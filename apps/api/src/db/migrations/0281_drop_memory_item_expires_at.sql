-- 删掉 `assistant_memory_items.expires_at`：一根没人写、没人读、也没人扫的列。
--
-- 依据（2026-09-25 逐层核过，三套词都查了）：
-- - 写侧：208/208 行全 NULL；drizzle 成员名 `expiresAt` 与裸 SQL 的 `expires_at` 都没有
--   任何一处给它赋值（唯一给 `expires_at` 赋 30 天的是 **`assistant_deliveries`** 那条
--   记忆候选投递，`companion-memory-extractor.ts:523-531`，与这张表无关）。
-- - 读侧：应用层没有任何查询拿它做过滤；`ttl-maintenance.ts` 的六项清理作业里没有它；
--   `pg_proc` 里唯一提到它的函数就是下面这个副本同步触发器，而它搬运的永远是 NULL。
-- - 界面侧：桌面上唯一带 `expiresAt` 的响应合同属于活动投递条
--   （`companionActivityDeliveryV1Schema`），不是记忆条目。
-- 本仓未上线、不为旧实现保留兼容层（AGENTS.md），所以连列带函数一次改完而不是留着"以后可能用"。

CREATE OR REPLACE FUNCTION public.ailearn_sync_global_companion_memory_copies()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_syncing text;
  v_key uuid;
BEGIN
  -- 内层调用：直接放行，不再级联。
  v_syncing := NULLIF(current_setting('app.memory_sync', true), '');
  IF v_syncing = 'on' THEN
    RETURN NULL;
  END IF;

  v_key := COALESCE(NEW.global_key, OLD.global_key);
  IF v_key IS NULL THEN
    RETURN NULL;  -- 空间内记忆，没有副本要同步
  END IF;

  PERFORM set_config('app.memory_sync', 'on', true);

  UPDATE public.assistant_memory_items
     SET content = NEW.content,
         deleted_at = NEW.deleted_at,
         archived_at = NEW.archived_at,
         pinned = NEW.pinned,
         dismissed_at = NEW.dismissed_at,
         importance = NEW.importance,
         confidence = NEW.confidence,
         candidate = NEW.candidate,
         updated_at = now()
   WHERE user_id = NEW.user_id
     AND global_key = v_key
     AND id <> NEW.id;

  PERFORM set_config('app.memory_sync', '', true);
  RETURN NULL;
END;
$function$;

ALTER TABLE public.assistant_memory_items DROP COLUMN IF EXISTS expires_at;
