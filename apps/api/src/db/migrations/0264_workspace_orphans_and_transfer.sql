-- 0264: 空间销毁的孤儿清理 + 所有权转让。
--
-- 两条都来自审查附录 C 的待核实清单：
--   - 「空间删除/成员删除时 89 张无 FK 表的孤儿数据处理路径」
--   - 「owner 退出自己空间、所有权转让是否有任何拦截或出口」
--
-- ─── 1. 孤儿清理 ───
-- 先核实事实：dev 库实测 **5,577 行孤儿**，分布在 18 张表（`evidence_snapshots_v2`
-- 1129、`card_generation_input_snapshots_v2` 435、`note_versions` 209、`note_blocks` 215、
-- `notes` 10 …）。成因就是审查反复说的那件事：96 张带 `workspace_id` 的表里只有 10 张
-- 真有 FK，删掉一个空间，其余表的行原样留下，谁也管不着。
--
-- 一次性给 100 张表补 FK 会锁表、而且要先清孤儿（这正是它一直没做的原因）。
-- 所以这一步做**兜底清理函数**而不是补 FK：
--   - 判据只有一条、而且是自证的：`workspace_id` 指向一个**不存在**的空间。
--     它绝不碰"属于别的空间"的行——那是隔离，不是清理。
--   - 表清单在函数里**动态枚举**（`pg_attribute` 里有 `workspace_id` 的所有表），
--     不写死名单：写死就意味着下一次新增表又漏了，而那正是这份审查的主题。
--   - `SECURITY DEFINER` + 只授给 `ailearn_migrator`：这是运维动作，不是请求路径。
--     API 角色拿不到 EXECUTE，所以没有任何 HTTP 入口能触发它。
--
-- ─── 2. 所有权转让 ───
-- 审查原文：「identity 模块里未见任何 transfer 路径。没有它，'owner 离职/换号'
-- 就没有出口」，而且「若 owner 退出自己拥有的协作空间没拦，空间变成无主孤儿，
-- `requireOwner` 的 OR 语义会让所有 member 同时'非 owner'，整个空间锁死」。
--
-- 核实：`leaveWorkspace` 对 `role === 'owner'` 确实拦了（`owner_cannot_leave`），
-- 所以"锁死"那条路被堵住了——但也因此 owner **完全没有出口**：既不能退，也不能交。
-- 这一支补上转让。数据库侧只需要一条不变量：新 owner 必须是**这个空间的活跃成员**
-- （不能把空间交给一个外人或已退出的人）。

-- ─── 1. 孤儿清理 ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ailearn_purge_workspace_orphans(dry_run boolean DEFAULT true)
RETURNS TABLE (table_name text, orphan_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  t record;
  n bigint;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
    WHERE ns.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    -- 孤儿 = workspace_id 指向一个不存在的空间。与"属于哪个空间"无关，
    -- 所以这条判据不可能删掉别人的数据。
    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE x.workspace_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = x.workspace_id)',
      t.relname
    ) INTO n;

    IF n > 0 THEN
      table_name := t.relname;
      orphan_rows := n;
      RETURN NEXT;
      IF NOT dry_run THEN
        EXECUTE format(
          'DELETE FROM public.%I x WHERE x.workspace_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = x.workspace_id)',
          t.relname
        );
      END IF;
    END IF;
  END LOOP;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_purge_workspace_orphans(boolean) IS
  '清理 workspace_id 指向不存在空间的行（审查附录 C）。dry_run=true 只报表；只授给 ailearn_migrator，API 角色无 EXECUTE。';

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_purge_workspace_orphans(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_purge_workspace_orphans(boolean) TO ailearn_migrator;

--> statement-breakpoint

-- ─── 2. 所有权转让的不变量 ──────────────────────────────────────────

-- 新 owner 必须是这个空间的活跃成员。做成触发器而不是只写在服务层：`owner_id`
-- 有三个写入点（注册、建协作空间、转让），触发器让"交给外人"在数据库层就不成立。
CREATE OR REPLACE FUNCTION public.ailearn_guard_workspace_owner_is_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_members m
      WHERE m.workspace_id = NEW.id
        AND m.user_id = NEW.owner_id
        AND m.left_at IS NULL
    ) THEN
      RAISE EXCEPTION 'workspace owner must be an active member of that workspace'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS workspaces_owner_must_be_member ON public.workspaces;
CREATE TRIGGER workspaces_owner_must_be_member
  BEFORE UPDATE OF owner_id ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_guard_workspace_owner_is_member();

--> statement-breakpoint

DO $$
DECLARE
  v_orphans bigint;
  v_tables integer;
BEGIN
  SELECT count(*), coalesce(sum(orphan_rows), 0) INTO v_tables, v_orphans
  FROM public.ailearn_purge_workspace_orphans(true);

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.proname = 'ailearn_purge_workspace_orphans'
  ) THEN
    RAISE EXCEPTION '孤儿清理函数没有建立';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'workspaces_owner_must_be_member' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '所有权转让的成员校验触发器没有建立';
  END IF;

  RAISE NOTICE '孤儿清理就绪：当前 % 张表、% 行孤儿（dry_run 只报表，未删除）', v_tables, v_orphans;
END
$$;
