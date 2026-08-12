-- 0100: worker generation-pipeline RLS exemption（既有问题修复，2026-08-11）。
--
-- 背景：0044/0045/0070 对 card_generation_runs/units/candidates/
-- candidate_evidence/plans 启用 RLS（ENABLE + FORCE，唯一策略是
-- workspace_id = app.workspace_id 单条件），但**未给 ailearn_worker 任何
-- 豁免**。worker 是跨 workspace 的队列消费者与对账器（claim 任意 workspace
-- 的 job、reconciler/specialist-persist 对账补投、metrics 统计），代码里约
-- 85 处对这几张表的访问均为裸 db 查询（无 app.workspace_id GUC）。
-- 生产角色 ailearn_worker（NOBYPASSRLS）下这些访问被 RLS 拦成 0 行/抛错，
-- 对账/补投/指标功能静默失效；测试环境用 superuser 连接（BYPASSRLS）掩盖了
-- 该问题。
--
-- 修复：为这 5 张内部生成流水线表增加 worker 角色豁免的 PERMISSIVE 策略
--（与 workspace_isolation PERMISSIVE 策略 OR 合并）。这是恢复 0044/0045
-- 时代的实际行为（worker 全量访问内部流水线数据）。注意：这些表含用户笔记
-- 的**派生明文**（runs.title_snapshot/block_manifest、units.input_manifest/
-- artifact_json、candidates.claim/topic、plans.plan_json 等），豁免后 worker
-- 可跨 workspace 无 GUC 读写；worker 为内部可信角色且这些是派生数据（非源
-- note 本体），风险 LOW–MEDIUM，若后续收紧需先收口对账路径的 GUC 访问。
-- jobs 表因含租约/请求者语义仍保持 0098 的函数化收紧，二者不冲突。
--
-- 同时补齐两处权限缺口：card_generation_plans 的 worker 权限（0070 未授、
-- 0071 已授 SELECT,INSERT；0100 的 GRANT SELECT 为幂等兜底）、
-- candidate_evidence 缺 DELETE（candidate-ledger 删除证据路径）。
-- 所有策略块均带 ailearn_worker 角色存在检查（fresh 库 roles.sql 先建角色）。

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    EXECUTE $policy$
      CREATE POLICY card_generation_runs_worker_all
        ON public.card_generation_runs FOR ALL TO ailearn_worker
        USING (CURRENT_USER = 'ailearn_worker')
        WITH CHECK (CURRENT_USER = 'ailearn_worker')
    $policy$;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    EXECUTE $policy$
      CREATE POLICY card_generation_units_worker_all
        ON public.card_generation_units FOR ALL TO ailearn_worker
        USING (CURRENT_USER = 'ailearn_worker')
        WITH CHECK (CURRENT_USER = 'ailearn_worker')
    $policy$;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    EXECUTE $policy$
      CREATE POLICY card_generation_candidates_worker_all
        ON public.card_generation_candidates FOR ALL TO ailearn_worker
        USING (CURRENT_USER = 'ailearn_worker')
        WITH CHECK (CURRENT_USER = 'ailearn_worker')
    $policy$;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    EXECUTE $policy$
      CREATE POLICY card_generation_candidate_evidence_worker_all
        ON public.card_generation_candidate_evidence FOR ALL TO ailearn_worker
        USING (CURRENT_USER = 'ailearn_worker')
        WITH CHECK (CURRENT_USER = 'ailearn_worker')
    $policy$;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    EXECUTE $policy$
      CREATE POLICY card_generation_plans_worker_all
        ON public.card_generation_plans FOR ALL TO ailearn_worker
        USING (CURRENT_USER = 'ailearn_worker')
        WITH CHECK (CURRENT_USER = 'ailearn_worker')
    $policy$;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

-- 权限补齐（策略豁免的前提是表级权限存在）：
-- plans 从未 GRANT worker（0070 遗漏）；candidate_evidence 缺 DELETE。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    IF to_regclass('public.card_generation_plans') IS NOT NULL THEN
      GRANT SELECT ON TABLE public.card_generation_plans TO ailearn_worker;
    END IF;
    IF to_regclass('public.card_generation_candidate_evidence') IS NOT NULL THEN
      GRANT DELETE ON TABLE public.card_generation_candidate_evidence TO ailearn_worker;
    END IF;
  END IF;
END $$;
