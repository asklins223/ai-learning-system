-- 0119: learning_task_variants 状态枚举加入 standby。
--
-- 文档 16 §7.4：PREPARE 时预签发的备选 Variant 是"预授权但未激活"——
-- 同一 Task 至多一个 active Variant（唯一约束见 0118），备选 Variant 以
-- standby 落库；switch_variant 时 standby→active、旧 active→superseded。

--> statement-breakpoint

ALTER TABLE public.learning_task_variants
  DROP CONSTRAINT IF EXISTS learning_task_variants_status_check;

--> statement-breakpoint

ALTER TABLE public.learning_task_variants
  ADD CONSTRAINT learning_task_variants_status_check CHECK (
    status IN ('active', 'standby', 'superseded', 'abandoned')
  );
