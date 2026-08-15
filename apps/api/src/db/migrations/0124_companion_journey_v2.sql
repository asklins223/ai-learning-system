-- 0124: Journey V2 表（文档 16 §10.1）。
--
-- companion_account_invitations：账号级一次性邀请（换 workspace 不重复首邀）；
-- companion_journeys：workspace 级旅程进度（CAS；同一账号至多一个非终态旅程）；
-- companion_journey_pending_events：乱序领域事件 buffer（(journeyId, domainEventId)
--   幂等，JourneyReducer 唯一写 currentStep/refs/completionKind）。
--
-- 权限契约：api CRUD（RLS workspace+user）；worker 只读。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_account_invitations (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'not_offered',
  offered_at timestamptz,
  decided_at timestamptz,
  deferred_until timestamptz,
  replay_requested_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_account_invitations_status_check CHECK (status IN (
    'not_offered', 'offered', 'deferred', 'accepted', 'skipped'
  ))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_account_invitations_status_idx
  ON public.companion_account_invitations (status, deferred_until);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  assistant_session_id uuid,
  status text NOT NULL DEFAULT 'active',
  branch text NOT NULL DEFAULT 'own_material',
  current_step text,
  step_revision integer NOT NULL DEFAULT 0,
  dismissed_narration_steps jsonb NOT NULL DEFAULT '[]',
  refs jsonb NOT NULL DEFAULT '{}',
  last_domain_event_id text,
  paused_at timestamptz,
  pause_reason text,
  resume_token_ref text,
  resume_expires_at timestamptz,
  completion_kind text,
  error jsonb,
  parent_journey_id uuid,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_journeys_status_check CHECK (status IN (
    'active', 'paused', 'skipped', 'completed', 'recoverable_error'
  )),
  CONSTRAINT companion_journeys_branch_check CHECK (branch IN (
    'own_material', 'blank_note', 'sandbox_sample'
  ))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS companion_journeys_user_active_unique_idx
  ON public.companion_journeys (user_id)
  WHERE status IN ('active', 'paused', 'recoverable_error');

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_journeys_workspace_user_idx
  ON public.companion_journeys (workspace_id, user_id, updated_at);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_journey_pending_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id uuid NOT NULL REFERENCES public.companion_journeys(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  domain_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_journey_pending_events_status_check CHECK (status IN (
    'pending', 'applied', 'superseded'
  ))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS companion_journey_pending_events_unique_idx
  ON public.companion_journey_pending_events (journey_id, domain_event_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_journey_pending_events_status_idx
  ON public.companion_journey_pending_events (journey_id, status);

--> statement-breakpoint

-- companion_account_invitations：账号级（无 workspace 列），仅 user 条件。
ALTER TABLE public.companion_account_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_account_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_account_invitations_user_isolation
  ON public.companion_account_invitations;
CREATE POLICY companion_account_invitations_user_isolation
  ON public.companion_account_invitations AS PERMISSIVE FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'companion_journeys',
    'companion_journey_pending_events'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS %I_workspace_user_isolation ON public.%I
    $p$, t, t);
    EXECUTE format($p$
      CREATE POLICY %I_workspace_user_isolation
        ON public.%I AS PERMISSIVE FOR ALL
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
        )
    $p$, t, t);
  END LOOP;
END $$;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_account_invitations TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_journeys TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_journey_pending_events TO ailearn_api;
GRANT SELECT ON public.companion_account_invitations TO ailearn_worker;
GRANT SELECT ON public.companion_journeys TO ailearn_worker;
GRANT SELECT ON public.companion_journey_pending_events TO ailearn_worker;
