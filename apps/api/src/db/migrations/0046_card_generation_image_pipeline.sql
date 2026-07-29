-- 0046: Learning-card generation engine v2, immutable image assets and region evidence

UPDATE public.workspaces
SET ai_data_policy = ai_data_policy || '{"sendImageContent": false}'::jsonb
WHERE NOT (ai_data_policy ? 'sendImageContent');
ALTER TABLE public.workspaces
  ALTER COLUMN ai_data_policy
  SET DEFAULT '{"sendToExternal": false, "sendImageContent": false, "piiDetection": true, "auditLogging": true}'::jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.note_image_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  uploaded_for_note_id uuid,
  object_key text NOT NULL,
  sha256 text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  normalized_object_key text,
  thumbnail_object_key text,
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT note_image_assets_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT note_image_assets_size_check CHECK (byte_size > 0 AND width > 0 AND height > 0),
  CONSTRAINT note_image_assets_mime_check CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  CONSTRAINT note_image_assets_status_check CHECK (status IN ('ready', 'deleted')),
  CONSTRAINT note_image_assets_object_key_check CHECK (length(trim(object_key)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS note_image_assets_workspace_id_unique_idx
  ON public.note_image_assets(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS note_image_assets_workspace_object_key_unique_idx
  ON public.note_image_assets(workspace_id, object_key);
CREATE INDEX IF NOT EXISTS note_image_assets_workspace_hash_idx
  ON public.note_image_assets(workspace_id, sha256);
CREATE INDEX IF NOT EXISTS note_image_assets_note_idx
  ON public.note_image_assets(workspace_id, uploaded_for_note_id, created_at);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.note_image_assets
    ADD CONSTRAINT note_image_assets_note_fk
    FOREIGN KEY (workspace_id, uploaded_for_note_id)
    REFERENCES public.notes(workspace_id, id)
    ON DELETE SET NULL (uploaded_for_note_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE public.note_blocks
  ADD COLUMN IF NOT EXISTS image_asset_id uuid;
CREATE INDEX IF NOT EXISTS note_blocks_image_asset_idx
  ON public.note_blocks(workspace_id, image_asset_id);
DO $$ BEGIN
  ALTER TABLE public.note_blocks
    ADD CONSTRAINT note_blocks_image_asset_fk
    FOREIGN KEY (workspace_id, image_asset_id)
    REFERENCES public.note_image_assets(workspace_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.note_blocks
    ADD CONSTRAINT note_blocks_image_asset_type_check
    CHECK (image_asset_id IS NULL OR type = 'image');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.note_image_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  image_asset_id uuid NOT NULL,
  cache_key text NOT NULL,
  extractor_version text NOT NULL,
  vision_model_id text NOT NULL,
  prompt_version text NOT NULL,
  governance_policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  content_type text,
  caption text,
  ocr_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_hash text,
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT note_image_insights_status_check CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  CONSTRAINT note_image_insights_attempts_check CHECK (attempts >= 0),
  CONSTRAINT note_image_insights_json_check CHECK (
    jsonb_typeof(ocr_json) = 'array'
    AND jsonb_typeof(facts_json) = 'array'
    AND jsonb_typeof(safety_json) = 'object'
  ),
  CONSTRAINT note_image_insights_success_check CHECK (
    status <> 'succeeded'
    OR (
      content_type IS NOT NULL
      AND artifact_hash IS NOT NULL
      AND error_code IS NULL
      AND finished_at IS NOT NULL
    )
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS note_image_insights_workspace_id_unique_idx
  ON public.note_image_insights(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS note_image_insights_workspace_id_asset_unique_idx
  ON public.note_image_insights(workspace_id, id, image_asset_id);
CREATE UNIQUE INDEX IF NOT EXISTS note_image_insights_asset_cache_unique_idx
  ON public.note_image_insights(workspace_id, image_asset_id, cache_key);
CREATE INDEX IF NOT EXISTS note_image_insights_status_idx
  ON public.note_image_insights(workspace_id, status, updated_at);
DO $$ BEGIN
  ALTER TABLE public.note_image_insights
    ADD CONSTRAINT note_image_insights_asset_fk
    FOREIGN KEY (workspace_id, image_asset_id)
    REFERENCES public.note_image_assets(workspace_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.note_image_evidence_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  image_insight_id uuid NOT NULL,
  image_asset_id uuid NOT NULL,
  unit_key text NOT NULL,
  ordinal integer NOT NULL,
  source_kind text NOT NULL,
  text text NOT NULL,
  text_hash text NOT NULL,
  region jsonb NOT NULL,
  confidence_bps integer NOT NULL,
  evidence_level text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_image_evidence_units_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT note_image_evidence_units_text_check CHECK (length(text) > 0 AND text_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT note_image_evidence_units_kind_check CHECK (source_kind IN ('image_ocr', 'image_fact')),
  CONSTRAINT note_image_evidence_units_level_check CHECK (evidence_level IN ('image_ocr_exact', 'image_structured')),
  CONSTRAINT note_image_evidence_units_confidence_check CHECK (confidence_bps BETWEEN 0 AND 10000),
  CONSTRAINT note_image_evidence_units_region_check CHECK (
    CASE WHEN jsonb_typeof(region) = 'object'
      AND jsonb_typeof(region->'x') = 'number'
      AND jsonb_typeof(region->'y') = 'number'
      AND jsonb_typeof(region->'width') = 'number'
      AND jsonb_typeof(region->'height') = 'number'
    THEN
      (region->>'x')::integer >= 0
      AND (region->>'y')::integer >= 0
      AND (region->>'width')::integer > 0
      AND (region->>'height')::integer > 0
      AND (region->>'x')::integer + (region->>'width')::integer <= 10000
      AND (region->>'y')::integer + (region->>'height')::integer <= 10000
    ELSE false END
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS note_image_evidence_units_workspace_id_unique_idx
  ON public.note_image_evidence_units(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS note_image_evidence_units_workspace_insight_id_unique_idx
  ON public.note_image_evidence_units(workspace_id, image_insight_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS note_image_evidence_units_insight_unit_unique_idx
  ON public.note_image_evidence_units(workspace_id, image_insight_id, unit_key);
CREATE INDEX IF NOT EXISTS note_image_evidence_units_asset_ordinal_idx
  ON public.note_image_evidence_units(workspace_id, image_asset_id, ordinal);
DO $$ BEGIN
  ALTER TABLE public.note_image_evidence_units
    ADD CONSTRAINT note_image_evidence_units_insight_asset_fk
    FOREIGN KEY (workspace_id, image_insight_id, image_asset_id)
    REFERENCES public.note_image_insights(workspace_id, id, image_asset_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE public.card_generation_candidate_evidence
  ALTER COLUMN evidence_span_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'text_span',
  ADD COLUMN IF NOT EXISTS image_evidence_unit_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_candidate_image_evidence_unique_idx
  ON public.card_generation_candidate_evidence(candidate_id, image_evidence_unit_id)
  WHERE image_evidence_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS card_generation_candidate_evidence_image_idx
  ON public.card_generation_candidate_evidence(workspace_id, image_evidence_unit_id);
DO $$ BEGIN
  ALTER TABLE public.card_generation_candidate_evidence
    ADD CONSTRAINT card_generation_candidate_evidence_image_fk
    FOREIGN KEY (workspace_id, image_evidence_unit_id)
    REFERENCES public.note_image_evidence_units(workspace_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.card_generation_candidate_evidence
    ADD CONSTRAINT card_generation_candidate_evidence_typed_check CHECK (
      (source_kind = 'text_span' AND evidence_span_id IS NOT NULL AND image_evidence_unit_id IS NULL)
      OR
      (source_kind = 'image_region' AND evidence_span_id IS NULL AND image_evidence_unit_id IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS image_asset_id uuid,
  ADD COLUMN IF NOT EXISTS image_insight_id uuid,
  ADD COLUMN IF NOT EXISTS image_evidence_unit_id uuid,
  ADD COLUMN IF NOT EXISTS region_json jsonb,
  ADD COLUMN IF NOT EXISTS extractor_version text;
CREATE INDEX IF NOT EXISTS evidences_image_evidence_idx
  ON public.evidences(workspace_id, image_evidence_unit_id);
DO $$ BEGIN
  ALTER TABLE public.evidences
    ADD CONSTRAINT evidences_image_asset_fk
    FOREIGN KEY (workspace_id, image_asset_id)
    REFERENCES public.note_image_assets(workspace_id, id)
    ON DELETE SET NULL (image_asset_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.evidences
    ADD CONSTRAINT evidences_image_insight_fk
    FOREIGN KEY (workspace_id, image_insight_id)
    REFERENCES public.note_image_insights(workspace_id, id)
    ON DELETE SET NULL (image_insight_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.evidences
    ADD CONSTRAINT evidences_image_unit_fk
    FOREIGN KEY (workspace_id, image_evidence_unit_id)
    REFERENCES public.note_image_evidence_units(workspace_id, id)
    ON DELETE SET NULL (image_evidence_unit_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.evidences DROP CONSTRAINT IF EXISTS evidences_typed_span_check;
ALTER TABLE public.evidences DROP CONSTRAINT IF EXISTS evidences_typed_source_check;
ALTER TABLE public.evidences
  ADD CONSTRAINT evidences_typed_source_check CHECK (
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
      AND image_asset_id IS NULL
      AND image_insight_id IS NULL
      AND image_evidence_unit_id IS NULL
      AND region_json IS NULL
      AND extractor_version IS NULL
    )
    OR (
      source_kind = 'image_region'
      AND evidence_span_id IS NULL
      AND char_start IS NULL
      AND char_end IS NULL
      AND source_hash IS NOT NULL
      AND image_asset_id IS NOT NULL
      AND image_insight_id IS NOT NULL
      AND image_evidence_unit_id IS NOT NULL
      AND jsonb_typeof(region_json) = 'object'
      AND extractor_version IS NOT NULL
      AND alignment_method IN ('image_ocr', 'image_structured')
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_guard_note_image_asset_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.width IS DISTINCT FROM OLD.width
    OR NEW.height IS DISTINCT FROM OLD.height
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'note image asset % identity is immutable', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS note_image_assets_identity_guard ON public.note_image_assets;
CREATE TRIGGER note_image_assets_identity_guard
  BEFORE UPDATE ON public.note_image_assets
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_guard_note_image_asset_identity();

CREATE OR REPLACE FUNCTION public.ailearn_guard_succeeded_image_insight()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'succeeded' THEN
    RAISE EXCEPTION 'succeeded image insight % is immutable', OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'image insight % cannot be deleted directly', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS note_image_insights_immutable_guard ON public.note_image_insights;
CREATE TRIGGER note_image_insights_immutable_guard
  BEFORE UPDATE OR DELETE ON public.note_image_insights
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_guard_succeeded_image_insight();

CREATE OR REPLACE FUNCTION public.ailearn_guard_note_image_evidence_unit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'note image evidence unit % is immutable', OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'note image evidence unit % cannot be deleted directly', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS note_image_evidence_units_immutable_guard ON public.note_image_evidence_units;
CREATE TRIGGER note_image_evidence_units_immutable_guard
  BEFORE UPDATE OR DELETE ON public.note_image_evidence_units
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_guard_note_image_evidence_unit();
--> statement-breakpoint

ALTER TABLE public.note_image_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_image_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.note_image_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_image_insights FORCE ROW LEVEL SECURITY;
ALTER TABLE public.note_image_evidence_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_image_evidence_units FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS note_image_assets_workspace_isolation ON public.note_image_assets;
CREATE POLICY note_image_assets_workspace_isolation
  ON public.note_image_assets FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS note_image_insights_workspace_isolation ON public.note_image_insights;
CREATE POLICY note_image_insights_workspace_isolation
  ON public.note_image_insights FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS note_image_evidence_units_workspace_isolation ON public.note_image_evidence_units;
CREATE POLICY note_image_evidence_units_workspace_isolation
  ON public.note_image_evidence_units FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.note_image_assets,
      public.note_image_insights,
      public.note_image_evidence_units
    TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT ON public.note_image_assets TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.note_image_insights TO ailearn_worker;
    GRANT SELECT, INSERT ON public.note_image_evidence_units TO ailearn_worker;
  END IF;
END $$;
