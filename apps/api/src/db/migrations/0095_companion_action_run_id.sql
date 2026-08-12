-- P5 §6.6：companion_action_proposals 加 action_run_id（confirm 后指向 run）。
ALTER TABLE public.companion_action_proposals
  ADD COLUMN IF NOT EXISTS action_run_id uuid REFERENCES public.companion_action_runs(id);

CREATE INDEX IF NOT EXISTS companion_action_proposals_run_idx
  ON public.companion_action_proposals (action_run_id)
  WHERE action_run_id IS NOT NULL;
