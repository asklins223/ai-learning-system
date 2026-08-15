-- 方案 16 §20 埋点最小闭环：学习漏斗指标事件。
-- 只记录引用/状态/行为元数据（origin×goal×intent×interaction×purpose×trustClass
-- funnel 维度），绝不记录答案正文/原始语音/private rubric（§20.1）。
-- 事件由服务端权威写入（run 主链路由层 + tick 收尾），客户端不可上报。

CREATE TABLE IF NOT EXISTS public.learning_metric_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  -- run_created | task_presented | artifact_locked | action | run_result
  run_id uuid,
  task_id uuid,
  origin jsonb,
  goal text,
  intent text,
  interaction_kind text,
  variant_purpose text,
  trust_class text,
  action_kind text,
  outcome text,
  schedule_impact jsonb,
  active_seconds_used integer,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_metric_events_ws_time_idx
  ON public.learning_metric_events (workspace_id, occurred_at DESC);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_metric_events_type_idx
  ON public.learning_metric_events (workspace_id, event_type, occurred_at DESC);

--> statement-breakpoint

ALTER TABLE public.learning_metric_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_metric_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_metric_events_workspace_user_isolation
  ON public.learning_metric_events;
CREATE POLICY learning_metric_events_workspace_user_isolation
  ON public.learning_metric_events FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

--> statement-breakpoint

GRANT SELECT, INSERT ON public.learning_metric_events TO ailearn_api;
GRANT SELECT, INSERT ON public.learning_metric_events TO ailearn_worker;
