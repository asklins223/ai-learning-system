-- 0089: companion_turn_runs.last_event_seq（03 §4.3 CompanionTurnRunV1.lastEventSeq）
-- 0088 漏建该列；SSE/幂等恢复需要每个 run 的最后一个 durable event seq。
ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS last_event_seq bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0);
