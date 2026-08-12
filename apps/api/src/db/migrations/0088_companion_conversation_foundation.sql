-- 0088: P2 companion conversation foundation（03 合同 §7.1–§7.6 六张表）
--
-- 创建六张表：companion_conversations / companion_messages / companion_turn_runs /
-- companion_stream_events / companion_voice_artifacts / companion_proactive_deliveries。
-- 全部 ENABLE + FORCE ROW LEVEL SECURITY，policy 同时匹配 app.workspace_id 与
-- app.user_id（03 §8）。voice_artifacts 在 P2 保持空表且无写路径（P3 启用 provenance）。

-- ─── 7.1 companion_conversations ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.companion_conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  kind text NOT NULL CHECK (kind IN ('dialogue', 'inbox')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  title_source text NOT NULL CHECK (title_source IN ('placeholder', 'auto', 'user', 'system')),
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  next_message_seq bigint NOT NULL DEFAULT 1 CHECK (next_message_seq >= 1),
  next_event_seq bigint NOT NULL DEFAULT 1 CHECK (next_event_seq >= 1),
  next_generation integer NOT NULL DEFAULT 1 CHECK (next_generation >= 1),
  summary_text text CHECK (summary_text IS NULL OR char_length(summary_text) <= 20000),
  summary_version integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS companion_conversations_activity_idx
  ON public.companion_conversations
  (workspace_id, user_id, COALESCE(last_message_at, created_at) DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS companion_conversations_inbox_active_unique
  ON public.companion_conversations (workspace_id, user_id)
  WHERE kind = 'inbox' AND status = 'active';

-- ─── 7.2 companion_messages ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.companion_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq >= 1),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  kind text NOT NULL CHECK (kind IN ('text', 'voice_transcript', 'proactive', 'action', 'result', 'error')),
  blocks jsonb NOT NULL,
  run_id uuid,
  client_message_id uuid,
  content_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  CONSTRAINT companion_messages_conversation_seq_unique UNIQUE (conversation_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS companion_messages_client_message_unique
  ON public.companion_messages (conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS companion_messages_conversation_seq_desc_idx
  ON public.companion_messages (conversation_id, seq DESC);

-- ─── 7.3 companion_turn_runs ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.companion_turn_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  user_message_id uuid NOT NULL REFERENCES public.companion_messages(id),
  assistant_message_id uuid REFERENCES public.companion_messages(id),
  job_id uuid,
  generation integer NOT NULL CHECK (generation >= 1),
  status text NOT NULL CHECK (status IN ('accepted', 'running', 'succeeded', 'cancel_requested', 'cancelled', 'failed', 'superseded')),
  idempotency_key_hash char(64) NOT NULL,
  request_body_hash char(64) NOT NULL,
  provider_id text,
  model_id text,
  prompt_version text,
  page_context jsonb,
  context_grant_id uuid,
  cancel_requested_at timestamptz,
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_turn_runs_conversation_generation_unique UNIQUE (conversation_id, generation),
  CONSTRAINT companion_turn_runs_idempotency_unique UNIQUE (conversation_id, idempotency_key_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS companion_turn_runs_active_unique
  ON public.companion_turn_runs (conversation_id)
  WHERE status IN ('accepted', 'running', 'cancel_requested');

CREATE UNIQUE INDEX IF NOT EXISTS companion_turn_runs_job_id_unique
  ON public.companion_turn_runs (job_id)
  WHERE job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS companion_turn_runs_context_grant_unique
  ON public.companion_turn_runs (context_grant_id)
  WHERE context_grant_id IS NOT NULL;

-- ─── 7.4 companion_stream_events ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.companion_stream_events (
  conversation_id uuid NOT NULL REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq >= 1),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  run_id uuid,
  generation integer NOT NULL CHECK (generation >= 0),
  account_epoch integer NOT NULL CHECK (account_epoch >= 0),
  type text NOT NULL CHECK (type IN (
    'turn.accepted', 'assistant.status', 'assistant.delta', 'assistant.final',
    'character.cue', 'action.proposed', 'action.decision', 'action.expired',
    'action.started', 'action.completed', 'action.failed', 'voice.segment.ready',
    'proactive.delivery', 'proactive.delivery.updated', 'turn.cancelled', 'error'
  )),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS companion_stream_events_expires_idx
  ON public.companion_stream_events (expires_at);

-- ─── 7.5 companion_voice_artifacts（P2 空表，无写路径） ───────────────────

CREATE TABLE IF NOT EXISTS public.companion_voice_artifacts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid,
  message_id uuid,
  status text NOT NULL CHECK (status IN ('pending', 'attached', 'expired')),
  transcript_sha256 char(64) NOT NULL,
  asr_provider text NOT NULL,
  asr_model text NOT NULL,
  language text NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 200 AND 60000),
  raw_audio_persisted boolean NOT NULL DEFAULT false CHECK (raw_audio_persisted = false),
  expires_at timestamptz NOT NULL,
  attached_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_voice_artifacts_state_check CHECK (
    (status IN ('pending', 'expired') AND conversation_id IS NULL AND message_id IS NULL AND attached_at IS NULL)
    OR
    (status = 'attached' AND conversation_id IS NOT NULL AND message_id IS NOT NULL AND attached_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS companion_voice_artifacts_message_unique
  ON public.companion_voice_artifacts (message_id)
  WHERE status = 'attached';

-- ─── 7.6 companion_proactive_deliveries ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.companion_proactive_deliveries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  permit_id text NOT NULL,
  conversation_id uuid REFERENCES public.companion_conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.companion_messages(id),
  reason_id text NOT NULL,
  suggestion_class_id text NOT NULL,
  content_policy text NOT NULL CHECK (content_policy IN ('content', 'content_hidden')),
  status text NOT NULL CHECK (status IN ('pending', 'shown', 'suppressed', 'dismissed', 'expired')),
  content_claimed_device_session_hash char(64),
  expires_at timestamptz NOT NULL,
  first_presented_at timestamptz,
  shown_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_proactive_deliveries_permit_unique UNIQUE (permit_id)
);

-- ─── RLS（03 §8）：全部六表 ENABLE + FORCE，policy 匹配 workspace+user ────

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'companion_conversations',
    'companion_messages',
    'companion_turn_runs',
    'companion_stream_events',
    'companion_voice_artifacts',
    'companion_proactive_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format($p$CREATE POLICY %I_scope_isolation ON public.%I FOR ALL
      USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
             AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
      WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
                  AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)$p$,
      tbl, tbl);
  END LOOP;
END $$;

-- ─── Grants（role-bootstrap 幂等） ────────────────────────────────────────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    -- Worker：turn run 状态机与事件追加（仍通过 SECURITY DEFINER 事务函数操作，
    -- 直连仅限本 workspace 上下文的只读/追加）。
    GRANT SELECT ON public.companion_conversations TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.companion_turn_runs TO ailearn_worker;
    GRANT SELECT, INSERT ON public.companion_stream_events TO ailearn_worker;
    GRANT SELECT ON public.companion_messages TO ailearn_worker;
  END IF;
END $$;
