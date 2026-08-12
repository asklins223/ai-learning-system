-- 0110_companion_messages_workspace_user_idx.sql
-- 2026-08-11（性能专项，第九轮）：
-- companion_export 的 messages 全量查询按
--   WHERE workspace_id + user_id ORDER BY (conversation_id, seq)
-- 现有索引仅有 (conversation_id, seq)（companion_messages_conversation_seq_desc_idx）
-- 与 client_message 唯一索引，导出/对账场景会全表扫描或需回表。
-- 补 workspace_id + user_id 引导的复合索引。

CREATE INDEX IF NOT EXISTS "companion_messages_workspace_user_conv_seq_idx"
  ON public.companion_messages USING btree ("workspace_id", "user_id", "conversation_id", "seq" DESC);
