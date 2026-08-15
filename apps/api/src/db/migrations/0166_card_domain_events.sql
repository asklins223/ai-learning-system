-- 0166_card_domain_events.sql
-- 方案 20 §17.7 领域事件通道（R36）：
-- card_generation_events_v2 是 run-scoped 的生成进度事件（SSE），无法承载
-- card/objective/reminder 生命周期事件（无 runId、需 aggregate 语义）。
-- 本表提供独立的领域事件通道，供 Today/Card 通知、search、shared topology 等
-- 白名单消费者（§17.7 事件路由白名单第二行）幂等消费。

CREATE TABLE IF NOT EXISTS card_domain_events_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_kind text NOT NULL,          -- card | objective | reminder
  aggregate_id uuid NOT NULL,
  aggregate_revision integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  causation_id uuid,
  correlation_id uuid,
  idempotency_key text,
  schema_version integer NOT NULL DEFAULT 2,
  -- 消费者幂等水位：{consumerName: lastEventId}（§17.7 (eventId, consumerName)）。
  consumer_watermarks jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cde_v2_ws_event_unique
  ON card_domain_events_v2 (workspace_id, event_id);

CREATE INDEX IF NOT EXISTS cde_v2_ws_agg_idx
  ON card_domain_events_v2 (workspace_id, aggregate_kind, aggregate_id, occurred_at);

CREATE INDEX IF NOT EXISTS cde_v2_ws_type_idx
  ON card_domain_events_v2 (workspace_id, event_type, occurred_at);

CREATE INDEX IF NOT EXISTS cde_v2_ws_occurred_idx
  ON card_domain_events_v2 (workspace_id, occurred_at);

CREATE INDEX IF NOT EXISTS cde_v2_ws_consumer_idx
  ON card_domain_events_v2 (workspace_id, event_type)
  WHERE consumer_watermarks = '{}'::jsonb;

-- 事件类型白名单（§17.7 lifecycle 事件族 + 迁移期扩展）。
ALTER TABLE card_domain_events_v2
  ADD CONSTRAINT cde_v2_type_chk CHECK (
    event_type IN (
      'learning_objective.revised',
      'learning_objective.superseded',
      'learning_objective.archived',
      'learning_card.revised',
      'learning_card.revealed',
      'learning_card.archived',
      'initial_validation_reminder.created',
      'initial_validation_reminder.deferred',
      'initial_validation_reminder.ready',
      'initial_validation_reminder.completed',
      'initial_validation_reminder.cancelled'
    )
  );

-- aggregate_kind 与事件族一致性。
ALTER TABLE card_domain_events_v2
  ADD CONSTRAINT cde_v2_agg_kind_chk CHECK (
    (event_type LIKE 'learning_objective.%' AND aggregate_kind = 'objective')
    OR (event_type LIKE 'learning_card.%' AND aggregate_kind = 'card')
    OR (event_type LIKE 'initial_validation_reminder.%' AND aggregate_kind = 'reminder')
  );

-- RLS 与角色授权（0162 模式）：api 写、worker 读；workspace 单条件隔离。
ALTER TABLE card_domain_events_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY cde_v2_ws_isolation ON card_domain_events_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON card_domain_events_v2 TO ailearn_api, ailearn_worker;

