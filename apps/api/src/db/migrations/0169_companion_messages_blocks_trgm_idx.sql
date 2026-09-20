-- 0169: companion_messages.blocks 的 pg_trgm GIN 索引。
--
-- 背景（PERF-WN / 审计第二轮 #12）：GET /companion/history/search
-- （continuous-history-routes.ts）对 companion_messages 用
-- `blocks::text ILIKE '%keyword%'`。前置通配符无法命中 B-tree，RLS 已把
-- 范围收窄到单 user/workspace，但无 GIN 索引时每次请求仍是该用户全部消息
-- 的全表扫描（LIMIT 只约束返回体积，不约束扫描工作量）。
--
-- pg_trgm 的 GIN 索引支持 `ILIKE '%...%'`，可把扫描从线性退化降为索引
-- 加速的候选扫描。基于 jsonb 列的 text 表达式建 GIN（与 0053 的
-- search_documents 模式一致）。索引不含任何数据语义变更，幂等可重放。

--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS pg_trgm;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_messages_blocks_trgm_idx
  ON public.companion_messages USING gin ((blocks::text) gin_trgm_ops);
