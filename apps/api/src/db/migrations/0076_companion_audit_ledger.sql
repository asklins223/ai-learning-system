-- 0076: 阶段 02（W1）任务 02-4 —— Companion audit/ledger 与隐私生命周期（§5.8 + §12.2）
--
-- 新建两张表：
-- 1) companion_invitation_ledger：页面/target 邀请 ledger（user-private-in-workspace）。
--    每 (workspace_id, user_id, stable_page_context_key) 一行，承载 context/reason
--    双预算键、bounded reason、cooldown epoch、展示/dismiss 终态，以及单事务原子
--    签发的 activeSuggestionLease + 一次性 permit（01-3 §12.5）。budgetKey 唯一索引
--    保证同一 context 预算至多一行原子签发；重复触发/跨设备旧写/迟到 dismiss
--    不得回退终态或重复展示。原始 entity refs 只保留到 TTL（默认 30 天），到期后由
--    清理函数替换为不可逆、content-free 的预算 tombstone（02-4 §3）。
-- 2) companion_audit：Companion page/action 审计（user-private + 短 TTL）。
--    只存 page/action/entity opaque IDs、context/permission hashes、policyVersion、
--    result 与 created_at；不保存整页内容、DOM、截图、凭据或未提交输入（§12.2 §2.2）。
--    30 天默认 TTL（W0 privacy owner 冻结），到期删除或替换 content-free tombstone。
--
-- RLS（0075 风格）：
--   - ledger 属 user-private-in-workspace → workspace_id + user_id 双条件 policy；
--   - audit 属 user-private → 同样使用 workspace_id + user_id 双条件（0075 风格），
--     任一 context 缺失即 fail closed；跨 workspace/user 泄漏为 0。
-- GRANT：ailearn_api 两张表读写；ailearn_worker 不授权（审计/ledger 是 API 面
-- 安全与预算记录，worker 无读取必要，与 account-scoped Companion 表同原则）。
--
-- 幂等：CREATE TABLE/INDEX 用 IF NOT EXISTS，CHECK 用 DO $$ ... EXCEPTION
-- duplicate_object，policy 用 DROP POLICY IF EXISTS + CREATE POLICY，GRANT 按角色
-- 存在性；fresh / upgrade / repeat / restore 全路径安全可重跑。

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- companion_invitation_ledger（workspace-scoped）
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.companion_invitation_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  stable_page_context_key text NOT NULL,
  context_budget_key text NOT NULL,
  reason_budget_key text NOT NULL,
  reason_budget_remaining integer NOT NULL DEFAULT 0,
  bounded_reason text,
  cooldown_epoch integer NOT NULL DEFAULT 0,
  shown_at timestamptz,
  dismissed_at timestamptz,
  suggestion_lease jsonb,
  one_time_permit jsonb,
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.companion_invitation_ledger
    ADD CONSTRAINT companion_invitation_ledger_reason_budget_check
    CHECK (reason_budget_remaining >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.companion_invitation_ledger
    ADD CONSTRAINT companion_invitation_ledger_cooldown_check
    CHECK (cooldown_epoch >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- bounded reason：有界、非空即长度受限（§12.2，不进入画像）。
DO $$ BEGIN
  ALTER TABLE public.companion_invitation_ledger
    ADD CONSTRAINT companion_invitation_ledger_bounded_reason_check
    CHECK (bounded_reason IS NULL OR length(bounded_reason) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

-- 每 user/workspace/页面一行；budgetKey 唯一（01-3 §12.5 双预算）。
CREATE UNIQUE INDEX IF NOT EXISTS companion_invitation_ledger_user_page_unique_idx
  ON public.companion_invitation_ledger (workspace_id, user_id, stable_page_context_key);
CREATE UNIQUE INDEX IF NOT EXISTS companion_invitation_ledger_context_budget_unique_idx
  ON public.companion_invitation_ledger (workspace_id, user_id, context_budget_key);
-- TTL/清理索引（TTL 到期后 tombstone/删除）。
CREATE INDEX IF NOT EXISTS companion_invitation_ledger_cleanup_idx
  ON public.companion_invitation_ledger (workspace_id, user_id, updated_at);
CREATE INDEX IF NOT EXISTS companion_invitation_ledger_tombstone_idx
  ON public.companion_invitation_ledger (tombstoned_at)
  WHERE tombstoned_at IS NOT NULL;

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- companion_audit（user-private + 短 TTL）
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.companion_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  page_action_type text NOT NULL,
  page_opaque_id text,
  action_opaque_id text,
  entity_opaque_ids text[] NOT NULL DEFAULT '{}',
  context_permission_hashes jsonb,
  policy_version text,
  result text,
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.companion_audit
    ADD CONSTRAINT companion_audit_page_action_type_check
    CHECK (page_action_type IN (
      'page_view', 'invitation_shown', 'invitation_dismissed',
      'invitation_permit_issued', 'page_action_confirm', 'onboarding_transition',
      'runtime_fence', 'suppression_change', 'audit_export', 'audit_delete'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.companion_audit
    ADD CONSTRAINT companion_audit_policy_version_check
    CHECK (policy_version IS NULL OR length(policy_version) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.companion_audit
    ADD CONSTRAINT companion_audit_result_check
    CHECK (result IS NULL OR length(result) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

-- TTL/清理 + 用户导出索引（02-4 §4）。
CREATE INDEX IF NOT EXISTS companion_audit_user_created_idx
  ON public.companion_audit (user_id, created_at);
CREATE INDEX IF NOT EXISTS companion_audit_workspace_user_idx
  ON public.companion_audit (workspace_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS companion_audit_tombstone_idx
  ON public.companion_audit (tombstoned_at)
  WHERE tombstoned_at IS NOT NULL;

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- RLS：workspace_id + user_id 双条件（0075 风格，§13.3 + §12.1）
-- ledger 属 user-private-in-workspace；audit 属 user-private（双条件实现）。
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.companion_invitation_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_invitation_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_invitation_ledger_workspace_user_isolation
  ON public.companion_invitation_ledger;
CREATE POLICY companion_invitation_ledger_workspace_user_isolation
  ON public.companion_invitation_ledger FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.companion_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_audit_workspace_user_isolation
  ON public.companion_audit;
CREATE POLICY companion_audit_workspace_user_isolation
  ON public.companion_audit FOR ALL
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
-- least-privilege GRANT（0071/0075 模式：按角色存在性授权）
-- ailearn_api：两张表读写（导出/删除端点依赖 DELETE）；
-- ailearn_worker：不授权（审计/ledger 是 API 面安全与预算记录，worker 无权限）。
-- ════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_invitation_ledger TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_audit TO ailearn_api;
  END IF;
  -- 有意不 GRANT：companion_invitation_ledger / companion_audit 对
  -- ailearn_worker 一律不可见（隐私/安全记录，worker 无读取必要）。
END $$;
