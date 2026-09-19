-- 0227: 念头（thought）管线（outputs/ai-伴星能力与主动性设计汇总-2026-09-18 §四）。
--
-- 念头库：候选念头带紧急度 / 熟悉度门槛 / grounding 引用 / 衰减（expires_at）。
-- worker 定时（每天 2–4 次）生成候选（确定性规则：复习到期 / 连续学习 / 惰性；
-- LLM 批量可选），沉默是默认——大多数念头默默过期，只有少数被选中表达。
-- embedding 语义去重：与最近 7 天说过的念头比 cosine 相似度，过阈值不说。
--
-- 表的 RLS 与 0170 的 pet_profiles 等同模式（worker 全权 / api 按 workspace+user）。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.assistant_thoughts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 素材来源：确定性规则（review_due/streak/inactivity）或 LLM 批量（llm）
  source text NOT NULL,
  topic text NOT NULL,
  -- 同主题冷却键（如 review_due:2026-09-18）；同 key 存在未过期念头则不重复生成
  dedupe_key text NOT NULL,
  -- 候选文案（≤200 字，写入端限制）
  text text NOT NULL,
  -- 表达允许引用的实体 [{name, entityRef}]；表达必须命中其一，不许编造
  grounding jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 表达定稿后的向量（语义去重用），候选期可为空
  embedding vector(1024),
  status text NOT NULL DEFAULT 'candidate',
  -- candidate → delivered → spent（用户点开主动开场）| suppressed（反馈降权）| expired
  urgency int NOT NULL DEFAULT 0,
  -- 熟悉度门槛：pet_profiles.familiarity 低于此值不表达（冷启动就该安静）
  familiarity_required real NOT NULL DEFAULT 0,
  score real NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_thoughts_source_check CHECK (source IN ('review_due', 'streak', 'inactivity', 'llm')),
  CONSTRAINT assistant_thoughts_status_check CHECK (status IN ('candidate', 'delivered', 'spent', 'suppressed', 'expired')),
  CONSTRAINT assistant_thoughts_text_len CHECK (char_length(text) BETWEEN 1 AND 200),
  CONSTRAINT assistant_thoughts_urgency_range CHECK (urgency BETWEEN 0 AND 100)
);

ALTER TABLE public.assistant_thoughts ENABLE ROW LEVEL SECURITY;

CREATE POLICY assistant_thoughts_workspace_user_isolation
  ON public.assistant_thoughts FOR ALL
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_thoughts TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_thoughts TO ailearn_api;

CREATE INDEX IF NOT EXISTS assistant_thoughts_ws_user_status_idx
  ON public.assistant_thoughts (workspace_id, user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS assistant_thoughts_dedupe_idx
  ON public.assistant_thoughts (workspace_id, user_id, dedupe_key, created_at DESC);

--> statement-breakpoint

-- 念头生成调度：与 0171 日记调度同模式——SECURITY DEFINER 函数由 worker
-- 每分钟 tick 调用（进程内 15min 节流），按 4 小时桶幂等入队（每天 2–4 次），
-- 沉默默认：静默时段内完全不生成，30 天无活动的账号不生成。
CREATE OR REPLACE FUNCTION public.ailearn_enqueue_companion_thoughts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket text;
  v_workspace_id uuid;
  v_user_id uuid;
  v_inserted integer := 0;
BEGIN
  v_bucket := floor(extract(epoch FROM now()) / 14400)::text;

  FOR v_workspace_id, v_user_id IN
    SELECT m.workspace_id, s.user_id
    FROM user_companion_account_state s
    JOIN workspace_members m ON m.user_id = s.user_id
    WHERE s.global_enabled = true
      AND EXISTS (
        SELECT 1 FROM learning_runs lr
        WHERE lr.workspace_id = m.workspace_id AND lr.user_id = s.user_id
          AND lr.created_at > now() - interval '30 days'
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.workspace_id = m.workspace_id
          AND j.type = 'companion_thought'
          AND j.created_at > now() - interval '4 hours'
      )
  LOOP
    -- 静默时段判定（跨午夜语义）在 worker handler 内用与 proactive-hook 相同的
    -- 规则执行（JS 侧），SQL 里不复刻钟面数学；这里只负责按桶幂等入队。
    INSERT INTO jobs
      (workspace_id, type, requested_by, payload, status, priority, resource_class, idempotency_key, scheduled_at)
    VALUES
      (v_workspace_id, 'companion_thought', v_user_id,
       jsonb_build_object('userId', v_user_id, 'bucket', v_bucket),
       'pending', 10, 'maintenance',
       'companion-thought:' || v_workspace_id || ':' || v_user_id || ':' || v_bucket,
       now())
    ON CONFLICT DO NOTHING;
    IF found THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$$;
