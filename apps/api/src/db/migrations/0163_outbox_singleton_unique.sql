-- 0162: 修正 0155 的唯一约束——只对每 run 单例 job 类型生效。
--
-- 背景（第六轮发现）：0155 的 `cgro_v2_run_job_type_unique (run_id, job_type)`
-- 对**全部** job 类型唯一。但 recheck/regenerate 是 per-candidate 语义
-- （worker 按 payload.candidateId 处理单个候选）——同一 run 编辑/重生成
-- 多个候选会入队多个同类型 job，全类型唯一约束 + 入队侧 onConflictDoNothing
-- （W#2）会把第二个 job **静默吞掉**（recheck 永远不执行）。500 崩溃变成了
-- 静默丢任务，比约束之前更糟。
--
-- 修复：唯一约束收窄为每 run 单例的 job 类型
-- （card_generation_plan / card_v2_post_activation）——这两种天然每 run 一条；
-- recheck/regenerate/replan 允许同 run 多行（worker 端有 run 行 FOR UPDATE
-- 串行化，多 job 安全）。入队侧 onConflictDoNothing 保留（对单例类型防重
-- 正确；对多实例类型不再有约束可撞）。

--> statement-breakpoint

DROP INDEX IF EXISTS public.cgro_v2_run_job_type_unique;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS cgro_v2_run_singleton_job_type_unique
  ON public.card_generation_run_outbox_v2 (run_id, job_type)
  WHERE job_type IN ('card_generation_plan', 'card_v2_post_activation');
