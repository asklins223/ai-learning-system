-- 0045: Learning-card generation engine v2, exact text Map/Reduce pipeline
--
-- Adds immutable source spans, durable unit checkpoints, validated candidates,
-- typed candidate-to-span evidence, and the queue/unit relationship needed for
-- bounded fan-out. Legacy card/evidence rows remain nullable-compatible.

CREATE UNIQUE INDEX IF NOT EXISTS note_versions_workspace_id_unique_idx
  ON public.note_versions(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS note_blocks_workspace_version_id_unique_idx
  ON public.note_blocks(workspace_id, version_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_runs_workspace_id_version_unique_idx
  ON public.card_generation_runs(workspace_id, id, note_version_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.note_evidence_spans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  note_version_id uuid NOT NULL,
  block_id uuid NOT NULL,
  unit_key text NOT NULL,
  planner_version text NOT NULL,
  ordinal integer NOT NULL,
  char_start integer NOT NULL,
  char_end integer NOT NULL,
  text_hash text NOT NULL,
  section_path jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_kind text NOT NULL,
  token_estimate integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_evidence_spans_offsets_check CHECK (
    ordinal >= 0 AND char_start >= 0 AND char_end > char_start
  ),
  CONSTRAINT note_evidence_spans_token_check CHECK (token_estimate > 0),
  CONSTRAINT note_evidence_spans_source_kind_check CHECK (
    source_kind IN ('text', 'list', 'code')
  ),
  CONSTRAINT note_evidence_spans_section_path_check CHECK (
    jsonb_typeof(section_path) = 'array'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS note_evidence_spans_workspace_id_unique_idx
  ON public.note_evidence_spans(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS note_evidence_spans_workspace_version_id_unique_idx
  ON public.note_evidence_spans(workspace_id, note_version_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS note_evidence_spans_version_unit_unique_idx
  ON public.note_evidence_spans(workspace_id, note_version_id, unit_key);
CREATE INDEX IF NOT EXISTS note_evidence_spans_block_ordinal_idx
  ON public.note_evidence_spans(workspace_id, note_version_id, block_id, ordinal);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.note_evidence_spans
    ADD CONSTRAINT note_evidence_spans_version_fk
    FOREIGN KEY (workspace_id, note_version_id)
    REFERENCES public.note_versions(workspace_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.note_evidence_spans
    ADD CONSTRAINT note_evidence_spans_block_fk
    FOREIGN KEY (workspace_id, note_version_id, block_id)
    REFERENCES public.note_blocks(workspace_id, version_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.card_generation_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  parent_unit_id uuid,
  kind text NOT NULL,
  level integer NOT NULL DEFAULT 0,
  ordinal integer NOT NULL,
  unit_key text NOT NULL,
  pipeline_version text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  input_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_hash text NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  artifact_json jsonb,
  artifact_hash text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_generation_units_kind_check CHECK (
    kind IN (
      'planner', 'image', 'text_map', 'section_reduce', 'deck_plan',
      'card_render', 'verify', 'publish'
    )
  ),
  CONSTRAINT card_generation_units_status_check CHECK (
    status IN (
      'pending', 'running', 'succeeded', 'retryable_failed',
      'terminal_failed', 'cancelled', 'superseded'
    )
  ),
  CONSTRAINT card_generation_units_counts_check CHECK (
    level >= 0 AND ordinal >= 0 AND token_estimate >= 0 AND attempts >= 0
  ),
  CONSTRAINT card_generation_units_manifest_check CHECK (
    jsonb_typeof(input_manifest) = 'object'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_units_workspace_id_unique_idx
  ON public.card_generation_units(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_units_workspace_run_id_unique_idx
  ON public.card_generation_units(workspace_id, run_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_units_identity_unique_idx
  ON public.card_generation_units(run_id, kind, level, ordinal, pipeline_version);
CREATE INDEX IF NOT EXISTS card_generation_units_run_status_idx
  ON public.card_generation_units(workspace_id, run_id, kind, status, ordinal);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.card_generation_units
    ADD CONSTRAINT card_generation_units_run_fk
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.card_generation_runs(workspace_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.card_generation_units
    ADD CONSTRAINT card_generation_units_parent_fk
    FOREIGN KEY (workspace_id, run_id, parent_unit_id)
    REFERENCES public.card_generation_units(workspace_id, run_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.card_generation_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  local_ordinal integer NOT NULL,
  local_id text NOT NULL,
  claim text NOT NULL,
  normalized_claim_hash text NOT NULL,
  topic text NOT NULL,
  section_key text NOT NULL,
  cognitive_type text NOT NULL,
  importance text NOT NULL,
  validation_status text NOT NULL DEFAULT 'accepted',
  exclusion_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_generation_candidates_ordinal_check CHECK (local_ordinal >= 0),
  CONSTRAINT card_generation_candidates_cognitive_check CHECK (
    cognitive_type IN ('concept', 'comparison', 'causal', 'procedure', 'boundary')
  ),
  CONSTRAINT card_generation_candidates_importance_check CHECK (
    importance IN ('core', 'supporting', 'detail')
  ),
  CONSTRAINT card_generation_candidates_validation_check CHECK (
    validation_status IN ('accepted', 'excluded')
  ),
  CONSTRAINT card_generation_candidates_exclusion_check CHECK (
    (validation_status = 'accepted' AND exclusion_reason IS NULL)
    OR (validation_status = 'excluded' AND exclusion_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_candidates_workspace_id_unique_idx
  ON public.card_generation_candidates(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_candidates_workspace_run_id_unique_idx
  ON public.card_generation_candidates(workspace_id, run_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_candidates_unit_local_unique_idx
  ON public.card_generation_candidates(workspace_id, run_id, unit_id, local_id);
CREATE INDEX IF NOT EXISTS card_generation_candidates_run_status_idx
  ON public.card_generation_candidates(workspace_id, run_id, validation_status, section_key);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.card_generation_candidates
    ADD CONSTRAINT card_generation_candidates_run_fk
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.card_generation_runs(workspace_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.card_generation_candidates
    ADD CONSTRAINT card_generation_candidates_unit_fk
    FOREIGN KEY (workspace_id, run_id, unit_id)
    REFERENCES public.card_generation_units(workspace_id, run_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.card_generation_candidate_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  note_version_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  evidence_span_id uuid NOT NULL,
  ordinal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_generation_candidate_evidence_ordinal_check CHECK (ordinal >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_candidate_evidence_unique_idx
  ON public.card_generation_candidate_evidence(candidate_id, evidence_span_id);
CREATE INDEX IF NOT EXISTS card_generation_candidate_evidence_candidate_idx
  ON public.card_generation_candidate_evidence(workspace_id, run_id, candidate_id, ordinal);
CREATE INDEX IF NOT EXISTS card_generation_candidate_evidence_span_idx
  ON public.card_generation_candidate_evidence(workspace_id, note_version_id, evidence_span_id);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.card_generation_candidate_evidence
    ADD CONSTRAINT card_generation_candidate_evidence_run_version_fk
    FOREIGN KEY (workspace_id, run_id, note_version_id)
    REFERENCES public.card_generation_runs(workspace_id, id, note_version_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.card_generation_candidate_evidence
    ADD CONSTRAINT card_generation_candidate_evidence_candidate_fk
    FOREIGN KEY (workspace_id, run_id, candidate_id)
    REFERENCES public.card_generation_candidates(workspace_id, run_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.card_generation_candidate_evidence
    ADD CONSTRAINT card_generation_candidate_evidence_span_fk
    FOREIGN KEY (workspace_id, note_version_id, evidence_span_id)
    REFERENCES public.note_evidence_spans(workspace_id, note_version_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_generation_unit_requires_run_check
    CHECK (generation_unit_id IS NULL OR generation_run_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_generation_unit_fk
    FOREIGN KEY (workspace_id, generation_run_id, generation_unit_id)
    REFERENCES public.card_generation_units(workspace_id, run_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS jobs_generation_unit_idx
  ON public.jobs(generation_run_id, generation_unit_id, status);
--> statement-breakpoint

ALTER TABLE public.card_key_points
  ADD COLUMN IF NOT EXISTS candidate_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS card_key_points_candidate_unique_idx
  ON public.card_key_points(workspace_id, candidate_id)
  WHERE candidate_id IS NOT NULL;
DO $$ BEGIN
  ALTER TABLE public.card_key_points
    ADD CONSTRAINT card_key_points_candidate_fk
    FOREIGN KEY (workspace_id, candidate_id)
    REFERENCES public.card_generation_candidates(workspace_id, id)
    ON DELETE SET NULL (candidate_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS evidence_span_id uuid,
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS char_start integer,
  ADD COLUMN IF NOT EXISTS char_end integer,
  ADD COLUMN IF NOT EXISTS source_hash text;
CREATE INDEX IF NOT EXISTS evidences_span_idx
  ON public.evidences(workspace_id, evidence_span_id);
DO $$ BEGIN
  ALTER TABLE public.evidences
    ADD CONSTRAINT evidences_span_fk
    FOREIGN KEY (workspace_id, evidence_span_id)
    REFERENCES public.note_evidence_spans(workspace_id, id)
    ON DELETE SET NULL (evidence_span_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.evidences
    ADD CONSTRAINT evidences_typed_span_check CHECK (
      source_kind IS NULL
      OR (
        source_kind = 'text_span'
        AND evidence_span_id IS NOT NULL
        AND char_start IS NOT NULL
        AND char_end IS NOT NULL
        AND char_start >= 0
        AND char_end > char_start
        AND source_hash IS NOT NULL
        AND alignment_method = 'exact_span'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_guard_note_evidence_span()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'note evidence span % is immutable', OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'note evidence span % cannot be deleted directly', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS note_evidence_spans_immutable_guard
  ON public.note_evidence_spans;
CREATE TRIGGER note_evidence_spans_immutable_guard
  BEFORE UPDATE OR DELETE ON public.note_evidence_spans
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_guard_note_evidence_span();
--> statement-breakpoint

ALTER TABLE public.note_evidence_spans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_evidence_spans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_units FORCE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_candidate_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_candidate_evidence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS note_evidence_spans_workspace_isolation
  ON public.note_evidence_spans;
CREATE POLICY note_evidence_spans_workspace_isolation
  ON public.note_evidence_spans FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS card_generation_units_workspace_isolation
  ON public.card_generation_units;
CREATE POLICY card_generation_units_workspace_isolation
  ON public.card_generation_units FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS card_generation_candidates_workspace_isolation
  ON public.card_generation_candidates;
CREATE POLICY card_generation_candidates_workspace_isolation
  ON public.card_generation_candidates FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS card_generation_candidate_evidence_workspace_isolation
  ON public.card_generation_candidate_evidence;
CREATE POLICY card_generation_candidate_evidence_workspace_isolation
  ON public.card_generation_candidate_evidence FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint

-- Keep deployed least-privilege roles usable before roles.sql is replayed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.note_evidence_spans,
      public.card_generation_units,
      public.card_generation_candidates,
      public.card_generation_candidate_evidence
    TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, INSERT ON public.note_evidence_spans TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.card_generation_units TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.card_generation_candidates TO ailearn_worker;
    GRANT SELECT, INSERT ON public.card_generation_candidate_evidence TO ailearn_worker;
  END IF;
END $$;
