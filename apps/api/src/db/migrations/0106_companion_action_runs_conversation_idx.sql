-- 0106: companion_action_runs conversation_id 索引（L6）。
-- 0092 只建了 workspace_idx；proposal create/decision 与 DELETE conversation
-- 都按 conversation_id 扫 action_runs，缺索引时随行数线性退化。

CREATE INDEX IF NOT EXISTS companion_action_runs_conversation_idx
  ON public.companion_action_runs (conversation_id);

CREATE INDEX IF NOT EXISTS companion_action_proposals_conversation_idx
  ON public.companion_action_proposals (conversation_id);
