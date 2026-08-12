-- 0083: bounded Tutor detours for the Card → Session path.
-- The tables persist lifecycle, permission and nonce state only.  Tutor turns
-- are deliberately represented by a counter; raw chat history is not a second
-- canonical learning stream and is never stored here.

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_tutor_detours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.learning_episodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL,
  question_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  end_reason text,
  question_marker_saved boolean NOT NULL DEFAULT false,
  turn_count integer NOT NULL DEFAULT 0,
  max_turns integer NOT NULL DEFAULT 2,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  last_turn_at timestamptz,
  CONSTRAINT learning_tutor_detours_status_check
    CHECK (status IN ('active', 'ended')),
  CONSTRAINT learning_tutor_detours_end_reason_check
    CHECK (end_reason IS NULL OR end_reason IN ('return_to_origin', 'end_session')),
  CONSTRAINT learning_tutor_detours_turn_count_check
    CHECK (turn_count >= 0 AND turn_count <= max_turns),
  CONSTRAINT learning_tutor_detours_max_turns_check
    CHECK (max_turns = 2)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_tutor_detours_workspace_user_idx
  ON public.learning_tutor_detours (workspace_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS learning_tutor_detours_session_idx
  ON public.learning_tutor_detours (workspace_id, user_id, session_id, episode_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_tutor_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id, target_id)
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_tutor_action_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.learning_sessions(id) ON DELETE CASCADE,
  key_point_id uuid NOT NULL,
  nonce_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_tutor_action_nonces_lookup_idx
  ON public.learning_tutor_action_nonces
  (workspace_id, user_id, session_id, key_point_id, expires_at);

--> statement-breakpoint

ALTER TABLE public.learning_tutor_detours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_tutor_detours FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_tutor_detours_workspace_user_isolation
  ON public.learning_tutor_detours;
CREATE POLICY learning_tutor_detours_workspace_user_isolation
  ON public.learning_tutor_detours FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.learning_tutor_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_tutor_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_tutor_permissions_workspace_user_isolation
  ON public.learning_tutor_permissions;
CREATE POLICY learning_tutor_permissions_workspace_user_isolation
  ON public.learning_tutor_permissions FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

ALTER TABLE public.learning_tutor_action_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_tutor_action_nonces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_tutor_action_nonces_workspace_user_isolation
  ON public.learning_tutor_action_nonces;
CREATE POLICY learning_tutor_action_nonces_workspace_user_isolation
  ON public.learning_tutor_action_nonces FOR ALL
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_tutor_detours TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_tutor_permissions TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_tutor_action_nonces TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT ON public.learning_tutor_detours TO ailearn_worker;
    GRANT SELECT ON public.learning_tutor_permissions TO ailearn_worker;
  END IF;
END $$;
