-- 0078: 阶段 02（W1）任务 02-9 —— learning_outbox_events（canonical 事件 outbox，§12.2/§12.5）
--
-- 同事务 outbox：正式 overall outcome / attempt / schedule 落现有权威域
-- （validation_events / review_attempts / understanding_events 及其现行权威
-- 表/枚举），facet projection 只读扩展后的 validation_point_assessments；
-- **不新增 understanding_evidence_events 作为平行 canonical 真相**。本表只
-- 保存 append-only 的安全摘要事件行（schema action、IDs、hash、版本、计数、
-- usage、安全摘要），capability/map projection 由同一事务内写入的 outbox 行
-- 派生；相同 canonical event stream 重放必须得到相同 mastery/facet/星图投影
-- hash（projection_hash 列承载，drift 检测依据）。
--
-- payload 安全规则：只存 schema action / IDs / hash / 版本 / 计数 / usage /
-- 安全摘要；**不存 raw chain-of-thought / 回答原文**。写入路径由服务端
-- validateCanonicalEventPayload 白名单强制；此处再加 CHECK 兜底拒绝明显敏感键
-- （userAnswer / answer / answerText / question / chainOfThought / rationale）。
--
-- sequence 每 workspace 单调：使用全局序列 nextval 的单调子集
-- （同一 workspace 内递增），unique(workspace_id, sequence) 兜底。
-- sequence 用 bigint：全局累计可能超过 2^31-1（review 发现），integer 会阻断所有 workspace。
--
-- RLS（0075/0077 风格）：outbox 事件属 user-private-in-workspace（§12.1 正式
-- outcome/attempt/schedule 归属域），使用 workspace_id + user_id 双条件 policy；
-- 任一 context 缺失（NULLIF(...) IS NULL）即 fail closed。
-- GRANT：ailearn_api 读写 + 序列 usage；ailearn_worker 只读（投影消费）+ 序列 usage。
--
-- 幂等：CREATE SEQUENCE/TABLE/INDEX 用 IF NOT EXISTS，policy 用 DROP POLICY
-- IF EXISTS + CREATE POLICY，GRANT 按角色存在性；fresh / upgrade / repeat /
-- restore 全路径安全。

--> statement-breakpoint

CREATE SEQUENCE IF NOT EXISTS public.learning_outbox_events_seq;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- schema action：validation.event | review.attempt | understanding.event
  event_type text NOT NULL,
  -- 只存安全摘要（服务端白名单 + 本 CHECK 兜底）。
  payload jsonb NOT NULL,
  -- 每 workspace 单调递增（全局序列的子集）。
  sequence bigint NOT NULL DEFAULT nextval('public.learning_outbox_events_seq'),
  -- 事件对三类投影（mastery/facet/map）的确定性贡献指纹，drift 检测依据。
  projection_hash text NOT NULL,
  -- 投影消费完成时间；NULL = 未消费。
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 数据库层兜底：禁止明显敏感键进入 outbox payload（完整白名单在服务端强制）。
  CONSTRAINT learning_outbox_payload_safe_summary_check CHECK (
    NOT (payload ? 'userAnswer')
    AND NOT (payload ? 'answer')
    AND NOT (payload ? 'answerText')
    AND NOT (payload ? 'question')
    AND NOT (payload ? 'chainOfThought')
    AND NOT (payload ? 'chain_of_thought')
    AND NOT (payload ? 'rationale')
  )
);

--> statement-breakpoint

-- 每 workspace 的 sequence 唯一 → 该 workspace 内事件顺序唯一（重放顺序依据）。
CREATE UNIQUE INDEX IF NOT EXISTS learning_outbox_workspace_sequence_unique_idx
  ON public.learning_outbox_events (workspace_id, sequence);
-- 投影派生主查询：按 workspace+user 顺序读取未消费事件。
CREATE INDEX IF NOT EXISTS learning_outbox_workspace_user_idx
  ON public.learning_outbox_events (workspace_id, user_id, sequence);
-- 未消费游标（投影 worker）。
CREATE INDEX IF NOT EXISTS learning_outbox_unprocessed_idx
  ON public.learning_outbox_events (processed_at) WHERE processed_at IS NULL;
-- 按事件类型查询。
CREATE INDEX IF NOT EXISTS learning_outbox_type_idx
  ON public.learning_outbox_events (workspace_id, event_type, sequence);

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- RLS：workspace_id + user_id 双条件（0075/0077 风格，§13.3）
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.learning_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_outbox_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_outbox_events_workspace_user_isolation
  ON public.learning_outbox_events;
CREATE POLICY learning_outbox_events_workspace_user_isolation
  ON public.learning_outbox_events FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- least-privilege GRANT（0071/0075 模式：按角色存在性授权）
-- ailearn_api：读写 + 序列 usage；ailearn_worker：SELECT + 标记消费（UPDATE processed_at）+ 序列 usage。
-- ════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_outbox_events TO ailearn_api;
    GRANT USAGE ON SEQUENCE public.learning_outbox_events_seq TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, UPDATE ON public.learning_outbox_events TO ailearn_worker;
    GRANT USAGE ON SEQUENCE public.learning_outbox_events_seq TO ailearn_worker;
  END IF;
END $$;
