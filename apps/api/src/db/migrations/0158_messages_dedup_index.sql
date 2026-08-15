-- 0158: 移除 companion_messages 冗余 DESC 索引。
--
-- 背景（PERF-WN-5 / 审计发现）：0088 同时建了
-- companion_messages_conversation_seq_unique UNIQUE (conversation_id, seq)
-- 与 companion_messages_conversation_seq_desc_idx (conversation_id, seq DESC)
-- ——同一键序的两份 B-tree，每条 message INSERT 写两棵树（存储 + 写放大）。
-- 唯一约束已覆盖 (conversation_id, seq) 前缀，B-tree 可双向扫描，
-- DESC 索引不提供额外能力，直接删除。

--> statement-breakpoint

DROP INDEX IF EXISTS public.companion_messages_conversation_seq_desc_idx;
