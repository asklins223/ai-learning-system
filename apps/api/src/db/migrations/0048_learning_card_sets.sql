-- 0048: Learning-card generation engine v2, M5 card-set product model
--
-- Card sets become the publish/supersede boundary. New cards carry typed set
-- and generation provenance, while all new columns remain nullable so legacy
-- cards continue to load unchanged.

CREATE UNIQUE INDEX IF NOT EXISTS card_generation_runs_workspace_identity_unique_idx
  ON public.card_generation_runs(workspace_id, id, note_id, note_version_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_card_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  note_id uuid NOT NULL,
  note_version_id uuid NOT NULL,
  generation_run_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  title text NOT NULL,
  summary text NOT NULL,
  coverage_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  superseded_at timestamptz
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_card_sets
    ADD CONSTRAINT learning_card_sets_status_check
    CHECK (status IN ('draft', 'active', 'partial_ready', 'superseded', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.learning_card_sets
    ADD CONSTRAINT learning_card_sets_title_check
    CHECK (length(trim(title)) > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.learning_card_sets
    ADD CONSTRAINT learning_card_sets_coverage_report_check
    CHECK (jsonb_typeof(coverage_report) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.learning_card_sets
  DROP CONSTRAINT IF EXISTS learning_card_sets_timestamps_check;
ALTER TABLE public.learning_card_sets
  ADD CONSTRAINT learning_card_sets_timestamps_check
  CHECK (
    (activated_at IS NULL OR activated_at >= created_at)
    AND (
      superseded_at IS NULL
      OR (
        superseded_at >= created_at
        AND (activated_at IS NULL OR superseded_at >= activated_at)
      )
    )
  );
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS learning_card_sets_workspace_id_unique_idx
  ON public.learning_card_sets(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS learning_card_sets_generation_run_unique_idx
  ON public.learning_card_sets(workspace_id, generation_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS learning_card_sets_generation_identity_unique_idx
  ON public.learning_card_sets(workspace_id, generation_run_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS learning_card_sets_active_note_unique_idx
  ON public.learning_card_sets(workspace_id, note_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS learning_card_sets_note_version_idx
  ON public.learning_card_sets(workspace_id, note_id, note_version_id, created_at);
CREATE INDEX IF NOT EXISTS learning_card_sets_status_idx
  ON public.learning_card_sets(workspace_id, status, created_at);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_card_sets
    ADD CONSTRAINT learning_card_sets_note_fk
    FOREIGN KEY (workspace_id, note_id)
    REFERENCES public.notes(workspace_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.learning_card_sets
    ADD CONSTRAINT learning_card_sets_version_fk
    FOREIGN KEY (workspace_id, note_id, note_version_id)
    REFERENCES public.note_versions(workspace_id, note_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.learning_card_sets
    ADD CONSTRAINT learning_card_sets_generation_run_fk
    FOREIGN KEY (workspace_id, generation_run_id, note_id, note_version_id)
    REFERENCES public.card_generation_runs(workspace_id, id, note_id, note_version_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE public.learning_cards
  ADD COLUMN IF NOT EXISTS card_set_id uuid,
  ADD COLUMN IF NOT EXISTS generation_run_id uuid,
  ADD COLUMN IF NOT EXISTS scope text,
  ADD COLUMN IF NOT EXISTS scope_key text,
  ADD COLUMN IF NOT EXISTS ordinal integer;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_cards
    ADD CONSTRAINT learning_cards_card_set_shape_check
    CHECK (
      (
        card_set_id IS NULL
        AND generation_run_id IS NULL
        AND scope IS NULL
        AND scope_key IS NULL
        AND ordinal IS NULL
      )
      OR
      (
        card_set_id IS NOT NULL
        AND generation_run_id IS NOT NULL
        AND scope IN ('overview', 'section')
        AND scope_key IS NOT NULL
        AND length(trim(scope_key)) > 0
        AND ordinal IS NOT NULL
        AND ordinal >= 0
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS public.learning_cards_workspace_note_version_active_unique_idx;
CREATE INDEX IF NOT EXISTS learning_cards_workspace_note_version_active_idx
  ON public.learning_cards(workspace_id, note_version_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_workspace_note_version_legacy_active_unique_idx
  ON public.learning_cards(workspace_id, note_version_id)
  WHERE status = 'active' AND card_set_id IS NULL;
CREATE INDEX IF NOT EXISTS learning_cards_set_idx
  ON public.learning_cards(workspace_id, card_set_id, ordinal);
CREATE INDEX IF NOT EXISTS learning_cards_generation_run_idx
  ON public.learning_cards(workspace_id, generation_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_set_ordinal_unique_idx
  ON public.learning_cards(workspace_id, card_set_id, ordinal)
  WHERE card_set_id IS NOT NULL AND ordinal IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_set_overview_unique_idx
  ON public.learning_cards(workspace_id, card_set_id)
  WHERE card_set_id IS NOT NULL AND scope = 'overview';
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_cards
    ADD CONSTRAINT learning_cards_card_set_generation_fk
    FOREIGN KEY (workspace_id, generation_run_id, card_set_id)
    REFERENCES public.learning_card_sets(workspace_id, generation_run_id, id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.card_generation_runs
    ADD CONSTRAINT card_generation_runs_result_card_set_fk
    FOREIGN KEY (workspace_id, id, result_card_set_id)
    REFERENCES public.learning_card_sets(workspace_id, generation_run_id, id)
    ON DELETE SET NULL (result_card_set_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE public.learning_card_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_card_sets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_card_sets_workspace_isolation
  ON public.learning_card_sets;
CREATE POLICY learning_card_sets_workspace_isolation
  ON public.learning_card_sets FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint

-- Keep deployed least-privilege roles usable before roles.sql is replayed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.learning_card_sets TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, INSERT, UPDATE
      ON public.learning_card_sets TO ailearn_worker;
  END IF;
END $$;
