-- 0081: Learning Session processing outbox.
-- The immutable answer artifact, processing phase CAS, and this command row
-- are committed together. Payload is identifier-only; answer text never enters
-- the processing queue.

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_session_processing_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.learning_episodes(id) ON DELETE CASCADE,
  command_type text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_session_processing_outbox_command_check
    CHECK (command_type IN ('assessment_requested', 'commit_requested')),
  CONSTRAINT learning_session_processing_outbox_payload_check
    CHECK (
      NOT (payload ? 'answer')
      AND NOT (payload ? 'answerText')
      AND NOT (payload ? 'userAnswer')
      AND NOT (payload ? 'question')
    ),
  CONSTRAINT learning_session_processing_outbox_scope_key_unique
    UNIQUE (workspace_id, idempotency_key)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_session_processing_outbox_pending_idx
  ON public.learning_session_processing_outbox (available_at, created_at)
  WHERE processed_at IS NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_session_processing_outbox_episode_idx
  ON public.learning_session_processing_outbox (workspace_id, episode_id, created_at);

--> statement-breakpoint

ALTER TABLE public.learning_session_processing_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_session_processing_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_session_processing_outbox_workspace_user_isolation
  ON public.learning_session_processing_outbox;
CREATE POLICY learning_session_processing_outbox_workspace_user_isolation
  ON public.learning_session_processing_outbox FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.learning_session_processing_outbox TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    -- Worker claim/release is a deliberate cross-workspace operation. The
    -- payload contains identifiers only; learning rows remain user-scoped.
    GRANT SELECT, UPDATE ON public.learning_session_processing_outbox TO ailearn_worker;
  END IF;
END $$;
