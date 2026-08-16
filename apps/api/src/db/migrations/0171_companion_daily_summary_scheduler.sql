-- 0171: 桌宠日记每日 01:00 调度（22-real-desktop-pet-memory-context-prd-tdd.md §15.4）
--
-- Worker 通过 SECURITY DEFINER 函数扫描账号时区桶，在本地时间 01:00 为前一天
-- 有活动的用户入队 companion_daily_summary 任务。幂等由 jobs.idempotency_key
-- 唯一索引保证（daily-summary:<workspaceId>:<userId>:<date>）。

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_enqueue_companion_daily_summaries()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    -- 仅本地时间 01:00 这个小时触发（tick 每分钟调用，重复由幂等键吸收）。
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

      -- 有活动定义：对话 / 页面上下文 / 学习 Run / 笔记 / 卡片 / 资料 / 任务。
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
          SELECT 1 FROM learning_cards
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

      v_inserted := v_inserted + 1;
    END LOOP;
  END LOOP;

  RETURN v_inserted;
END;
$$;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_daily_summaries() TO ailearn_worker;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_enqueue_companion_daily_summaries() IS
  '桌宠日记调度：在用户本地时区 01:00 为前一天有活动的用户入队 companion_daily_summary（幂等）。';
