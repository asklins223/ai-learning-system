-- 0164: 三张表的查询支撑索引（第七轮 N#7-6/N#7-7/N#7-10）。
--
-- 背景：
-- 1) 投影 outbox（canonical/practice）principal GET（projection-routes.ts:225-252）
--    按 (workspace_id, user_id, status, created_at DESC) 过滤排序，现有
--    status_idx(status, created_at) 与 runScopeUnique 均无法前缀服务 → 全扫描。
--    补两表复合索引（practice 多 scope 维度）。
-- 2) import 幂等（import/routes.ts:289-302）对 note_versions.content_json
--    做 JSONB path 过滤（->>'importId'），无 GIN 索引 → 全表扫描（advisory
--    锁事务内重试放大）。补 jsonb_ops GIN 索引。
-- 3) listSources（source/service.ts:197-207）按 (created_at DESC, id) 游标
--    分页，现有 sources_workspace_updated_idx 不服务该排序 → 每页全分区排序。
--    补 (workspace_id, created_at DESC, id)。

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS canonical_learning_event_outbox_ws_user_status_time_idx
  ON public.canonical_learning_event_outbox (workspace_id, user_id, status, created_at DESC);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS practice_trail_event_outbox_ws_user_scope_status_time_idx
  ON public.practice_trail_event_outbox (workspace_id, user_id, scope, status, created_at DESC);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS note_versions_content_json_gin_idx
  ON public.note_versions USING gin (content_json jsonb_ops);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sources_workspace_created_idx
  ON public.sources (workspace_id, created_at DESC, id);
