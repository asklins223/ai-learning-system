-- 0236: 念头调度不再要求"30 天内有正式学习运行"（方案 29 §9.15，抱怨 #8）。
--
-- 0227 版 `ailearn_enqueue_companion_thoughts()` 的循环条件里有一条：
--   AND EXISTS (SELECT 1 FROM learning_runs lr WHERE ... lr.created_at > now() - interval '30 days')
-- 也就是**只有跑过正式学习的人才会被生成主动念头**。dev 库里这个用户一条
-- `learning_runs` 都没有（有卡、有复习、有 320 次伴星互动），于是调度器每
-- 15 分钟 tick 一次、每次都入队 0 条，`assistant_thoughts` 恒 0 行——
-- 用户侧的直接体感就是"完全没感知到主动提醒"，而且日志里一条错误都没有
-- （调度器只在 inserted>0 时打 info）。
--
-- 主动性本来就不该以"上过正式学习课"为前提：一个天天跟桌宠说话、攒了 25 条
-- 待复习的人，正是最该被提醒的人。改成以**伴星关系本身是否活着**为门槛：
--   pet_profiles.last_active_at 在 14 天内。
-- 这个字段由互动路径维护（当前值就是几分钟前），语义正好是"最近还在理我"。
-- `global_enabled = true` 保留——那是账号级总开关，用户能关掉一切主动输出。
--
-- 顺带把桶从 4 小时收到 2 小时：一天 12 个窗口、日预算 2 条，提醒才有机会落在
-- 用户真的在屏幕前的时段；4 小时桶配合静默时段判定，实测整天都在闸外。

CREATE OR REPLACE FUNCTION public.ailearn_enqueue_companion_thoughts()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_bucket text;
  v_workspace_id uuid;
  v_user_id uuid;
  v_inserted integer := 0;
BEGIN
  v_bucket := floor(extract(epoch FROM now()) / 7200)::text;

  FOR v_workspace_id, v_user_id IN
    SELECT m.workspace_id, s.user_id
    FROM user_companion_account_state s
    JOIN workspace_members m ON m.user_id = s.user_id
    JOIN pet_profiles p ON p.workspace_id = m.workspace_id AND p.user_id = s.user_id
    WHERE s.global_enabled = true
      AND p.last_active_at > now() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.workspace_id = m.workspace_id
          AND j.type = 'companion_thought'
          AND j.scheduled_at > now() - interval '2 hours'
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
$function$;

COMMENT ON FUNCTION public.ailearn_enqueue_companion_thoughts() IS
  '念头批量生成入队（2 小时桶幂等）。门槛是伴星关系是否活着（pet_profiles.last_active_at 14 天内），不是有没有上过正式学习课。';
