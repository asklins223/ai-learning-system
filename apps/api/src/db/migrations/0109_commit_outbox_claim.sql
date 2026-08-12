-- 0109: learning_session_processing_outbox 的 commit_requested claim 函数
--
-- 背景：评估 worker 写 assessment_complete 后，同事务入队 command_type=
-- 'commit_requested'（生产者在 worker 侧）。消费方是 API（commit 编排
-- episode-commit/vertical-slice/PgCommitPort 都在 apps/api，且 proactive
-- fireCompanionTrigger 在 API 域）。
--
-- 但 outbox 表 RLS（0081）只放行 ailearn_worker（跨 workspace 豁免）或
-- app.workspace_id/user_id 上下文。ailearn_api 无法跨 workspace claim。
-- 沿用 0098 的既有模式（SECURITY DEFINER 函数 + migrator owner BYPASSRLS，
-- 函数内绕过 RLS；API 仅 EXECUTE），提供跨 workspace 的 claim 入口。
-- 函数只返回 scoped 标识符 + 租约字段，不返回任何作答内容
--（0081/0098 payload CHECK 已禁止 answer/answerText/userAnswer/question/
-- rationale/chainOfThought）。
--
-- 实现注意：RETURNS TABLE 的输出参数名（id 等）与 outbox 表列同名会触发
-- PL/pgSQL 歧义错误，因此内部用 record 变量 + RETURN QUERY（SELECT 里表列
-- 优先于输出变量解析）。

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_claim_commit_outbox(
  p_worker_id text,
  p_lease_ms integer,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  user_id uuid,
  session_id uuid,
  episode_id uuid,
  command_type text,
  payload jsonb,
  idempotency_key text,
  attempts integer,
  lease_owner text,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_lease_expires_at timestamptz := p_now + make_interval(secs => p_lease_ms / 1000.0);
  v_row record;
BEGIN
  SELECT id, workspace_id, user_id, session_id, episode_id, command_type, payload,
         idempotency_key, attempts
    INTO v_row
  FROM public.learning_session_processing_outbox AS t
  WHERE t.processed_at IS NULL
    AND t.command_type = 'commit_requested'
    AND t.attempts < 8
    AND t.available_at <= p_now
    AND (t.lease_expires_at IS NULL OR t.lease_expires_at <= p_now)
  ORDER BY t.created_at, t.id
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_row.id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.learning_session_processing_outbox
  SET leased_at = p_now,
      lease_owner = p_worker_id,
      lease_expires_at = v_lease_expires_at,
      attempts = v_row.attempts + 1,
      updated_at = p_now
  WHERE public.learning_session_processing_outbox.id = v_row.id;

  RETURN QUERY
  SELECT v_row.id, v_row.workspace_id, v_row.user_id, v_row.session_id,
         v_row.episode_id, v_row.command_type, v_row.payload,
         v_row.idempotency_key, v_row.attempts, p_worker_id,
         v_lease_expires_at;
END;
$function$;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_claim_commit_outbox(text, integer, timestamptz)
  TO ailearn_api;
