-- 0154: card_generation_run_outbox_v2 增加租约列 + claim/reaper 索引。
--
-- 背景（PERF-W1 / 审计发现）：V2 outbox 的 claim 只把 status 置 'processing'，
-- 无 lease_token / lease_expires_at / started_at——worker 崩溃后行永久卡在
-- 'processing'（无 reaper 可回收），complete/fail 也无租约门闩（迟到完成可
-- 覆盖他人已重领的行）。此处补齐租约三列，并配套 claim（status='pending'
-- ORDER BY created_at）与 reaper（status='processing' AND lease_expires_at
-- < now()）的支撑索引。
--
-- 表当前无生产写入（未激活路径），加列/重置孤儿均为安全操作。

--> statement-breakpoint

ALTER TABLE public.card_generation_run_outbox_v2
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

--> statement-breakpoint

-- reaper：按 (status, lease_expires_at) 过滤过期租约（部分索引，行数少）。
CREATE INDEX IF NOT EXISTS cgro_v2_status_lease_idx
  ON public.card_generation_run_outbox_v2 (status, lease_expires_at)
  WHERE status = 'processing';

--> statement-breakpoint

-- claim：按 status='pending' ORDER BY created_at 领取（现有
-- cgro_v2_ws_run_status_idx 以 workspace_id 为前缀，无法服务该查询）。
CREATE INDEX IF NOT EXISTS cgro_v2_pending_claim_idx
  ON public.card_generation_run_outbox_v2 (status, created_at)
  WHERE status = 'pending';

--> statement-breakpoint

-- 存量孤儿重置：历史遗留的 processing 行（无租约语义）回收为 pending 重试。
UPDATE public.card_generation_run_outbox_v2
  SET status = 'pending', processed_at = NULL
  WHERE status = 'processing';
