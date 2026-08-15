-- 方案 16 §7.8：learning_task_presentation_history 关联 run_id——
-- Run 结算时按 runId 幂等回填 outcome/exposed（轮换检查与 exposure 统计）。

ALTER TABLE public.learning_task_presentation_history
  ADD COLUMN run_id uuid REFERENCES public.learning_runs(id) ON DELETE CASCADE;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_task_pres_hist_run_idx
  ON public.learning_task_presentation_history (run_id);
