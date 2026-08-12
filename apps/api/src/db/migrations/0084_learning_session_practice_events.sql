-- 0084: Learning Session practice/diagnostic events.
--
-- These rows are process evidence only. They are deliberately separate from
-- validation_events/review_attempts/understanding_events and can never drive
-- mastery or scheduling. The payload is a bounded safe summary, not answer
-- text or private rubric content.

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_session_practice_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.learning_episodes(id) ON DELETE CASCADE,
  key_point_id uuid NOT NULL REFERENCES public.card_key_points(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  idempotency_key text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_session_practice_events_type_check
    CHECK (event_type IN ('practice', 'diagnostic')),
  CONSTRAINT learning_session_practice_events_summary_safe_check
    CHECK (
      NOT (summary ? 'answer')
      AND NOT (summary ? 'answerText')
      AND NOT (summary ? 'userAnswer')
      AND NOT (summary ? 'question')
      AND NOT (summary ? 'rationale')
    )
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS learning_session_practice_events_idempotency_idx
  ON public.learning_session_practice_events (workspace_id, user_id, episode_id, idempotency_key);
CREATE INDEX IF NOT EXISTS learning_session_practice_events_session_idx
  ON public.learning_session_practice_events (workspace_id, user_id, session_id, created_at);

--> statement-breakpoint

ALTER TABLE public.learning_session_practice_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_session_practice_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_session_practice_events_workspace_user_isolation
  ON public.learning_session_practice_events;
CREATE POLICY learning_session_practice_events_workspace_user_isolation
  ON public.learning_session_practice_events FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.learning_session_practice_events TO ailearn_api;
  END IF;
END $$;
