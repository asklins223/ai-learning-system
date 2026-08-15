-- 0138: Card Generation V2 — §18 补表与审查修复（方案 20）
-- ---------------------------------------------------------------------------
-- 依据：docs/evidence/learning-companion/20-learning-card-v2-implementation-review.md
-- 修复项：
--   1) 0135 全部 16 个 RLS 策略补 ailearn_worker 豁免（0116 模式）——
--      worker 以 NOBYPASSRLS 且不设 app.user_id（部分路径连 app.workspace_id
--      也不设，如 outbox claim）直查 V2 表，缺豁免会被策略拦截为 0 行；
--   2) card_content_capability_state（§18.1 epoch 单一权威）；
--   3) card_generation_semantic_specs_v2 / card_generation_input_snapshots_v2
--      （§18.1 immutable 权威表，替代 run 表内联 jsonb）；
--   4) evidence 域四表：evidence_snapshots_v2 / evidence_redactions_v2 /
--      semantic_support_reports_v2 / learning_objective_evidence_bindings_v2（§18.3）；
--   5) equivalence 两表：learning_objective_equivalence_reports_v2 /
--      learning_objective_revision_equivalence_v2（§18.2/§5.4）；
--   6) learning_objective_private_contracts_v2 / learning_objective_lineage_v2（§18.2）；
--   7) learning_exposures_v2（objective-scoped append-only，§18.2/§15.2）；
--   8) card_candidate_quality_reports_v2 / card_candidate_lineage_v2 /
--      card_candidate_feedback_v2（§18.1）；
--   9) card_activation_receipts_v2 幂等键补 user_id（§17.5）；
--  10) evidence_eligibility_states_v2 补 (workspace_id, evidence_snapshot_id)
--      unique 与 FK（§18.5）；
--  11) learning_target_snapshots_v2.run_id FK 改指 learning_runs(id)
--      ON DELETE RESTRICT（§16.1/§18.4），并补 §16.1 缺失列；
--  12) legacy_target_snapshot_attachments_v2 补 §21.3 字段。
-- ---------------------------------------------------------------------------

--> statement-breakpoint

-- ─── 1. RLS ailearn_worker 豁免（0135 策略修正） ─────────────────────────
-- workspace-only 策略补 worker 豁免；workspace+user 策略同样补 worker 豁免。
-- （worker 连接不设 app.user_id，双条件策略会把它挡成 0 行。）

--> statement-breakpoint

ALTER POLICY cg_v2_ws_isolation ON card_generation_runs_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY cgp_v2_ws_isolation ON card_generation_plans_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY cgc_v2_ws_isolation ON card_generation_candidates_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY cge_v2_ws_isolation ON card_generation_events_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY cgro_v2_ws_isolation ON card_generation_run_outbox_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY car_v2_ws_isolation ON card_activation_receipts_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY cebp_v2_ws_isolation ON candidate_evidence_binding_plans_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY ees_v2_ws_isolation ON evidence_eligibility_states_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY lo_v2_ws_isolation ON learning_objectives_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY lo_v2_rev_ws_isolation ON learning_objective_revisions_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY lc_v2_ws_isolation ON learning_cards_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY lc_v2_pub_ws_isolation ON learning_card_publication_revisions_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY lts_v2_ws_isolation ON learning_target_snapshots_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY ltsa_v2_ws_isolation ON legacy_target_snapshot_attachments_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

--> statement-breakpoint

ALTER POLICY ce_v2_ws_isolation ON card_exposure_ledger_v2
  USING (CURRENT_USER = 'ailearn_worker' OR ((workspace_id = (current_setting('app.workspace_id', true))::uuid) AND (user_id = (current_setting('app.user_id', true))::uuid)))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR ((workspace_id = (current_setting('app.workspace_id', true))::uuid) AND (user_id = (current_setting('app.user_id', true))::uuid)));

--> statement-breakpoint

ALTER POLICY ivr_v2_ws_isolation ON initial_validation_reminders_v2
  USING (CURRENT_USER = 'ailearn_worker' OR ((workspace_id = (current_setting('app.workspace_id', true))::uuid) AND (user_id = (current_setting('app.user_id', true))::uuid)))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR ((workspace_id = (current_setting('app.workspace_id', true))::uuid) AND (user_id = (current_setting('app.user_id', true))::uuid)));

--> statement-breakpoint

-- ─── 2. card_content_capability_state（§18.1 epoch 单一权威） ────────────

CREATE TABLE IF NOT EXISTS public.card_content_capability_state (
  workspace_id uuid PRIMARY KEY,
  content_epoch integer NOT NULL CHECK (content_epoch >= 1),
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'live')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  change_receipt text,
  CONSTRAINT ccs_v2_epoch_min CHECK (content_epoch >= 1)
);

ALTER TABLE public.card_content_capability_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY ccs_v2_ws_isolation ON public.card_content_capability_state
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT, UPDATE ON public.card_content_capability_state TO ailearn_api, ailearn_worker;

--> statement-breakpoint

-- ─── 3. Semantic Spec / Input Snapshot 权威表（§18.1 immutable） ────────

CREATE TABLE IF NOT EXISTS public.card_generation_semantic_specs_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  semantic_spec_hash text NOT NULL,
  semantic_spec jsonb NOT NULL,
  version integer NOT NULL DEFAULT 2,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cgss_v2_hash_unique UNIQUE (semantic_spec_hash)
);

ALTER TABLE public.card_generation_semantic_specs_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY cgss_v2_ws_isolation ON public.card_generation_semantic_specs_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.card_generation_semantic_specs_v2 TO ailearn_api, ailearn_worker;

CREATE TABLE IF NOT EXISTS public.card_generation_input_snapshots_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  generation_run_id uuid NOT NULL,
  input_snapshot_hash text NOT NULL,
  input_snapshot jsonb NOT NULL,
  version integer NOT NULL DEFAULT 2,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cgis_v2_run_unique UNIQUE (generation_run_id),
  CONSTRAINT cgis_v2_hash_unique UNIQUE (input_snapshot_hash)
);

ALTER TABLE public.card_generation_input_snapshots_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY cgis_v2_ws_isolation ON public.card_generation_input_snapshots_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.card_generation_input_snapshots_v2 TO ailearn_api, ailearn_worker;

--> statement-breakpoint

-- ─── 4. Evidence 域（§18.3） ─────────────────────────────────────────────

-- 通用 immutable 保护函数（与 0135 同模式）
CREATE OR REPLACE FUNCTION public.prevent_immutable_v2_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable_v2_row: % rows on % cannot be modified',
    TG_OP, TG_TABLE_NAME;
END;
$$;

CREATE TABLE IF NOT EXISTS public.evidence_snapshots_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  evidence_snapshot_id uuid NOT NULL,
  evidence_snapshot_hash text NOT NULL,
  source_snapshot_id uuid NOT NULL,
  note_id uuid,
  block_id uuid,
  start_offset integer NOT NULL DEFAULT 0,
  end_offset integer NOT NULL DEFAULT 0,
  protected_quote_ref text,
  quote_hash text,
  block_content_hash text,
  source_content_hash text NOT NULL,
  modality text NOT NULL DEFAULT 'text' CHECK (modality IN ('text', 'image', 'diagram', 'formula', 'code', 'table')),
  asset_id uuid,
  asset_version_hash text,
  region jsonb,
  page integer,
  protected_extracted_text_ref text,
  extracted_text_hash text,
  support_description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT es_v2_snapshot_unique UNIQUE (evidence_snapshot_id)
);

ALTER TABLE public.evidence_snapshots_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY es_v2_ws_isolation ON public.evidence_snapshots_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.evidence_snapshots_v2 TO ailearn_api, ailearn_worker;

CREATE TRIGGER es_v2_no_update BEFORE UPDATE ON public.evidence_snapshots_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();
CREATE TRIGGER es_v2_no_delete BEFORE DELETE ON public.evidence_snapshots_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();

CREATE TABLE IF NOT EXISTS public.evidence_redactions_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  evidence_snapshot_id uuid NOT NULL REFERENCES public.evidence_snapshots_v2(evidence_snapshot_id) ON DELETE RESTRICT,
  redaction_revision integer NOT NULL CHECK (redaction_revision >= 1),
  scope text NOT NULL CHECK (scope IN ('quote_content', 'extracted_text', 'asset', 'all_content')),
  reason_code text NOT NULL,
  redacted_at timestamptz NOT NULL DEFAULT now(),
  tombstone_hash text NOT NULL
);

ALTER TABLE public.evidence_redactions_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY er_v2_ws_isolation ON public.evidence_redactions_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.evidence_redactions_v2 TO ailearn_api, ailearn_worker;

CREATE TABLE IF NOT EXISTS public.semantic_support_reports_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  report_id uuid NOT NULL,
  candidate_revision_id uuid NOT NULL,
  evidence_snapshot_id uuid NOT NULL,
  report jsonb NOT NULL,
  verdict text NOT NULL,
  report_hash text NOT NULL,
  version integer NOT NULL DEFAULT 2,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ssr_v2_report_unique UNIQUE (workspace_id, report_id)
);

ALTER TABLE public.semantic_support_reports_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY ssr_v2_ws_isolation ON public.semantic_support_reports_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.semantic_support_reports_v2 TO ailearn_api, ailearn_worker;

CREATE TRIGGER ssr_v2_no_update BEFORE UPDATE ON public.semantic_support_reports_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();
CREATE TRIGGER ssr_v2_no_delete BEFORE DELETE ON public.semantic_support_reports_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();

CREATE TABLE IF NOT EXISTS public.learning_objective_evidence_bindings_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  objective_revision_id uuid NOT NULL,
  target_unit_kind text NOT NULL CHECK (target_unit_kind IN ('answer', 'rubric', 'relation', 'learning_support')),
  target_unit_id text,
  evidence_snapshot_id uuid NOT NULL REFERENCES public.evidence_snapshots_v2(evidence_snapshot_id) ON DELETE RESTRICT,
  relation text NOT NULL CHECK (relation IN ('entails', 'defines_boundary', 'supports_example', 'supports_contrast')),
  support_strength text NOT NULL CHECK (support_strength IN ('direct', 'derived')),
  semantic_support_report_id uuid NOT NULL,
  semantic_support_report_hash text NOT NULL,
  derivation_report_id uuid,
  derivation_report_hash text,
  binding_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loeb_v2_binding_unique UNIQUE (workspace_id, binding_id)
);

ALTER TABLE public.learning_objective_evidence_bindings_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY loeb_v2_ws_isolation ON public.learning_objective_evidence_bindings_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.learning_objective_evidence_bindings_v2 TO ailearn_api, ailearn_worker;

CREATE INDEX es_v2_ws_snapshot_idx ON public.evidence_snapshots_v2 (workspace_id, evidence_snapshot_id);

CREATE INDEX loeb_v2_unit_idx ON public.learning_objective_evidence_bindings_v2
  (workspace_id, objective_revision_id, target_unit_kind, target_unit_id);

--> statement-breakpoint

-- ─── 5. Equivalence 两表（§18.2/§5.4） ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.learning_objective_equivalence_reports_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  report_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  prior_objective_revision_id uuid NOT NULL,
  prior_target_revision_hash text NOT NULL,
  proposed_candidate_revision_id uuid NOT NULL,
  proposed_candidate_revision_hash text NOT NULL,
  proposed_semantic_content_hash text NOT NULL,
  proposed_evidence_binding_plan_hash text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('equivalent', 'semantic_change', 'abstain')),
  checks jsonb NOT NULL,
  policy_version text NOT NULL,
  authorized_by text NOT NULL CHECK (authorized_by IN ('deterministic_policy_and_human', 'migration_adjudication')),
  report_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loer_v2_report_unique UNIQUE (report_id)
);

ALTER TABLE public.learning_objective_equivalence_reports_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY loer_v2_ws_isolation ON public.learning_objective_equivalence_reports_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

-- 等价报告为 server-private：API 只读、worker 读写
GRANT SELECT ON public.learning_objective_equivalence_reports_v2 TO ailearn_api;
GRANT SELECT, INSERT ON public.learning_objective_equivalence_reports_v2 TO ailearn_worker;

CREATE INDEX loer_v2_ws_report_idx ON public.learning_objective_equivalence_reports_v2 (workspace_id, report_id);

CREATE TRIGGER loer_v2_no_update BEFORE UPDATE ON public.learning_objective_equivalence_reports_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();
CREATE TRIGGER loer_v2_no_delete BEFORE DELETE ON public.learning_objective_equivalence_reports_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();

CREATE TABLE IF NOT EXISTS public.learning_objective_revision_equivalence_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  report_id uuid NOT NULL REFERENCES public.learning_objective_equivalence_reports_v2(report_id) ON DELETE RESTRICT,
  report_hash text NOT NULL,
  prior_objective_revision_id uuid NOT NULL,
  resulting_objective_revision_id uuid NOT NULL,
  resulting_target_revision_hash text NOT NULL,
  activated_candidate_revision_id uuid NOT NULL,
  evaluated_candidate_evidence_binding_plan_hash text NOT NULL,
  resulting_evidence_binding_set_hash text NOT NULL,
  binding_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lore_v2_report_unique UNIQUE (report_id)
);

ALTER TABLE public.learning_objective_revision_equivalence_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY lore_v2_ws_isolation ON public.learning_objective_revision_equivalence_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT ON public.learning_objective_revision_equivalence_v2 TO ailearn_api;
GRANT SELECT, INSERT ON public.learning_objective_revision_equivalence_v2 TO ailearn_worker;

--> statement-breakpoint

-- ─── 6. Private Contracts / Objective Lineage（§18.2） ──────────────────

CREATE TABLE IF NOT EXISTS public.learning_objective_private_contracts_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  objective_revision_id uuid NOT NULL,
  canonical_answer jsonb NOT NULL,
  learning_support jsonb NOT NULL,
  scoring_rubric jsonb NOT NULL,
  private_payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lopc_v2_rev_unique UNIQUE (objective_revision_id)
);

ALTER TABLE public.learning_objective_private_contracts_v2 ENABLE ROW LEVEL SECURITY;

-- server-private：ailearn_api 无任何访问（§22.1）
CREATE POLICY lopc_v2_ws_isolation ON public.learning_objective_private_contracts_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.learning_objective_private_contracts_v2 TO ailearn_worker;

CREATE TABLE IF NOT EXISTS public.learning_objective_lineage_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  predecessor_revision_id uuid NOT NULL,
  successor_revision_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('edit', 'merge', 'split', 'supersede')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lol_v2_no_self CHECK (predecessor_revision_id <> successor_revision_id)
);

ALTER TABLE public.learning_objective_lineage_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY lol_v2_ws_isolation ON public.learning_objective_lineage_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.learning_objective_lineage_v2 TO ailearn_api, ailearn_worker;

CREATE INDEX lol_v2_pred_idx ON public.learning_objective_lineage_v2 (workspace_id, predecessor_revision_id);
CREATE INDEX lol_v2_succ_idx ON public.learning_objective_lineage_v2 (workspace_id, successor_revision_id);

--> statement-breakpoint

-- ─── 7. learning_exposures_v2（objective-scoped append-only，§15.2/§18.2） ──

CREATE TABLE IF NOT EXISTS public.learning_exposures_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  exposure_id uuid NOT NULL,
  user_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  objective_revision integer NOT NULL,
  card_id uuid,
  card_revision integer,
  exposure_kind text NOT NULL CHECK (exposure_kind IN ('answer_reveal', 'evidence_reveal', 'answer_editor_view')),
  context_hash text NOT NULL,
  idempotency_key text NOT NULL,
  source_candidate_exposure_id uuid,
  exposed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lex_v2_exposure_unique UNIQUE (workspace_id, exposure_id),
  CONSTRAINT lex_v2_idem_unique UNIQUE (workspace_id, user_id, idempotency_key)
);

ALTER TABLE public.learning_exposures_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY lex_v2_ws_isolation ON public.learning_exposures_v2
  USING (CURRENT_USER = 'ailearn_worker' OR ((workspace_id = (current_setting('app.workspace_id', true))::uuid) AND (user_id = (current_setting('app.user_id', true))::uuid)))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR ((workspace_id = (current_setting('app.workspace_id', true))::uuid) AND (user_id = (current_setting('app.user_id', true))::uuid)));

GRANT SELECT, INSERT ON public.learning_exposures_v2 TO ailearn_api, ailearn_worker;

CREATE INDEX lex_v2_obj_idx ON public.learning_exposures_v2 (workspace_id, user_id, objective_id, exposed_at DESC, id);

CREATE TRIGGER lex_v2_no_update BEFORE UPDATE ON public.learning_exposures_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();
CREATE TRIGGER lex_v2_no_delete BEFORE DELETE ON public.learning_exposures_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();

--> statement-breakpoint

-- ─── 8. Candidate 质量报告 / lineage / feedback（§18.1） ────────────────

CREATE TABLE IF NOT EXISTS public.card_candidate_quality_reports_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  candidate_revision_id uuid NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('grounding', 'pedagogy', 'semantic_support')),
  input_hash text NOT NULL,
  report jsonb NOT NULL,
  verdict text NOT NULL,
  gate_version text NOT NULL,
  report_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.card_candidate_quality_reports_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY ccqr_v2_ws_isolation ON public.card_candidate_quality_reports_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.card_candidate_quality_reports_v2 TO ailearn_api, ailearn_worker;

CREATE INDEX ccqr_v2_rev_idx ON public.card_candidate_quality_reports_v2 (workspace_id, candidate_revision_id);

CREATE TRIGGER ccqr_v2_no_update BEFORE UPDATE ON public.card_candidate_quality_reports_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();
CREATE TRIGGER ccqr_v2_no_delete BEFORE DELETE ON public.card_candidate_quality_reports_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();

CREATE TABLE IF NOT EXISTS public.card_candidate_lineage_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  parent_revision_id uuid NOT NULL,
  child_revision_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('edit', 'merge', 'split', 'repair')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ccl_v2_no_self CHECK (parent_revision_id <> child_revision_id)
);

ALTER TABLE public.card_candidate_lineage_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY ccl_v2_ws_isolation ON public.card_candidate_lineage_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.card_candidate_lineage_v2 TO ailearn_api, ailearn_worker;

CREATE INDEX ccl_v2_parent_idx ON public.card_candidate_lineage_v2 (workspace_id, parent_revision_id);
CREATE INDEX ccl_v2_child_idx ON public.card_candidate_lineage_v2 (workspace_id, child_revision_id);

CREATE TABLE IF NOT EXISTS public.card_candidate_feedback_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  action text NOT NULL,
  reason_code text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.card_candidate_feedback_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY ccf_v2_ws_isolation ON public.card_candidate_feedback_v2
  USING (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid))
  WITH CHECK (CURRENT_USER = 'ailearn_worker' OR (workspace_id = (current_setting('app.workspace_id', true))::uuid));

GRANT SELECT, INSERT ON public.card_candidate_feedback_v2 TO ailearn_api, ailearn_worker;

CREATE INDEX ccf_v2_run_idx ON public.card_candidate_feedback_v2 (workspace_id, run_id);

--> statement-breakpoint

-- ─── 9. Activation Receipt 幂等键补 user_id（§17.5） ─────────────────────

DROP INDEX IF EXISTS public.car_v2_ws_idem_idx;
CREATE UNIQUE INDEX car_v2_ws_user_idem_idx ON public.card_activation_receipts_v2 (workspace_id, user_id, idempotency_key);

--> statement-breakpoint

-- ─── 10. Evidence Eligibility 唯一约束 + FK（§18.5） ───────────────────

DROP INDEX IF EXISTS public.ees_v2_ws_snapshot_idx;
CREATE UNIQUE INDEX ees_v2_ws_snapshot_unique ON public.evidence_eligibility_states_v2 (workspace_id, evidence_snapshot_id);

ALTER TABLE public.evidence_eligibility_states_v2
  ADD CONSTRAINT ees_v2_snapshot_fk FOREIGN KEY (evidence_snapshot_id)
  REFERENCES public.evidence_snapshots_v2(evidence_snapshot_id) ON DELETE RESTRICT;

--> statement-breakpoint

-- ─── 11. LearningTargetSnapshot：FK 改指 learning_runs + §16.1 缺失列 ───

ALTER TABLE public.learning_target_snapshots_v2
  DROP CONSTRAINT IF EXISTS learning_target_snapshots_v2_run_id_fkey;

ALTER TABLE public.learning_target_snapshots_v2
  ADD CONSTRAINT lts_v2_run_fk FOREIGN KEY (run_id)
  REFERENCES public.learning_runs(id) ON DELETE RESTRICT;

ALTER TABLE public.learning_target_snapshots_v2
  ADD COLUMN user_id uuid,
  ADD COLUMN card_id uuid,
  ADD COLUMN publication_revision integer,
  ADD COLUMN card_revision integer,
  ADD COLUMN public_payload_hash text,
  ADD COLUMN reveal_payload_hash text,
  ADD COLUMN evidence_binding_set_hash text,
  ADD COLUMN evidence_eligibility_vector_hash text,
  ADD COLUMN planning_exposure jsonb,
  ADD COLUMN lifecycle_at_prepare text,
  ADD COLUMN published_target_eligibility text,
  ADD COLUMN prepared_at timestamptz,
  ADD COLUMN target_snapshot_policy_version text;

--> statement-breakpoint

-- ─── 12. Legacy Attachment §21.3 字段 ───────────────────────────────────

ALTER TABLE public.legacy_target_snapshot_attachments_v2
  ADD COLUMN mapped_objective_id uuid,
  ADD COLUMN source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN integrity_class text NOT NULL DEFAULT 'unverifiable'
    CHECK (integrity_class IN ('verified_source_only', 'partial_source', 'unverifiable')),
  ADD COLUMN backfilled_at timestamptz;
