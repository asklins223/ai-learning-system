-- 0161: 补两张表的 TTL/reap 支撑索引。
--
-- 背景（第五轮 W#6/W#7）：
-- 1) card_generation_agent_events 仅有 (workspace_id, run_id, created_at) 前缀
--    索引，0160 的 `DELETE ... WHERE created_at < now()-90d` 每次全表扫描
--    （该表为最大公共表之一且持续增长）——补裸 created_at 索引。
-- 2) jobs 的 ailearn_reap_stale_jobs（0105）谓词
--    `status='running' AND started_at < X ORDER BY started_at, id` 仅有
--    (status, scheduled_at) 索引——补 (status, started_at) 复合索引。

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS card_generation_agent_events_created_at_idx
  ON public.card_generation_agent_events (created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS jobs_status_started_at_idx
  ON public.jobs (status, started_at);
