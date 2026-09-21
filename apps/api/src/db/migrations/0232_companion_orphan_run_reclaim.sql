-- 0232: 回收"job 已死 / 根本没有 job"的孤儿 companion run（方案 29 §9.3）。
--
-- 现象：companion_agent job 走到 dead（重试次数用尽或非重试错误）之后，它的
-- companion_turn_runs 行**仍停在 accepted/running**。而 active run 上有 partial
-- unique index 保护同一会话，于是该 conversation 之后的每一轮 turn 都被
-- 409 RUN_ALREADY_ACTIVE 拒死——一次失败毒死整个会话，而不是一轮。
-- 这正是用户报的「经常性的出现输出不了东西了」的一条独立成因，与单轮 fail-closed
-- （§3.5）不是一回事。
--
-- 实测样本：dev 库里有 6 个 run 停在 running 且 started_at IS NULL、job_id 无对应行
-- （worker 在 read 阶段崩溃/被杀留下的），最早的是 09-19；另有若干 accepted 行其
-- job 已 dead。
--
-- 为什么写成 SECURITY DEFINER 而不是 worker 里一条 SELECT：
--   worker 在**生产**用 DATABASE_URL_WORKER=ailearn_worker（非 superuser、无
--   BYPASSRLS），跨租户扫描会被 companion_turn_runs / companion_conversations 的
--   RLS 滤成空集——回收器会在 dev 一切正常、在生产静默什么都不做。owner 取
--   ailearn_migrator（BYPASSRLS），与 0212 记忆维护、0217 确认回收同一模式。
--
-- 副作用与 worker 侧 markCompanionRunFailed（companion-dialogue-store.ts）逐条对齐，
-- 避免两条终结路径语义漂移：
--   - run → failed，写 error_code，清 waiting_proposal_id，落 finished_at
--   - 每个 run 补写 error + character.cue 两个事件（同一会话内分配连续 seq）
--   - 该 run 已有事件的 expires_at 统一刷成 now()+24h
--   - 回写 run.last_event_seq 并 pg_notify，让挂着的 SSE 立刻收尾而不是干等
--
-- 只处理 accepted/running 两种状态：waiting_for_confirmation 由 0217 的确认回收负责
-- （它有活的 proposal 指针，语义不同），cancel_requested 由取消链路自己收尾。
-- 5 分钟宽限期是给正常执行留的余量：companion_agent 的 handler 超时是 110s，
-- 远小于此，所以不会误杀正在跑的轮次。

CREATE OR REPLACE FUNCTION public.ailearn_reclaim_orphaned_companion_runs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_conv record;
  v_run record;
  v_total integer := 0;
  v_seq bigint;
BEGIN
  -- 逐会话、再逐 run 处理。孤儿本就稀少（worker 崩溃/被杀才会产生），用循环换取
  -- 可读性与"seq 分配一眼可验"，比把 row_number 在三条语句里各算一遍更不容易错。
  FOR v_conv IN
    SELECT r.conversation_id AS cid
    FROM public.companion_turn_runs r
    LEFT JOIN public.jobs j ON j.id = r.job_id
    WHERE r.status IN ('accepted', 'running')
      AND r.created_at < now() - interval '5 minutes'
      AND (r.job_id IS NULL OR j.id IS NULL OR j.status = 'dead')
    GROUP BY r.conversation_id
  LOOP
    FOR v_run IN
      SELECT r.id, r.workspace_id, r.user_id, r.generation, r.account_epoch, r.job_id
      FROM public.companion_turn_runs r
      LEFT JOIN public.jobs j ON j.id = r.job_id
      WHERE r.conversation_id = v_conv.cid
        AND r.status IN ('accepted', 'running')
        AND r.created_at < now() - interval '5 minutes'
        AND (r.job_id IS NULL OR j.id IS NULL OR j.status = 'dead')
      ORDER BY r.created_at, r.id
    LOOP
      UPDATE public.companion_turn_runs
      SET status = 'failed',
          error_code = CASE WHEN v_run.job_id IS NULL THEN 'JOB_MISSING' ELSE 'JOB_DEAD' END,
          waiting_proposal_id = NULL,
          finished_at = now(),
          updated_at = now()
      WHERE id = v_run.id
        AND status IN ('accepted', 'running');

      IF NOT FOUND THEN
        -- 抢在回收之前被别的终态路径（cancel / supersede）收尾了。
        CONTINUE;
      END IF;

      -- 每个 run 两个事件：error @ seq、character.cue @ seq+1。
      UPDATE public.companion_conversations
      SET next_event_seq = next_event_seq + 2
      WHERE id = v_conv.cid
      RETURNING next_event_seq - 2 INTO v_seq;

      INSERT INTO public.companion_stream_events
        (conversation_id, seq, workspace_id, user_id, run_id, generation,
         account_epoch, type, payload, expires_at)
      VALUES
        (v_conv.cid, v_seq, v_run.workspace_id, v_run.user_id, v_run.id, v_run.generation,
         v_run.account_epoch, 'error',
         jsonb_build_object(
           'code', CASE WHEN v_run.job_id IS NULL THEN 'JOB_MISSING' ELSE 'JOB_DEAD' END,
           'message', '这一轮的处理任务已终止，没有产出回复。',
           'recoverable', false,
           'requestId', v_run.id
         ),
         now() + interval '24 hours'),
        (v_conv.cid, v_seq + 1, v_run.workspace_id, v_run.user_id, v_run.id, v_run.generation,
         v_run.account_epoch, 'character.cue',
         jsonb_build_object('cue', jsonb_build_object(
           'version', 1, 'intent', 'uncertain', 'emotion', 'concerned', 'intensity', 0.45
         )),
         now() + interval '24 hours');

      UPDATE public.companion_stream_events
      SET expires_at = now() + interval '24 hours'
      WHERE conversation_id = v_conv.cid AND run_id = v_run.id;

      UPDATE public.companion_turn_runs
      SET last_event_seq = v_seq + 1, updated_at = now()
      WHERE id = v_run.id;

      PERFORM pg_notify(
        'ailearn_companion_events_v1',
        json_build_object('conversationId', v_conv.cid, 'maxSeq', v_seq + 1)::text
      );

      v_total := v_total + 1;
    END LOOP;
  END LOOP;

  RETURN v_total;
END;
$$;

ALTER FUNCTION public.ailearn_reclaim_orphaned_companion_runs() OWNER TO ailearn_migrator;

-- 只有 worker 需要。不授 PUBLIC。
REVOKE ALL ON FUNCTION public.ailearn_reclaim_orphaned_companion_runs() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT EXECUTE ON FUNCTION public.ailearn_reclaim_orphaned_companion_runs() TO ailearn_worker;
  END IF;
END $$;

COMMENT ON FUNCTION public.ailearn_reclaim_orphaned_companion_runs() IS
  '定时兜底：终结 job 已死或缺失的孤儿 companion run，解除整个会话的 409 锁死。';
