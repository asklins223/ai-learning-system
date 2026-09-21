-- 0238: 伴星定时提醒（方案 29 §4.6 / 抱怨 #9「没有系统时间概念、没有定时任务/提醒」）。
--
-- 全仓库此前没有任何"到点由伴星主动开口"的载体：`assistant_deliveries` 只有两个
-- 生产者（run.completed 事件钩子、念头管线），两者都不携带**用户指定的时刻**。
-- 用户说"明天九点提醒我复习"，系统里没有一行东西能活到明天九点。
--
-- 时刻存 UTC（fire_at timestamptz），但工具参数收的是**用户本地挂钟时间**：
-- 让模型做时区算术一定会错（"她说早九点、系统按 UTC 九点"就是差八小时），
-- 而"明早九点"本来就是人的说法。换算在服务端做：
--   fire_at = ($local::timestamp AT TIME ZONE 账号时区)
-- 账号时区取 user_companion_account_state.quiet_hours->>'timezone'，回落 Asia/Shanghai，
-- 与 here_and_now / 静默判定同源（companion-here-and-now.ts 的 tzSubquery）。
--
-- 为什么不是 jobs 队列：一次对话里排的提醒可能在任何一分钟兑现，给每条建一个 job
-- 会往维护队列里塞上万条 pending；而"未来某个绝对时刻"也不是 jobs 的语义。
-- 一个每分钟扫表的定时器 + 四态状态机就够了。
--
-- 为什么要 missed 这一档：桌面端可能整夜关着。闹钟迟到八小时不是提醒，是骚扰。
-- 超过 2 小时没兑现的约定直接作废。
--
-- 与 0227 同模式：RLS 按 workspace+user，worker 全权（定时器要跨租户扫）；
-- 兑现函数 SECURITY DEFINER 且只授 EXECUTE 给 ailearn_worker。**roles.sql 的
-- REVOKE ALL ON ALL FUNCTIONS 会清掉这里的 GRANT EXECUTE**，必须同步镜像进
-- roles.sql 的 companion 白名单段，否则 worker 每分钟静默 permission denied。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 到点要说的话（≤200 字，写入端限制）。存的是**兑现文案**而不是"意图"：
  -- 兑现发生在几十个小时后，那时原对话早不在上下文里了。
  text text NOT NULL,
  fire_at timestamptz NOT NULL,
  -- pending → fired（已投递）| cancelled（用户撤回）| missed（过期太久，不再补发）
  status text NOT NULL DEFAULT 'pending',
  fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_reminders_text_len CHECK (char_length(text) BETWEEN 1 AND 200),
  CONSTRAINT companion_reminders_status_check
    CHECK (status IN ('pending', 'fired', 'cancelled', 'missed'))
);

ALTER TABLE public.companion_reminders ENABLE ROW LEVEL SECURITY;

-- 先 DROP 再 CREATE（与 0227 同模式）：migrate.ts 按文件内容 sha256 判断是否已应用，
-- 改动本文件会让它在已应用过的库上重跑，缺这一行会停在 "policy already exists"。
DROP POLICY IF EXISTS companion_reminders_workspace_user_isolation
  ON public.companion_reminders;
CREATE POLICY companion_reminders_workspace_user_isolation
  ON public.companion_reminders FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

-- 显式授权，不只依赖 0216 的 ALTER DEFAULT PRIVILEGES：那条只对**它之后**由 ailearn
-- 创建的表生效，而 dev 栈没有 docker-compose.yml 里的 role-grants 一次性服务
-- （0235 记录的同一个坑）。缺这一行的症状是"工具调用静默失败、一条日志都不留"。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_reminders TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_reminders TO ailearn_api;

-- 定时器每分钟只扫待兑现的那一小撮；用户侧"她答应了我什么"按人查。
CREATE INDEX IF NOT EXISTS companion_reminders_due_idx
  ON public.companion_reminders (fire_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS companion_reminders_user_idx
  ON public.companion_reminders (workspace_id, user_id, status, fire_at);

--> statement-breakpoint

-- 认领 + 投递 + NOTIFY 在**同一个函数调用**里做完，也就是同一个事务。
-- 如果先翻成 fired、再由 worker 单独开事务插投递，进程在两步之间挂掉就留下一条
-- "她已经答应、但永远不会兑现"的提醒。这里的补偿逻辑用 SQL 一次就能写完，
-- 不值得为它引入跨事务状态。
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
     WHERE r.status = 'pending'
       AND r.fire_at <= now()
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
  '到点提醒兑现：作废超过 2 小时的未兑现约定，认领到点的行、写进 assistant_deliveries 的 system_event 通道并随事务 NOTIFY。跨租户，仅供 worker 定时器调用。';

REVOKE ALL ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_fire_due_companion_reminders(integer) TO ailearn_worker;

-- 本迁移的上一版是"只认领不投递"的 ailearn_claim_due_companion_reminders：
-- 认领与投递分处两个事务，中间崩溃就留下一条永不兑现的 fired 提醒。合并职责后
-- 旧签名不留入口，直接删。
DROP FUNCTION IF EXISTS public.ailearn_claim_due_companion_reminders(integer);
