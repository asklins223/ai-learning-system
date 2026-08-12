-- P5 §6.7：companion_messages 加 action_ref（assistant confirmation message
-- 带 action_ref 指向 proposal；proposal 删除随 message 级联策略由 FK 定义）。
ALTER TABLE public.companion_messages
  ADD COLUMN IF NOT EXISTS action_ref uuid REFERENCES public.companion_action_proposals(id);

CREATE INDEX IF NOT EXISTS companion_messages_action_ref_idx
  ON public.companion_messages (action_ref)
  WHERE action_ref IS NOT NULL;
