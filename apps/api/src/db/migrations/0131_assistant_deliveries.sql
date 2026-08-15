-- 0131: assistant_deliveries（文档 16 §14.3 AssistantDeliveryV2）。
--
-- Orchestrator 主动消息/业务结果的唯一交付通道。inbox 以
-- (workspace_id, user_id) 分区，inbox_sequence 分区内单调；dedupe_key 唯一；
-- display_lease 跨设备只允许一个未过期租约（应用层 CAS）。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.assistant_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_session_id uuid,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  inbox_sequence integer NOT NULL,
  dedupe_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  kind text NOT NULL,
  payload_ref jsonb NOT NULL,
  display_lease jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_deliveries_state_check CHECK (state IN (
    'queued', 'delivered', 'displayed', 'acted', 'dismissed', 'snoozed', 'expired', 'suppressed'
  )),
  CONSTRAINT assistant_deliveries_kind_check CHECK (kind IN (
    'message', 'proposal', 'action_result', 'proactive_cue', 'system_event'
  ))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS assistant_deliveries_inbox_sequence_unique_idx
  ON public.assistant_deliveries (workspace_id, user_id, inbox_sequence);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS assistant_deliveries_dedupe_unique_idx
  ON public.assistant_deliveries (workspace_id, user_id, dedupe_key);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assistant_deliveries_inbox_idx
  ON public.assistant_deliveries (workspace_id, user_id, inbox_sequence);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assistant_deliveries_state_idx
  ON public.assistant_deliveries (state, expires_at);

--> statement-breakpoint

ALTER TABLE public.assistant_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_deliveries_workspace_user_isolation
  ON public.assistant_deliveries;
CREATE POLICY assistant_deliveries_workspace_user_isolation
  ON public.assistant_deliveries FOR ALL
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_deliveries TO ailearn_api;
GRANT SELECT, INSERT, UPDATE ON public.assistant_deliveries TO ailearn_worker;
