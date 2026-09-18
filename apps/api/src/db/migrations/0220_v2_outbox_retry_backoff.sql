-- 0220: card_generation_run_outbox_v2 增加重试退避列 next_attempt_at。
--
-- 背景（2026-09-15 管线评审 H1）：retryable 失败此前直接把 status 置回
-- 'pending'（attempts + 1），下一个 poll 立刻重新认领——没有任何退避。V2 管道
-- 是分钟级多轮 LLM 调用（planner→author→grounding→pedagogy，单 job 最多 ~60 次
-- 模型调用），密集即时重试在 429/5xx 时形成重试风暴，且每次重试都**重放**已付费
-- 的前置阶段。dev 库实测：13 个 job 各自对 HTTP 402 空转 7 次。
--
-- 修复：可重试失败时写入指数退避的下次可认领时间（15s → 30s → 60s → 120s →
-- 240s，封顶 300s），claim 侧只领取 `next_attempt_at IS NULL OR next_attempt_at
-- <= now()` 的行。退避是纯粹的排队延迟，不改变 attempts ≤ 6 的重试上限与
-- fail-closed 语义（重试耗尽仍 failed → run needs_attention）。
--
-- 表当前无生产写入（未激活路径）；加列 + 索引重建为安全操作。

--> statement-breakpoint

ALTER TABLE public.card_generation_run_outbox_v2
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

--> statement-breakpoint

COMMENT ON COLUMN public.card_generation_run_outbox_v2.next_attempt_at IS
  '可重试失败后的下次可认领时间（指数退避）；NULL = 立即可认领。';

--> statement-breakpoint

-- claim：按 status='pending' + 退避到期 ORDER BY created_at 领取
--（0163 之前的 cgro_v2_pending_claim_idx 不含退避列，无法服务新过滤条件）。
DROP INDEX IF EXISTS public.cgro_v2_pending_claim_idx;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS cgro_v2_pending_claim_idx
  ON public.card_generation_run_outbox_v2 (status, next_attempt_at, created_at)
  WHERE status = 'pending';
