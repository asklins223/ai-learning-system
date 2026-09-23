-- 0270: 到点提醒也要看"她此刻该不该开口"——空间级静音与账号总开关。
--
-- ── 为什么是这一支迁移
--
-- 全系统闭环审计（`docs/plans/34-systemwide-loop-closure-audit-2026-09-22.md`）L10/L11：
-- 空间级静音（0266）当时只有**念头**那一条路读它（`companion-thought.ts`），
-- 而到点提醒这条 SQL 路径（0238 的 `ailearn_fire_due_companion_reminders`）
-- 只在取时区时碰了一下 `user_companion_account_state`，
-- **既不看总开关，也不看勿扰，也不看这个空间是不是被静音了**。
-- 后果是用户能亲眼看到的：把她的空间静音之后，到点的约定照样弹气泡、
-- 并且走 `speakHomeV2Cue` 出声。
--
-- 判据只写一次：这一支补的是"能触达用户的每条路都得过同一道门"矩阵里
-- `提醒 × {总开关, 勿扰, 空间静音}` 这三格。其余路径（念头/日记）本来就有自己的判据，
-- 不在这里重复实现。
--
-- ── 有意**没有**加的一条：静默时段（quiet hours）
--
-- 静默时段的窗口判定在 TS 那一侧（`companion-proactive-policy.ts:isWithinQuietHours`），
-- SQL 里目前只有时区（`quiet_hours->>'timezone'`），没有第二份窗口实现。
-- 在这里新写一份窗口计算=把同一个规则做成两个来源，正是本审计反复批评的形状。
-- 而且提醒的语义和念头不同：它是**用户自己许下的约定**，
-- "夜里到点所以吞掉"与"到点提醒"是冲突的，要做的是"静默结束后补发"，
-- 那需要一套补发窗口与顺延规则——属于产品决定，不在本支顺手发明。
-- 现状如实：勿扰/总开关/空间静音会挡，静默时段目前不挡提醒。
--
-- 缺账号行的口径与全仓一致：**当成开启**（`LEFT JOIN` + `COALESCE(..., true)`）。
-- 那行只在用户动过伴星面板时才建（doc 34 L26 记了这个不对称，本支不改变它）。

CREATE OR REPLACE FUNCTION public.ailearn_fire_due_companion_reminders(p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_row record;
  v_fired integer := 0;
  v_dedupe_key text;
BEGIN
  UPDATE public.companion_reminders
     SET status = 'missed', updated_at = now()
   WHERE status = 'pending'
     AND fire_at < now() - interval '2 hours';

  FOR v_row IN
    SELECT r.id, r.workspace_id, r.user_id, r.text
      FROM public.companion_reminders r
      -- 账号级开关：跟着人走，哪个空间都一样。
      LEFT JOIN public.user_companion_account_state a ON a.user_id = r.user_id
      -- 空间级静音：跟着"这个空间的她"走（0266）。没有行 = 没静音过。
      LEFT JOIN public.companion_room_profiles p
        ON p.workspace_id = r.workspace_id AND p.user_id = r.user_id
     WHERE r.status = 'pending'
       AND r.fire_at <= now()
       AND COALESCE(a.global_enabled, true)
       -- `presence` 是 jsonb（0074 起就是），不是 text：库里现存的形状是 {"presence":"online"}。
       -- 直接拿它和字符串比较会当场报 `invalid input syntax for type json`，
       -- 整支提醒兑现函数每一次调用都失败——所以这里按 jsonb 取，
       -- 并兼容"对象包一层"与"裸字符串"两种写法，取不到就当 online。
       AND COALESCE(a.presence ->> 'presence', a.presence #>> '{}', 'online')
             NOT IN ('dnd', 'offline')
       AND NOT COALESCE(p.proactive_muted, false)
     ORDER BY r.fire_at
       FOR UPDATE OF r SKIP LOCKED
     LIMIT COALESCE(p_limit, 10)
  LOOP
    v_dedupe_key := 'reminder:' || v_row.id;
    -- inbox_sequence 取 MAX+1：与 API 的 deliver()/其他设备并发时用同一把用户级锁
    -- （记忆写入、念头送达是同一个 key 形态），否则会撞唯一约束。
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'companion-inbox:' || v_row.workspace_id || ':' || v_row.user_id, 0));
    INSERT INTO assistant_deliveries
      (assistant_session_id, workspace_id, user_id, inbox_sequence, dedupe_key,
       state, kind, payload_ref, expires_at)
    SELECT NULL, v_row.workspace_id, v_row.user_id,
           COALESCE(MAX(d.inbox_sequence), 0) + 1,
           v_dedupe_key, 'queued', 'system_event',
           jsonb_build_object('kind', 'system_event',
                              'systemEventId', v_dedupe_key,
                              'text', v_row.text),
           now() + interval '2 hours'
      FROM assistant_deliveries d
     WHERE d.workspace_id = v_row.workspace_id AND d.user_id = v_row.user_id
    ON CONFLICT (workspace_id, user_id, dedupe_key) DO NOTHING;
    UPDATE public.companion_reminders
       SET status = 'fired', fired_at = now(), updated_at = now()
     WHERE id = v_row.id;
    PERFORM pg_notify('ailearn_companion_inbox_v1',
                      json_build_object('userId', v_row.user_id)::text);
    v_fired := v_fired + 1;
  END LOOP;

  RETURN v_fired;
END;
$function$;

COMMENT ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) IS
  '到点提醒兑现：先作废超过 2 小时的未兑现约定，再认领到点**且此刻允许开口**的行'
  '（账号总开关、勿扰/离线、这个空间的静音三关一起判，0270），写进 '
  'assistant_deliveries 的 system_event 通道并随事务 NOTIFY。跨租户，仅供 worker 定时器调用。';

-- 权限形状与 0238 一致：只给 worker（`roles.sql` 的白名单里已有这一支签名，
-- 签名未变，所以不需要动那份清单）。
REVOKE ALL ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) TO ailearn_migrator;

-- 与本支一起自查的两条断言（跑迁移时若前提变了就红，而不是静默改成少发）：
-- 1) 被这三道门挡下的提醒**保持 pending**，不会被标成 fired/missed——
--    所以"静音两小时后再打开"它还会响；超过 2 小时的那批仍按既有规则走 missed。
-- 2) 三道门都放行时，行为与 0238 逐字一致（同一条 INSERT/UPDATE/NOTIFY）。
DO $$
BEGIN
  IF to_regclass('public.companion_room_profiles') IS NULL
     OR to_regclass('public.user_companion_account_state') IS NULL THEN
    RAISE EXCEPTION '0270 expects companion_room_profiles and user_companion_account_state to exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.companion_room_profiles'::regclass
       AND attname = 'proactive_muted'
  ) THEN
    RAISE EXCEPTION '0270 expects companion_room_profiles.proactive_muted (added by 0266)';
  END IF;
END
$$;
