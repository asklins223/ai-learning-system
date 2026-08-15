-- 0162: V2 post-activation 投影消费台账 + cutover 事件表。
--
-- 背景（R33，方案 20 §17.5 step 17）：
-- 1) `card_v2_post_activation` outbox job 原先只做投递确认（ack no-op），
--    投影消费者（Card 列表/搜索/shared topology 对账）未实现（证据包已知缺口）。
--    本迁移新增 `card_generation_post_activation_consumptions`：
--    - worker 消费者按 receiptId 幂等对账（receipt/cards/objectives 存在性 +
--      lifecycle 校验），对账结果写入台账（消费凭证，重复投递 DO NOTHING）；
--    - `personal_projection_writes = 0` 结构化 CHECK：消费者绝不允许写个人投影
--      （§17.5 step 17：personal projection 保持 0 变化）。
-- 2) C8 停写/回滚 drill 需要持久化切流事件（停写、epoch 前移、rollback drill），
--    新增 `card_generation_cutover_events`（审计闭包，供 C31/C39 drill 与
--    getCutoverStatus 的 lastCutoverAt/lastRollbackAt 读取）。
--
-- RLS：两表均按 workspace 隔离（app.workspace_id），ailearn_api + ailearn_worker
-- 全列可写（台账与事件不含 server-private 列）。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.card_generation_post_activation_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.card_generation_runs_v2(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL,
  card_ids uuid[] NOT NULL,
  objective_ids uuid[] NOT NULL,
  reconciled_card_count integer NOT NULL,
  reconciled_objective_count integer NOT NULL,
  personal_projection_writes integer NOT NULL DEFAULT 0,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  -- §17.5 step 17 幂等：同一 (workspace, receipt) 恰一次消费对账。
  CONSTRAINT cgpa_v2_ws_receipt_unique UNIQUE (workspace_id, receipt_id),
  -- 结构性不变量：消费者只写 shared 对账台账，绝不写 personal projection。
  CONSTRAINT cgpa_v2_zero_personal_writes_chk CHECK (personal_projection_writes = 0)
);

CREATE INDEX IF NOT EXISTS cgpa_v2_ws_run_idx
  ON public.card_generation_post_activation_consumptions (workspace_id, run_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.card_generation_cutover_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cgce_v2_type_chk CHECK (
    event_type IN ('v1_writer_shutdown','v1_writer_epoch_bump','rollback_drill')
  )
);

CREATE INDEX IF NOT EXISTS cgce_v2_ws_type_idx
  ON public.card_generation_cutover_events (workspace_id, event_type, created_at);

--> statement-breakpoint

ALTER TABLE public.card_generation_post_activation_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_cutover_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY cgpa_v2_ws_isolation ON public.card_generation_post_activation_consumptions
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY cgce_v2_ws_isolation ON public.card_generation_cutover_events
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.card_generation_post_activation_consumptions,
  public.card_generation_cutover_events
TO ailearn_api, ailearn_worker;
