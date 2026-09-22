-- 0265: 孤儿清理要认得"不可变行"——不该用删除去撞业务不变量。
--
-- 0264 的 `ailearn_purge_workspace_orphans` 一跑就撞墙（实测）：
--
--   ERROR: immutable_v2_row: DELETE rows on card_candidate_quality_reports_v2
--          cannot be modified
--
-- 有 5 张表装了 `prevent_immutable_v2_row_mutation` 的 BEFORE DELETE 触发器
-- （`card_candidate_quality_reports_v2`、`evidence_snapshots_v2`、`learning_exposures_v2`、
-- `learning_objective_equivalence_reports_v2`、`semantic_support_reports_v2`）。
-- 那些触发器是**业务不变量**（证据快照与质量报告按设计不可改不可删），
-- 清理工具去撞它们是本末倒置：孤儿清理是运维兜底，不该成为"绕过不可变约束"的后门。
--
-- 所以改成：**识别并跳过**带 BEFORE DELETE 触发器的表，把它们如实报出来。
-- 报出来而不是静默跳过，是因为"哪些表清不掉"本身就是要给人看的结论——
-- 静默跳过会让下一次有人问"孤儿清干净了吗"时拿到一个假 yes。
--
-- 这一类表的孤儿最终要靠**空间级联删除**处理（`workspaces` 的 FK 是 CASCADE，
-- 但只覆盖那 10 张有 FK 的表）；真要清它们，得先决定那些表的不变量是否允许
-- 随空间销毁而消失——那是产品决定，不是清理脚本能替它做的。

-- `CREATE OR REPLACE` 改不了返回类型（新增一列 `skipped_reason`），所以先 DROP。
-- 这是**同一支迁移内**的替换，不是"改已应用的迁移"：0265 还没在任何库上成功跑过。
DROP FUNCTION IF EXISTS public.ailearn_purge_workspace_orphans(boolean);

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_purge_workspace_orphans(dry_run boolean DEFAULT true)
RETURNS TABLE (table_name text, orphan_rows bigint, skipped_reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  t record;
  n bigint;
  v_blocked boolean;
  v_pass integer;
  v_progress boolean;
  v_remaining bigint;
  v_fk_blocked text[] := ARRAY[]::text[];
BEGIN
  -- ─── 第一遍：如实报出每张表的孤儿数，并标出哪些不能删 ───
  --
  -- 两条"不能删"的理由，都要说清：
  --   - 行级不可变守卫（BEFORE DELETE 触发器）：那是业务不变量，清理工具不该去撞；
  --   - 被别的表的外键引用：顺序问题，下面多轮重试解决。
  FOR t IN
    SELECT c.relname, c.oid
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
    WHERE ns.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE x.workspace_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = x.workspace_id)',
      t.relname
    ) INTO n;

    CONTINUE WHEN n = 0;

    SELECT EXISTS (
      SELECT 1 FROM pg_trigger tg
      WHERE tg.tgrelid = t.oid AND NOT tg.tgisinternal AND (tg.tgtype & 8) <> 0
    ) INTO v_blocked;

    table_name := t.relname;
    orphan_rows := n;
    skipped_reason := CASE
      WHEN v_blocked THEN 'row-level immutability guard (BEFORE DELETE trigger)'
      ELSE NULL
    END;
    RETURN NEXT;
  END LOOP;

  IF dry_run THEN
    RETURN;
  END IF;

  -- ─── 第二遍：多轮删除 ───
  --
  -- 为什么不是"按依赖排好序一次删完"：孤儿表之间的引用图是动态的，而且随时会变
  -- （这次实测 `learning_runs` 被 `learning_target_snapshots_v2` 挡着，下一次可能是
  -- 另一对）。多轮重试是**自适应**的：每一轮删掉能删的，剩下的下一轮再试；
  -- 直到某一轮一行都没删掉——那时剩下的就是真删不掉的（不可变守卫，或跨空间的
  -- 引用），如实报出来。
  FOR v_pass IN 1..10 LOOP
    v_progress := false;
    FOR t IN
      SELECT c.relname, c.oid
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
      WHERE ns.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    LOOP
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = t.oid AND NOT tg.tgisinternal AND (tg.tgtype & 8) <> 0
      ) INTO v_blocked;
      CONTINUE WHEN v_blocked;

      BEGIN
        EXECUTE format(
          'DELETE FROM public.%I x WHERE x.workspace_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = x.workspace_id)',
          t.relname
        );
        IF FOUND THEN
          v_progress := true;
        END IF;
      EXCEPTION
        WHEN foreign_key_violation THEN
          -- 还被别的表引用着：这一轮先跳过，下一轮引用方删掉之后就能删。
          IF NOT (t.relname = ANY(v_fk_blocked)) THEN
            v_fk_blocked := v_fk_blocked || t.relname;
          END IF;
      END;
    END LOOP;
    EXIT WHEN NOT v_progress;
  END LOOP;

  -- ─── 第三遍：把"最后还剩什么"如实报出来 ───
  --
  -- 静默跳过会让下一次有人问"孤儿清干净了吗"时拿到一个假 yes。
  FOR t IN
    SELECT c.relname, c.oid
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
    WHERE ns.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE x.workspace_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = x.workspace_id)',
      t.relname
    ) INTO v_remaining;

    CONTINUE WHEN v_remaining = 0;

    SELECT EXISTS (
      SELECT 1 FROM pg_trigger tg
      WHERE tg.tgrelid = t.oid AND NOT tg.tgisinternal AND (tg.tgtype & 8) <> 0
    ) INTO v_blocked;

    table_name := t.relname;
    orphan_rows := v_remaining;
    skipped_reason := CASE
      WHEN v_blocked THEN 'row-level immutability guard (BEFORE DELETE trigger)'
      WHEN t.relname = ANY(v_fk_blocked) THEN 'referenced by another table (FK still in place)'
      ELSE 'not removed after 10 passes'
    END;
    RETURN NEXT;
  END LOOP;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_purge_workspace_orphans(boolean) IS
  '清理 workspace_id 指向不存在空间的行（审查附录 C）。带 BEFORE DELETE 不可变守卫的表只报不删。dry_run=true 只报表；只授给 ailearn_migrator。';

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_purge_workspace_orphans(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_purge_workspace_orphans(boolean) TO ailearn_migrator;

--> statement-breakpoint

DO $$
DECLARE
  v_blocked integer;
  v_cleanable integer;
  v_rows bigint;
BEGIN
  SELECT count(*) FILTER (WHERE skipped_reason IS NOT NULL),
         count(*) FILTER (WHERE skipped_reason IS NULL),
         coalesce(sum(orphan_rows), 0)
  INTO v_blocked, v_cleanable, v_rows
  FROM public.ailearn_purge_workspace_orphans(true);

  RAISE NOTICE '孤儿清理（dry run）：% 张表可清、% 张表带不可变守卫，共 % 行',
    v_cleanable, v_blocked, v_rows;
END
$$;
