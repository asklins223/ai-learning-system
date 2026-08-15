-- 0121: learning_run_processing_outbox 的跨 workspace claim 函数。
--
-- 背景（与 0109 同模式）：RLS 只放行 ailearn_worker（跨 workspace 豁免）或
-- app.workspace_id/user_id 上下文；ailearn_api 无法跨 workspace claim。
-- 消费方是 API（run-processing-tick），因此提供 SECURITY DEFINER 函数
-- （migrator owner BYPASSRLS，函数内绕过 RLS；API 仅 EXECUTE）。
-- 函数只返回 scoped 标识符 + 租约字段，不返回作答内容（0117 payload CHECK
-- 已禁止 answer/answerText/userAnswer/transcript）。

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_claim_run_processing(
  p_worker_id text,
  p_lease_ms integer,
  p_max integer DEFAULT 50,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  id uuid,
  run_id uuid,
  task_id uuid,
  artifact_id uuid,
  workspace_id uuid,
  user_id uuid,
  command_type text,
  payload jsonb,
  idempotency_key text,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_lease_expires_at timestamptz := p_now + make_interval(secs => p_lease_ms / 1000.0);
  v_rows public.learning_run_processing_outbox[] := ARRAY[]::public.learning_run_processing_outbox[];
  v_row public.learning_run_processing_outbox;
BEGIN
  SELECT ARRAY(
    SELECT t
    FROM public.learning_run_processing_outbox AS t
    WHERE t.processed_at IS NULL
      AND t.attempts < 8
      AND t.available_at <= p_now
      AND (t.lease_expires_at IS NULL OR t.lease_expires_at <= p_now)
    ORDER BY t.created_at, t.id
    LIMIT p_max
    FOR UPDATE SKIP LOCKED
  ) INTO v_rows;

  IF array_length(v_rows, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH v_row IN ARRAY v_rows LOOP
    UPDATE public.learning_run_processing_outbox
    SET leased_at = p_now,
        lease_owner = p_worker_id,
        lease_expires_at = v_lease_expires_at,
        attempts = public.learning_run_processing_outbox.attempts + 1,
        updated_at = p_now
    WHERE public.learning_run_processing_outbox.id = v_row.id;
  END LOOP;

  RETURN QUERY
  SELECT u.id, u.run_id, u.task_id, u.artifact_id,
         u.workspace_id, u.user_id, u.command_type, u.payload,
         u.idempotency_key, u.attempts
  FROM unnest(v_rows) AS u;
END;
$function$;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_claim_run_processing(text, integer, integer, timestamptz) TO ailearn_api;
REVOKE ALL ON FUNCTION public.ailearn_claim_run_processing(text, integer, integer, timestamptz) FROM PUBLIC;

--> statement-breakpoint

-- 失败释放：清租约 + 写 last_error（attempts 已在 claim 时递增），
-- 使命令立即可被重试（否则要等租约过期）。
CREATE OR REPLACE FUNCTION public.ailearn_release_run_processing(
  p_outbox_id uuid,
  p_worker_id text,
  p_error text,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.learning_run_processing_outbox
  SET lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = left(p_error, 500),
      updated_at = p_now
  WHERE public.learning_run_processing_outbox.id = p_outbox_id
    AND public.learning_run_processing_outbox.lease_owner = p_worker_id;
END;
$function$;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_release_run_processing(uuid, text, text, timestamptz) TO ailearn_api;
REVOKE ALL ON FUNCTION public.ailearn_release_run_processing(uuid, text, text, timestamptz) FROM PUBLIC;

--> statement-breakpoint

-- 成功标记：processed_at 置位（SECURITY DEFINER，跨 workspace）。
CREATE OR REPLACE FUNCTION public.ailearn_mark_run_processing_processed(
  p_outbox_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.learning_run_processing_outbox
  SET processed_at = p_now,
      updated_at = p_now
  WHERE public.learning_run_processing_outbox.id = p_outbox_id;
END;
$function$;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_mark_run_processing_processed(uuid, timestamptz) TO ailearn_api;
REVOKE ALL ON FUNCTION public.ailearn_mark_run_processing_processed(uuid, timestamptz) FROM PUBLIC;
