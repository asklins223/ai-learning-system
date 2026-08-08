-- 0077: 阶段 02（W1）任务 02-8 —— learning_unit_exposure aggregate/guard（§7.6）
--
-- 新建两张表：
-- 1) learning_unit_exposure：learning-unit 的 exposure 生命周期 aggregate。
--    每 (workspace_id, user_id, content_exposure_key) 一行（content_exposure_key
--    由 workspaceId+userId+keyPointId+publishedContentRevision+normalizedClaimHash+
--    sortedEvidenceContentHashes 哈希得到，不含 Scene/rubric/provider/model/
--    assistance policy 版本，见 exposure-service.computeContentExposureKey）。
--    旧 question-first 与新 Episode 的 reveal/lock/submit 读写**同一行**，跨页面、
--    设备、Session、Scene/policy rollover 和重开不重置（01-2 §10.2）。
--    assistance_snapshot 是 lock 先赢时冻结的 pre-exposure snapshot（后续 reveal
--    不追溯污染已锁 artifact）；practice_only_since 表达 assistance 先赢后的
--    practice-only 态（之后 lock 必须看到 practice-only）。revision 乐观并发递增。
-- 2) learning_exposure_dependency_ledger：确定性 dependency ledger。共享 evidence
--    使 source → affected content exposure key 之间建立 dependency 边，同一条边
--    幂等（source+affected+sharedEvidenceRef 唯一），传播按确定性顺序执行。
--
-- RLS（0075/0076 风格）：两表均属 workspace-scoped learning 过程表，使用
-- workspace_id + user_id 双条件 policy；任一 context 缺失（NULLIF(...) IS NULL）
-- 即 fail closed。
-- GRANT：ailearn_api 两表读写；ailearn_worker 仅学习过程表最小权限
-- （SELECT/INSERT/UPDATE，无 DELETE，删除语义由 redaction/status 表达）。
--
-- 幂等：CREATE TABLE/INDEX 用 IF NOT EXISTS，policy 用 DROP POLICY IF EXISTS +
-- CREATE POLICY，GRANT 按角色存在性；fresh / upgrade / repeat / restore 全路径安全。

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- learning_unit_exposure（workspace-scoped learning 过程 aggregate）
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.learning_unit_exposure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 稳定 exposure 键（公式冻结，不含 Scene/rubric/provider/model/policy 版本）。
  content_exposure_key text NOT NULL,
  -- lock 先赢冻结的 pre-exposure snapshot；assistance 先赢时也记录降级 snapshot。
  assistance_snapshot jsonb,
  -- 已锁 artifact 的 opaque ref（01-2 §6.2 artifact lock 的 exposure 侧引用）。
  locked_artifact_ref text,
  last_revealed_at timestamptz,
  last_locked_at timestamptz,
  -- assistance 先赢：提供内容性辅助的时间点。
  assisted_at timestamptz,
  -- practice-only 生效时间点：存在即后续 lock 只见 practice-only。
  practice_only_since timestamptz,
  -- reveal 后的冷却截止；冷却期内不再返回内容性揭示。
  cooldown_until timestamptz,
  -- 累计 reveal 次数（单调递增，跨入口共享，不重置）。
  exposure_count integer NOT NULL DEFAULT 0,
  -- 乐观并发版本：每次写入递增，请求须携带 baseRevision（01-3 §2.3 CAS）。
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- content_exposure_key 在 workspace 内唯一：旧/新入口、跨 Session/rollover 都
-- 命中同一行（"每 user+workspace 至多一个当前 exposure" 由键唯一性兜底）。
CREATE UNIQUE INDEX IF NOT EXISTS learning_unit_exposure_key_unique_idx
  ON public.learning_unit_exposure (workspace_id, content_exposure_key);
-- user+workspace 查询路径（guard 主查询）。
CREATE INDEX IF NOT EXISTS learning_unit_exposure_workspace_user_idx
  ON public.learning_unit_exposure (workspace_id, user_id);
-- 冷却/重开持久查询。
CREATE INDEX IF NOT EXISTS learning_unit_exposure_cooldown_idx
  ON public.learning_unit_exposure (workspace_id, user_id, cooldown_until);

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- learning_exposure_dependency_ledger（确定性 dependency ledger）
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.learning_exposure_dependency_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_content_exposure_key text NOT NULL,
  affected_content_exposure_key text NOT NULL,
  -- 共享 evidence 引用（确定性内容 hash 或 ref），同一条边的幂等键。
  shared_evidence_ref text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- 同一条边幂等：source + affected + evidence 唯一（确定性 ledger 语义）。
CREATE UNIQUE INDEX IF NOT EXISTS learning_exposure_dependency_edge_unique_idx
  ON public.learning_exposure_dependency_ledger
  (workspace_id, source_content_exposure_key, affected_content_exposure_key, shared_evidence_ref);
-- 反向查询：某 affected key 的所有 source（传播入口）。
CREATE INDEX IF NOT EXISTS learning_exposure_dependency_affected_idx
  ON public.learning_exposure_dependency_ledger (workspace_id, affected_content_exposure_key);
-- 正向查询：某 source 影响的所有 keys（传播出口）。
CREATE INDEX IF NOT EXISTS learning_exposure_dependency_source_idx
  ON public.learning_exposure_dependency_ledger (workspace_id, source_content_exposure_key);

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- RLS：workspace_id + user_id 双条件（0075 风格，§13.3）
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.learning_unit_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_unit_exposure FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_unit_exposure_workspace_user_isolation
  ON public.learning_unit_exposure;
CREATE POLICY learning_unit_exposure_workspace_user_isolation
  ON public.learning_unit_exposure FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.learning_exposure_dependency_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_exposure_dependency_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_exposure_dependency_ledger_workspace_user_isolation
  ON public.learning_exposure_dependency_ledger;
DROP POLICY IF EXISTS learning_exposure_dependency_ledger_workspace_isolation
  ON public.learning_exposure_dependency_ledger;
-- 救火 2（审计迁移阻塞修复）：ledger 表无 user_id 列（workspace 级共享边），
-- policy 改为 workspace_id 单条件（§13.3 workspace-scoped 语义）。
CREATE POLICY learning_exposure_dependency_ledger_workspace_isolation
  ON public.learning_exposure_dependency_ledger FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- least-privilege GRANT（0071/0075 模式：按角色存在性授权）
-- ailearn_api：两表读写；ailearn_worker：学习过程表最小权限
-- （SELECT/INSERT/UPDATE，无 DELETE）。
-- ════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_unit_exposure TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_exposure_dependency_ledger TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON public.learning_unit_exposure TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.learning_exposure_dependency_ledger TO ailearn_worker;
  END IF;
END $$;
