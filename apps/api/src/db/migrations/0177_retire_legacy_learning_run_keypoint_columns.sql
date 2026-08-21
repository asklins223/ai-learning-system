-- 0177: 删除学习运行域残留的 V1 key_point_id 列
--
-- 0176 已将旧 FK 指向 V2 objective，但当前 LearningRun/Projection schema
-- 已完全以 objective/card V2 contract 为准，不再写入这些列。保留非空旧列
-- 会让新代码的 INSERT 因 NOT NULL 约束失败（例如 POST /learning-runs）。
-- 这些列及其约束属于已退役的兼容层；CASCADE 同时清理对应旧索引/FK。

--> statement-breakpoint

ALTER TABLE public.learning_runs
  DROP COLUMN IF EXISTS key_point_id CASCADE;

ALTER TABLE public.learning_run_private_contracts
  DROP COLUMN IF EXISTS key_point_id CASCADE;

ALTER TABLE public.learning_task_presentation_history
  DROP COLUMN IF EXISTS key_point_id CASCADE;

ALTER TABLE public.canonical_learning_event_outbox
  DROP COLUMN IF EXISTS key_point_id CASCADE;

ALTER TABLE public.practice_trail_event_outbox
  DROP COLUMN IF EXISTS key_point_id CASCADE;
