/**
 * Companion action proposal TTL 回收。
 *
 * 独立模块（而非放在 learning-action-bridge.ts）：turn-service 与 action bridge
 * 都需要在 active run 校验之前调用回收，而 bridge 依赖 turn-service 的
 * CompanionConversationError——把回收留在 bridge 会造成 turn-service ⇄ bridge
 * 循环 import。本模块只依赖 companion-account-epoch 叶子模块。
 */

import { sql } from "drizzle-orm";
import { getCompanionAccountEpoch } from "./companion-account-epoch.ts";

export type ExpiredProposalRow = {
  id: string; conversation_id: string;
  source_message_id: string; source_generation: number; payload: unknown;
  payload_sha256: string; title: string; target_summary: string; impact_summary: string;
  status: string; decision: string | null; expires_at: Date;
  decided_at: Date | null; created_at: Date; updated_at: Date;
};

/**
 * 轻微·18（round-4）：批量写入同 conversation 的 N 个 action.expired 事件。
 * account_epoch 共享（同 user），seq 由单次 counter UPDATE +N 后本地递推，
 * INSERT 用多行 VALUES。与逐行 appendActionExpiredEvent 语义/字段完全一致。
 */
async function appendActionExpiredEventsBatch(
  tx: { execute(q: unknown): Promise<unknown[] | unknown> },
  workspaceId: string,
  userId: string,
  conversationId: string,
  expired: ExpiredProposalRow[],
): Promise<void> {
  if (expired.length === 0) return;
  const accountEpoch = await getCompanionAccountEpoch(tx, userId);
  const counters = await tx.execute(sql`
    UPDATE companion_conversations SET next_event_seq = next_event_seq + ${expired.length}
    WHERE id = ${conversationId} RETURNING next_event_seq
  `);
  const baseSeq = Number((counters as Array<{ next_event_seq: string }>)[0].next_event_seq) - expired.length;
  // 多行 VALUES：用 sql.join 逐 tuple 参数化组装（每 tuple 的 uuid 字段经 ::uuid 绑定，
  // 键/值均受控，无注入；conversation_id 来自已校验的 expired 行）。
  const tuples = expired.map((row, i) =>
    sql`(${conversationId}, ${baseSeq + i}, ${workspaceId}, ${userId}, NULL, 0, ${accountEpoch},
         'action.expired', ${JSON.stringify({ proposalId: row.id })},
         now() + interval '24 hours')`,
  );
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
       type, payload, expires_at)
    VALUES ${sql.join(tuples, sql`, `)}
  `);
}

/**
 * 终结一组已失效 proposal 的挂起副作用：工具调用 → expired、其等待中的 run → 终态。
 * TTL 过期与账号世代失效共用，只有 error_code / 摘要不同。
 */
async function terminateProposalSideEffects(
  tx: { execute(q: unknown): Promise<unknown[] | unknown> },
  proposalIds: string[],
  errorCode: string,
  safeSummary: string,
): Promise<void> {
  if (proposalIds.length === 0) return;
  const ids = sql.join(proposalIds.map((id) => sql`${id}`), sql`, `);
  await tx.execute(sql`
    UPDATE companion_agent_tool_calls
    SET status = 'expired', result_safe_summary = ${safeSummary}, updated_at = now()
    WHERE proposal_id IN (${ids}) AND status = 'waiting_confirmation'
  `);
  await tx.execute(sql`
    UPDATE companion_turn_runs
    SET status = 'failed', error_code = ${errorCode},
        waiting_proposal_id = NULL, finished_at = now(), updated_at = now()
    WHERE waiting_proposal_id IN (${ids})
      AND status = 'waiting_for_confirmation'
  `);
}

const EXPIRED_PROPOSAL_RETURNING = sql`
  id, conversation_id, source_message_id, source_generation,
  payload, payload_sha256, title, target_summary, impact_summary,
  status, decision, expires_at, decided_at, created_at, updated_at
`;

/**
 * 原子回收一个 conversation 中已失效的 pending proposal，分两类：
 *
 * 1. TTL 过期（`expires_at < now()`，5 分钟确认窗口）。
 * 2. 账号世代失效：Agent proposal 所属 run 冻结的 `account_epoch` 与当前
 *    `user_companion_account_state.epoch` 不一致，或伴星被 global off。
 *    用户永远不会看到/确认它，而 run 仍停在 waiting_for_confirmation（active），
 *    该 conversation 的所有后续 turn 都会被 409 拒死。
 *
 * 两类都终结挂起副作用：
 * - companion_agent_tool_calls.waiting_confirmation → expired（冻结的确认不可再执行）
 * - companion_turn_runs.waiting_for_confirmation → failed
 *
 * 这是 Agent 方案 §5 的硬要求（“确认过期、账号关闭或 epoch 变化时，不执行工具，
 * 并将 run 置为终态”）。因此必须在 active run 校验**之前**调用
 * （createCompanionTurn / createCompanionProposalInTransaction），否则判 active
 * 会先抛 409，回收永不触发。返回本次回收的 proposal 数。
 */
export async function reclaimExpiredCompanionProposals(
  tx: { execute(q: unknown): Promise<unknown[] | unknown> },
  args: { workspaceId: string; userId: string; conversationId: string },
): Promise<number> {
  const expired = await tx.execute(sql`
    UPDATE companion_action_proposals
    SET status = 'expired', updated_at = now()
    WHERE conversation_id = ${args.conversationId} AND status = 'pending'
      AND expires_at < now()
    RETURNING ${EXPIRED_PROPOSAL_RETURNING}
  `) as ExpiredProposalRow[];
  await appendActionExpiredEventsBatch(tx, args.workspaceId, args.userId, args.conversationId, expired);
  await terminateProposalSideEffects(
    tx,
    expired.map((row) => row.id),
    "ACTION_EXPIRED",
    "确认已过期",
  );

  const stale = await tx.execute(sql`
    UPDATE companion_action_proposals p
    SET status = 'expired', updated_at = now()
    WHERE p.conversation_id = ${args.conversationId} AND p.status = 'pending'
      AND p.origin = 'agent_tool' AND p.agent_run_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM companion_turn_runs r
        LEFT JOIN user_companion_account_state s ON s.user_id = r.user_id
        WHERE r.id = p.agent_run_id
          AND (COALESCE(s.global_enabled, true) = false
               OR COALESCE(s.epoch, 0) <> r.account_epoch)
      )
    RETURNING ${EXPIRED_PROPOSAL_RETURNING}
  `) as ExpiredProposalRow[];
  await appendActionExpiredEventsBatch(tx, args.workspaceId, args.userId, args.conversationId, stale);
  await terminateProposalSideEffects(
    tx,
    stale.map((row) => row.id),
    "ACTION_STALE",
    "账号世代已变化，确认已失效",
  );

  return expired.length + stale.length;
}

/**
 * supersede 时作废被取代 run 的冻结确认。
 *
 * turn-service 把旧 run 置为 superseded 后，其 pending proposal 若仍可确认，
 * 用户点确认会走过 epoch/active 校验（该 run 已非 active）→ **真正执行副作用**，
 * 但 continuation 阶段因 run 不再是 waiting_for_confirmation 而返回 null：
 * 动作已生效、却既不回填工具结果也不继续 Agent。与 cancel 一致先行作废。
 * 事件语义由 turn.cancelled / 新 turn 承担，无需额外 action.expired。
 */
export async function invalidateSupersededRunProposals(
  tx: { execute(q: unknown): Promise<unknown[] | unknown> },
  args: { runId: string },
): Promise<void> {
  await tx.execute(sql`
    UPDATE companion_agent_tool_calls
    SET status = 'expired', result_safe_summary = '运行已被新的消息取代', updated_at = now()
    WHERE run_id = ${args.runId}
      AND status IN ('requested', 'executing', 'waiting_confirmation')
  `);
  await tx.execute(sql`
    UPDATE companion_action_proposals
    SET status = 'expired', updated_at = now()
    WHERE agent_run_id = ${args.runId} AND status = 'pending'
  `);
}
