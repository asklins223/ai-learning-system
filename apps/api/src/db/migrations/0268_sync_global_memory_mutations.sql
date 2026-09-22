-- 0268: 跨空间记忆的副本要跟着改——一次 UPDATE 覆盖所有空间。
--
-- 0267 把 `global` 记忆铺到了每个活跃空间，但没管之后的**变更**：用户在记忆中心
-- 把「我习惯晚上学习」删掉，只有当前空间那一份消失，另外几个空间还留着；改内容、
-- 固定、归档同理。那会让"跨空间同步"变成"只在写入那一刻同步"，而且用户没法真正
-- 撤销一条她不想留着的记忆——这正是"同步"这件事最容易被投诉的一面。
--
-- ─── 为什么用触发器而不是逐个改 service 函数 ───
-- `memory-service.ts` 里能改记忆的入口有九个（delete / pin / unpin / archive /
-- restore / dismiss / correct / clearMemories / resolveMemoryConflict）。逐个加
-- "记得同步副本"就是审查反复说的那种"靠开发者手写 WHERE"的约定——漏一个就静默
-- 分叉。触发器让"这一行变了"与"它的副本一起变"在数据库层同义，只写一次。
--
-- ─── 为什么不会递归 ───
-- 触发器里对副本的 UPDATE 会再次触发自己。用事务局部的 `app.memory_sync` 标记挡住
-- 第二层：外层设标记 → 内层看到标记直接返回 → 外层清标记。这是 PostgreSQL 触发器
-- 里做级联的标准做法，比"按 id 排除自己"更稳（后者在并发下会漏）。
--
-- ─── 同步哪些列 ───
-- 用户能感知的：content（纠正）、deleted_at（删除）、archived_at（归档）、
-- pinned（固定）、dismissed_at（气泡忽略）、importance / confidence（纠正时可能调）、
-- expires_at。**不同步** `workspace_id`（那是副本的身份）、`global_key`（那是它们的
-- 共同身份）、`source_event_id`（每份副本的来源引用各自有效）、embedding 相关
-- （各空间自己算，模型修订号可能不同）。
--
-- 顺带把 `candidate` 也同步：用户在某个空间确认了一条候选记忆，其余空间不该还把它
-- 当候选藏着——她已经在别处确认过了。

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
         expires_at = NEW.expires_at,
         candidate = NEW.candidate,
         updated_at = now()
   WHERE user_id = NEW.user_id
     AND global_key = v_key
     AND id <> NEW.id;

  PERFORM set_config('app.memory_sync', '', true);
  RETURN NULL;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_sync_global_companion_memory_copies() IS
  '把一条跨空间记忆的变更同步到它在其他空间的副本（0268）。事务局部标记 app.memory_sync 防递归。';

--> statement-breakpoint

DROP TRIGGER IF EXISTS assistant_memory_items_sync_copies ON public.assistant_memory_items;
CREATE TRIGGER assistant_memory_items_sync_copies
  AFTER UPDATE ON public.assistant_memory_items
  FOR EACH ROW
  WHEN (OLD.global_key IS NOT NULL OR NEW.global_key IS NOT NULL)
  EXECUTE FUNCTION public.ailearn_sync_global_companion_memory_copies();

--> statement-breakpoint

-- 物理删除（定时清理、级联）也要同步：软删除走上面的 UPDATE，硬删除走这条。
-- 用户可见的删除是软删除（`deleted_at`），硬删除只发生在保留期清理，两条都要覆盖，
-- 否则"清掉一条旧记忆"会留下几个空间的孤儿副本。
CREATE OR REPLACE FUNCTION public.ailearn_sync_global_companion_memory_deletes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_syncing text;
BEGIN
  v_syncing := NULLIF(current_setting('app.memory_sync', true), '');
  IF v_syncing = 'on' THEN
    RETURN NULL;
  END IF;
  IF OLD.global_key IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('app.memory_sync', 'on', true);
  DELETE FROM public.assistant_memory_items
   WHERE user_id = OLD.user_id
     AND global_key = OLD.global_key
     AND id <> OLD.id;
  PERFORM set_config('app.memory_sync', '', true);
  RETURN NULL;
END;
$function$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS assistant_memory_items_sync_deletes ON public.assistant_memory_items;
CREATE TRIGGER assistant_memory_items_sync_deletes
  AFTER DELETE ON public.assistant_memory_items
  FOR EACH ROW
  WHEN (OLD.global_key IS NOT NULL)
  EXECUTE FUNCTION public.ailearn_sync_global_companion_memory_deletes();

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'assistant_memory_items_sync_copies' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '副本同步触发器（UPDATE）没有建立';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'assistant_memory_items_sync_deletes' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '副本同步触发器（DELETE）没有建立';
  END IF;
  RAISE NOTICE '跨空间记忆的变更同步就绪';
END
$$;

--> statement-breakpoint

-- ─── 顺带：删掉"账号级可恢复旅程"那条链 ───
--
-- 2026-09-22 Owner 裁决：**旅程是空间级的**。0186 建的那个 SECURITY DEFINER 函数
-- 专门绕过 RLS 去别的 workspace 找一个 paused 的旅程，与空间级语义直接冲突；而且
-- 旅程步骤引用的是空间内的对象（笔记、目标、卡片），把它们带进另一个空间时那些对象
-- 并不存在。代码侧（service 分支、契约字段、界面提示）已在同一次改动里删除，这里把
-- 数据库对象也收掉——留着它就是一个"没人调用但能跨空间读"的入口。
DROP FUNCTION IF EXISTS public.ailearn_find_resumable_companion_journey(uuid, uuid);

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'ailearn_find_resumable_companion_journey'
  ) THEN
    RAISE EXCEPTION '跨空间旅程查找函数没有删除';
  END IF;
  RAISE NOTICE '跨空间旅程恢复链已整体收掉（空间级语义）';
END
$$;
