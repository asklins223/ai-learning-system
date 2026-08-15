-- 0155: card_generation_run_outbox_v2 增加 (run_id, job_type) 唯一约束。
--
-- 背景（PERF-W2 / 审计发现）：同一 run 若被 enqueue 两条同类型 job（API
-- 重试/双击），两个 worker 可能都读到 run.status='planning' 并各自跑完整
-- LLM 管道（双份计费 + 唯一键冲突重试风暴）。唯一约束 + enqueue 侧
-- ON CONFLICT DO NOTHING 提供防重（enqueue 侧接线在激活路径时落地）。
--
-- 表当前无生产写入（未激活路径），建唯一约束安全。

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS cgro_v2_run_job_type_unique
  ON public.card_generation_run_outbox_v2 (run_id, job_type);
