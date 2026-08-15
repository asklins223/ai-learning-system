-- 0151: companion_stream_events 两个过滤查询补索引。
--
-- 背景（PERF-BN2 / 审计发现）：表 PK = (conversation_id, seq)，仅覆盖
-- conversation_id 前缀；下面的查询无法利用 PK 前缀推进，只能按会话过滤扫描：
--   (a) companion-voice-service.ts:152-163 朗读段快路径
--         WHERE conversation_id=? AND run_id=? AND generation=? AND type='...'
--         AND payload->>'ordinal'=?  → 需要 (conversation_id, run_id, generation, type)
--   (b) companion-conversations-service.ts:253-259 快照恢复
--         WHERE conversation_id=? AND run_id=? ORDER BY seq ASC
--         → 需要 (conversation_id, run_id, seq)
--
-- run_id 等值本可大幅收敛事件集，建复合索引后长会话/多 generation 累计事件
-- 再多也能用 B-tree 前缀直接命中，避免对会话全部历史事件过滤扫描。

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_stream_events_conversation_run_generation_type_idx
  ON public.companion_stream_events (conversation_id, run_id, generation, type)
  WHERE run_id IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_stream_events_conversation_run_seq_idx
  ON public.companion_stream_events (conversation_id, run_id, seq)
  WHERE run_id IS NOT NULL;
