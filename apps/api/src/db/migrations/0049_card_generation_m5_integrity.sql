-- 0049: Learning-card generation engine v2, M6 integrity tightening
--
-- M5 publishes a card set and its overview card as one terminal result. Keep
-- legacy cards/runs nullable, but fail closed for terminal M5 runs and make
-- the published result identity tenant-, run-, and set-safe.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.card_generation_runs AS run
    WHERE run.pipeline_version = 'card-generation-v2-m5'
      AND run.status IN ('succeeded', 'partial_ready')
      AND (
        run.result_card_set_id IS NULL
        OR run.result_card_id IS NULL
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '0049 preflight: terminal M5 runs must reference a result card set and result card';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.card_generation_runs AS run
    WHERE run.pipeline_version = 'card-generation-v2-m5'
      AND run.status IN ('succeeded', 'partial_ready')
      AND NOT EXISTS (
        SELECT 1
        FROM public.learning_cards AS card
        WHERE card.workspace_id = run.workspace_id
          AND card.generation_run_id = run.id
          AND card.card_set_id = run.result_card_set_id
          AND card.id = run.result_card_id
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = '0049 preflight: terminal M5 result cards must belong to their generation run and result card set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.learning_cards AS card
    WHERE (
      card.card_set_id IS NULL
      AND (
        card.generation_run_id IS NOT NULL
        OR card.scope IS NOT NULL
        OR card.scope_key IS NOT NULL
        OR card.ordinal IS NOT NULL
      )
    )
    OR (
      card.card_set_id IS NOT NULL
      AND (
        card.generation_run_id IS NULL
        OR card.scope IS NULL
        OR card.scope_key IS NULL
        OR length(trim(card.scope_key)) = 0
        OR card.ordinal IS NULL
        OR NOT (
          (card.scope = 'overview' AND card.ordinal = 0)
          OR (card.scope = 'section' AND card.ordinal > 0)
        )
      )
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '0049 preflight: learning-card set members have invalid provenance, scope, or ordinal';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.learning_cards AS card
    WHERE card.card_set_id IS NOT NULL
    GROUP BY card.workspace_id, card.card_set_id, card.scope_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = '0049 preflight: scope_key must be unique within each learning-card set';
  END IF;
END
$migration$;
--> statement-breakpoint

ALTER TABLE public.learning_cards
  DROP CONSTRAINT IF EXISTS learning_cards_card_set_shape_check;
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
      AND scope_key IS NOT NULL
      AND length(trim(scope_key)) > 0
      AND ordinal IS NOT NULL
      AND (
        (scope = 'overview' AND ordinal = 0)
        OR (scope = 'section' AND ordinal > 0)
      )
    )
  );
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_generation_set_identity_unique_idx
  ON public.learning_cards(workspace_id, generation_run_id, card_set_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_set_scope_key_unique_idx
  ON public.learning_cards(workspace_id, card_set_id, scope_key)
  WHERE card_set_id IS NOT NULL AND scope_key IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.card_generation_runs
  DROP CONSTRAINT IF EXISTS card_generation_runs_m5_terminal_result_check;
ALTER TABLE public.card_generation_runs
  ADD CONSTRAINT card_generation_runs_m5_terminal_result_check
  CHECK (
    pipeline_version <> 'card-generation-v2-m5'
    OR status NOT IN ('succeeded', 'partial_ready')
    OR (
      result_card_set_id IS NOT NULL
      AND result_card_id IS NOT NULL
    )
  );
--> statement-breakpoint

-- The old SET NULL actions conflict with the terminal-result check. NO ACTION
-- protects published pointers, while deferred checking allows the existing
-- run -> set -> card cascade cycle to remove the whole graph atomically.
ALTER TABLE public.card_generation_runs
  DROP CONSTRAINT IF EXISTS card_generation_runs_result_card_fk;
ALTER TABLE public.card_generation_runs
  ADD CONSTRAINT card_generation_runs_result_card_fk
  FOREIGN KEY (workspace_id, result_card_id)
  REFERENCES public.learning_cards(workspace_id, id)
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

ALTER TABLE public.card_generation_runs
  DROP CONSTRAINT IF EXISTS card_generation_runs_result_card_set_fk;
ALTER TABLE public.card_generation_runs
  ADD CONSTRAINT card_generation_runs_result_card_set_fk
  FOREIGN KEY (workspace_id, id, result_card_set_id)
  REFERENCES public.learning_card_sets(workspace_id, generation_run_id, id)
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

ALTER TABLE public.card_generation_runs
  DROP CONSTRAINT IF EXISTS card_generation_runs_result_card_identity_fk;
ALTER TABLE public.card_generation_runs
  ADD CONSTRAINT card_generation_runs_result_card_identity_fk
  FOREIGN KEY (workspace_id, id, result_card_set_id, result_card_id)
  REFERENCES public.learning_cards(
    workspace_id,
    generation_run_id,
    card_set_id,
    id
  )
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
