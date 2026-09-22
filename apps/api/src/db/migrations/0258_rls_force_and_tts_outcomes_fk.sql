-- 0258: 补上 `companion_tts_outcomes` 的空间外键，并把 RLS FORCE 补齐。
--
-- 两件事都是 2026-09-20 多空间审查里点名、0257 之后剩下的尾巴。
--
-- ─── 1. `companion_tts_outcomes` 缺空间外键 ───
-- 这张表是 0246 建的，带 `workspace_id` 却没有指向 `workspaces` 的 FK——
-- `schema-isolation-gate-postgres` 的棘轮在 0257 之后立刻把它抓了出来
-- （"以下新表带 workspace_id 却没有指向 workspaces 的外键"）。棘轮的规矩是
-- 补 FK，不是加进基线绕过。
--
-- `ON DELETE CASCADE` 与同类伴星表（`companion_reminders`、`assistant_thoughts`、
-- `companion_conversations`）一致：合成结果没有跨空间存续的意义，空间没了就该走。
-- 加 FK 前先清孤儿：这张表没有用户数据，孤儿只可能来自夹具删行，直接删。
--
-- ─── 2. 35 张表 RLS enabled 但没有 FORCE ───
-- 审查原文：「33 张表 RLS enabled 但未 FORCE（表属主 `ailearn_migrator` 有
-- `rolbypassrls`），与 `rls-policies-postgres.integration.ts:384-390` 自称的不变量
-- 不一致」。没有 FORCE 时，策略对**表属主**不生效——也就是"换个角色连上去就绕过"。
-- 生产里跑业务的是 `ailearn_api` / `ailearn_worker`（都不是属主），所以这一条
-- 不是线上漏洞；但它是"我读到的策略真的是在挡"这件事的前提，而审查反复撞到的
-- 正是"看起来有防线、其实没生效"。
--
-- 迁移本身不受影响：`DATABASE_URL_MIGRATOR` 连的 `ailearn` 是 superuser +
-- `rolbypassrls`，FORCE 只对属主之外的普通角色生效（见 PostgreSQL 文档
-- "FORCE ROW LEVEL SECURITY ... except when the row owner is the table owner"
-- 的例外是 superuser 与 BYPASSRLS）。
--
-- 这里不写"35 张表"的硬编码名单，而是按当前状态批量补——名单会随迁移漂移，
-- 而"enabled 就必须 forced"是一条不变量，交给下面第 3 段的验证收口。

-- ─── 1. 空间外键 ────────────────────────────────────────────────────

DELETE FROM public.companion_tts_outcomes o
 WHERE NOT EXISTS (
   SELECT 1 FROM public.workspaces w WHERE w.id = o.workspace_id
 );

--> statement-breakpoint

ALTER TABLE public.companion_tts_outcomes
  ADD CONSTRAINT companion_tts_outcomes_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

--> statement-breakpoint

-- ─── 2. 补 FORCE ────────────────────────────────────────────────────

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.relname);
    RAISE NOTICE 'RLS FORCE 已补：%', target.relname;
  END LOOP;
END
$$;

--> statement-breakpoint

-- ─── 3. fail-closed 验证 ────────────────────────────────────────────

DO $$
DECLARE
  v_unforced text;
  v_missing_fk text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO v_unforced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF v_unforced IS NOT NULL THEN
    RAISE EXCEPTION 'RLS FORCE 补齐失败，这些表仍是 enabled-not-forced：%', v_unforced;
  END IF;

  SELECT count(*)::text INTO v_missing_fk
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'companion_tts_outcomes'
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint k
      WHERE k.conrelid = c.oid AND k.contype = 'f'
        AND k.confrelid = 'public.workspaces'::regclass
    );
  IF v_missing_fk <> '0' THEN
    RAISE EXCEPTION 'companion_tts_outcomes 的空间外键没有加上';
  END IF;

  RAISE NOTICE 'RLS FORCE 与空间外键补齐完成';
END
$$;
