-- 0276 —— 解散空间：把"删一个空间"变成一件说得清后果的事（doc 34 L6 的 ②）。
--
-- 为什么不是"删一行 workspaces 了事"：实测库里有 **102 张表带 `workspace_id`，只有 13 张真有
-- 指向 `workspaces` 的外键**（L39 那句"装了引擎没接启动键"就是这个缺口的另一面）。
-- 只删父行会留下 89 张表的孤儿，而 `notes` 连外键都没有——那正是既有的夹具注释写着的
-- "删空间不会带走笔记，只会留孤儿"。
--
-- 三条判据（都是量出来的，不是设计偏好）：
--  ① 记忆跟人绑定（用户 2026-09-23 拍定）：`scope='global'` 的行**不删**，改指到本人的个人空间；
--     实测这类行有 92 条的 workspace_id 不是本人个人空间，跟着删就是杀人的记忆。
--     `scope='workspace'` 的行按 L38 那支函数收掉。没有个人空间的用户**不静默丢**，计入返回值。
--  ② 审计必须活过这次删除：`ai_audit_log` / `companion_audit` 在排除名单里，
--     并且 `workspace.dissolved` 这条 tombstone 与被删同一事务（L40 的规矩：不伪造历史）。
--  ③ 要清的表**从 catalog 现生成**，不手抄名单——手抄那份会随迁移增长而悄悄漏表，
--     漏一张就是一批永远没人认领的孤儿行。
--
-- SECURITY DEFINER 的理由与 L38 同源：策略按 (workspace,user) 收窄，而这件事的发起者是 owner、
-- 处理对象包含其他成员的行；同时逐表动态 DELETE 需要跨租户守卫，只能由函数内部按参数判范围。

CREATE OR REPLACE FUNCTION public.ailearn_dissolve_workspace(
  p_workspace_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ws record;
  v_member record;
  v_table record;
  v_pass integer;
  v_deleted integer;
  v_total integer := 0;
  v_counts jsonb := '{}'::jsonb;
  v_rehomed_memories integer := 0;
  v_orphaned_global_memories integer := 0;
  v_actor_personal_ws uuid;
  v_retired_memories integer := 0;
  v_deferred text[] := ARRAY[]::text[];
  v_pass_rows integer;
  -- 排除名单：每张都要有理由，测试会断言这份名单不增长。
  v_exclude text[] := ARRAY[
    'workspaces',              -- 父行，最后单独删
    'ai_audit_log',            -- ②：AI 外发合规审计必须活过解散（它就是"当初有没有外发过"的唯一凭据）
    'workspace_audit_log',     -- ②：本次 tombstone 自己也要活下来，否则等于没记
    -- 注：`companion_audit`（页级不透明遥测）**跟着空间一起清**——它不是合规凭据，
    -- 留着只会造出指向已消失空间的悬空行（L39 那类孤儿）。
    'assistant_memory_items',  -- ①：由下面两段显式处理（global 不删）
    'assistant_memory_embeddings'
  ];
BEGIN
  SELECT id, workspace_type, name INTO v_ws
    FROM public.workspaces WHERE id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;
  IF v_ws.workspace_type = 'personal' THEN
    -- 个人空间是会话的落回点（`personal_workspace_missing` 那条判据的正面），不给删。
    RAISE EXCEPTION 'cannot_dissolve_personal_workspace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_actor_user_id
      AND role = 'owner' AND left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'actor_is_not_active_owner';
  END IF;

  -- ① 先处理记忆：每个成员收掉本空间那一份，再把属于人的 global 行改指回他的个人空间。
  FOR v_member IN
    SELECT user_id FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND left_at IS NULL
  LOOP
    v_retired_memories := v_retired_memories
      + public.ailearn_retire_workspace_memories_on_departure(p_workspace_id, v_member.user_id);

    UPDATE public.assistant_memory_items m
       SET workspace_id = u.personal_workspace_id, updated_at = now()
      FROM public.users u
     WHERE m.workspace_id = p_workspace_id
       AND m.user_id = u.id
       AND m.scope = 'global'
       AND u.personal_workspace_id IS NOT NULL
       AND u.personal_workspace_id <> p_workspace_id;
    GET DIAGNOSTICS v_pass_rows = ROW_COUNT;
    v_rehomed_memories := v_rehomed_memories + v_pass_rows;
  END LOOP;

  SELECT count(*) INTO v_orphaned_global_memories
    FROM public.assistant_memory_items m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.workspace_id = p_workspace_id AND m.scope = 'global'
     AND (u.personal_workspace_id IS NULL OR u.personal_workspace_id = p_workspace_id);

  DELETE FROM public.assistant_memory_embeddings
   WHERE workspace_id = p_workspace_id;
  DELETE FROM public.assistant_memory_items
   WHERE workspace_id = p_workspace_id AND scope = 'workspace';

  SELECT personal_workspace_id INTO v_actor_personal_ws
    FROM public.users WHERE id = p_actor_user_id;
  IF v_actor_personal_ws IS NULL OR v_actor_personal_ws = p_workspace_id THEN
    -- 没有可落回的审计归属地，就不做这件事：宁可拒绝解散，也不能删完留不下证据。
    RAISE EXCEPTION 'actor_has_no_surviving_workspace_for_audit';
  END IF;

  -- ② tombstone：与被删同一事务，回滚了就不该留下一条"这个空间被解散过"。
  -- **量出来的坑**：`workspace_audit_log.workspace_id` 对 `workspaces` 是 ON DELETE CASCADE
  -- ——tombstone 写在这个空间名下就会被自己删掉，"这个空间被解散过"这件事查无实据。
  -- 所以它记在**发起者的个人空间**名下（个人空间不许解散，见上面的门卫），
  -- target_id 才是那个消失的空间。顺带说明：这条级联是审计闭环上一个独立的洞（L40 族）。
  INSERT INTO public.workspace_audit_log (workspace_id, actor_user_id, action, target_kind, target_id, detail)
  VALUES (v_actor_personal_ws, p_actor_user_id, 'workspace.dissolved', 'workspace', p_workspace_id,
          jsonb_build_object('workspaceName', v_ws.name,
                             'dissolvedWorkspaceId', p_workspace_id,
                             'tombstoneRecordedUnderActorPersonalWorkspace', true,
                             'rehomedGlobalMemories', v_rehomed_memories,
                             'orphanedGlobalMemories', v_orphaned_global_memories,
                             'retiredWorkspaceMemories', v_retired_memories));

  -- ③ 逐表清空：清单来自 catalog，多轮扫（撞外键的表推到下一轮），直到一轮里没有任何行被删掉。
  FOR v_pass IN 1..6 LOOP
    v_deleted := 0;
    FOR v_table IN
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname <> ALL (v_exclude)
       ORDER BY c.relname
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE workspace_id = $1', v_table.relname)
          USING p_workspace_id;
        GET DIAGNOSTICS v_total = ROW_COUNT;
        IF v_total > 0 THEN
          v_counts := v_counts || jsonb_build_object(v_table.relname,
            coalesce((v_counts ->> v_table.relname)::integer, 0) + v_total);
          v_deleted := v_deleted + v_total;
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        -- 这一轮删不动：它还有指向别的空间的行。留到下一轮，最后一轮仍删不动就报出来。
        IF NOT (v_table.relname = ANY (v_deferred)) THEN
          v_deferred := v_deferred || v_table.relname;
        END IF;
      END;
    END LOOP;
    IF v_deleted = 0 THEN
      EXIT;
    END IF;
  END LOOP;

  IF v_deferred <> ARRAY[]::text[] THEN
    RAISE EXCEPTION 'dissolve_blocked_by_cross_workspace_references: %',
      array_to_string(v_deferred, ',');
  END IF;

  DELETE FROM public.workspaces WHERE id = p_workspace_id;

  RETURN v_counts || jsonb_build_object(
    '_rehomedGlobalMemories', v_rehomed_memories,
    '_orphanedGlobalMemories', v_orphaned_global_memories,
    '_retiredWorkspaceMemories', v_retired_memories);
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_dissolve_workspace(uuid, uuid) IS
  '解散一个协作空间：收成员的空间侧记忆、把属于人的记忆改指回个人空间、写审计 tombstone、逐表清空（清单来自 catalog）、删空间行。个人空间与 actor 非 owner 一律 RAISE。返回逐表删除计数。';

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_dissolve_workspace(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_dissolve_workspace(uuid, uuid) TO ailearn_api;
GRANT EXECUTE ON FUNCTION public.ailearn_dissolve_workspace(uuid, uuid) TO ailearn_migrator;
