-- 0198: point companion daily-summary activity detection at the V2 card table.
--
-- The original 0171 function still queried the retired learning_cards table.
-- Replace the function in place so the worker's scheduled call remains valid
-- after the V1 card tables are removed.

CREATE OR REPLACE FUNCTION public.ailearn_enqueue_companion_daily_summaries()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tz text;
  local_date text;
  v_workspace_id uuid;
  v_user_id uuid;
  v_inserted integer := 0;
BEGIN
  FOR tz IN
    SELECT DISTINCT COALESCE(quiet_hours->>'timezone', 'Asia/Shanghai')
    FROM user_companion_account_state
    WHERE global_enabled = true
  LOOP
    IF extract(hour FROM now() AT TIME ZONE tz) <> 1 THEN
      CONTINUE;
    END IF;

    local_date := to_char((now() AT TIME ZONE tz)::date - 1, 'YYYY-MM-DD');

    FOR v_user_id IN
      SELECT u.user_id
      FROM user_companion_account_state u
      WHERE u.global_enabled = true
        AND COALESCE(u.quiet_hours->>'timezone', 'Asia/Shanghai') = tz
    LOOP
      SELECT wm.workspace_id INTO v_workspace_id
      FROM workspace_members wm
      WHERE wm.user_id = v_user_id
        AND wm.left_at IS NULL
      ORDER BY wm.joined_at ASC
      LIMIT 1;

      IF v_workspace_id IS NULL THEN
        CONTINUE;
      END IF;

      IF NOT (
        EXISTS (
          SELECT 1 FROM companion_messages
          WHERE workspace_id = v_workspace_id AND user_id = v_user_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM assistant_page_contexts
          WHERE workspace_id = v_workspace_id AND user_id = v_user_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM learning_runs
          WHERE workspace_id = v_workspace_id AND user_id = v_user_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM notes
          WHERE workspace_id = v_workspace_id AND created_by = v_user_id
            AND deleted_at IS NULL
            AND (created_at >= (local_date::date AT TIME ZONE tz)
                 AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
                 OR updated_at >= (local_date::date AT TIME ZONE tz)
                 AND updated_at < ((local_date::date + 1) AT TIME ZONE tz))
        )
        OR EXISTS (
          SELECT 1 FROM learning_cards_v2
          WHERE workspace_id = v_workspace_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM sources
          WHERE workspace_id = v_workspace_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM jobs
          WHERE workspace_id = v_workspace_id AND requested_by = v_user_id
            AND (scheduled_at >= (local_date::date AT TIME ZONE tz)
                 AND scheduled_at < ((local_date::date + 1) AT TIME ZONE tz)
                 OR finished_at >= (local_date::date AT TIME ZONE tz)
                 AND finished_at < ((local_date::date + 1) AT TIME ZONE tz))
        )
      ) THEN
        CONTINUE;
      END IF;

      INSERT INTO jobs
        (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
      VALUES
        ('companion_daily_summary', v_workspace_id, v_user_id,
         jsonb_build_object('date', local_date, 'timezone', tz, 'userId', v_user_id),
         'pending', 10, 'maintenance',
         'daily-summary:' || v_workspace_id || ':' || v_user_id || ':' || local_date)
      ON CONFLICT (workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING;

      IF FOUND THEN
        v_inserted := v_inserted + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_daily_summaries() TO ailearn_worker;

ALTER FUNCTION public.ailearn_run_companion_memory_maintenance()
  SET search_path = pg_catalog, public;

COMMENT ON FUNCTION public.ailearn_enqueue_companion_daily_summaries() IS
  '桌宠日记调度：在用户本地时区 01:00 为前一天有活动的用户入队 companion_daily_summary（幂等）。';
