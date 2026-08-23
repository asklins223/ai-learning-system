-- 0181：修复 ailearn_claim_commit_outbox 的 PL/pgSQL 列引用歧义（42702）。
--
-- 背景（2026-08-23）：0109 原始定义中 SELECT ... INTO 的列清单未加表前缀，
-- 与 RETURNS TABLE 声明的同名 OUT 参数构成 variable_conflict 歧义——在默认
-- plpgsql.variable_conflict = error 下每次调用即抛
-- "column reference id is ambiguous"。该函数属已停用的 V1 commit 消费链路
-- （server.ts 以 LEARNING_RUN_V1 门控，V2 由 run-processing-tick 独占 Commit），
-- 但函数与消费代码仍在注册，留作地雷；本迁移消除歧义使其可安全重放。
--
-- 修复：SELECT 清单逐列加 t. 前缀。语义不变，幂等可重放。

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
  SELECT t.id, t.workspace_id, t.user_id, t.session_id, t.episode_id, t.command_type, t.payload,
         t.idempotency_key, t.attempts
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
