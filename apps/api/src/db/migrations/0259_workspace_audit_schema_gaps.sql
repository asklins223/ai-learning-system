-- 0259: 审查剩余的三个 schema 级缺口——念头调度的 left_at、成员角色约束、
-- 伴星旅程的活跃唯一键。
--
-- 三条都来自 2026-09-20 多空间审查的"未完成"清单，逐条说明为什么是这个形状。
--
-- ─── 1. 念头调度不过滤 left_at（审查原文：中）───
-- `ailearn_enqueue_companion_thoughts` 按 `(workspace, user)` 入队念头，取对的
-- 语句是 `JOIN workspace_members m ON m.user_id = s.user_id`——**没有 `left_at`
-- 条件**（0227 起就是这样，0236/0254 两次改写都没补）。后果：用户已经退出的空间
-- 仍然持续生成念头并投进 inbox；每退一个空间就多一路"她还在那儿跟你说话"。
--
-- 对比：同批修的日记调度（0243）有 `wm.left_at IS NULL`。两条调度器一个有一个没有，
-- 正是审查说的"隔离 100% 依赖开发者手写 WHERE"。
--
-- ─── 2. workspace_members.role 是 free-text（审查原文：中）───
-- 实测 `pg_constraint` 在这张表上只有 2 条 FK，没有任何 CHECK。dev 库里曾经出现过
-- 3 条把非 owner 用户写成 `role='owner'` 塞进他人个人空间的夹具行——绕过全部业务
-- 校验，而数据库一句话都没说。角色只有 owner / member 两种（`PRODUCT.md:67`），
-- 加 CHECK 是让"写错角色"在插入那一刻就失败，而不是等到某个权限判据读到它。
--
-- ─── 3. companion_journeys 活跃唯一键是账号全局（审查原文：中）───
-- `0124` 建的是 `UNIQUE (user_id) WHERE status IN ('active','paused','recoverable_error')`
-- ——账号全局。于是一个人在第二个空间里**永远起不来新手旅程**：第一段旅程还活着，
-- 唯一键就把他挡在门外。旅程是空间内的过程（`companion_journeys` 自带
-- `workspace_id`），唯一性应当在空间内成立，而不是跨空间互斥。
--
-- 三处都不改已应用的迁移文件（`migrate.ts` 以 sha256 判断是否应用过，改旧文件等于
-- 让它在已应用库上重跑），一律写前向迁移。

-- ─── 1. 念头调度补 left_at ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ailearn_enqueue_companion_thoughts()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_bucket text;
  v_workspace_id uuid;
  v_user_id uuid;
  v_inserted integer := 0;
BEGIN
  v_bucket := floor(extract(epoch FROM now()) / 1800)::text;

  FOR v_workspace_id, v_user_id IN
    SELECT m.workspace_id, s.user_id
    FROM user_companion_account_state s
    JOIN workspace_members m ON m.user_id = s.user_id
    JOIN pet_profiles p ON p.workspace_id = m.workspace_id AND p.user_id = s.user_id
    WHERE s.global_enabled = true
      -- 0259：已退出的空间不再生成念头（与 0243 的日记调度同一判据）。
      AND m.left_at IS NULL
      AND p.last_active_at > now() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.workspace_id = m.workspace_id
          AND j.type = 'companion_thought'
          AND j.scheduled_at > now() - interval '30 minutes'
      )
  LOOP
    -- 静默时段（跨午夜语义）与按偏好的间隔判定都在 worker handler 内用与
    -- proactive-hook 同源的规则执行（JS 侧），SQL 里不复刻钟面数学；
    -- 这里只负责按桶幂等入队。
    INSERT INTO jobs
      (workspace_id, type, requested_by, payload, status, priority, resource_class, idempotency_key, scheduled_at)
    VALUES
      (v_workspace_id, 'companion_thought', v_user_id,
       jsonb_build_object('userId', v_user_id, 'bucket', v_bucket),
       'pending', 10, 'maintenance',
       'companion-thought:' || v_workspace_id || ':' || v_user_id || ':' || v_bucket,
       now())
    ON CONFLICT DO NOTHING;
    IF found THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_enqueue_companion_thoughts() IS
  '念头批量生成入队（30 分钟桶幂等，供最快一档 30 分钟的节奏用）。说不说由 handler 按静默时段/反馈/间隔判。门槛：pet_profiles.last_active_at 14 天内 + 账号总开关 + 成员未退出（0259 补 left_at）。';

--> statement-breakpoint

-- ─── 2. 成员角色 CHECK ──────────────────────────────────────────────

ALTER TABLE public.workspace_members
  ADD CONSTRAINT workspace_members_role_check CHECK (role IN ('owner', 'member'));

--> statement-breakpoint

-- ─── 3. 旅程活跃唯一键收到空间内 ────────────────────────────────────

DROP INDEX IF EXISTS public.companion_journeys_user_active_unique_idx;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS companion_journeys_workspace_user_active_unique_idx
  ON public.companion_journeys (workspace_id, user_id)
  WHERE status IN ('active', 'paused', 'recoverable_error');

--> statement-breakpoint

-- ─── 4. fail-closed 验证 ────────────────────────────────────────────

DO $$
DECLARE
  v_body text;
  v_has_check boolean;
  v_has_ws_index boolean;
  v_has_user_index boolean;
BEGIN
  SELECT pg_get_functiondef('public.ailearn_enqueue_companion_thoughts()'::regprocedure)
  INTO v_body;
  IF position('left_at IS NULL' IN v_body) = 0 THEN
    RAISE EXCEPTION '念头调度没有补上 left_at 过滤';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.workspace_members'::regclass
      AND conname = 'workspace_members_role_check'
  ) INTO v_has_check;
  IF NOT v_has_check THEN
    RAISE EXCEPTION 'workspace_members.role 的 CHECK 约束没有加上';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'companion_journeys_workspace_user_active_unique_idx'
  ) INTO v_has_ws_index;
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'companion_journeys_user_active_unique_idx'
  ) INTO v_has_user_index;
  IF NOT v_has_ws_index OR v_has_user_index THEN
    RAISE EXCEPTION '旅程活跃唯一键没有换成按 (workspace_id, user_id)';
  END IF;

  RAISE NOTICE '0259 三项 schema 缺口已收口';
END
$$;
