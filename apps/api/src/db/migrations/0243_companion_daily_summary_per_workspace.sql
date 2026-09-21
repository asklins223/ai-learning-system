-- 0243: 每日小结按**每个未退出的空间**入队（批次 3 调度器修复，接 `0198`）。
--
-- `0198_fix_companion_daily_summary_activity.sql:96-101` 在"这个人昨天有没有动静"之前
-- 先替他挑了一个空间：
--
--   SELECT wm.workspace_id ... WHERE wm.user_id = v_user_id AND wm.left_at IS NULL
--   ORDER BY wm.joined_at ASC LIMIT 1;
--
-- 加入 3 个空间的人，小结永远只围绕**最早加入的那一个**：另外两个空间里的笔记、来源、
-- 卡片、任务全都不参与判断，job 也只带那一个 workspace_id。多空间用户拿到的是
-- "按注册时间猜的空间"的摘要，而不是他实际在用的空间的摘要。
--
-- 现在改成按 (user, workspace) 对入队。幂等键本来就带 workspace_id
-- （`daily-summary:<ws>:<user>:<date>`），所以放开扇出不会重复投喂。
--
-- 一处需要产品知晓的放大：判定"昨天有没有动静"的 7 个 EXISTS 里，`learning_cards_v2`
-- 与 `sources` 两张表只按 workspace 过滤、不按人（其余按 user/created_by）。单空间时它
-- 表达的是"这个空间昨天活跃过"；扇出到每个空间后，协作空间里**别人**新增来源也会让
-- 每个成员收到小结。这是原语义的自然延伸、不是新引入的漏洞，但它会实际影响打扰频率——
-- 若要收紧，应给这两张表补 created_by/requested_by 过滤，属于另一个决定。

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_enqueue_companion_daily_summaries()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  tz text;
  local_date text;
  v_pair record;
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

    -- 每个未退出的空间各算一次，不再 ORDER BY joined_at LIMIT 1 替用户挑空间。
    FOR v_pair IN
      SELECT u.user_id, wm.workspace_id
      FROM user_companion_account_state u
      JOIN workspace_members wm
        ON wm.user_id = u.user_id
       AND wm.left_at IS NULL
      WHERE u.global_enabled = true
        AND COALESCE(u.quiet_hours->>'timezone', 'Asia/Shanghai') = tz
      ORDER BY u.user_id, wm.joined_at
    LOOP
      IF NOT (
        EXISTS (
          SELECT 1 FROM companion_messages
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM assistant_page_contexts
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM learning_runs
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM notes
          WHERE workspace_id = v_pair.workspace_id AND created_by = v_pair.user_id
            AND deleted_at IS NULL
            AND (created_at >= (local_date::date AT TIME ZONE tz)
                 AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
                 OR updated_at >= (local_date::date AT TIME ZONE tz)
                 AND updated_at < ((local_date::date + 1) AT TIME ZONE tz))
        )
        OR EXISTS (
          SELECT 1 FROM learning_cards_v2
          WHERE workspace_id = v_pair.workspace_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM sources
          WHERE workspace_id = v_pair.workspace_id
            AND created_at >= (local_date::date AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1) AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM jobs
          WHERE workspace_id = v_pair.workspace_id AND requested_by = v_pair.user_id
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
        ('companion_daily_summary', v_pair.workspace_id, v_pair.user_id,
         jsonb_build_object('date', local_date, 'timezone', tz, 'userId', v_pair.user_id),
         'pending', 10, 'maintenance',
         'daily-summary:' || v_pair.workspace_id || ':' || v_pair.user_id || ':' || local_date)
      ON CONFLICT (workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING;

      IF FOUND THEN
        v_inserted := v_inserted + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_inserted;
END
$function$;

--> statement-breakpoint

-- 函数体重写不改属主与授权，但把授权写成断言：worker 必须还能 EXECUTE，
-- 否则调度侧会静默不产 job（与 0235 那次修的是同一类问题）。
DO $$
BEGIN
  IF NOT has_function_privilege('ailearn_worker',
        'public.ailearn_enqueue_companion_daily_summaries()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ailearn_worker 失去 ailearn_enqueue_companion_daily_summaries 的 EXECUTE 权限';
  END IF;
END
$$;
