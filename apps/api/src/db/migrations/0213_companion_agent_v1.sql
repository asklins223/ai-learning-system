-- 0213: Companion Agent v1 runtime, skills, tools and permission snapshots.
-- The companion conversation tables remain workspace/user scoped. Worker access
-- is granted only inside the existing worker transaction/RLS context.

ALTER TABLE public.user_companion_account_state
  ADD COLUMN IF NOT EXISTS agent_settings jsonb NOT NULL
    DEFAULT '{"version":1,"permissionLevel":"guided","enabledSkillIds":["learning-context","learning-tutor","learning-planner","companion-memory","companion-navigation"]}'::jsonb;

-- Rows created before Agent settings existed have the temporary empty default;
-- normalize those rows to the v1 default. After this migration an explicit []
-- means that the user disabled every built-in Skill.
UPDATE public.user_companion_account_state
SET agent_settings = jsonb_build_object(
  'version', 1,
  'permissionLevel', 'guided',
  'enabledSkillIds', jsonb_build_array(
    'learning-context', 'learning-tutor', 'learning-planner',
    'companion-memory', 'companion-navigation'
  )
)
WHERE agent_settings->>'version' = '1'
  AND jsonb_typeof(agent_settings->'enabledSkillIds') = 'array'
  AND jsonb_array_length(agent_settings->'enabledSkillIds') = 0;

ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS agent_mode text NOT NULL DEFAULT 'hybrid',
  ADD COLUMN IF NOT EXISTS active_skill_id text,
  ADD COLUMN IF NOT EXISTS active_skill_version text,
  ADD COLUMN IF NOT EXISTS permission_level text,
  ADD COLUMN IF NOT EXISTS permission_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS budget_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS step_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tool_call_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS waiting_proposal_id uuid,
  ADD COLUMN IF NOT EXISTS provider_capability_fingerprint text;

ALTER TABLE public.companion_turn_runs
  DROP CONSTRAINT IF EXISTS companion_turn_runs_status_check;
ALTER TABLE public.companion_turn_runs
  ADD CONSTRAINT companion_turn_runs_status_check CHECK (status IN (
    'accepted', 'running', 'waiting_for_confirmation', 'succeeded',
    'cancel_requested', 'cancelled', 'failed', 'superseded'
  ));

DROP INDEX IF EXISTS public.companion_turn_runs_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS companion_turn_runs_active_unique
  ON public.companion_turn_runs (conversation_id)
  WHERE status IN ('accepted', 'running', 'waiting_for_confirmation', 'cancel_requested');

ALTER TABLE public.companion_action_proposals
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS agent_run_id uuid,
  ADD COLUMN IF NOT EXISTS agent_tool_call_id text,
  ADD COLUMN IF NOT EXISTS agent_skill_id text,
  ADD COLUMN IF NOT EXISTS agent_tool_version text,
  ADD COLUMN IF NOT EXISTS risk_class text;

CREATE UNIQUE INDEX IF NOT EXISTS companion_action_proposals_agent_tool_call_unique
  ON public.companion_action_proposals (agent_run_id, agent_tool_call_id)
  WHERE agent_run_id IS NOT NULL AND agent_tool_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS companion_action_proposals_agent_run_idx
  ON public.companion_action_proposals (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.companion_agent_steps (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.companion_turn_runs(id) ON DELETE CASCADE,
  step_no integer NOT NULL CHECK (step_no BETWEEN 1 AND 8),
  kind text NOT NULL CHECK (kind IN ('model', 'tool', 'confirmation', 'final', 'error')),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'waiting', 'failed', 'cancelled')),
  skill_id text,
  request_hash char(64),
  result_hash char(64),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_agent_steps_run_step_unique UNIQUE (run_id, step_no)
);

CREATE INDEX IF NOT EXISTS companion_agent_steps_workspace_run_idx
  ON public.companion_agent_steps (workspace_id, user_id, run_id, step_no);

CREATE TABLE IF NOT EXISTS public.companion_agent_tool_calls (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.companion_turn_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES public.companion_agent_steps(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  name text NOT NULL,
  tool_version text NOT NULL,
  skill_id text NOT NULL,
  arguments jsonb NOT NULL,
  arguments_sha256 char(64) NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('read', 'reversible_low', 'consequential', 'irreversible')),
  status text NOT NULL CHECK (status IN ('requested', 'executing', 'waiting_confirmation', 'succeeded', 'failed', 'blocked', 'expired')),
  proposal_id uuid,
  result_ref text,
  result_safe_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_agent_tool_calls_run_call_unique UNIQUE (run_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS companion_agent_tool_calls_workspace_run_idx
  ON public.companion_agent_tool_calls (workspace_id, user_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS companion_agent_tool_calls_proposal_idx
  ON public.companion_agent_tool_calls (proposal_id)
  WHERE proposal_id IS NOT NULL;

ALTER TABLE public.companion_stream_events
  DROP CONSTRAINT IF EXISTS companion_stream_events_type_check;
ALTER TABLE public.companion_stream_events
  ADD CONSTRAINT companion_stream_events_type_check CHECK (type IN (
    'turn.accepted', 'assistant.status', 'assistant.delta', 'assistant.final',
    'agent.skill', 'agent.tool', 'character.cue', 'action.proposed',
    'action.decision', 'action.expired', 'action.started', 'action.completed',
    'action.failed', 'voice.segment.ready', 'proactive.delivery',
    'proactive.delivery.updated', 'turn.cancelled', 'error'
  ));

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['companion_agent_steps', 'companion_agent_tool_calls'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I_scope_isolation ON public.%I', tbl, tbl);
    EXECUTE format($policy$
      CREATE POLICY %I_scope_isolation ON public.%I FOR ALL
      USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
             AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
      WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
                  AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
    $policy$, tbl, tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO ailearn_worker', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
      EXECUTE format('GRANT SELECT ON public.%I TO ailearn_api', tbl);
    END IF;
  END LOOP;
END $$;

-- New Agent jobs are worker-created through the same allowlist as existing
-- companion memory jobs. Keep the policy idempotent for fresh and upgraded DBs.
DROP POLICY IF EXISTS "worker_type_allowlist_insert_guard" ON public.jobs;
CREATE POLICY "worker_type_allowlist_insert_guard"
  ON public.jobs
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'::name
    AND "type" IN (
      'companion_agent', 'companion_memory_extract', 'companion_summarizer',
      'companion_daily_summary'
    )
  );
