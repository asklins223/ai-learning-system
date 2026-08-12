-- 0111_card_generation_rls_complete.sql
-- 2026-08-11（第十轮，迁移安全审计）：
-- 1) 0052 创建的六张表从未 ENABLE RLS（审计实测 rowsecurity=f），
--    与同域 0044/0045/0070/0100 的 FORCE RLS 不一致——生产 ailearn_api/
--    ailearn_worker（NOBYPASSRLS）对这些表无行级隔离、全表可见。
--    补齐：ENABLE + FORCE RLS + workspace_isolation 策略 + worker 豁免
--    （照 0070/0100 模式；worker 豁免让现有裸访问点继续工作）。
-- 2) 0064 对 ailearn_fail_job 先 DROP 后 CREATE，清掉了 0022 建立的
--    REVOKE FROM PUBLIC + GRANT TO ailearn_worker ACL（SECURITY DEFINER
--    函数默认 PUBLIC 可 EXECUTE）——补回最小权限契约（幂等）。
-- 3) sessions 无 FK（workspace 删除后成孤儿）+ 缺 (workspace_id,user_id)
--    索引（invite/identity/learning 多路径按该组合吊销）——补 CASCADE FK
--    与复合索引。

-- ── 1) 六张 card_generation 相关表 RLS 补齐 ─────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'card_generation_agent_events',
    'card_generation_source_bundles',
    'card_generation_source_bundle_members',
    'card_generation_drafts',
    'card_generation_quality_reports',
    'note_evidence_embeddings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS %I_workspace_isolation ON public.%I
    $p$, t, t);
    EXECUTE format($p$
      CREATE POLICY %I_workspace_isolation
        ON public.%I AS PERMISSIVE
        FOR ALL
        USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
        WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
    $p$, t, t);
  END LOOP;

  -- worker 豁免（角色存在检查，fresh 库 roles.sql 先建角色；照 0100 模式）
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    FOREACH t IN ARRAY tables LOOP
      EXECUTE format($p$
        DROP POLICY IF EXISTS %I_worker_all ON public.%I
      $p$, t, t);
      EXECUTE format($p$
        CREATE POLICY %I_worker_all
          ON public.%I AS PERMISSIVE
          FOR ALL TO ailearn_worker
          USING (CURRENT_USER = 'ailearn_worker')
          WITH CHECK (CURRENT_USER = 'ailearn_worker')
      $p$, t, t);
    END LOOP;
  END IF;
END $$;

--> statement-breakpoint

-- ── 2) ailearn_fail_job 最小权限契约补回（0064 DROP+CREATE 清 ACL）───────
REVOKE ALL ON FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_fail_job(uuid, uuid, text, text, integer) TO ailearn_worker;

--> statement-breakpoint

-- ── 3) sessions FK + 复合索引 ──────────────────────────────────────────
-- FK 前清理孤儿 session（早期数据残留：user/workspace 无引用的 18 行，
-- 2026-08-11 实测）。无引用即无法认证（decodeToken JOIN 判 NULL 吊销），
-- 清理安全。
DELETE FROM public.sessions s
WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = s.user_id)
   OR NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = s.workspace_id);

DO $$
BEGIN
  BEGIN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_user_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_workspace_id_fk
      FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS sessions_workspace_user_idx
  ON public.sessions USING btree ("workspace_id", "user_id");
