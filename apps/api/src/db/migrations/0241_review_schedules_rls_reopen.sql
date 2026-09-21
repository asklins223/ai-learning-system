-- 0241: 重开 `review_schedules` 的 RLS（2026-09-20 多空间审查，批次 3 决定 8）。
--
-- 背景：`0027_sec01_rls_expansion_failsafe.sql:77-78` 把这张表的 RLS 关成
-- "expansion mode"——三条策略（`tenant_guard` / `actor_guard` / `runtime_access`）
-- 一直挂着但没人执行，隔离完全依赖调用方自己写 WHERE。审查发现读写点共 18 个文件，
-- 其中"到期数""复习队列"这类只按 workspace 过滤的语句，会让协作空间里一个成员的
-- 复习数报到另一个人名下。批次 3 已把这些点逐个补上 `user_id`（含导出包的
-- review_schedules / onboarding_states / workspaceMembers / users 四处私有行过滤），
-- 现在才有条件把它真的打开。
--
-- 为什么现在才开：策略里两条是 **RESTRICTIVE**（`workspace_id = app.workspace_id`
-- 与 `user_id = app.user_id`）。一条语句若在没有 `app.user_id` 的上下文里跑，
-- 打开 RLS 后不是报错而是**静默 0 行**。所以先补齐归因、再翻开关，顺序不能反。
--
-- 与「系统级到期投影」的相互约束：`actor_guard` 要求 `user_id = app.user_id`，
-- 因此 `user_id IS NULL` 的全局行在 RLS 下对任何人都不可见。到期提醒必须**按人展开
-- 成行**（每成员一行、带自己的 user_id），不能存一条空间级 NULL 行——否则提醒会在
-- 生产静默消失。这条约束由集成测试
-- `apps/api/src/integration-tests/workspace-collab-postgres.integration.ts` 的
-- 「RLS 重开后」一组用例钉住。
--
-- 验证口径：dev 栈里 api/worker 容器与集成测试都用 `ailearn`（superuser + BYPASSRLS）
-- 连接，RLS 对它们天然不可见；真正的执行效果只能靠 `SET ROLE ailearn_api` 测出来，
-- 所以上面那组用例走的是 SET ROLE，而不是"跑一遍看看"。

--> statement-breakpoint

ALTER TABLE public.review_schedules ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.review_schedules FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

-- fail-closed：只有策略齐备才允许这次重开。缺任何一条就等于把一张没有规则、
-- 又对普通角色全隐身的表推上线（表现是"数据莫名其妙空了"，不是报错）。
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(required.name, ', ' ORDER BY required.name) INTO v_missing
  FROM (VALUES
    ('sec01_v1_review_schedules_tenant_guard'),
    ('sec01_v1_review_schedules_actor_guard'),
    ('sec01_v1_review_schedules_runtime_access')
  ) AS required (name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = 'public.review_schedules'::regclass
      AND polname = required.name
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'review_schedules RLS 重开被拒绝：缺少策略 %', v_missing;
  END IF;
END
$$;

--> statement-breakpoint

-- 重开必须可复核：把当前状态打出来，迁移日志里留痕。
DO $$
BEGIN
  RAISE NOTICE 'review_schedules: relrowsecurity=% force=% policies=%',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.review_schedules'::regclass),
    (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.review_schedules'::regclass),
    (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.review_schedules'::regclass);
END
$$;
