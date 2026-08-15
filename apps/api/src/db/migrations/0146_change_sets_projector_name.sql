-- 方案 16 §16.2：projector consumption 唯一约束 (projectorName, sourceEventId)。
-- 单 projector（personal_v2）下 change set 即消费记录；显式命名列 + 唯一索引
-- 满足合同（未来多 projector 不重复消费同一 source event）。

ALTER TABLE public.understanding_change_sets
  ADD COLUMN projector_name text NOT NULL DEFAULT 'personal_v2';

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS understanding_change_sets_projector_source_unique_idx
  ON public.understanding_change_sets (projector_name, source_event_id);
