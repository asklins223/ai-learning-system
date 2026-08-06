-- 0052: Supervisor Agent v1 Schema (Expand Phase)
-- 计划 §9, §10: 数据模型与基础设施迁移
-- 此迁移属于 expand → verify → cutover → contract 中的 expand 阶段
-- Agent routing 关闭时旧 v2 正常运行，plain PG 在部署前明确失败

-- ─── 1. pgvector extension（计划 §7.4, §10.1） ──────────────────────────
-- 断言 vector type 存在，再创建表
-- fresh DB 由 init 脚本创建 extension，现有 volume 由管理员 bootstrap
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── 2. card_generation_runs 扩展（计划 §9.1） ──────────────────────────
-- 新增 Supervisor Agent 相关字段
ALTER TABLE card_generation_runs
  ADD COLUMN IF NOT EXISTS engine_mode text NOT NULL DEFAULT 'supervisor_agent_v1',
  ADD COLUMN IF NOT EXISTS shell_version text,
  ADD COLUMN IF NOT EXISTS supervisor_policy_version text,
  ADD COLUMN IF NOT EXISTS tool_schema_version text,
  ADD COLUMN IF NOT EXISTS planner_version text,
  ADD COLUMN IF NOT EXISTS verifier_version text,
  ADD COLUMN IF NOT EXISTS retrieval_policy_version text,
  ADD COLUMN IF NOT EXISTS embedding_profile_version text,
  ADD COLUMN IF NOT EXISTS result_contract_version text NOT NULL DEFAULT 'result-contract-v1',
  ADD COLUMN IF NOT EXISTS provider_capability_fingerprint text,
  ADD COLUMN IF NOT EXISTS budget_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS usage_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS verified_draft_id uuid,
  ADD COLUMN IF NOT EXISTS verified_draft_hash text,
  ADD COLUMN IF NOT EXISTS quality_report_id uuid,
  ADD COLUMN IF NOT EXISTS degraded_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 用 result_contract_version 替换只针对 pipeline_version=v2-m5 的终态完整性 CHECK
-- 旧 m5 check 保留兼容，新 check 覆盖 supervisor_agent_v1
ALTER TABLE card_generation_runs
  DROP CONSTRAINT IF EXISTS card_generation_runs_m5_terminal_result_check;

ALTER TABLE card_generation_runs
  ADD CONSTRAINT card_generation_runs_result_contract_check CHECK (
    result_contract_version <> 'result-contract-v1'
    OR status NOT IN ('succeeded', 'partial_ready')
    OR (
      result_card_set_id IS NOT NULL
      AND result_card_id IS NOT NULL
    )
  );

-- 回填历史 engine/result contract（不把旧 run 伪装成 Agent）
UPDATE card_generation_runs
  SET engine_mode = 'supervisor_agent_v1',
      result_contract_version = 'result-contract-v1'
  WHERE engine_mode IS NULL OR engine_mode = '';

-- ─── 3. card_generation_units 扩展（计划 §9.2） ─────────────────────────
-- 泛化为 durable checkpoint，Agent 路径只使用粗粒度 kind

-- 更新 kind check 约束，添加 Agent 单元类型
ALTER TABLE card_generation_units
  DROP CONSTRAINT IF EXISTS card_generation_units_kind_check;
ALTER TABLE card_generation_units
  ADD CONSTRAINT card_generation_units_kind_check
  CHECK (kind = ANY (ARRAY[
    'planner'::text, 'image'::text, 'text_map'::text, 'section_reduce'::text,
    'deck_plan'::text, 'card_render'::text, 'verify'::text, 'publish'::text,
    'prepare'::text, 'agent_run'::text, 'deterministic_verify'::text
  ]));

ALTER TABLE card_generation_units
  ADD COLUMN IF NOT EXISTS node_contract_version text,
  ADD COLUMN IF NOT EXISTS budget_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cursor_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS retry_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 新增 (workspace_id, run_id, unit_key) 唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_units_run_unit_key_unique_idx
  ON card_generation_units (workspace_id, run_id, unit_key);

-- 更新 note_evidence_spans source_kind 约束，添加 Agent 路径类型
ALTER TABLE note_evidence_spans
  DROP CONSTRAINT IF EXISTS note_evidence_spans_source_kind_check;
ALTER TABLE note_evidence_spans
  ADD CONSTRAINT note_evidence_spans_source_kind_check
  CHECK (source_kind = ANY (ARRAY[
    'text'::text, 'list'::text, 'code'::text,
    'text_span'::text, 'image'::text, 'heading'::text, 'quote'::text
  ]));

-- 更新 card_generation_runs status 约束，添加 Agent 路径状态
ALTER TABLE card_generation_runs
  DROP CONSTRAINT IF EXISTS card_generation_runs_status_check;
ALTER TABLE card_generation_runs
  ADD CONSTRAINT card_generation_runs_status_check
  CHECK (status = ANY (ARRAY[
    'queued'::text, 'planning'::text, 'awaiting_assets'::text, 'mapping'::text,
    'reducing'::text, 'rendering'::text, 'validating'::text, 'publishing'::text,
    'needs_attention'::text, 'partial_ready'::text, 'succeeded'::text,
    'cancelled'::text, 'superseded'::text,
    'running'::text, 'agent_running'::text, 'verifying'::text
  ]));

-- ─── 4. card_generation_agent_events（计划 §9.3） ────────────────────────
-- 一张 append-only 表统一承载所有 Agent 事件
CREATE TABLE IF NOT EXISTS card_generation_agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES card_generation_runs(id) ON DELETE CASCADE,
  unit_id uuid REFERENCES card_generation_units(id) ON DELETE CASCADE,
  parent_unit_id uuid,
  child_unit_id uuid,
  event_key text NOT NULL,
  event_type text NOT NULL,
  agent_role text,
  turn_no integer,
  attempt_no integer,
  tool_name text,
  tool_version text,
  input_hash text,
  output_hash text,
  safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_request_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_agent_events_event_key_unique_idx
  ON card_generation_agent_events (workspace_id, run_id, event_key);

CREATE INDEX IF NOT EXISTS card_generation_agent_events_workspace_run_idx
  ON card_generation_agent_events (workspace_id, run_id, created_at);

CREATE INDEX IF NOT EXISTS card_generation_agent_events_unit_idx
  ON card_generation_agent_events (workspace_id, run_id, unit_id, turn_no);

-- ─── 5. card_generation_source_bundles（计划 §9.4） ─────────────────────
-- Source Bundle Ledger：语义上下文 bundle 和 coverage decision
CREATE TABLE IF NOT EXISTS card_generation_source_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES card_generation_runs(id) ON DELETE CASCADE,
  note_version_id uuid NOT NULL,
  bundle_key text NOT NULL,
  bundle_ordinal integer NOT NULL,
  section_path jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_start_ordinal integer NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0,
  input_hash text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  assignment_status text NOT NULL DEFAULT 'pending',
  assigned_agent_unit_id uuid,
  decision_status text NOT NULL DEFAULT 'pending',
  decision_reason text,
  decided_event_key text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_source_bundles_workspace_id_unique_idx
  ON card_generation_source_bundles (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_source_bundles_run_key_unique_idx
  ON card_generation_source_bundles (workspace_id, run_id, bundle_key);

CREATE INDEX IF NOT EXISTS card_generation_source_bundles_run_ordinal_idx
  ON card_generation_source_bundles (workspace_id, run_id, bundle_ordinal);

CREATE INDEX IF NOT EXISTS card_generation_source_bundles_assignment_idx
  ON card_generation_source_bundles (workspace_id, run_id, assignment_status, bundle_ordinal);

-- ─── 6. card_generation_source_bundle_members（计划 §9.4） ──────────────
-- typed text/image evidence reference，primary | context_only
CREATE TABLE IF NOT EXISTS card_generation_source_bundle_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES card_generation_runs(id) ON DELETE CASCADE,
  bundle_id uuid NOT NULL REFERENCES card_generation_source_bundles(id) ON DELETE CASCADE,
  member_ordinal integer NOT NULL,
  evidence_ref_type text NOT NULL,
  evidence_span_id uuid REFERENCES note_evidence_spans(id) ON DELETE CASCADE,
  image_evidence_unit_id uuid REFERENCES note_image_evidence_units(id) ON DELETE CASCADE,
  membership text NOT NULL DEFAULT 'primary',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- XOR CHECK：text span 和 image evidence 只能有一个
  CONSTRAINT card_generation_source_bundle_members_xor_check CHECK (
    (evidence_span_id IS NOT NULL)::integer +
    (image_evidence_unit_id IS NOT NULL)::integer = 1
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_source_bundle_members_workspace_id_unique_idx
  ON card_generation_source_bundle_members (workspace_id, id);

CREATE INDEX IF NOT EXISTS card_generation_source_bundle_members_bundle_idx
  ON card_generation_source_bundle_members (workspace_id, run_id, bundle_id, member_ordinal);

-- partial unique index 保证同 run 的 atomic source 只有一个 primary owner
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_source_bundle_members_primary_span_unique_idx
  ON card_generation_source_bundle_members (run_id, evidence_span_id)
  WHERE evidence_span_id IS NOT NULL AND membership = 'primary';

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_source_bundle_members_primary_image_unique_idx
  ON card_generation_source_bundle_members (run_id, image_evidence_unit_id)
  WHERE image_evidence_unit_id IS NOT NULL AND membership = 'primary';

-- ─── 7. card_generation_drafts（计划 §9.6） ─────────────────────────────
-- Immutable Draft：只插入，不原地更新
CREATE TABLE IF NOT EXISTS card_generation_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES card_generation_runs(id) ON DELETE CASCADE,
  draft_version integer NOT NULL,
  parent_draft_id uuid REFERENCES card_generation_drafts(id) ON DELETE SET NULL,
  produced_by_unit_id uuid NOT NULL,
  produced_by_event_key text NOT NULL,
  schema_version text NOT NULL,
  content_json jsonb NOT NULL,
  content_hash text NOT NULL,
  deck_title text NOT NULL,
  deck_summary text NOT NULL,
  density text NOT NULL DEFAULT 'standard',
  card_budget integer NOT NULL,
  base_ledger_hash text NOT NULL,
  summary_support_candidate_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_drafts_workspace_id_unique_idx
  ON card_generation_drafts (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_drafts_run_version_unique_idx
  ON card_generation_drafts (workspace_id, run_id, draft_version);

CREATE INDEX IF NOT EXISTS card_generation_drafts_run_hash_idx
  ON card_generation_drafts (workspace_id, run_id, content_hash);

-- ─── 8. card_generation_quality_reports（计划 §9.6） ────────────────────
-- Quality Report：Repair 后创建新 Draft，旧 report 自动失效
CREATE TABLE IF NOT EXISTS card_generation_quality_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES card_generation_runs(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES card_generation_drafts(id) ON DELETE CASCADE,
  draft_hash text NOT NULL,
  candidate_pool_hash text NOT NULL,
  source_ledger_hash text NOT NULL,
  critic_version text NOT NULL,
  verifier_version text NOT NULL,
  hard_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  soft_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  per_claim_verdicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  critic_status text NOT NULL DEFAULT 'pending',
  deterministic_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_quality_reports_workspace_id_unique_idx
  ON card_generation_quality_reports (workspace_id, id);

CREATE INDEX IF NOT EXISTS card_generation_quality_reports_draft_hash_idx
  ON card_generation_quality_reports (workspace_id, run_id, draft_hash);

-- ─── 9. note_evidence_embeddings（计划 §7.4, §9.7） ─────────────────────
-- 固定 vector(D) profile，typed source ref、source/input hash、model revision
CREATE TABLE IF NOT EXISTS note_evidence_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  note_version_id uuid NOT NULL,
  evidence_ref_type text NOT NULL,
  evidence_span_id uuid REFERENCES note_evidence_spans(id) ON DELETE CASCADE,
  image_evidence_unit_id uuid REFERENCES note_image_evidence_units(id) ON DELETE CASCADE,
  candidate_id uuid,
  bundle_id uuid,
  source_hash text NOT NULL,
  input_hash text NOT NULL,
  model_revision text NOT NULL,
  dimensions integer NOT NULL,
  embedding vector(1024) NOT NULL,
  profile_version text NOT NULL DEFAULT 'card-evidence-v1',
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- XOR CHECK
  CONSTRAINT note_evidence_embeddings_xor_check CHECK (
    (evidence_span_id IS NOT NULL)::integer +
    (image_evidence_unit_id IS NOT NULL)::integer +
    (candidate_id IS NOT NULL)::integer +
    (bundle_id IS NOT NULL)::integer = 1
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS note_evidence_embeddings_workspace_id_unique_idx
  ON note_evidence_embeddings (workspace_id, id);

CREATE INDEX IF NOT EXISTS note_evidence_embeddings_version_profile_idx
  ON note_evidence_embeddings (workspace_id, note_version_id, profile_version, status);

CREATE INDEX IF NOT EXISTS note_evidence_embeddings_source_hash_idx
  ON note_evidence_embeddings (workspace_id, note_version_id, source_hash);

-- ─── 10. card_generation_candidates 扩展（计划 §9.5） ───────────────────
-- Agent 路径新增字段
ALTER TABLE card_generation_candidates
  ADD COLUMN IF NOT EXISTS candidate_kind text NOT NULL DEFAULT 'extracted',
  ADD COLUMN IF NOT EXISTS source_start_ordinal integer,
  ADD COLUMN IF NOT EXISTS section_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS primary_section text,
  ADD COLUMN IF NOT EXISTS origin_agent_event_key text,
  ADD COLUMN IF NOT EXISTS derived_candidate_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS relation_hints jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS quality_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS importance_score double precision,
  ADD COLUMN IF NOT EXISTS group_key text,
  ADD COLUMN IF NOT EXISTS overview_score double precision,
  ADD COLUMN IF NOT EXISTS support_mode text,
  ADD COLUMN IF NOT EXISTS semantic_support_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS semantic_support_score_bps integer,
  ADD COLUMN IF NOT EXISTS verifier_version text,
  ADD COLUMN IF NOT EXISTS quality_report_id uuid;

CREATE INDEX IF NOT EXISTS card_generation_candidates_run_kind_idx
  ON card_generation_candidates (workspace_id, run_id, candidate_kind, validation_status);

-- ─── 11. 证据来源真实性与语义支撑拆层（计划 §7.3, §9.7） ─────────────────
-- Canonical evidence 增加来源验证和语义支撑字段
ALTER TABLE card_generation_candidate_evidence
  ADD COLUMN IF NOT EXISTS source_verification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS source_verification_method text,
  ADD COLUMN IF NOT EXISTS semantic_support_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS semantic_support_score_bps integer,
  ADD COLUMN IF NOT EXISTS verifier_version text,
  ADD COLUMN IF NOT EXISTS quality_report_id uuid;

-- ─── 12. jobs per-job retry policy（计划 §9.8） ──────────────────────────
-- 全局固定三次、2s/4s 不能同时处理 transport、协议、业务和 budget 错误
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS max_attempts integer,
  ADD COLUMN IF NOT EXISTS retry_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS retry_after_at timestamptz;

-- ─── 13. card_generation_runs 六层 coverage report 索引 ──────────────────
-- coverage_report jsonb 现在存储六层结构化数据
-- 已有 coverage_report 字段，只需确保索引存在
CREATE INDEX IF NOT EXISTS card_generation_runs_engine_mode_idx
  ON card_generation_runs (workspace_id, engine_mode, status, updated_at);
