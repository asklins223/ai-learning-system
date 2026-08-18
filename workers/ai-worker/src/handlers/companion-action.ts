/**
 * P5 §6.8/§9.5：companion_action worker handler（慢动作真实状态）。
 *
 * - 读 job payload 的 opaque actionRunId；
 * - RLS 事务内：校验 run 仍 accepted（fence）→ 置 running → 按 payload.kind
 *   执行 Learning 公共入口的真实副作用（start_session 创建 learning_session；
 *   resume_session 只确认仍存在的活动 session；未具备可验证授权的
 *   ask_grounded_tutor fail-closed）→
 *   恰好一条 durable result 消息（kind='result'，resultRef 指向 run）→
 *   run succeeded/failed → action.completed/failed event → NOTIFY；
 * - 人设口吻不改变事实：result 正文 = 确定性模板 + 服务端事实字段
 *   （title/targetSummary/impactSummary 或执行结果），不引用模型原话。
 */

import { createHash, randomUUID } from "node:crypto";
import { logger } from "../lib/logger.ts";
export interface CompanionActionHandlerContext {
  payload: Record<string, unknown>;
  workspaceId: string;
  requestedBy: string | null;
}
import { sql } from "drizzle-orm";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { sanitizeOperationalError } from "@ailearn/shared";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 方案 16 §14.3：worker 侧 action_result delivery 投递（与 API delivery-service
 * 同一张表/同一 NOTIFY 通道；避免跨包引入 API db/client 依赖）。
 */
async function deliverActionInbox(
  tx: { execute(query: unknown): Promise<unknown> },
  input: {
    workspaceId: string;
    userId: string;
    kind: "proposal" | "action_result" | "proactive_cue" | "system_event";
    payloadRef: unknown;
    dedupeKey: string;
    expiresAt: Date;
  },
): Promise<void> {
  const existing = await tx.execute(sql`
    SELECT id FROM assistant_deliveries
    WHERE workspace_id = ${input.workspaceId} AND user_id = ${input.userId}
      AND dedupe_key = ${input.dedupeKey}
    LIMIT 1
  `) as Array<{ id: string }>;
  if (existing[0]) return;

  const maxRows = await tx.execute(sql`
    SELECT inbox_sequence FROM assistant_deliveries
    WHERE workspace_id = ${input.workspaceId} AND user_id = ${input.userId}
    ORDER BY inbox_sequence DESC LIMIT 1
    FOR UPDATE
  `) as Array<{ inbox_sequence: string }>;
  const inboxSequence = (Number(maxRows[0]?.inbox_sequence ?? 0)) + 1;

  const expiresAt = input.expiresAt.toISOString();
  await tx.execute(sql`
    INSERT INTO assistant_deliveries
      (id, assistant_session_id, workspace_id, user_id, inbox_sequence, dedupe_key,
       state, kind, payload_ref, created_at, expires_at, updated_at)
    VALUES
      (${randomUUID()}, NULL, ${input.workspaceId}, ${input.userId}, ${inboxSequence},
       ${input.dedupeKey}, 'queued', ${input.kind}, ${JSON.stringify(input.payloadRef)}::jsonb,
       now(), ${expiresAt}, now())
  `);
  await tx.execute(sql`
    SELECT pg_notify('ailearn_companion_inbox_v1', ${JSON.stringify({ userId: input.userId })})
  `);
}

interface ActionRunRow {
  [k: string]: unknown;
  id: string;
  conversation_id: string;
  workspace_id: string;
  user_id: string;
  proposal_id: string;
  status: string;
}

interface ProposalRow {
  [k: string]: unknown;
  payload: { kind: string; sessionId?: string; cardId?: string; keyPointId?: string; question?: string };
  title: string;
  target_summary: string;
}

/** L11：读取当前账号世代（与 API 侧 getCompanionAccountEpoch 同源）。 */
async function readAccountEpoch(
  tx: { execute(q: unknown): Promise<unknown> },
  userId: string,
): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT COALESCE(MAX(epoch), 0)::int AS epoch
    FROM user_companion_account_state
    WHERE user_id = ${userId}
  `)) as Array<{ epoch: string }>;
  return Number(rows[0]?.epoch ?? 0);
}

async function appendActionFailedEvent(
  tx: { execute(query: unknown): Promise<unknown[] | unknown> },
  run: ActionRunRow,
  code: string,
  recoverable: boolean,
): Promise<void> {
  const counters = await tx.execute(sql`
    UPDATE companion_conversations
    SET next_event_seq = next_event_seq + 1
    WHERE id = ${run.conversation_id}
    RETURNING next_event_seq
  `) as Array<{ next_event_seq: string }>;
  const eventSeq = Number(counters[0]?.next_event_seq ?? 1) - 1;
  const accountEpoch = await readAccountEpoch(tx, run.user_id);
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
       type, payload, expires_at)
    VALUES (${run.conversation_id}, ${eventSeq}, ${run.workspace_id}, ${run.user_id}, NULL, 0, ${accountEpoch},
            'action.failed',
            ${JSON.stringify({ actionRunId: run.id, code, recoverable })},
            now() + interval '24 hours')
  `);
  await tx.execute(sql`
    SELECT pg_notify('ailearn_companion_events_v1', ${JSON.stringify({ conversationId: run.conversation_id, maxSeq: eventSeq })})
  `);
}

function actionFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/ACTION_STALE|disappeared|not found/i.test(message)) return "ACTION_STALE";
  if (/unavailable|disabled|not configured/i.test(message)) return "ACTION_UNAVAILABLE";
  return "INTERNAL_ERROR";
}

async function projectCompanionActionFailure(args: {
  actionRunId: string;
  workspaceId: string;
  userId: string | null;
  code: string;
}): Promise<void> {
  await withWorkerWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const runs = await tx.execute<ActionRunRow>(sql`
        SELECT id, conversation_id, workspace_id, user_id, proposal_id, status
        FROM companion_action_runs
        WHERE id = ${args.actionRunId}
        FOR UPDATE
      `);
      const run = runs[0];
      if (!run || !["accepted", "running"].includes(run.status)) return;
      await tx.execute(sql`
        UPDATE companion_action_runs
        SET status = 'failed', error_code = ${args.code}, finished_at = now(), updated_at = now()
        WHERE id = ${run.id} AND status IN ('accepted', 'running')
      `);
      await tx.execute(sql`
        UPDATE companion_action_proposals
        SET status = 'failed', updated_at = now()
        WHERE id = ${run.proposal_id} AND status IN ('accepted', 'executing')
      `);
      await appendActionFailedEvent(tx, run, args.code, args.code === "INTERNAL_ERROR");
    },
  );
}

export async function runCompanionAction(ctx: CompanionActionHandlerContext): Promise<void> {
  const payload = ctx.payload as { actionRunId?: string };
  const runId = payload.actionRunId;
  if (!runId) {
    throw new Error("companion_action payload 缺 actionRunId");
  }

  let outcome: { skipped: boolean; failed?: boolean };
  try {
    outcome = await withWorkerWorkspaceTransaction(
      // requestedBy 为 null 时传 null（db.ts 的 normalizeContextUuid 支持 null），
      // 不能传 "" —— 空串会被 UUID 校验拒绝抛错，job 必失败。
      { workspaceId: ctx.workspaceId, userId: ctx.requestedBy ?? null },
      async (tx) => {
      const runs = await tx.execute<ActionRunRow>(sql`
        SELECT id, conversation_id, workspace_id, user_id, proposal_id, status
        FROM companion_action_runs
        WHERE id = ${runId}
        FOR UPDATE
      `);
      const run = runs[0];
      if (!run) return { skipped: true as const };
      if (run.status !== "accepted") return { skipped: true as const }; // 已处理/取消

      const proposals = await tx.execute<ProposalRow>(sql`
        SELECT payload, title, target_summary
        FROM companion_action_proposals
        WHERE id = ${run.proposal_id}
      `);
      const proposal = proposals[0];
      if (!proposal) {
        await tx.execute(sql`
          UPDATE companion_action_runs SET status = 'failed', error_code = 'NOT_FOUND',
            finished_at = now(), updated_at = now() WHERE id = ${run.id}
        `);
        await tx.execute(sql`
          UPDATE companion_action_proposals
          SET status = 'failed', updated_at = now()
          WHERE id = ${run.proposal_id}
        `);
        await appendActionFailedEvent(tx, run, "NOT_FOUND", false);
        return { skipped: false as const, failed: true as const };
      }

      await tx.execute(sql`
        UPDATE companion_action_runs SET status = 'running', started_at = now(), updated_at = now()
        WHERE id = ${run.id}
      `);
      await tx.execute(sql`
        UPDATE companion_action_proposals
        SET status = 'executing', updated_at = now()
        WHERE id = ${run.proposal_id} AND status = 'accepted'
      `);

      // 容错：postgres.js 原生 tag 写入的 jsonb 可能为字符串值（双重序列化历史数据）
      const proposalPayload =
        typeof proposal.payload === "string"
          ? (JSON.parse(proposal.payload) as ProposalRow["payload"])
          : proposal.payload;
      const kind = proposalPayload.kind;
      let resultText: string;
      let actionRoute: {
        kind: "learning_session";
        cardId: string;
        keyPointId: string;
        sessionId: string;
        origin: "card" | "review" | "star_map" | "now";
      } | null = null;
      if (kind === "start_session") {
        // The API decision path already ran the canonical PREPARE transaction.
        // Resolve that real session/episode and never fabricate a container-only
        // session in the worker.
        // V2: key_point_id is now an alias for objective_id;
        // card_id resolves through learning_cards_v2.objective_id.
        const prepared = await tx.execute<{
          session_id: string;
          card_id: string;
          key_point_id: string;
          origin: "card" | "review" | "star_map" | "now";
        }>(sql`
          SELECT s.id AS session_id, c.card_id, e.key_point_id, s.origin
          FROM learning_sessions s
          JOIN learning_episodes e ON e.session_id = s.id
          JOIN learning_cards_v2 c ON c.objective_id = e.key_point_id
          WHERE s.workspace_id = ${run.workspace_id}
            AND s.user_id = ${run.user_id}
            AND e.workspace_id = ${run.workspace_id}
            AND e.user_id = ${run.user_id}
            AND c.workspace_id = ${run.workspace_id}
            AND c.card_id = ${proposalPayload.cardId ?? ""}
            AND s.status = 'active'
            AND e.status IN ('draft', 'active')
            AND e.key_point_id = ${proposalPayload.keyPointId ?? ""}
          ORDER BY s.created_at DESC
          LIMIT 1
        `);
        if (!prepared[0]) throw new Error("ACTION_STALE: prepared learning session disappeared");
        actionRoute = {
          kind: "learning_session",
          cardId: prepared[0].card_id,
          keyPointId: prepared[0].key_point_id,
          sessionId: prepared[0].session_id,
          origin: prepared[0].origin,
        };
        resultText = `已为你开始一小段学习：${proposal.target_summary}。`;
      } else if (kind === "resume_session") {
        // resume_current is built only from an already-active Learning Session.
        // Do not mutate learning_sessions here: the companion worker must not
        // bypass the Learning Session service's lifecycle rules. The action is
        // a durable navigation/result projection over the active public route.
        const resumed = await tx.execute<{ id: string }>(sql`
          SELECT id
          FROM learning_sessions
          WHERE id = ${proposalPayload.sessionId ?? ""}
            AND workspace_id = ${run.workspace_id} AND user_id = ${run.user_id}
            AND status = 'active'
          LIMIT 1
        `);
        if (!resumed[0]) throw new Error("ACTION_STALE: active learning session disappeared");
        // V2: key_point_id is now an alias for objective_id;
        // card_id resolves through learning_cards_v2.objective_id.
        const routeRows = await tx.execute<{
          card_id: string;
          key_point_id: string;
          origin: "card" | "review" | "star_map" | "now";
        }>(sql`
          SELECT c.card_id, e.key_point_id, s.origin
          FROM learning_sessions s
          JOIN learning_episodes e ON e.session_id = s.id
          JOIN learning_cards_v2 c ON c.objective_id = e.key_point_id
          WHERE s.id = ${proposalPayload.sessionId ?? ""}
            AND s.workspace_id = ${run.workspace_id}
            AND s.user_id = ${run.user_id}
            AND e.workspace_id = ${run.workspace_id}
            AND e.user_id = ${run.user_id}
            AND c.workspace_id = ${run.workspace_id}
            AND e.status IN ('draft', 'active')
          ORDER BY e.created_at ASC
          LIMIT 1
        `);
        if (!routeRows[0]) throw new Error("ACTION_STALE: learning session episode disappeared");
        actionRoute = {
          kind: "learning_session",
          cardId: routeRows[0].card_id,
          keyPointId: routeRows[0].key_point_id,
          sessionId: proposalPayload.sessionId ?? "",
          origin: routeRows[0].origin,
        };
        resultText = `已为你继续当前学习：${proposal.target_summary}。`;
      } else {
        // Grounded tutor is available through the Learning Session page's
        // explicit grant flow. Until an action proposal carries the same
        // verifiable grant, fail closed instead of fabricating a tutor result.
        throw new Error("ACTION_UNAVAILABLE: grounded tutor action requires a verified page grant");
      }

      // 恰好一条 durable result 消息（resultRef → run）
      const resultMessageId = randomUUID();
      const counters = await tx.execute<{ next_message_seq: string; next_event_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_message_seq = next_message_seq + 1,
            next_event_seq = next_event_seq + 1,
            last_message_at = now()
        WHERE id = ${run.conversation_id}
        RETURNING next_message_seq, next_event_seq
      `);
      const messageSeq = Number(counters[0].next_message_seq) - 1;
      const eventSeq = Number(counters[0].next_event_seq) - 1;
      const blocks = [{ type: "text", text: resultText }];
      await tx.execute(sql`
        INSERT INTO companion_messages
          (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
        VALUES (${resultMessageId}, ${run.conversation_id}, ${run.workspace_id}, ${run.user_id},
                'assistant', ${messageSeq}, 'result', ${JSON.stringify(blocks)},
                ${sha256Hex(resultText)})
      `);
      await tx.execute(sql`
        UPDATE companion_action_runs
        SET status = 'succeeded', result_message_id = ${resultMessageId},
            result_ref = ${`run:${run.id}`}, safe_summary = ${proposal.target_summary.slice(0, 240)},
            route = ${JSON.stringify(actionRoute)}, finished_at = now(), updated_at = now()
        WHERE id = ${run.id}
      `);
      await tx.execute(sql`
        UPDATE companion_action_proposals
        SET status = 'succeeded', updated_at = now()
        WHERE id = ${run.proposal_id}
      `);
      const completedAccountEpoch = await readAccountEpoch(tx, run.user_id);
      await tx.execute(sql`
        INSERT INTO companion_stream_events
          (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
           type, payload, expires_at)
        VALUES (${run.conversation_id}, ${eventSeq}, ${run.workspace_id}, ${run.user_id}, NULL, 0, ${completedAccountEpoch},
                'action.completed',
                ${JSON.stringify({
                  actionRunId: run.id,
                  resultRef: `run:${run.id}`,
                  route: actionRoute,
                  safeSummary: proposal.target_summary.slice(0, 240),
                })},
                now() + interval '24 hours')
      `);
      await tx.execute(sql`
        SELECT pg_notify('ailearn_companion_events_v1', ${JSON.stringify({ conversationId: run.conversation_id, maxSeq: eventSeq })})
      `);
      // 方案 16 §14.3：异步 action 完成后向 pet inbox 投递 action_result。
      await deliverActionInbox(tx, {
        workspaceId: run.workspace_id,
        userId: run.user_id,
        kind: "action_result",
        payloadRef: { kind: "action_result", actionRunId: run.id },
        dedupeKey: `action_result:${run.id}`,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      return { skipped: false as const, failed: false as const };
      },
    );
  } catch (error) {
    const code = actionFailureCode(error);
    try {
      await projectCompanionActionFailure({
        actionRunId: runId,
        workspaceId: ctx.workspaceId,
        // 与主路径一致：requestedBy 为 null 传 null，不能传 ""（UUID 校验拒绝）
        userId: ctx.requestedBy ?? null,
        code,
      });
    } catch (projectionError) {
      logger.error({ runId, code, error: sanitizeOperationalError(projectionError) }, "companion action failure projection failed");
      throw projectionError;
    }
    logger.warn({ runId, code, err: error }, "companion action projected as failed");
    return;
  }

  if (outcome.skipped) return;
  if (outcome.failed) return;
}
