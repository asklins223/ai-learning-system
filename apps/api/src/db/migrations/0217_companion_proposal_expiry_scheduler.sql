-- 0217: 定时兜底回收失效的 companion 确认（方案 §5）。
--
-- Companion Agent 的高风险工具会冻结一个 5 分钟 TTL 的 proposal，并把 run 停在
-- waiting_for_confirmation。该状态属于 active（companion_turn_runs 的 active partial
-- unique index 覆盖它），因此只要 run 不终结，该 conversation 的所有后续 turn 都会被
-- 409 RUN_ALREADY_ACTIVE 拒死。
--
-- API 侧已在所有交互入口（新 turn / 新 proposal / 确认决策）做惰性回收，但惰性意味着
-- 「用户不再操作」时 run 会永久停在非终态。本函数是定时兜底：worker 周期性调用，
-- 保证无论有没有后续交互，失效确认都会终结。
--
-- 回收条件与 API 侧 companion-proposal-expiry.ts 保持一致：
--   1. TTL 过期：expires_at < now()
--   2. 账号世代失效：Agent run 冻结的 account_epoch ≠ 当前 epoch，或伴星 global off
--      （用户永远看不到/无法确认它）
--
-- 副作用（与 API 侧逐条对齐，避免两条路径语义漂移）：
--   - proposal → expired
--   - 等待确认的工具调用 → expired（冻结的确认不可再执行）
--   - 停在 waiting_for_confirmation 的 run → failed / ACTION_EXPIRED
--   - 每个受影响 conversation 补写 action.expired 事件（分配连续 seq + NOTIFY）
--
-- SECURITY DEFINER：worker 角色受 RLS 约束无法跨租户扫描；owner 为 ailearn_migrator
-- （BYPASSRLS），与 0212 的维护函数同一模式。

CREATE OR REPLACE FUNCTION public.ailearn_reclaim_stale_companion_proposals()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ids uuid[];
  v_total integer := 0;
  v_conv record;
  v_start_seq bigint;
BEGIN
  SELECT array_agg(p.id), count(*)::int
    INTO v_ids, v_total
  FROM public.companion_action_proposals p
  LEFT JOIN public.companion_turn_runs r ON r.id = p.agent_run_id
  LEFT JOIN public.user_companion_account_state s ON s.user_id = p.user_id
  WHERE p.status = 'pending'
    AND (
      p.expires_at < now()
      OR (
        p.origin = 'agent_tool'
        AND p.agent_run_id IS NOT NULL
        AND (
          COALESCE(s.global_enabled, true) = false
          OR COALESCE(s.epoch, 0) <> r.account_epoch
        )
      )
    );

  IF v_total = 0 OR v_ids IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.companion_action_proposals
  SET status = 'expired', updated_at = now()
  WHERE id = ANY(v_ids);

  UPDATE public.companion_agent_tool_calls
  SET status = 'expired', result_safe_summary = '确认已过期', updated_at = now()
  WHERE proposal_id = ANY(v_ids)
    AND status = 'waiting_confirmation';

  UPDATE public.companion_turn_runs
  SET status = 'failed', error_code = 'ACTION_EXPIRED',
      waiting_proposal_id = NULL, finished_at = now(), updated_at = now()
  WHERE waiting_proposal_id = ANY(v_ids)
    AND status = 'waiting_for_confirmation';

  FOR v_conv IN
    SELECT p.conversation_id AS cid, count(*)::int AS n
    FROM public.companion_action_proposals p
    WHERE p.id = ANY(v_ids)
    GROUP BY p.conversation_id
  LOOP
    -- 与 API 侧 appendActionExpiredEventsBatch 相同的 seq 算术：
    -- RETURNING 拿到的是加完后的值，因此本批可用区间是 [new - n, new - 1]。
    UPDATE public.companion_conversations
    SET next_event_seq = next_event_seq + v_conv.n
    WHERE id = v_conv.cid
    RETURNING next_event_seq - v_conv.n INTO v_start_seq;

    INSERT INTO public.companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation,
       account_epoch, type, payload, expires_at)
    SELECT p.conversation_id,
           v_start_seq + (row_number() OVER (ORDER BY p.id)) - 1,
           p.workspace_id,
           p.user_id,
           NULL,
           0,
           COALESCE((
             SELECT MAX(s.epoch) FROM public.user_companion_account_state s
             WHERE s.user_id = p.user_id
           ), 0),
           'action.expired',
           jsonb_build_object('proposalId', p.id),
           now() + interval '24 hours'
    FROM public.companion_action_proposals p
    WHERE p.id = ANY(v_ids)
      AND p.conversation_id = v_conv.cid;

    PERFORM pg_notify(
      'ailearn_companion_events_v1',
      json_build_object(
        'conversationId', v_conv.cid,
        'maxSeq', v_start_seq + v_conv.n - 1
      )::text
    );
  END LOOP;

  RETURN v_total;
END;
$$;

ALTER FUNCTION public.ailearn_reclaim_stale_companion_proposals() OWNER TO ailearn_migrator;

-- 只有 worker 需要（API 走 TS 惰性回收路径）。不授 PUBLIC。
REVOKE ALL ON FUNCTION public.ailearn_reclaim_stale_companion_proposals() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT EXECUTE ON FUNCTION public.ailearn_reclaim_stale_companion_proposals() TO ailearn_worker;
  END IF;
END $$;

COMMENT ON FUNCTION public.ailearn_reclaim_stale_companion_proposals() IS
  '定时兜底：把过期或账号世代失效的 companion 确认置为终态并终结其挂起 run。';
