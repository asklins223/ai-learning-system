-- 0251 还顺手修一处从 `0171` 就在的窗口平移：活跃判据写的是
-- `local_date::date AT TIME ZONE tz`，而 Postgres 对 date 会先按**会话时区**升成
-- timestamptz、再折算成该时区的**无 timestamptz** timestamp（上海得到 08:00），
-- 与 timestamptz 列比较时又被按会话时区读回 UTC —— 整个窗口平移了一个时区差。
-- 实测（2026-09-21，dev 库）：标着 09-20 的判据窗口实际盖住 09-20 16:34–09-21 14:11
-- 的本地钟点。旧实现只拼统计句，没人看得出来；正文改成她写的日记之后，
-- "昨天的日记"讲的是今天这件事用户一眼就能看见，所以必须一起修。
-- 正确写法是 `::date::timestamp AT TIME ZONE tz`（生成器同一写法，见
-- workers/ai-worker/src/handlers/companion-daily-summary.ts 的 dayStart/dayEnd）。
--
-- 0251：日记入队窗口从"本地 01:00 那一小时"放宽到 01:00–06:59
-- （C-2【P1】，`26-systemwide-behavior-audit-and-fix-plan.md:690-712` 的主方案）。
--
-- `0243_...sql:41` 判的是 `extract(hour ...) <> 1 THEN CONTINUE`：worker 只要跨过
-- 本地 01:00–01:59 这一小时不可达（部署、宿主机休眠、笔记本合盖），那一天的日记
-- 就**永久缺失**——只读路由按 §16.6 有意不触发生成，用户没有任何自救手段。
-- 日记正文改成由她写之后这件事更值得修：一次漏跑不再只是"少一行统计"，
-- 而是那一天的日记永远不会存在。
--
-- 放宽是安全的，两个既有机制各自兜住一半：
--   - `jobs` 的幂等键 `daily-summary:<ws>:<user>:<date>` 带 workspace，
--     一天至多一条 job（`ON CONFLICT DO NOTHING`）；
--   - `companion_daily_summaries` 的 `(workspace_id, user_id, date)` 唯一索引
--     保证即便重投也只 revision+1，不会写出两篇。
-- 所以 01:00 之后每个 tick 再试一次，只是给"首个可达 tick"更多机会，不产生重复。
--
-- **注明一处有意不做的增强**（审计记录里的备选项）：job 已入队但跑失败时，
-- 幂等键冲突仍会阻止当天重新入队。以前失败的是确定性模板，重投无意义；
-- 现在失败可能是模型侧的临时故障，看起来值得补一条
-- `ON CONFLICT DO UPDATE SET status='pending'`。这里**不加**：
-- `consent_required` 与 `diary_output_invalid` 已被判为不可重试（dead），
-- 按 status 重投会让这两种确定性失败每小时再烧一次调用。
-- 残余边界因此是：当天 job 已存在且已 dead ⇒ 这天没有日记，次日恢复。

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
    -- 0251：01..6 而不是只认 1。见文件头的两个幂等兜底。
    IF extract(hour FROM now() AT TIME ZONE tz) NOT BETWEEN 1 AND 6 THEN
      CONTINUE;
    END IF;

    local_date := to_char((now() AT TIME ZONE tz)::date - 1, 'YYYY-MM-DD');

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
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM assistant_page_contexts
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM learning_runs
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM notes
          WHERE workspace_id = v_pair.workspace_id AND created_by = v_pair.user_id
            AND deleted_at IS NULL
            AND (created_at >= (local_date::date::timestamp AT TIME ZONE tz)
                 AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
                 OR updated_at >= (local_date::date::timestamp AT TIME ZONE tz)
                 AND updated_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz))
        )
        OR EXISTS (
          SELECT 1 FROM learning_cards_v2
          WHERE workspace_id = v_pair.workspace_id
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM sources
          WHERE workspace_id = v_pair.workspace_id
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM jobs
          WHERE workspace_id = v_pair.workspace_id AND requested_by = v_pair.user_id
            AND (scheduled_at >= (local_date::date::timestamp AT TIME ZONE tz)
                 AND scheduled_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
                 OR finished_at >= (local_date::date::timestamp AT TIME ZONE tz)
                 AND finished_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz))
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
-- 否则调度侧会静默不产 job（与 0235/0243 修的是同一类问题）。
DO $$
BEGIN
  IF NOT has_function_privilege('ailearn_worker',
        'public.ailearn_enqueue_companion_daily_summaries()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ailearn_worker 失去 ailearn_enqueue_companion_daily_summaries 的 EXECUTE 权限';
  END IF;
END
$$;
