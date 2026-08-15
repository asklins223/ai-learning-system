-- 0118: 修正 learning_task_variants 唯一约束。
--
-- 0116 的 (task_id, revision) 全量唯一与文档 16 §7.4/§12.2 语义冲突：
-- 同一 Task 在 PREPARE 时预签发多个 Variant（text + voice），各自 revision=1；
-- switch_variant 后旧 Variant status=superseded 保留修订历史。只有 active
-- Variant 需要"同 revision 唯一"（防止同 revision 出现两个可提交的 active
-- Variant），superseded/abandoned 历史行可以共享 revision 编号。

--> statement-breakpoint

ALTER TABLE public.learning_task_variants
  DROP CONSTRAINT IF EXISTS learning_task_variants_task_revision_unique;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS learning_task_variants_task_revision_active_unique_idx
  ON public.learning_task_variants (task_id, revision)
  WHERE status = 'active';
