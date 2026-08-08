-- 0075: 阶段 02（W1）任务 02-2 —— RLS 矩阵与权限边界（§13.3 + §12.1）
--
-- 在 0074（任务 02-1 schema）基础上把 RLS 矩阵落为最终形态：
--
-- 1) workspace-scoped 学习表（learning_sessions / learning_episodes /
--    learning_session_probes / learning_response_artifacts /
--    learning_assessment_reports）：0074 仅按 app.workspace_id 隔离，本迁移
--    收紧为 workspace_id + user_id 双条件（§13.3「workspace-scoped ... 使用
--    workspace_id + user_id 双条件 RLS」）。写入/更新时 actor 必须同时是
--    workspace 成员与行属主：USING/WITH CHECK 要求 app.workspace_id 与
--    app.user_id 同时匹配；任一 context 缺失（NULLIF(...) IS NULL）即 fail
--    closed，无 user 上下文的 workspace-only actor 一律不可见。
-- 2) account-scoped Companion 表（user_companion_onboarding /
--    user_companion_account_state）：只按认证 user_id 授权（§13.3），禁止
--    workspace actor 与其他用户读取；不使用 workspace RLS，跨设备同步。
--    0074 已建 user_isolation policy，此处幂等重申，保证矩阵可独立审阅。
-- 3) user_learning_preferences：account 级行（workspace_id IS NULL）按
--    user_id 授权（跨设备同步）；workspace 级行（workspace_id IS NOT NULL）
--    再叠加 workspace_id 收紧 —— §12.1「prefs/projection →
--    user-private-in-workspace」。
-- 4) device-local hide：不写持久表；runtime-fence 仅保留 user/device
--    session/surface epoch/TTL（ephemeral，任务 02-3），本迁移只以注释
--    确认，不新增任何 device-local 持久表。
-- 5) GRANT 按角色存在性（0071 模式）：ailearn_api 全部新表读写；
--    ailearn_worker 仅学习过程表最小权限（SELECT/INSERT/UPDATE，无
--    DELETE，删除语义由 redaction/status 表达），account-scoped Companion
--    状态表一律不授权。
--
-- 幂等：ENABLE/FORCE 与 GRANT 天然可重跑；policy 用 DROP POLICY IF EXISTS +
-- CREATE POLICY 可重跑；fresh / upgrade / repeat / restore 全路径安全。

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- workspace-scoped 学习表：workspace_id + user_id 双条件 RLS（§13.3）
-- 0074 已 ENABLE+FORCE；此处重申并替换单条件 policy 为双条件。
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.learning_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_sessions_workspace_isolation
  ON public.learning_sessions;
DROP POLICY IF EXISTS learning_sessions_workspace_user_isolation
  ON public.learning_sessions;
CREATE POLICY learning_sessions_workspace_user_isolation
  ON public.learning_sessions FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.learning_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_episodes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_episodes_workspace_isolation
  ON public.learning_episodes;
DROP POLICY IF EXISTS learning_episodes_workspace_user_isolation
  ON public.learning_episodes;
CREATE POLICY learning_episodes_workspace_user_isolation
  ON public.learning_episodes FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.learning_session_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_session_probes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_session_probes_workspace_isolation
  ON public.learning_session_probes;
DROP POLICY IF EXISTS learning_session_probes_workspace_user_isolation
  ON public.learning_session_probes;
CREATE POLICY learning_session_probes_workspace_user_isolation
  ON public.learning_session_probes FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.learning_response_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_response_artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_response_artifacts_workspace_isolation
  ON public.learning_response_artifacts;
DROP POLICY IF EXISTS learning_response_artifacts_workspace_user_isolation
  ON public.learning_response_artifacts;
CREATE POLICY learning_response_artifacts_workspace_user_isolation
  ON public.learning_response_artifacts FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.learning_assessment_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_assessment_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_assessment_reports_workspace_isolation
  ON public.learning_assessment_reports;
DROP POLICY IF EXISTS learning_assessment_reports_workspace_user_isolation
  ON public.learning_assessment_reports;
CREATE POLICY learning_assessment_reports_workspace_user_isolation
  ON public.learning_assessment_reports FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- account-scoped Companion 表：只按认证 user_id 授权（§13.3）
-- 0074 已建 user_isolation policy；此处幂等重申（DROP+CREATE 同语义），
-- 禁止 workspace actor（未设置 app.user_id 时 fail closed）与其他用户读取，
-- 不使用 workspace RLS，跨设备同步。
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_companion_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_companion_onboarding FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_companion_onboarding_user_isolation
  ON public.user_companion_onboarding;
CREATE POLICY user_companion_onboarding_user_isolation
  ON public.user_companion_onboarding FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.user_companion_account_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_companion_account_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_companion_account_state_user_isolation
  ON public.user_companion_account_state;
CREATE POLICY user_companion_account_state_user_isolation
  ON public.user_companion_account_state FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- user_learning_preferences：account 级 + workspace 级混合矩阵（§12.1）
-- account 级行（workspace_id IS NULL）按 user_id 授权（跨设备同步）；
-- workspace 级行（workspace_id IS NOT NULL）叠加 workspace_id 收紧，即
-- §12.1「prefs/projection → user-private-in-workspace」。单一 policy 覆盖
-- 两种行形态，workspace actor 与其他用户一律不可读。
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_learning_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_learning_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_learning_preferences_user_isolation
  ON public.user_learning_preferences;
CREATE POLICY user_learning_preferences_user_isolation
  ON public.user_learning_preferences FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND (
      workspace_id IS NULL
      OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND (
      workspace_id IS NULL
      OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
  );

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- device-local hide：不写持久表（§13.3）
-- temporary_hidden / auth-surface hide 只留设备本地布尔值，不关联
-- user/workspace/登录标识/错误历史/学习数据；清除站点数据即可移除。
-- 0074 未创建对应持久表，本迁移不新增任何 device-local 表。runtime-fence
-- 仅保留 user + device session + surface epoch + TTL（ephemeral），落点在
-- 任务 02-3 的 lease/fence 实现，绝不进入 account-scoped 或 workspace 持久域。
-- ════════════════════════════════════════════════════════════════════════

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- least-privilege GRANT（0071 模式：按角色存在性授权，幂等可重跑）
-- ailearn_api：全部新表读写；ailearn_worker：仅学习过程表最小权限
-- （SELECT/INSERT/UPDATE，无 DELETE；删除语义由 redaction/status 表达），
-- account-scoped Companion 状态表不授权。
-- ════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_sessions TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_episodes TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_session_probes TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_response_artifacts TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_assessment_reports TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_companion_onboarding TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_companion_account_state TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_learning_preferences TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON public.learning_sessions TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.learning_episodes TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.learning_session_probes TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.learning_response_artifacts TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.learning_assessment_reports TO ailearn_worker;
    -- 有意不 GRANT：user_companion_onboarding / user_companion_account_state /
    -- user_learning_preferences 对 worker 一律不可见。
  END IF;
END $$;
