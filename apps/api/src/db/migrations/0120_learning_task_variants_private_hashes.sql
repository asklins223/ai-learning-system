-- 0120: learning_task_variants 冗余 private hash/rubric 目标（P2 权限缺口修复）。
--
-- 0116 的权限契约规定 ailearn_api 对 learning_task_private_solutions /
-- learning_task_safety_reports 仅 INSERT、无 SELECT——而 submission 事务在
-- api 进程中需要 privateSolutionHash / safetyReportHash / rubricTargetIds
-- 才能创建 Artifact 闭包与排队 Assessment。直接读 private 表会
-- permission denied（提交 500）。
--
-- 修复：创建 Variant 时（api 进程持有这些值）把 hash 与 rubric 目标 id
-- 冗余到 variant 行——api 可读自己的行，private 表的 SELECT 隔离保持不破。
-- rubric 目标 id 本身不承载答案（expected 内容仍在 private solution jsonb）。

--> statement-breakpoint

ALTER TABLE public.learning_task_variants
  ADD COLUMN IF NOT EXISTS private_solution_hash text;

--> statement-breakpoint

ALTER TABLE public.learning_task_variants
  ADD COLUMN IF NOT EXISTS safety_report_hash text;

--> statement-breakpoint

ALTER TABLE public.learning_task_variants
  ADD COLUMN IF NOT EXISTS rubric_target_ids jsonb NOT NULL DEFAULT '[]';

--> statement-breakpoint

-- 回填：从 private 表补齐已有行（ailearn_migrator 执行，无 RLS 限制）。
-- 同 variant 多报告时取最新一条。
UPDATE public.learning_task_variants v
SET private_solution_hash = s.private_solution_hash,
    safety_report_hash = (
      SELECT r.report_hash
      FROM public.learning_task_safety_reports r
      WHERE r.variant_id = v.id
      ORDER BY r.created_at DESC
      LIMIT 1
    )
FROM public.learning_task_private_solutions s
WHERE s.variant_id = v.id;

--> statement-breakpoint

ALTER TABLE public.learning_task_variants
  ALTER COLUMN private_solution_hash SET NOT NULL;

--> statement-breakpoint

ALTER TABLE public.learning_task_variants
  ALTER COLUMN safety_report_hash SET NOT NULL;
