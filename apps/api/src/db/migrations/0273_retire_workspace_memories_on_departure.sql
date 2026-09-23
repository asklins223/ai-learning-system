-- 0273 —— 成员退出/被移出之后，把"跟这个空间有关的那一份记忆"收掉（doc 34 L38）。
--
-- 用户给的口径：记忆归属于个人；涵盖了某个空间的那一份只是**关联**到空间。
-- 所以这里只收 `scope = 'workspace'` 且属于这个空间的行，`scope='global'`（带 `global_key`
-- 的那一半）**一动不动**——那是她自己的东西，跟着她走。
--
-- 为什么做成 SECURITY DEFINER 函数，而不是在两个调用点各写一句 UPDATE：
-- `assistant_memory_items` 只有一条 PERMISSIVE 策略
-- （`workspace_id = current_setting('app.workspace_id') AND user_id = current_setting('app.user_id')`，
-- 外加 worker 那一支）。`removeMember` 的事务上下文是 (这个空间, **owner**)，
-- 按那条策略去改**那位成员**的记忆恒匹配 0 行——不报错，静默什么也没做。
-- 只有绕过调用方身份、在函数内部按参数判范围，这件事才做得成（先例：
-- `ailearn_fanout_global_companion_memory`，0267）。
--
-- 为什么写 `deleted_at` 而不是 `archived_at`：`archived_at` 有一条"取消归档"的界面上报路
-- （`memory-service.ts:340`）和 `includeArchived` 开关，等于给"我自己翻回来"留了出口；
-- `deleted_at` 是全仓 60 处判据都认的那一个，也是召回/列表/星图共同尊重的那一个。
-- 重新加入空间不会把这些记忆带回来，这是有意的：那段上下文属于她不在场的那段时间。
--
-- 不发 `pg_notify`、不收 `assistant_deliveries`：投递行按 (workspace_id, user_id) 存在，
-- 人走了那个空间就读不到（投递的终态结账在 L42 已经装在"用户对记忆表态"那条路上，
-- 与"离开空间"是两件事，硬并进来会让这条函数承担它管不着的副作用）。

CREATE OR REPLACE FUNCTION public.ailearn_retire_workspace_memories_on_departure(
  p_workspace_id uuid,
  p_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_retired integer := 0;
BEGIN
  -- 参数为空就不是"某个人离开某个空间"这件事，直接 0，别把全表扫进 UPDATE。
  IF p_workspace_id IS NULL OR p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.assistant_memory_items
     SET deleted_at = now(),
         updated_at = now()
   WHERE workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND scope = 'workspace'
     AND deleted_at IS NULL;

  GET DIAGNOSTICS v_retired = ROW_COUNT;
  RETURN v_retired;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_retire_workspace_memories_on_departure(uuid, uuid) IS
  '成员退出/被移出时收掉该空间那一侧的记忆（scope=workspace，软删除）。global 那一半跟人走，不动。SECURITY DEFINER 是必需的：策略要求 app.user_id 等于行的 user_id，owner 发起的移除按策略恒匹配 0 行。只授 ailearn_api / ailearn_migrator。';

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_retire_workspace_memories_on_departure(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_retire_workspace_memories_on_departure(uuid, uuid) TO ailearn_api;
GRANT EXECUTE ON FUNCTION public.ailearn_retire_workspace_memories_on_departure(uuid, uuid) TO ailearn_migrator;
