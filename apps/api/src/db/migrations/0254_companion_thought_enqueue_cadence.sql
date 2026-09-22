-- 0254: 念头调度的入队门槛从固定 2 小时改成 30 分钟（方案 29 §9.61）。
--
-- 0236 把桶从 4 小时收到 2 小时，理由是"一天 12 个窗口、日预算 2 条，提醒才有机会
-- 落在用户真的在屏幕前的时段"。现在日预算被删掉了——节奏改成按 `intervention_level`
-- 的**最小间隔**（安静 3 小时 / 适度 90 分钟 / 活跃 30 分钟，见 shared 的
-- PROACTIVE_CADENCE_MS）。调度器必须比**最快那一档**更细，否则活跃档的"30 分钟"
-- 永远兑现不了：桶是 2 小时，她就最多 2 小时说一次，偏好设置里那一档成了空话。
--
-- 所以这里只把"供给"调细，"说不说"仍然由念头管线判：
--   调度器（进程内 15 分钟一次）→ 本函数按 30 分钟幂等入队
--   → handler 在任何模型调用之前判 静默时段 / 反馈降权 / 间隔，不合格直接沉默。
-- 安静档因此会多出一些"入队后立刻沉默"的调度，但那一次只读几条 SQL，不烧模型。
--
-- 门槛与桶同粒度：30 分钟内已有 companion_thought job 就不再入队，避免同一个用户
-- 在两个相邻桶里被排两次。

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
  v_bucket := floor(extract(epoch FROM now()) / 1800)::text;

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
          AND j.scheduled_at > now() - interval '30 minutes'
      )
  LOOP
    -- 静默时段（跨午夜语义）与按偏好的间隔判定都在 worker handler 内用与
    -- proactive-hook 同源的规则执行（JS 侧），SQL 里不复刻钟面数学；
    -- 这里只负责按桶幂等入队。
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
  '念头批量生成入队（30 分钟桶幂等，供最快一档 30 分钟的节奏用）。说不说由 handler 按静默时段/反馈/间隔判。门槛仍是 pet_profiles.last_active_at 14 天内 + 账号总开关。';
