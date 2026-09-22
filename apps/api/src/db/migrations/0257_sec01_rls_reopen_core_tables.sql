-- 0257: 重开工作区核心表的 RLS（2026-09-20 多空间审查的阻断项，接 0241）。
--
-- 背景：`0027_sec01_rls_expansion_failsafe.sql` 把 `0024` 启用的 RLS 整批关回
-- "expansion mode"，理由是当时并非所有 workspace 归属查询都跑在带
-- `app.workspace_id` 的事务里。0241 先重开了 `review_schedules`（先补齐按人归因、
-- 再翻开关）。这一支把剩下的核心内容表与边界表一起打开。
--
-- 为什么现在能开：`withWorkspaceTransaction` 已经是全部业务模块的唯一入口
-- （`db/client.ts` 的注释列了保留裸 `db` 的两类场景），并且这次补上了**第二条
-- 上下文** `withActorTransaction`——登录、令牌解析、空间列表这三条路发生在
-- "还不知道当前空间"的时刻，它们要读的正是"这个人属于哪些空间"，
-- 没有这条上下文，`workspace_members` 一开就 401（实测）。
--
-- ─── 三张表的重开方式与其余不同，逐条说明 ───
--
-- 1. `workspace_members` / `workspaces`：租户守卫是 RESTRICTIVE 的
--    `workspace_id = app.workspace_id`（`workspaces` 是 `id = app.workspace_id`）。
--    登录时要按 `user_id` 读成员行，而那时还没有 workspace。所以补一条
--    **actor 读策略**：`user_id = app.user_id`（workspaces 那条是
--    `id = app.workspace_id`）。它不是放宽隔离——策略仍然是 AND 在租户守卫之上，
--    只是给"空间建立之前读自己那一行"留了一个入口。写路径（建空间、发邀请、
--    改成员）仍然只由租户守卫约束。
--
-- 2. `sessions`：这张表**没有** `workspace_id` 之外的归属键可用——它的主键就是
--    令牌哈希。所以策略按令牌判：`token = app.session_token`。会话行的
--    user_id/workspace_id 在 `decodeToken` 里是**从这一行读出来的**，用它们做
--    谓词会变成循环依赖。`app.session_token` 由 `withActorTransaction` 设置，
--    值就是 `hashToken(rawToken)`——调用方即使把 WHERE 写错，也只能拿到
--    自己手里那一个令牌对应的行。
--
-- 3. 其余 11 张表策略早已齐备（0024 装的，0027 只是关掉了 enforcement），
--    这里只做 ENABLE + FORCE，不新增策略。
--
-- ─── FORCE 的含义 ───
-- 表属主是 `ailearn_migrator`（`rolbypassrls`），迁移与 `roles.sql` 的授权流程
-- 需要绕过策略；`FORCE` 只影响属主之外的普通角色，也就是 `ailearn_api` 与
-- `ailearn_worker`——正是生产里跑业务的那两个。
--
-- ─── 与 0027 的先后关系 ───
-- 0027 是无条件批量 `DISABLE`。迁移按文件名顺序重放，所以本文件必须排在它之后
-- （0257 > 0027）。谁再写一支批量 DISABLE，`schema-isolation-gate-postgres`
-- 的棘轮会红——那份基线只减不增。

-- ─── 1. 补两条 actor 读策略与四条会话策略 ───────────────────────────

-- `workspace_members` / `workspaces` 的租户守卫要**让开 actor 事务**。
--
-- 这两张表与其余内容表有一个本质区别：它们是"这个人属于哪些空间"的答案本身。
-- 登录、`/auth/workspaces`、接受邀请这三条路都发生在"当前空间"还不存在的时刻，
-- 而它们要读的正是这张表。RESTRICTIVE 的 `workspace_id = app.workspace_id` 在
-- 那种时刻恒为假（`app.workspace_id` 是空串 → NULL → 不通过），实测结果是
-- `POST /auth/login` 直接 401。
--
-- 所以守卫改成"**给了空间就按空间收**"：
--   `app.workspace_id IS NULL OR workspace_id = app.workspace_id`
-- 空值只可能来自 `withActorTransaction`——它是事务局部的（`set_config(..., true)`），
-- 不会跨请求泄漏到连接池里的下一条语句。业务请求一律走
-- `withWorkspaceTransaction`，那里 `app.workspace_id` 必然有值，守卫照旧生效。
--
-- 这不是"放宽隔离"，而是把守卫的语义从"必须有一个空间"改成"有空间就必须匹配"：
-- 前者会把"还没选空间"这件事本身判成违规，而那是登录的必经状态。
DROP POLICY IF EXISTS sec01_v1_workspace_members_tenant_guard ON public.workspace_members;
CREATE POLICY sec01_v1_workspace_members_tenant_guard ON public.workspace_members
  AS RESTRICTIVE FOR ALL TO public
  USING (
    NULLIF(current_setting('app.workspace_id', true), '') IS NULL
    OR workspace_id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.workspace_id', true), '') IS NULL
    OR workspace_id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS sec01_v1_workspaces_tenant_guard ON public.workspaces;
CREATE POLICY sec01_v1_workspaces_tenant_guard ON public.workspaces
  AS RESTRICTIVE FOR ALL TO public
  USING (
    NULLIF(current_setting('app.workspace_id', true), '') IS NULL
    OR id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.workspace_id', true), '') IS NULL
    OR id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid
  );

--> statement-breakpoint

CREATE POLICY sec01_v1_workspace_members_actor_read ON public.workspace_members
  AS PERMISSIVE FOR SELECT TO public
  USING (
    CURRENT_USER = 'ailearn_api'::name
    AND user_id = (NULLIF(current_setting('app.user_id', true), ''))::uuid
  );

--> statement-breakpoint

CREATE POLICY sec01_v1_workspaces_actor_read ON public.workspaces
  AS PERMISSIVE FOR SELECT TO public
  USING (
    CURRENT_USER = 'ailearn_api'::name
    -- 不能写 `owner_id = app.user_id`：空间列表要报出**加入的协作空间**的名字，
    -- 而那些行的 owner 是别人。这一支服务的是"我属于哪些空间"的读，行的范围由
    -- 上面那条租户守卫与调用方的 WHERE（`id IN (我加入的空间)`）共同收窄。
    AND (NULLIF(current_setting('app.workspace_id', true), '') IS NULL
         OR id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid)
  );

--> statement-breakpoint

-- 邀请码的兑换同样发生在"还不知道是哪个空间"的时刻：用户手里只有一串明文邀请码，
-- 空间 id 是**这一行读出来之后**才知道的。所以按令牌哈希放行一行：
-- `token_hash = app.session_token`。和 `sessions` 那条同一个道理——调用方即使把
-- WHERE 写错，也只能拿到自己手里那一个邀请码对应的行，而这一行本来就是凭它换来的。
-- 这条策略只给 SELECT；消费（写 consumed_by）仍然要过租户守卫。
--
-- 同时**撤掉 0024 那一条租户守卫**：`invite_codes` 上有两条 RESTRICTIVE 的
-- `workspace_id = app.workspace_id`（sec01 与 sec02 各一条），RESTRICTIVE 之间是 AND，
-- 两条都要求"当前空间"，所以只放宽一条没有用——实测兑换邀请码仍然是 404。
-- 两条的表达式逐字相同，所以直接删掉 sec01 那份重复项；sec02 那条改成与
-- `workspace_members` / `workspaces` 同一形状——给了空间才按空间收。
DROP POLICY IF EXISTS sec01_v1_invite_codes_tenant_guard ON public.invite_codes;
DROP POLICY IF EXISTS sec02_v1_invite_codes_tenant_guard ON public.invite_codes;
CREATE POLICY sec02_v1_invite_codes_tenant_guard ON public.invite_codes
  AS RESTRICTIVE FOR ALL TO public
  USING (
    NULLIF(current_setting('app.workspace_id', true), '') IS NULL
    OR workspace_id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.workspace_id', true), '') IS NULL
    OR workspace_id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid
  );

--> statement-breakpoint

CREATE POLICY sec01_v1_invite_codes_actor_read ON public.invite_codes
  AS PERMISSIVE FOR SELECT TO public
  USING (
    CURRENT_USER = 'ailearn_api'::name
    AND token_hash = NULLIF(current_setting('app.session_token', true), '')
  );

--> statement-breakpoint

-- 会话行的读/改/删**按令牌**可达，插入按身份。
--
-- 为什么读路径不能同时要求 `user_id = app.user_id`：`decodeToken` 的第一步就是
-- "拿着一个令牌问这是谁"，那时 user_id 还是未知量——把它写进策略会变成循环依赖
-- （实测：策略这么写，登录成功、下一个请求 401 invalid token）。
-- 令牌哈希是 256 位高熵值，`token = app.session_token` 本身就是一条足够强的绑定：
-- 调用方即使把 WHERE 写错，也只能拿到自己手里那一个令牌的行。
--
-- 但批量会话维护（改密后撤销全部、退出所有设备、每小时清理过期行）不属于任何
-- 单个令牌，所以额外给一个 `app.session_token` 为空的分支，并按 `user_id` 收窄——
-- 那三条路的调用方都显式声明了"我在处理某个人的全部会话"。
-- INSERT 反过来：新建会话时必须说明这是谁的行，所以只认 `user_id = app.user_id`。
CREATE POLICY sec01_v1_sessions_actor_read ON public.sessions
  AS PERMISSIVE FOR SELECT TO public
  USING (
    CURRENT_USER = 'ailearn_api'::name
    AND (
      token = NULLIF(current_setting('app.session_token', true), '')
      OR (
        NULLIF(current_setting('app.session_token', true), '') IS NULL
        AND user_id = (NULLIF(current_setting('app.user_id', true), ''))::uuid
      )
    )
  );

--> statement-breakpoint

CREATE POLICY sec01_v1_sessions_actor_insert ON public.sessions
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    CURRENT_USER = 'ailearn_api'::name
    AND user_id = (NULLIF(current_setting('app.user_id', true), ''))::uuid
  );

--> statement-breakpoint

CREATE POLICY sec01_v1_sessions_actor_update ON public.sessions
  AS PERMISSIVE FOR UPDATE TO public
  USING (
    CURRENT_USER = 'ailearn_api'::name
    AND (
      token = NULLIF(current_setting('app.session_token', true), '')
      OR (
        NULLIF(current_setting('app.session_token', true), '') IS NULL
        AND user_id = (NULLIF(current_setting('app.user_id', true), ''))::uuid
      )
    )
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_api'::name
    AND user_id = (NULLIF(current_setting('app.user_id', true), ''))::uuid
  );

--> statement-breakpoint

CREATE POLICY sec01_v1_sessions_actor_delete ON public.sessions
  AS PERMISSIVE FOR DELETE TO public
  USING (
    CURRENT_USER = 'ailearn_api'::name
    AND (
      token = NULLIF(current_setting('app.session_token', true), '')
      OR (
        NULLIF(current_setting('app.session_token', true), '') IS NULL
        AND user_id = (NULLIF(current_setting('app.user_id', true), ''))::uuid
      )
    )
  );

--> statement-breakpoint

-- ─── 2. 重开 enforcement ────────────────────────────────────────────
-- 内容表（策略早已齐备）。
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.note_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_versions FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.note_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_blocks FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sources FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.source_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_segments FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_documents FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.ai_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_artifacts FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.ai_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_audit_log FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

-- 边界与队列表。
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_codes FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.onboarding_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_states FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

-- ─── 3. fail-closed 验证：策略齐备 + enforcement 真的开了 ───────────

DO $$
DECLARE
  v_missing text;
  v_disabled text;
BEGIN
  SELECT string_agg(required.table_name || '.' || required.name, ', ' ORDER BY required.table_name, required.name)
  INTO v_missing
  FROM (VALUES
    ('workspace_members', 'sec01_v1_workspace_members_actor_read'),
    ('workspace_members', 'sec01_v1_workspace_members_runtime_access'),
    ('workspace_members', 'sec01_v1_workspace_members_tenant_guard'),
    ('workspaces', 'sec01_v1_workspaces_actor_read'),
    ('workspaces', 'sec01_v1_workspaces_runtime_access'),
    ('workspaces', 'sec01_v1_workspaces_tenant_guard'),
    ('sessions', 'sec01_v1_sessions_actor_read'),
    ('sessions', 'sec01_v1_sessions_actor_insert'),
    ('sessions', 'sec01_v1_sessions_actor_update'),
    ('sessions', 'sec01_v1_sessions_actor_delete'),
    ('notes', 'sec01_v1_notes_runtime_access'),
    ('notes', 'sec01_v1_notes_tenant_guard'),
    ('note_versions', 'sec01_v1_note_versions_runtime_access'),
    ('note_versions', 'sec01_v1_note_versions_tenant_guard'),
    ('note_blocks', 'sec01_v1_note_blocks_runtime_access'),
    ('note_blocks', 'sec01_v1_note_blocks_tenant_guard'),
    ('sources', 'sec01_v1_sources_runtime_access'),
    ('sources', 'sec01_v1_sources_tenant_guard'),
    ('source_segments', 'sec01_v1_source_segments_runtime_access'),
    ('source_segments', 'sec01_v1_source_segments_tenant_guard'),
    ('search_documents', 'sec01_v1_search_documents_runtime_access'),
    ('search_documents', 'sec01_v1_search_documents_tenant_guard'),
    ('ai_artifacts', 'sec01_v1_ai_artifacts_runtime_access'),
    ('ai_artifacts', 'sec01_v1_ai_artifacts_tenant_guard'),
    ('ai_audit_log', 'sec01_v1_ai_audit_api_owner_read'),
    ('ai_audit_log', 'sec01_v1_ai_audit_tenant_guard'),
    ('invite_codes', 'sec01_v1_invite_codes_actor_read'),
    ('invite_codes', 'sec02_v1_invite_codes_runtime_access'),
    ('invite_codes', 'sec02_v1_invite_codes_tenant_guard'),
    ('jobs', 'sec01_v1_jobs_tenant_guard'),
    ('onboarding_states', 'sec02_v1_onboarding_states_actor_guard'),
    ('onboarding_states', 'sec02_v1_onboarding_states_runtime_access'),
    ('onboarding_states', 'sec02_v1_onboarding_states_tenant_guard')
  ) AS required (table_name, name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = ('public.' || required.table_name)::regclass
      AND polname = required.name
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'RLS 重开被拒绝：缺少策略 %', v_missing;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO v_disabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'notes', 'note_versions', 'note_blocks', 'sources', 'source_segments',
      'search_documents', 'ai_artifacts', 'ai_audit_log',
      'workspaces', 'workspace_members', 'invite_codes', 'jobs',
      'onboarding_states', 'sessions'
    )
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'RLS 重开被拒绝：这些表没有同时 ENABLE+FORCE：%', v_disabled;
  END IF;

  RAISE NOTICE 'SEC-01 重开完成：14 张表 ENABLE+FORCE，策略齐备';
END
$$;
