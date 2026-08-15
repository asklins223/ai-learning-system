-- 0135: Card Generation V2 核心数据底座
-- docs/plans/learning-companion/20-learning-card-v2-value-first-generation-and-learning-target-rebase.md
--
-- §18 数据库模式：V2 generation runs、candidates、plans、objectives、cards、
-- evidence、exposure、reminders、activation receipts 和 outbox 事件。
--
-- 设计原则（§1.4/§9.5/§11.4/§13.3/§15/§16/§17）：
-- - 所有业务表以 (workspace_id, id) 支持 scope 查询
-- - Candidate 三态分离（quality_state / review_decision / publish_state）
-- - review_ready 是派生视图，不是可独立写入的状态字段
-- - 答案/rubric/private evidence 不进入 public 列或索引
-- - (workspace_id, idempotency_key) unique 防重复创建
-- - RLS: workspace+user 双条件 + ailearn_worker 豁免

--> statement-breakpoint

-- ─── §17.2 Generation Run ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.card_generation_runs_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  note_version_id uuid NOT NULL REFERENCES public.note_versions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  card_content_epoch integer NOT NULL DEFAULT 1,
  semantic_spec_hash text NOT NULL,
  input_snapshot_hash text NOT NULL,
  generation_fingerprint text NOT NULL,
  source_snapshot_hash text NOT NULL,
  source_content_hash text NOT NULL,
  block_manifest_hash text NOT NULL,
  asset_manifest_hash text NOT NULL,
  scope_manifest_hash text NOT NULL,
  current_plan_version integer NOT NULL DEFAULT 0,
  review_draft_revision integer NOT NULL DEFAULT 1,
  semantic_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  supersedes_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cg_v2_status_chk CHECK (
    status IN ('queued','source_sealing','planning','authoring','checking',
              'review_ready','no_cards_recommended','needs_attention',
              'activating','activated','closed_without_activation',
              'failed','cancelled','stale')
  ),
  CONSTRAINT cg_v2_epoch_chk CHECK (card_content_epoch >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS cg_v2_ws_idempotency_idx
  ON public.card_generation_runs_v2 (workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS cg_v2_ws_id_idx
  ON public.card_generation_runs_v2 (workspace_id, id);
CREATE INDEX IF NOT EXISTS cg_v2_ws_note_idx
  ON public.card_generation_runs_v2 (workspace_id, note_id, created_at);
CREATE INDEX IF NOT EXISTS cg_v2_ws_status_idx
  ON public.card_generation_runs_v2 (workspace_id, status, updated_at);

--> statement-breakpoint

-- ─── §8.5 CardPlan revisions ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.card_generation_plans_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.card_generation_runs_v2(id) ON DELETE CASCADE,
  plan_revision_id uuid NOT NULL,
  plan_version integer NOT NULL,
  previous_plan_revision_id uuid,
  input_snapshot_hash text NOT NULL,
  card_content_epoch integer NOT NULL,
  result jsonb NOT NULL,
  atom_decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cg_v2_plan_version_chk CHECK (plan_version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS cg_v2_plan_revision_idx
  ON public.card_generation_plans_v2 (workspace_id, plan_revision_id);
CREATE UNIQUE INDEX IF NOT EXISTS cg_v2_plan_run_version_idx
  ON public.card_generation_plans_v2 (workspace_id, run_id, plan_version);
CREATE INDEX IF NOT EXISTS cg_v2_plan_run_idx
  ON public.card_generation_plans_v2 (workspace_id, run_id, plan_version);

--> statement-breakpoint

-- ─── §11 Candidate revisions ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.card_generation_candidates_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.card_generation_runs_v2(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL,
  candidate_revision_id uuid NOT NULL,
  revision integer NOT NULL,
  plan_revision_id uuid NOT NULL,
  plan_version integer NOT NULL,
  plan_hash text NOT NULL,
  card_content_epoch integer NOT NULL,
  plan_objective_local_id text NOT NULL,
  recommendation jsonb NOT NULL DEFAULT '{}'::jsonb,
  derived_from jsonb NOT NULL DEFAULT '[]'::jsonb,
  objective_draft jsonb NOT NULL,
  presentation_draft jsonb NOT NULL,
  evidence_set_hash text NOT NULL,
  candidate_revision_hash text NOT NULL,
  quality_state text NOT NULL DEFAULT 'authored',
  review_decision text NOT NULL DEFAULT 'undecided',
  publish_state text NOT NULL DEFAULT 'unpublished',
  review_reason_code text,
  review_note text,
  quality_report_hashes text[] NOT NULL DEFAULT '{}',
  evidence_binding_plan_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cg_v2_cand_quality_chk CHECK (
    quality_state IN ('authored','checking','passed','failed')
  ),
  CONSTRAINT cg_v2_cand_review_chk CHECK (
    review_decision IN ('undecided','keep','reject','merged')
  ),
  CONSTRAINT cg_v2_cand_publish_chk CHECK (
    publish_state IN ('unpublished','activating','activated','activation_failed','superseded','expired')
  ),
  CONSTRAINT cg_v2_cand_revision_chk CHECK (revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS cg_v2_cand_revision_idx
  ON public.card_generation_candidates_v2 (workspace_id, candidate_revision_id);
CREATE INDEX IF NOT EXISTS cg_v2_cand_run_idx
  ON public.card_generation_candidates_v2 (workspace_id, run_id, candidate_id, revision);
CREATE INDEX IF NOT EXISTS cg_v2_cand_latest_idx
  ON public.card_generation_candidates_v2 (workspace_id, run_id, candidate_id, revision DESC);

--> statement-breakpoint

-- ─── §15.3 Learning Objective (stable + revisions) ──────────────────────

CREATE TABLE IF NOT EXISTS public.learning_objectives_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  semantic_identity_class_id text NOT NULL,
  semantic_identity_policy_version text NOT NULL,
  semantic_target_fingerprint text NOT NULL,
  lifecycle text NOT NULL DEFAULT 'active',
  lifecycle_epoch integer NOT NULL DEFAULT 1,
  current_objective_revision_id uuid,
  current_revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lo_v2_lifecycle_chk CHECK (
    lifecycle IN ('active','archived','superseded')
  ),
  CONSTRAINT lo_v2_epoch_chk CHECK (lifecycle_epoch >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS lo_v2_ws_objective_idx
  ON public.learning_objectives_v2 (workspace_id, objective_id);
CREATE INDEX IF NOT EXISTS lo_v2_ws_lifecycle_idx
  ON public.learning_objectives_v2 (workspace_id, lifecycle, updated_at);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_objective_revisions_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  objective_revision_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  revision integer NOT NULL,
  objective_statement text NOT NULL,
  public_summary text NOT NULL,
  knowledge_form text NOT NULL,
  preferred_intents text[] NOT NULL,
  canonical_answer jsonb NOT NULL,
  learning_support jsonb NOT NULL,
  scoring_rubric jsonb NOT NULL,
  relations jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  supersedes_objective_revision_id uuid,
  semantic_target_fingerprint text NOT NULL,
  target_revision_hash text NOT NULL,
  private_payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lo_v2_rev_revision_chk CHECK (revision >= 1),
  CONSTRAINT lo_v2_rev_no_self_ref_chk CHECK (
    objective_revision_id IS DISTINCT FROM supersedes_objective_revision_id
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lo_v2_rev_revision_idx
  ON public.learning_objective_revisions_v2 (workspace_id, objective_revision_id);
CREATE INDEX IF NOT EXISTS lo_v2_rev_objective_idx
  ON public.learning_objective_revisions_v2 (workspace_id, objective_id, revision DESC);

--> statement-breakpoint

-- ─── §15.1 Learning Card + Publication Revisions ───────────────────────

CREATE TABLE IF NOT EXISTS public.learning_cards_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  card_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  card_revision integer NOT NULL DEFAULT 1,
  current_publication_revision integer NOT NULL DEFAULT 1,
  lifecycle text NOT NULL DEFAULT 'active',
  front jsonb NOT NULL,
  public_summary text NOT NULL,
  knowledge_form text NOT NULL,
  strategy text NOT NULL,
  source_label text,
  presentation_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lc_v2_lifecycle_chk CHECK (
    lifecycle IN ('active','archived','superseded')
  ),
  CONSTRAINT lc_v2_card_rev_chk CHECK (card_revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS lc_v2_ws_card_idx
  ON public.learning_cards_v2 (workspace_id, card_id);
CREATE INDEX IF NOT EXISTS lc_v2_ws_lifecycle_idx
  ON public.learning_cards_v2 (workspace_id, lifecycle, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS lc_v2_ws_obj_active_idx
  ON public.learning_cards_v2 (workspace_id, objective_id)
  WHERE lifecycle = 'active';

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_card_publication_revisions_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  card_id uuid NOT NULL,
  publication_revision integer NOT NULL,
  card_revision integer NOT NULL,
  objective_id uuid NOT NULL,
  objective_revision integer NOT NULL,
  lifecycle_at_publication text NOT NULL,
  public_payload_hash text NOT NULL,
  reveal_payload_hash text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lc_v2_pub_lifecycle_chk CHECK (
    lifecycle_at_publication IN ('active','archived','superseded')
  ),
  CONSTRAINT lc_v2_pub_rev_chk CHECK (publication_revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS lc_v2_pub_card_rev_idx
  ON public.learning_card_publication_revisions_v2 (workspace_id, card_id, publication_revision);

--> statement-breakpoint

-- ─── §15.2 Exposure Ledger ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.card_exposure_ledger_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  exposure_id uuid NOT NULL,
  subject_kind text NOT NULL,
  subject_candidate_id uuid,
  subject_candidate_revision integer,
  subject_objective_id uuid,
  subject_objective_revision integer,
  subject_card_id uuid,
  subject_card_revision integer,
  exposure_kind text NOT NULL,
  context_hash text NOT NULL,
  idempotency_key text NOT NULL,
  exposed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ce_v2_subject_chk CHECK (
    subject_kind IN ('candidate','objective')
  ),
  CONSTRAINT ce_v2_kind_chk CHECK (
    exposure_kind IN ('answer_reveal','evidence_reveal','answer_editor_view')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ce_v2_ws_idem_idx
  ON public.card_exposure_ledger_v2 (workspace_id, user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS ce_v2_ws_user_obj_idx
  ON public.card_exposure_ledger_v2 (workspace_id, user_id, subject_objective_id, exposed_at DESC, id);
CREATE INDEX IF NOT EXISTS ce_v2_ws_user_cand_idx
  ON public.card_exposure_ledger_v2 (workspace_id, user_id, subject_candidate_id, exposed_at DESC, id);

--> statement-breakpoint

-- ─── §17.3 Initial Validation Reminder ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.initial_validation_reminders_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reminder_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  exposure_scope_id text NOT NULL,
  qualification_not_before timestamptz NOT NULL,
  last_exposure_id uuid,
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reminder_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ivr_v2_status_chk CHECK (
    status IN ('pending','ready','completed','cancelled','superseded')
  ),
  CONSTRAINT ivr_v2_rev_chk CHECK (reminder_revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS ivr_v2_ws_user_obj_pending_idx
  ON public.initial_validation_reminders_v2 (workspace_id, user_id, objective_id)
  WHERE status IN ('pending','ready');
CREATE INDEX IF NOT EXISTS ivr_v2_ws_user_status_idx
  ON public.initial_validation_reminders_v2 (workspace_id, user_id, status, qualification_not_before);

--> statement-breakpoint

-- ─── §17.5 Activation Receipt ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.card_activation_receipts_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.card_generation_runs_v2(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  mappings jsonb NOT NULL,
  lifecycle_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_hash text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS car_v2_ws_receipt_idx
  ON public.card_activation_receipts_v2 (workspace_id, receipt_id);
CREATE UNIQUE INDEX IF NOT EXISTS car_v2_ws_idem_idx
  ON public.card_activation_receipts_v2 (workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS car_v2_ws_run_idx
  ON public.card_activation_receipts_v2 (workspace_id, run_id);

--> statement-breakpoint

-- ─── §17.1 Generation Run Events (SSE) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.card_generation_events_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.card_generation_runs_v2(id) ON DELETE CASCADE,
  event_seq integer NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cge_v2_ws_run_seq_idx
  ON public.card_generation_events_v2 (workspace_id, run_id, event_seq);
CREATE INDEX IF NOT EXISTS cge_v2_ws_run_created_idx
  ON public.card_generation_events_v2 (workspace_id, run_id, created_at);

--> statement-breakpoint

-- ─── RLS Policies ────────────────────────────────────────────────────────

ALTER TABLE public.card_generation_runs_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_plans_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_candidates_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_objectives_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_objective_revisions_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_cards_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_card_publication_revisions_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_exposure_ledger_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.initial_validation_reminders_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_activation_receipts_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_events_v2 ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY cg_v2_ws_isolation ON public.card_generation_runs_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY cgp_v2_ws_isolation ON public.card_generation_plans_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY cgc_v2_ws_isolation ON public.card_generation_candidates_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY lo_v2_ws_isolation ON public.learning_objectives_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY lo_v2_rev_ws_isolation ON public.learning_objective_revisions_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY lc_v2_ws_isolation ON public.learning_cards_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY lc_v2_pub_ws_isolation ON public.learning_card_publication_revisions_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY ce_v2_ws_isolation ON public.card_exposure_ledger_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid AND
         user_id = current_setting('app.user_id', true)::uuid);
CREATE POLICY ivr_v2_ws_isolation ON public.initial_validation_reminders_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid AND
         user_id = current_setting('app.user_id', true)::uuid);
CREATE POLICY car_v2_ws_isolation ON public.card_activation_receipts_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY cge_v2_ws_isolation ON public.card_generation_events_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

--> statement-breakpoint

-- ─── Grants ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.card_generation_runs_v2,
  public.card_generation_plans_v2,
  public.card_generation_candidates_v2,
  public.learning_objectives_v2,
  public.learning_objective_revisions_v2,
  public.learning_cards_v2,
  public.learning_card_publication_revisions_v2,
  public.card_exposure_ledger_v2,
  public.initial_validation_reminders_v2,
  public.card_activation_receipts_v2,
  public.card_generation_events_v2
TO ailearn_api, ailearn_worker;

-- ─── §16.1 Learning Target Snapshot V2 ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.learning_target_snapshots_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.card_generation_runs_v2(id) ON DELETE CASCADE,
  objective_id uuid NOT NULL,
  objective_revision_id uuid NOT NULL,
  objective_revision integer NOT NULL,
  semantic_target_fingerprint text NOT NULL,
  target_revision_hash text NOT NULL,
  semantic_identity_class_id text NOT NULL,
  semantic_identity_policy_version text NOT NULL,
  objective_lifecycle_epoch integer NOT NULL,
  card_content_epoch integer NOT NULL,
  assistance_snapshot_hash text,
  canonical_answer jsonb NOT NULL,
  scoring_rubric jsonb NOT NULL,
  relations jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  preferred_intents text[] NOT NULL,
  snapshot_hash text NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lts_v2_revision_chk CHECK (objective_revision >= 1),
  CONSTRAINT lts_v2_epoch_chk CHECK (card_content_epoch >= 1),
  CONSTRAINT lts_v2_lifecycle_epoch_chk CHECK (objective_lifecycle_epoch >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS lts_v2_snapshot_id_idx
  ON public.learning_target_snapshots_v2 (workspace_id, snapshot_id);
CREATE INDEX IF NOT EXISTS lts_v2_ws_run_idx
  ON public.learning_target_snapshots_v2 (workspace_id, run_id, objective_id);
CREATE INDEX IF NOT EXISTS lts_v2_ws_objective_idx
  ON public.learning_target_snapshots_v2 (workspace_id, objective_id, frozen_at);

--> statement-breakpoint

-- ─── §16.4 Legacy Target Snapshot Attachment V2 ──────────────────────────

CREATE TABLE IF NOT EXISTS public.legacy_target_snapshot_attachments_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  run_id uuid NOT NULL,
  key_point_id uuid NOT NULL,
  semantic_target_fingerprint text NOT NULL,
  target_revision_hash text NOT NULL,
  legacy_claim text NOT NULL,
  legacy_quote_text text NOT NULL,
  evidence_content_hashes text[] NOT NULL DEFAULT '{}',
  snapshot_hash text NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ltsa_v2_attachment_id_idx
  ON public.legacy_target_snapshot_attachments_v2 (workspace_id, attachment_id);
CREATE INDEX IF NOT EXISTS ltsa_v2_ws_run_idx
  ON public.legacy_target_snapshot_attachments_v2 (workspace_id, run_id, key_point_id);

--> statement-breakpoint

-- ─── §12.2 Candidate Evidence Binding Plan V2 ────────────────────────────

CREATE TABLE IF NOT EXISTS public.candidate_evidence_binding_plans_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  binding_plan_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.card_generation_runs_v2(id) ON DELETE CASCADE,
  candidate_revision_id uuid NOT NULL,
  candidate_revision_hash text NOT NULL,
  plan_revision_id uuid NOT NULL,
  plan_version integer NOT NULL,
  plan_hash text NOT NULL,
  target_unit_bindings jsonb NOT NULL,
  binding_plan_hash text NOT NULL,
  evidence_eligibility_vector_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cebp_v2_version_chk CHECK (plan_version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS cebp_v2_id_idx
  ON public.candidate_evidence_binding_plans_v2 (workspace_id, binding_plan_id);
CREATE INDEX IF NOT EXISTS cebp_v2_ws_candidate_idx
  ON public.candidate_evidence_binding_plans_v2 (workspace_id, candidate_revision_id);

--> statement-breakpoint

-- ─── §13.1 Evidence Eligibility State V2 ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.evidence_eligibility_states_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  eligibility_id uuid NOT NULL,
  evidence_snapshot_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'usable',
  eligibility_epoch integer NOT NULL DEFAULT 1,
  eligibility_vector_hash text NOT NULL,
  restricted_reason text,
  restricted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ees_v2_status_chk CHECK (status IN ('usable','restricted','revoked')),
  CONSTRAINT ees_v2_epoch_chk CHECK (eligibility_epoch >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS ees_v2_id_idx
  ON public.evidence_eligibility_states_v2 (workspace_id, eligibility_id);
CREATE INDEX IF NOT EXISTS ees_v2_ws_snapshot_idx
  ON public.evidence_eligibility_states_v2 (workspace_id, evidence_snapshot_id, status);

--> statement-breakpoint

-- ─── §17.2 Card Generation Run Outbox V2 (worker enqueue) ────────────────

CREATE TABLE IF NOT EXISTS public.card_generation_run_outbox_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.card_generation_runs_v2(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT cgro_v2_status_chk CHECK (status IN ('pending','processing','completed','failed'))
);

CREATE INDEX IF NOT EXISTS cgro_v2_ws_run_status_idx
  ON public.card_generation_run_outbox_v2 (workspace_id, run_id, status, created_at);

--> statement-breakpoint

-- ─── RLS for new tables ────────────────────────────────────────────────────

ALTER TABLE public.learning_target_snapshots_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_target_snapshot_attachments_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_evidence_binding_plans_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_eligibility_states_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_run_outbox_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY lts_v2_ws_isolation ON public.learning_target_snapshots_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY ltsa_v2_ws_isolation ON public.legacy_target_snapshot_attachments_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY cebp_v2_ws_isolation ON public.candidate_evidence_binding_plans_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY ees_v2_ws_isolation ON public.evidence_eligibility_states_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY cgro_v2_ws_isolation ON public.card_generation_run_outbox_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

--> statement-breakpoint

-- ─── Grants for new tables ────────────────────────────────────────────────

-- §22.1 Private column hardening for learning_target_snapshots_v2:
-- canonical_answer, scoring_rubric, evidence_bindings are server-private.
-- ailearn_worker gets full access; ailearn_api gets only public columns.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.legacy_target_snapshot_attachments_v2,
  public.candidate_evidence_binding_plans_v2,
  public.evidence_eligibility_states_v2,
  public.card_generation_run_outbox_v2
TO ailearn_api, ailearn_worker;

-- learning_target_snapshots_v2: worker gets full access
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.learning_target_snapshots_v2
TO ailearn_worker;

-- learning_target_snapshots_v2: API gets only public columns (no canonical_answer, scoring_rubric, evidence_bindings)
GRANT SELECT (
  id, workspace_id, snapshot_id, run_id, objective_id, objective_revision_id,
  objective_revision, semantic_target_fingerprint, target_revision_hash,
  semantic_identity_class_id, semantic_identity_policy_version,
  objective_lifecycle_epoch, card_content_epoch, assistance_snapshot_hash,
  relations, preferred_intents, snapshot_hash, frozen_at
) ON public.learning_target_snapshots_v2 TO ailearn_api;
GRANT INSERT (
  id, workspace_id, snapshot_id, run_id, objective_id, objective_revision_id,
  objective_revision, semantic_target_fingerprint, target_revision_hash,
  semantic_identity_class_id, semantic_identity_policy_version,
  objective_lifecycle_epoch, card_content_epoch, assistance_snapshot_hash,
  canonical_answer, scoring_rubric, relations, evidence_bindings, preferred_intents,
  snapshot_hash, frozen_at
) ON public.learning_target_snapshots_v2 TO ailearn_api;
GRANT UPDATE (
  id, workspace_id, snapshot_id, run_id, objective_id, objective_revision_id,
  objective_revision, semantic_target_fingerprint, target_revision_hash,
  semantic_identity_class_id, semantic_identity_policy_version,
  objective_lifecycle_epoch, card_content_epoch, assistance_snapshot_hash,
  relations, preferred_intents, snapshot_hash, frozen_at
) ON public.learning_target_snapshots_v2 TO ailearn_api;
GRANT DELETE ON public.learning_target_snapshots_v2 TO ailearn_api;

--> statement-breakpoint

-- ─── §22.1 Private rubric/answer column hardening ────────────────────────
-- learning_objective_revisions_v2: canonical_answer, learning_support,
-- scoring_rubric, evidence_bindings, private_payload_hash are server-private.
-- Revoke from ailearn_api; only ailearn_worker has full access.
-- API reads public fields via a view or explicit column list.

REVOKE SELECT ON public.learning_objective_revisions_v2 FROM ailearn_api;

-- Grant API access to only the public columns (via column-level GRANT)
GRANT SELECT (
  id, workspace_id, objective_revision_id, objective_id, revision,
  objective_statement, public_summary, knowledge_form, preferred_intents,
  relations, supersedes_objective_revision_id, semantic_target_fingerprint,
  target_revision_hash, created_at
) ON public.learning_objective_revisions_v2 TO ailearn_api;

--> statement-breakpoint

-- ─── §15.3/§15.7 Immutable triggers for Objective Revisions ──────────────
-- Prevent UPDATE/DELETE on learning_objective_revisions_v2 rows after insert.
-- Objective revisions are append-only: corrections create a new revision.

CREATE OR REPLACE FUNCTION prevent_objective_revision_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'learning_objective_revisions_v2 is immutable: % operation not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lo_v2_rev_no_update
  BEFORE UPDATE ON public.learning_objective_revisions_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_objective_revision_mutation();

CREATE TRIGGER lo_v2_rev_no_delete
  BEFORE DELETE ON public.learning_objective_revisions_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_objective_revision_mutation();

--> statement-breakpoint

-- ─── §15.1/§15.7 Immutable triggers for Card Publication Revisions ────────
-- Prevent UPDATE/DELETE on learning_card_publication_revisions_v2 rows.
-- Publication revisions are append-only.

CREATE OR REPLACE FUNCTION prevent_publication_revision_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'learning_card_publication_revisions_v2 is immutable: % operation not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lc_v2_pub_no_update
  BEFORE UPDATE ON public.learning_card_publication_revisions_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_publication_revision_mutation();

CREATE TRIGGER lc_v2_pub_no_delete
  BEFORE DELETE ON public.learning_card_publication_revisions_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_publication_revision_mutation();

--> statement-breakpoint

-- ─── §16.3 Fix FK constraint: learning_runs.key_point_id ─────────────────
-- Change from ON DELETE CASCADE to ON DELETE RESTRICT to prevent
-- accidental data loss when a keyPoint is deleted while referenced by a run.

ALTER TABLE public.learning_runs
  DROP CONSTRAINT IF EXISTS learning_runs_key_point_id_fkey;

ALTER TABLE public.learning_runs
  ADD CONSTRAINT learning_runs_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES public.card_key_points(id)
  ON DELETE RESTRICT;
