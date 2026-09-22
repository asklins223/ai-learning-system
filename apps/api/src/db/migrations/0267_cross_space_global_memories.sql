-- 0267: 与空间关联不强的记忆跨空间同步（2026-09-22 Owner 裁决）。
--
-- 裁决原文：「伴星的设置这些东西都需要同步一下，不要另外启用新的，然后跟空间关联性
-- 不强的记忆也是需要带过去的」。
--
-- ─── 不新造机制 ───
-- `assistant_memory_items.scope` 早就有 `global | workspace | task` 三档，而且两条
-- 检索路径**已经**写着 `(scope = 'workspace' OR scope = 'global' OR scope = 当前)`。
-- 也就是说读那侧一直为 global 准备好了，只是从来没有任何写入点写过这个值（dev 库
-- 实测：全部 45 条都是 `workspace`）。所以这一支只做两件事：
--   1. 给 global 记忆一个跨空间的身份（`global_key`）；
--   2. 提供"铺到该用户所有活跃空间"的唯一实现。
-- 不新建表、不新建读取通道、不改检索谓词。
--
-- ─── 为什么是"铺"而不是"存一份、跨空间读" ───
-- 存一份就得让检索跨空间读，而 `assistant_memory_items` 的隔离策略是按
-- `app.workspace_id` 收的（0261 那批刚立的）。跨空间读要么放宽策略（把刚建起来的
-- 边界打开一个口子），要么再写一个 SECURITY DEFINER 函数——两条都是"另起一套"。
-- 铺的代价是每空间一行副本，换来的是：读路径一个字不改、RLS 不动、记忆中心在每个
-- 空间都能看到并撤销它。偏好与互动习惯本来就只有几条，这个代价可以忽略。
--
-- ─── global_key：让"改一处、处处跟着"成为一次 UPDATE ───
-- 各空间的副本必须有共同身份，否则用户在记忆中心删掉一条，另外几个空间还留着。
-- `global_key` 取**最初那条**记忆的 id，所有副本共用它；于是：
--   改/删/归档/固定 = 按 `user_id + global_key` 一次更新全部副本。
-- 同一空间内不允许同一 global_key 出现两行（唯一索引兜底）。
--
-- ─── 哪些算"与空间关联不强" ───
-- 由**种类**决定，不由模型决定（模型给的 scope 会被服务端按种类覆盖）：
--   preference        —— "我习惯晚上学习"：跟人走
--   interaction_note  —— "别用太长的句子"：跟人走
--   goal / learning_context / episodic —— 绑定空间内的内容，留在原空间
-- 判据写在服务端而不是 prompt 里：prompt 是请求，服务端才是规则。

ALTER TABLE public.assistant_memory_items
  ADD COLUMN IF NOT EXISTS global_key uuid;

--> statement-breakpoint

COMMENT ON COLUMN public.assistant_memory_items.global_key IS
  '跨空间记忆的共同身份（0267）：同一逻辑记忆在各空间的副本共用它。NULL = 空间内记忆。';

--> statement-breakpoint

-- 已有的 global 行（历史上若有）先各自成为自己的 key。
UPDATE public.assistant_memory_items
   SET global_key = id
 WHERE scope = 'global' AND global_key IS NULL;

--> statement-breakpoint

-- 同一空间内同一逻辑记忆只允许一行。
CREATE UNIQUE INDEX IF NOT EXISTS assistant_memory_items_global_key_unique_idx
  ON public.assistant_memory_items (workspace_id, global_key)
  WHERE global_key IS NOT NULL AND deleted_at IS NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assistant_memory_items_global_key_user_idx
  ON public.assistant_memory_items (user_id, global_key)
  WHERE global_key IS NOT NULL;

--> statement-breakpoint

-- ─── 唯一的"铺开"实现 ───
--
-- `p_global_key` 为空时以源行为准（首次铺开）；否则铺的是这个 key 下的新内容
-- （用户在某处改了内容，其余副本跟着更新——由调用方决定是 UPDATE 还是 INSERT）。
--
-- SECURITY DEFINER：要写"该用户的其他空间"，而调用方的事务上下文停在某一个空间上。
-- 只授给 `ailearn_worker`（记忆抽取）与 `ailearn_migrator`（维护）——API 角色拿不到
-- EXECUTE，所以没有任何 HTTP 入口能触发跨空间写。
CREATE OR REPLACE FUNCTION public.ailearn_fanout_global_companion_memory(
  p_source_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  src record;
  target record;
  v_inserted integer := 0;
  v_key uuid;
BEGIN
  SELECT id, workspace_id, user_id, kind, content, scope, importance, confidence,
         user_stated, user_confirmed, source_event_id, source_session_id, source_type,
         pinned, global_key
    INTO src
    FROM public.assistant_memory_items
   WHERE id = p_source_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  IF src.scope <> 'global' THEN
    RETURN 0;
  END IF;

  -- 源行自己先认领这个 key（首次铺开时就是它自己的 id）。
  v_key := COALESCE(src.global_key, src.id);
  IF src.global_key IS DISTINCT FROM v_key THEN
    UPDATE public.assistant_memory_items SET global_key = v_key WHERE id = src.id;
  END IF;

  FOR target IN
    SELECT m.workspace_id
      FROM public.workspace_members m
     WHERE m.user_id = src.user_id
       AND m.left_at IS NULL
       AND m.workspace_id <> src.workspace_id
  LOOP
    INSERT INTO public.assistant_memory_items
      (workspace_id, user_id, kind, content, source_event_id, source_session_id,
       user_stated, user_confirmed, candidate, importance, confidence, scope,
       source_type, embedding_status, global_key, pinned, created_at, updated_at)
    VALUES
      (target.workspace_id, src.user_id, src.kind, src.content, src.source_event_id,
       src.source_session_id, src.user_stated, src.user_confirmed, false,
       src.importance, src.confidence, 'global', src.source_type, 'pending',
       v_key, src.pinned, now(), now())
    ON CONFLICT (workspace_id, global_key) WHERE global_key IS NOT NULL AND deleted_at IS NULL
      DO NOTHING;
    IF FOUND THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_fanout_global_companion_memory(uuid) IS
  '把一条 scope=global 的记忆铺到该用户所有活跃空间（0267）。只授 ailearn_worker/ailearn_migrator，API 角色无 EXECUTE。';

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_fanout_global_companion_memory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_fanout_global_companion_memory(uuid) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.ailearn_fanout_global_companion_memory(uuid) TO ailearn_migrator;

--> statement-breakpoint

-- ─── 加入新空间时补铺 ───
--
-- 用户后来加入一个新空间，之前攒下的 global 记忆要跟过去——否则"跨空间同步"只在
-- 写入那一刻成立，之后加入的空间永远是空的。
CREATE OR REPLACE FUNCTION public.ailearn_backfill_global_memories_on_join()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  src record;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  FOR src IN
    SELECT DISTINCT ON (m.global_key) m.id
      FROM public.assistant_memory_items m
     WHERE m.user_id = NEW.user_id
       AND m.scope = 'global'
       AND m.global_key IS NOT NULL
       AND m.deleted_at IS NULL
       AND m.workspace_id <> NEW.workspace_id
     ORDER BY m.global_key, m.updated_at DESC
  LOOP
    PERFORM public.ailearn_fanout_global_companion_memory(src.id);
  END LOOP;

  RETURN NEW;
END;
$function$;

--> statement-breakpoint

-- 注意：成员表上已经有 0261 的 epoch 触发器。这里是第二个 AFTER 触发器，
-- 顺序无关（一个抬 epoch、一个补记忆），互不依赖。
DROP TRIGGER IF EXISTS workspace_members_backfill_global_memories ON public.workspace_members;
CREATE TRIGGER workspace_members_backfill_global_memories
  AFTER INSERT ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_backfill_global_memories_on_join();

--> statement-breakpoint

-- 重新加入（UPDATE left_at → NULL）也要补。
DROP TRIGGER IF EXISTS workspace_members_backfill_global_memories_rejoin ON public.workspace_members;
CREATE TRIGGER workspace_members_backfill_global_memories_rejoin
  AFTER UPDATE OF left_at ON public.workspace_members
  FOR EACH ROW
  WHEN (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL)
  EXECUTE FUNCTION public.ailearn_backfill_global_memories_on_join();

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'assistant_memory_items'
      AND column_name = 'global_key'
  ) THEN
    RAISE EXCEPTION 'assistant_memory_items.global_key 没有加上';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'ailearn_fanout_global_companion_memory'
  ) THEN
    RAISE EXCEPTION '铺开函数没有建立';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'workspace_members_backfill_global_memories' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '加入空间时的补铺触发器没有建立';
  END IF;
  RAISE NOTICE '跨空间记忆同步就绪（global_key + 铺开函数 + 加入补铺）';
END
$$;
