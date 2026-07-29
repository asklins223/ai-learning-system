-- 0044: Learning-card generation engine v2, M1 bridge
--
-- Introduces the durable business run/event model, immutable generation
-- snapshots, and the generation-epoch ordering fence while the execution path
-- still delegates to the legacy generate_card handler.

ALTER TABLE public.note_versions
  ADD COLUMN IF NOT EXISTS sealed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sealed_reason text;
--> statement-breakpoint

ALTER TABLE public.notes
  ADD COLUMN IF NOT EXISTS card_generation_epoch integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latest_generation_run_id uuid;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS notes_workspace_id_unique_idx
  ON public.notes(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS note_versions_workspace_note_id_id_unique_idx
  ON public.note_versions(workspace_id, note_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_workspace_id_unique_idx
  ON public.learning_cards(workspace_id, id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.card_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  note_id uuid NOT NULL,
  note_version_id uuid NOT NULL,
  requested_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  request_idempotency_key text NOT NULL,
  generation_fingerprint text NOT NULL,
  generation_epoch integer NOT NULL,
  supersedes_run_id uuid,

  title_snapshot text NOT NULL,
  source_content_hash text NOT NULL,
  block_manifest_hash text NOT NULL,
  asset_manifest_hash text NOT NULL,
  block_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  asset_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,

  pipeline_version text NOT NULL DEFAULT 'card-generation-v2-m1',
  prompt_bundle_version text NOT NULL DEFAULT 'legacy-card-v1',
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  governance_policy_version text NOT NULL DEFAULT 'workspace-policy-snapshot-v1',

  status text NOT NULL DEFAULT 'queued',
  stage text NOT NULL DEFAULT 'queued',
  state_version integer NOT NULL DEFAULT 1,
  next_event_sequence integer NOT NULL DEFAULT 1,
  error_code text,
  retryable boolean NOT NULL DEFAULT false,

  required_units integer NOT NULL DEFAULT 0,
  completed_units integer NOT NULL DEFAULT 0,
  failed_units integer NOT NULL DEFAULT 0,
  required_images integer NOT NULL DEFAULT 0,
  completed_images integer NOT NULL DEFAULT 0,
  source_coverage_bps integer,
  image_coverage_bps integer,
  coverage_report jsonb NOT NULL DEFAULT '{}'::jsonb,

  result_card_set_id uuid,
  result_card_id uuid,
  legacy_job_id uuid,
  exclusion_policy jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  cancel_requested_at timestamptz,

  CONSTRAINT card_generation_runs_status_check CHECK (
    status IN (
      'queued', 'planning', 'awaiting_assets', 'mapping', 'reducing',
      'rendering', 'validating', 'publishing', 'needs_attention',
      'partial_ready', 'succeeded', 'cancelled', 'superseded'
    )
  ),
  CONSTRAINT card_generation_runs_stage_check CHECK (
    stage IN (
      'queued', 'snapshot', 'planner', 'image_analysis', 'text_map',
      'section_reduce', 'deck_plan', 'card_render', 'global_verify',
      'publish', 'legacy_generate', 'complete'
    )
  ),
  CONSTRAINT card_generation_runs_epoch_positive CHECK (generation_epoch > 0),
  CONSTRAINT card_generation_runs_state_version_positive CHECK (state_version > 0),
  CONSTRAINT card_generation_runs_event_sequence_positive CHECK (next_event_sequence > 0),
  CONSTRAINT card_generation_runs_progress_nonnegative CHECK (
    required_units >= 0 AND completed_units >= 0 AND failed_units >= 0
    AND required_images >= 0 AND completed_images >= 0
  ),
  CONSTRAINT card_generation_runs_coverage_range CHECK (
    (source_coverage_bps IS NULL OR source_coverage_bps BETWEEN 0 AND 10000)
    AND (image_coverage_bps IS NULL OR image_coverage_bps BETWEEN 0 AND 10000)
  ),
  CONSTRAINT card_generation_runs_note_fk
    FOREIGN KEY (workspace_id, note_id)
    REFERENCES public.notes(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT card_generation_runs_version_fk
    FOREIGN KEY (workspace_id, note_id, note_version_id)
    REFERENCES public.note_versions(workspace_id, note_id, id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_runs_workspace_id_unique_idx
  ON public.card_generation_runs(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_runs_request_idem_unique_idx
  ON public.card_generation_runs(workspace_id, request_idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_runs_note_epoch_unique_idx
  ON public.card_generation_runs(workspace_id, note_id, generation_epoch);
CREATE UNIQUE INDEX IF NOT EXISTS card_generation_runs_active_fingerprint_unique_idx
  ON public.card_generation_runs(workspace_id, note_version_id, generation_fingerprint)
  WHERE status NOT IN ('succeeded', 'cancelled', 'superseded');
CREATE INDEX IF NOT EXISTS card_generation_runs_note_created_idx
  ON public.card_generation_runs(workspace_id, note_id, created_at);
CREATE INDEX IF NOT EXISTS card_generation_runs_status_idx
  ON public.card_generation_runs(workspace_id, status, updated_at);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.card_generation_runs
    ADD CONSTRAINT card_generation_runs_supersedes_fk
    FOREIGN KEY (workspace_id, supersedes_run_id)
    REFERENCES public.card_generation_runs(workspace_id, id)
    ON DELETE SET NULL (supersedes_run_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.card_generation_runs
    ADD CONSTRAINT card_generation_runs_result_card_fk
    FOREIGN KEY (workspace_id, result_card_id)
    REFERENCES public.learning_cards(workspace_id, id)
    ON DELETE SET NULL (result_card_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.notes
    ADD CONSTRAINT notes_latest_generation_run_fk
    FOREIGN KEY (workspace_id, latest_generation_run_id)
    REFERENCES public.card_generation_runs(workspace_id, id)
    ON DELETE SET NULL (latest_generation_run_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.card_generation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  sequence integer NOT NULL,
  stage text NOT NULL,
  state text NOT NULL,
  completed integer,
  total integer,
  unit text,
  message_code text NOT NULL,
  safe_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_generation_events_sequence_positive CHECK (sequence > 0),
  CONSTRAINT card_generation_events_progress_nonnegative CHECK (
    (completed IS NULL OR completed >= 0)
    AND (total IS NULL OR total >= 0)
  ),
  CONSTRAINT card_generation_events_run_fk
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.card_generation_runs(workspace_id, id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_events_run_sequence_unique_idx
  ON public.card_generation_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS card_generation_events_workspace_run_idx
  ON public.card_generation_events(workspace_id, run_id, sequence);
--> statement-breakpoint

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS generation_run_id uuid,
  ADD COLUMN IF NOT EXISTS generation_unit_id uuid,
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS resource_class text NOT NULL DEFAULT 'maintenance',
  ADD COLUMN IF NOT EXISTS idempotency_key text;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_generation_run_fk
    FOREIGN KEY (workspace_id, generation_run_id)
    REFERENCES public.card_generation_runs(workspace_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS jobs_generation_run_idx
  ON public.jobs(generation_run_id, stage, status);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_workspace_idempotency_unique_idx
  ON public.jobs(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
UPDATE public.jobs
SET
  priority = CASE type
    WHEN 'evaluate_validation' THEN 100
    WHEN 'generate_validation_question' THEN 100
    WHEN 'parse_source' THEN 70
    WHEN 'generate_card' THEN 50
    WHEN 'align_evidence' THEN 10
    ELSE 50
  END,
  resource_class = CASE type
    WHEN 'evaluate_validation' THEN 'interactive_ai'
    WHEN 'generate_validation_question' THEN 'interactive_ai'
    WHEN 'parse_source' THEN 'card_foreground'
    WHEN 'generate_card' THEN 'card_foreground'
    WHEN 'align_evidence' THEN 'maintenance'
    ELSE resource_class
  END
WHERE generation_run_id IS NULL;
--> statement-breakpoint

-- Prefer the explicit resource class/priority while retaining a type fallback
-- for old producers that have not yet been migrated. Interactive validation
-- always wins the next free slot over card fan-out work.
CREATE OR REPLACE FUNCTION public.ailearn_claim_jobs(
  p_limit integer,
  p_max_attempts integer
)
RETURNS TABLE (
  id uuid,
  type text,
  payload jsonb,
  workspace_id uuid,
  requested_by uuid,
  attempts integer,
  lease_token text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH claim_parameters AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 1), 32)) AS claim_limit,
      greatest(1, least(coalesce(p_max_attempts, 3), 10)) AS max_attempts,
      clock_timestamp() AS claimed_at
  ), candidates AS MATERIALIZED (
    SELECT j.id
    FROM public.jobs AS j
    CROSS JOIN claim_parameters AS parameters
    WHERE j.status = 'pending'
      AND j.attempts < parameters.max_attempts
      AND j.scheduled_at <= parameters.claimed_at
    ORDER BY
      CASE
        WHEN j.resource_class = 'interactive_ai' THEN 1000
        ELSE 0
      END
      + greatest(
          j.priority,
          CASE j.type
            WHEN 'evaluate_validation' THEN 100
            WHEN 'generate_validation_question' THEN 100
            WHEN 'parse_source' THEN 70
            WHEN 'generate_card' THEN 50
            WHEN 'align_evidence' THEN 10
            ELSE 50
          END
        ) DESC,
      j.scheduled_at,
      j.id
    LIMIT (SELECT claim_limit FROM claim_parameters)
    FOR UPDATE OF j SKIP LOCKED
  ), claimed AS (
    UPDATE public.jobs AS j
    SET
      status = 'running',
      started_at = parameters.claimed_at,
      finished_at = NULL,
      lease_token = pg_catalog.gen_random_uuid()::text
    FROM candidates
    CROSS JOIN claim_parameters AS parameters
    WHERE j.id = candidates.id
      AND j.status = 'pending'
    RETURNING
      j.id,
      j.type,
      j.payload,
      j.workspace_id,
      j.requested_by,
      j.attempts,
      j.lease_token
  )
  SELECT
    claimed.id,
    claimed.type,
    claimed.payload,
    claimed.workspace_id,
    claimed.requested_by,
    claimed.attempts,
    claimed.lease_token
  FROM claimed;
$function$;
--> statement-breakpoint

-- Once a run seals a note version, its snapshot fields and blocks are immutable.
-- Cascading physical deletion of an entire note remains possible.
CREATE OR REPLACE FUNCTION public.ailearn_guard_sealed_note_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.sealed_at IS NOT NULL AND (
    NEW.note_id IS DISTINCT FROM OLD.note_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.version_no IS DISTINCT FROM OLD.version_no
    OR NEW.content_json IS DISTINCT FROM OLD.content_json
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
    OR NEW.sealed_reason IS DISTINCT FROM OLD.sealed_reason
  ) THEN
    RAISE EXCEPTION 'sealed note version % is immutable', OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' AND OLD.sealed_at IS NOT NULL AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'sealed note version % cannot be deleted directly', OLD.id
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS note_versions_sealed_guard ON public.note_versions;
CREATE TRIGGER note_versions_sealed_guard
  BEFORE UPDATE OR DELETE ON public.note_versions
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_guard_sealed_note_version();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_guard_sealed_note_blocks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_version_id uuid;
  target_sealed_at timestamptz;
BEGIN
  target_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT sealed_at INTO target_sealed_at
  FROM public.note_versions
  WHERE id = target_version_id;

  IF target_sealed_at IS NOT NULL
     AND NOT (TG_OP = 'DELETE' AND pg_trigger_depth() > 1) THEN
    RAISE EXCEPTION 'blocks for sealed note version % are immutable', target_version_id
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS note_blocks_sealed_guard ON public.note_blocks;
CREATE TRIGGER note_blocks_sealed_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.note_blocks
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_guard_sealed_note_blocks();
--> statement-breakpoint

ALTER TABLE public.card_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS card_generation_runs_workspace_isolation
  ON public.card_generation_runs;
CREATE POLICY card_generation_runs_workspace_isolation
  ON public.card_generation_runs FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS card_generation_events_workspace_select
  ON public.card_generation_events;
CREATE POLICY card_generation_events_workspace_select
  ON public.card_generation_events FOR SELECT
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS card_generation_events_workspace_insert
  ON public.card_generation_events;
CREATE POLICY card_generation_events_workspace_insert
  ON public.card_generation_events FOR INSERT
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint

-- Keep deployed least-privilege roles usable even before roles.sql is replayed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.card_generation_runs TO ailearn_api;
    GRANT SELECT, INSERT ON public.card_generation_events TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, UPDATE ON public.card_generation_runs TO ailearn_worker;
    GRANT SELECT, INSERT ON public.card_generation_events TO ailearn_worker;
  END IF;
END $$;
