-- 0266: 空间级的"这里可以打扰我吗"开关（审查 4.4 的最后一项）。
--
-- 审查原文：「主动触达（proactive hook、念头、delivery）按 (ws,user) 各自产生，
-- 用户在一个屏幕上会收到来自多个空间的'她想跟你说话'。现在只有账号级
-- `global_enabled` + quiet hours，**没有'哪个空间可以打扰我'这一层**。」
--
-- 这是多空间真正落地之后必然出现的问题：一个人白天在班级空间、晚上在个人空间，
-- 而伴星的主动开口是每个空间各算一份。账号级总开关只能"全开或全关"，
-- 于是用户要么忍受所有空间一起说话，要么把整个伴星关掉——后者会把
-- "她记得我"这件事一起关掉。
--
-- 落在 `companion_room_profiles` 而不是新表：那张表已经是 (workspace, user) 双键
-- 的房间级偏好（装饰、效果），"这个房间要不要出声"属于同一层。
--
-- 默认 `false`（不静音）：既有行为不变。静音是用户显式动作，不能靠迁移替他们决定。

ALTER TABLE public.companion_room_profiles
  ADD COLUMN IF NOT EXISTS proactive_muted boolean NOT NULL DEFAULT false;

--> statement-breakpoint

COMMENT ON COLUMN public.companion_room_profiles.proactive_muted IS
  '这个空间里伴星是否可以主动开口（0266）。账号级 global_enabled/quiet_hours 之外的空间级开关。';

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'companion_room_profiles'
      AND column_name = 'proactive_muted'
  ) THEN
    RAISE EXCEPTION 'companion_room_profiles.proactive_muted 没有加上';
  END IF;
  RAISE NOTICE '空间级打扰开关就绪（默认 false，不改变既有行为）';
END
$$;
