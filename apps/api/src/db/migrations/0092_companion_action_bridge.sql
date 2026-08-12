-- P5 — Trusted Learning Action Bridge（03 §6.6/§6.7）
-- companion_action_proposals / companion_action_runs + turn run 的
-- frozen router decision 字段（只保存 intent/confidence/promptVersion/hash/
-- contextRevision/payloadHash，不保存 classifier prompt body 或重复 user text）。
-- 全部表 workspace+user RLS；proposal 先确认后执行，run 由 worker 慢动作推进。

-- ─── companion_action_proposals ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.companion_action_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  source_message_id uuid NOT NULL REFERENCES public.companion_messages(id),
  source_generation integer NOT NULL CHECK (source_generation >= 0),
  context_grant_id uuid,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  target_summary text NOT NULL CHECK (char_length(target_summary) BETWEEN 1 AND 160),
  impact_summary text NOT NULL CHECK (char_length(impact_summary) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN
    ('pending', 'rejected', 'accepted', 'executing', 'succeeded', 'failed', 'expired')),
  decision text CHECK (decision IN ('confirm', 'reject')),
  decision_key_hash char(64),
  idempotency_key_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 同 conversation 单一 pending proposal（§6.6：create 时校验无其他 pending）
CREATE UNIQUE INDEX IF NOT EXISTS companion_action_proposals_single_pending_idx
  ON public.companion_action_proposals (conversation_id)
  WHERE status = 'pending';

-- 同 key 同 decision 幂等；异参冲突（§6.6）
CREATE UNIQUE INDEX IF NOT EXISTS companion_action_proposals_decision_key_idx
  ON public.companion_action_proposals (decision_key_hash)
  WHERE decision_key_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS companion_action_proposals_workspace_idx
  ON public.companion_action_proposals (workspace_id, user_id);

-- ─── companion_action_runs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.companion_action_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES public.companion_action_proposals(id),
  job_id uuid,
  status text NOT NULL CHECK (status IN
    ('accepted', 'running', 'succeeded', 'failed', 'cancelled')),
  result_message_id uuid REFERENCES public.companion_messages(id),
  result_ref text CHECK (result_ref IS NULL OR char_length(result_ref) BETWEEN 1 AND 240),
  route jsonb,
  safe_summary text CHECK (safe_summary IS NULL OR char_length(safe_summary) BETWEEN 1 AND 240),
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS companion_action_runs_proposal_idx
  ON public.companion_action_runs (proposal_id);

CREATE INDEX IF NOT EXISTS companion_action_runs_workspace_idx
  ON public.companion_action_runs (workspace_id, user_id);

-- ─── companion_turn_runs：frozen router decision（§6.7） ─────────────────
ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS router_intent text,
  ADD COLUMN IF NOT EXISTS router_confidence integer CHECK (router_confidence IS NULL OR router_confidence BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS router_prompt_version text,
  ADD COLUMN IF NOT EXISTS router_prompt_hash char(64),
  ADD COLUMN IF NOT EXISTS router_context_revision char(64),
  ADD COLUMN IF NOT EXISTS router_payload_hash char(64);

-- ─── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.companion_action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_action_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_action_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_action_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY companion_action_proposals_workspace_scope ON public.companion_action_proposals
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid
         AND user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid
              AND user_id = current_setting('app.user_id', true)::uuid);

CREATE POLICY companion_action_runs_workspace_scope ON public.companion_action_runs
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid
         AND user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid
              AND user_id = current_setting('app.user_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON public.companion_action_proposals TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.companion_action_runs TO ailearn_worker;
  END IF;
END $$;
