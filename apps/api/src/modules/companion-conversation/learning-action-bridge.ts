/**
 * P5 §6.7：Learning menu context adapter（只读）。
 *
 * GET /companion/learning-context：只调用 Learning Session/service 的只读
 * public adapter（learning_sessions/learning_episodes/card_key_points 查询），
 * 零 canonical write、零 conversation write、零模型调用。
 * - resumeCandidate：最近 active learning_session（null → 菜单项 disabled）；
 * - startCandidate：最近 episode 对应的 key point/card（null → disabled）；
 * - contextRevision：候选快照的 canonical JSON sha256（稳定 revision）；
 * - payloadSha256：候选 payload 的 canonical JSON sha256（proposal create 时精确匹配）。
 * 所有文本字段净化（控制字符/空白压缩）后再截断到合同上限。
 */

import { sql } from "drizzle-orm";
import {
  canonicalJsonV1,
  sha256Utf8V1,
  companionGroundedTutorGrantV1Schema,
  companionLearningSessionContextV1Schema,
  companionProposalSnapshotV1Schema,
} from "@ailearn/shared";
import type { CompanionLearningContextV1 } from "@ailearn/shared";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { resolveAuthSurfaceManifestSecret } from "../companion-shell/auth-surface.ts";
import { getCompanionAccountEpoch } from "./companion-account-epoch.ts";
import {
  buildCompanionLearningSessionContext,
  contextRevisionForCompanionLearningSession,
  loadCompanionLearningSessionContext,
} from "./learning-session-context.ts";

function sanitizeText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function resolveCompanionLearningContextInTransaction(
  tx: ApiTransaction,
  args: {
    workspaceId: string;
    userId: string;
  },
): Promise<CompanionLearningContextV1> {
  // This helper deliberately accepts the caller's transaction. Proposal
  // creation must validate the read-only context and perform all writes under
  // the same RLS snapshot; opening a nested transaction here would leave a
  // race between validation and insertion.
  // resume：最近 active session + 其 episode 的 key point
  const sessions = await tx.execute<{ id: string; intent: string }>(sql`
    SELECT s.id, s.intent
    FROM learning_sessions s
    WHERE s.workspace_id = ${args.workspaceId}
      AND s.user_id = ${args.userId}
      AND s.status = 'active'
    ORDER BY s.created_at DESC
    LIMIT 1
  `);
  let resumeCandidate: CompanionLearningContextV1["resumeCandidate"] = null;
  if (sessions[0]) {
    const eps = await tx.execute<{ key_point_id: string; claim: string | null }>(sql`
      SELECT e.key_point_id, k.claim
      FROM learning_episodes e
      JOIN card_key_points k ON k.id = e.key_point_id
      WHERE e.session_id = ${sessions[0].id}
        AND e.workspace_id = ${args.workspaceId}
        AND e.user_id = ${args.userId}
        AND k.workspace_id = ${args.workspaceId}
      LIMIT 1
    `);
    const claim = eps[0]?.claim ?? sessions[0].intent;
    const title = sanitizeText(claim, 80) || "继续当前学习";
    const payload = { kind: "resume_session", sessionId: sessions[0].id };
    resumeCandidate = {
      candidateId: "resume_current",
      title,
      targetSummary: sanitizeText(`继续学习：${title}`, 160),
      impactSummary: "完成后更新学习进度",
      payloadSha256: sha256Utf8V1(canonicalJsonV1(payload)),
    };
  }

  // start：最近 episode 的 key point + card（构造 start_session payload）
  const startRows = await tx.execute<{
    key_point_id: string;
    card_id: string;
    claim: string | null;
  }>(sql`
    SELECT k.id AS key_point_id, k.card_id, k.claim
    FROM learning_episodes e
    JOIN card_key_points k ON k.id = e.key_point_id
    WHERE e.workspace_id = ${args.workspaceId}
      AND e.user_id = ${args.userId}
      AND k.workspace_id = ${args.workspaceId}
    ORDER BY e.created_at DESC
    LIMIT 1
  `);
  let startCandidate: CompanionLearningContextV1["startCandidate"] = null;
  if (startRows[0]) {
    const claim = startRows[0].claim ?? "";
    const title = sanitizeText(claim, 80) || "开始一小段学习";
    const payload = {
      kind: "start_session",
      origin: "now",
      cardId: startRows[0].card_id,
      keyPointId: startRows[0].key_point_id,
    };
    startCandidate = {
      candidateId: "start_short",
      title,
      targetSummary: sanitizeText(`开始学习：${title}`, 160),
      impactSummary: "完成后更新学习进度",
      payloadSha256: sha256Utf8V1(canonicalJsonV1(payload)),
    };
  }

  const contextRevision = sha256Utf8V1(
    canonicalJsonV1({ resumeCandidate, startCandidate }),
  );
  return {
    version: 1,
    contextRevision,
    resumeCandidate,
    startCandidate,
  };
}

export async function resolveCompanionLearningContext(args: {
  workspaceId: string;
  userId: string;
}): Promise<CompanionLearningContextV1> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    (tx) => resolveCompanionLearningContextInTransaction(tx, args),
  );
}

// ─── P5 §6.7 Menu proposal create（原子事务） ───────────────────────────

import { randomUUID } from "node:crypto";
import {
  canonicalJsonV1 as canonicalJson,
  sha256Utf8V1 as sha256,
} from "@ailearn/shared";
import { CompanionConversationError } from "./turn-service.ts";
import {
  createPgSessionRepository,
  createSession,
  SessionServiceError,
} from "../learning-sessions/session-service.ts";

const PROPOSAL_TTL_MINUTES = 5; // §6.7：resume/start 默认 5min（纯导航 10min）

function menuProposalRequestHash(body: {
  version: 1;
  conversationId?: string;
  clientMessageId: string;
  candidateId: "resume_current" | "start_short";
  expectedContextRevision: string;
  expectedPayloadSha256: string;
  sourceSurface: "pet" | "main" | "web_fallback";
}): string {
  return sha256(canonicalJson({
    version: body.version,
    conversationId: body.conversationId ?? null,
    clientMessageId: body.clientMessageId,
    candidateId: body.candidateId,
    expectedContextRevision: body.expectedContextRevision,
    expectedPayloadSha256: body.expectedPayloadSha256,
    sourceSurface: body.sourceSurface,
  }));
}

/**
 * §6.7：POST /companion/menu-proposals。
 * 同一 RLS 事务：重算 context → 精确验证 revision/candidate/payloadSha256 →
 * conversation 校验/创建 → 原子插入 user action message + assistant confirmation
 * （带 action_ref）+ pending proposal + action.proposed event。
 * 任何验证失败零写入；同 key 同 body 幂等返回同 response，异 body 409。
 */
export async function createCompanionMenuProposal(args: {
  workspaceId: string;
  userId: string;
  body: {
    version: 1;
    conversationId?: string;
    clientMessageId: string;
    candidateId: "resume_current" | "start_short";
    expectedContextRevision: string;
    expectedPayloadSha256: string;
    sourceSurface: "pet" | "main" | "web_fallback";
  };
  idempotencyKey: string;
}): Promise<unknown> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      // L11：事件携带当前账号世代（global off 后旧 action 事件被客户端拒绝）。
      const accountEpoch = await getCompanionAccountEpoch(tx, args.userId);
      // 幂等：同 key 同 body 返回同 response；异 body 冲突
      // §2.1：idempotency key hash 对校验后的 UUID 小写 ASCII 原文计算。
      const keyHash = sha256(args.idempotencyKey.toLowerCase());
      const requestBodyHash = menuProposalRequestHash(args.body);
      const existing = await tx.execute<{
        id: string;
        conversation_id: string;
        source_message_id: string;
        payload: { kind: string; [key: string]: unknown };
        source_generation: number;
        context_grant_id: string | null;
        payload_sha256: string;
        title: string;
        target_summary: string;
        impact_summary: string;
        status: string;
        decision: string | null;
        action_run_id: string | null;
        expires_at: Date;
        decided_at: Date | null;
        created_at: Date;
        updated_at: Date;
        request_body_sha256: string | null;
        assistant_message_id: string | null;
        event_cursor: string | null;
      }>(sql`
        SELECT p.id, p.conversation_id, p.source_message_id, p.payload,
               p.source_generation, p.context_grant_id, p.payload_sha256,
               p.title, p.target_summary, p.impact_summary, p.status, p.decision,
               p.action_run_id, p.expires_at, p.decided_at, p.created_at, p.updated_at,
               p.request_body_sha256,
               assistant.id AS assistant_message_id,
               event.seq AS event_cursor
        FROM companion_action_proposals p
        LEFT JOIN companion_messages assistant ON assistant.action_ref = p.id
        LEFT JOIN companion_stream_events event
          ON event.conversation_id = p.conversation_id
         AND event.type = 'action.proposed'
         AND event.payload->'proposal'->>'id' = p.id::text
        WHERE p.idempotency_key_hash = ${keyHash}
        LIMIT 1
      `);
      if (existing[0]) {
        const row = existing[0];
        if (row.request_body_sha256 !== requestBodyHash) {
          throw new CompanionConversationError(
            "IDEMPOTENCY_CONFLICT", 409, "menu proposal key reused with a different body",
          );
        }
        if (!row.assistant_message_id || !row.event_cursor) {
          throw new CompanionConversationError(
            "IDEMPOTENCY_CONFLICT", 409, "existing menu proposal response is incomplete",
          );
        }
        return {
          version: 1,
          conversationId: row.conversation_id,
          userMessageId: row.source_message_id,
          assistantMessageId: row.assistant_message_id,
          proposal: {
            version: 1,
            proposalId: row.id,
            conversationId: row.conversation_id,
            sourceMessageId: row.source_message_id,
            sourceGeneration: row.source_generation,
            contextGrantId: row.context_grant_id,
            payload: row.payload,
            payloadSha256: row.payload_sha256,
            title: row.title,
            targetSummary: row.target_summary,
            impactSummary: row.impact_summary,
            requiresConfirmation: true,
            status: row.status,
            decision: row.decision,
            actionRunId: row.action_run_id,
            expiresAt: new Date(row.expires_at).toISOString(),
            decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          },
          eventCursor: Number(row.event_cursor),
        };
      }

      // 重算 context（同事务只读）
      const context = await resolveCompanionLearningContextInTransaction(tx, {
        workspaceId: args.workspaceId,
        userId: args.userId,
      });
      if (context.contextRevision !== args.body.expectedContextRevision) {
        throw new CompanionConversationError(
          "ACTION_STALE", 409, "context revision mismatch",
        );
      }
      const candidate =
        args.body.candidateId === "resume_current"
          ? context.resumeCandidate
          : context.startCandidate;
      if (!candidate) {
        throw new CompanionConversationError(
          "ACTION_STALE", 409, "candidate unavailable",
        );
      }
      if (candidate.payloadSha256 !== args.body.expectedPayloadSha256) {
        throw new CompanionConversationError(
          "ACTION_STALE", 409, "payload hash mismatch",
        );
      }
      // 服务端重新构造候选 payload（引用来自只读查询），并精确验证其 sha256
      // 与候选 payloadSha256/expected 一致（§6.7：payload 完全由服务端构造）。
      let payload: { kind: string; [k: string]: unknown };
      if (args.body.candidateId === "resume_current") {
        const rows = await tx.execute<{ id: string }>(sql`
          SELECT id FROM learning_sessions
          WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.userId}
            AND status = 'active'
          ORDER BY created_at DESC LIMIT 1
        `);
        if (!rows[0]) {
          throw new CompanionConversationError("ACTION_STALE", 409, "active learning session disappeared");
        }
        payload = { kind: "resume_session", sessionId: rows[0].id };
      } else {
        const rows = await tx.execute<{ key_point_id: string; card_id: string }>(sql`
          SELECT k.id AS key_point_id, k.card_id
          FROM learning_episodes e JOIN card_key_points k ON k.id = e.key_point_id
          WHERE e.workspace_id = ${args.workspaceId} AND e.user_id = ${args.userId}
            AND k.workspace_id = ${args.workspaceId}
          ORDER BY e.created_at DESC LIMIT 1
        `);
        if (!rows[0]) {
          throw new CompanionConversationError("ACTION_STALE", 409, "learning candidate disappeared");
        }
        payload = {
          kind: "start_session",
          origin: "now",
          cardId: rows[0].card_id,
          keyPointId: rows[0].key_point_id,
        };
      }
      const payloadHash = sha256(canonicalJson(payload));
      if (payloadHash !== args.body.expectedPayloadSha256) {
        throw new CompanionConversationError(
          "ACTION_STALE", 409, "payload hash mismatch",
        );
      }

      // conversation：提供时校验；缺省时原子创建 dialogue
      let conversationId = args.body.conversationId;
      if (conversationId) {
        const conv = await tx.execute<{ id: string; kind: string; status: string }>(sql`
          SELECT id, kind, status FROM companion_conversations WHERE id = ${conversationId}
          FOR UPDATE
        `);
        if (!conv[0]) {
          throw new CompanionConversationError("NOT_FOUND", 404, "conversation not found");
        }
        if (conv[0].kind !== "dialogue" || conv[0].status !== "active") {
          throw new CompanionConversationError("FORBIDDEN", 403, "conversation is not an active dialogue");
        }
        const active = await tx.execute<{ id: string }>(sql`
          SELECT id FROM companion_turn_runs
          WHERE conversation_id = ${conversationId} AND status IN ('accepted', 'running', 'cancel_requested')
          LIMIT 1
        `);
        if (active[0]) {
          throw new CompanionConversationError("RUN_ALREADY_ACTIVE", 409, "active dialogue run");
        }
        // §8.5：先原子回收过期 pending（TTL 5min → expired + action.expired
        // 事件），否则过期 proposal 会永久阻塞新 proposal 创建（恒 409）。
        const expired = await tx.execute<{
          id: string; conversation_id: string; source_message_id: string;
          source_generation: number; payload: unknown; payload_sha256: string;
          title: string; target_summary: string; impact_summary: string;
          status: string; decision: string | null; expires_at: Date;
          decided_at: Date | null; created_at: Date; updated_at: Date;
        }>(sql`
          UPDATE companion_action_proposals
          SET status = 'expired', updated_at = now()
          WHERE conversation_id = ${conversationId} AND status = 'pending'
            AND expires_at < now()
          RETURNING id, conversation_id, source_message_id, source_generation,
                    payload, payload_sha256, title, target_summary, impact_summary,
                    status, decision, expires_at, decided_at, created_at, updated_at
        `);
        for (const row of expired) {
          await appendActionExpiredEvent(tx, args.workspaceId, args.userId, row);
        }
        const pending = await tx.execute<{ id: string }>(sql`
          SELECT id FROM companion_action_proposals
          WHERE conversation_id = ${conversationId} AND status = 'pending'
            AND expires_at >= now()
          LIMIT 1
        `);
        if (pending[0]) {
          throw new CompanionConversationError(
            "IDEMPOTENCY_CONFLICT", 409, "pending proposal exists",
          );
        }
      } else {
        // §6.1/§6.7：与 createCompanionConversation 同限额——用户新建 dialogue
        // 对话上限 200，不能绕过 API 检查直接 INSERT。
        const dialogueCount = await tx.execute<{ n: string }>(sql`
          SELECT count(*)::int AS n FROM companion_conversations
          WHERE workspace_id = ${args.workspaceId}
            AND user_id = ${args.userId}
            AND kind = 'dialogue'
            AND status = 'active'
        `);
        if (Number(dialogueCount[0]?.n ?? 0) >= 200) {
          throw new CompanionConversationError(
            "CONVERSATION_LIMIT_REACHED", 409, "max 200 user-created dialogue conversations",
          );
        }
        const created = await tx.execute<{ id: string }>(sql`
          INSERT INTO companion_conversations
            (id, workspace_id, user_id, kind, title, title_source, status)
          VALUES (${randomUUID()}, ${args.workspaceId}, ${args.userId}, 'dialogue',
                  ${candidate.title.slice(0, 80)}, 'auto', 'active')
          RETURNING id
        `);
        if (!created[0]) {
          throw new CompanionConversationError("INTERNAL_ERROR", 500, "conversation create failed");
        }
        conversationId = created[0].id;
      }

      // clientMessageId is the second idempotency fence for an explicit
      // conversation. The database unique index is the final guard, but a
      // deterministic 409 is preferable to leaking a constraint error as 500.
      const duplicateClientMessage = await tx.execute<{ id: string }>(sql`
        SELECT id FROM companion_messages
        WHERE conversation_id = ${conversationId}
          AND client_message_id = ${args.body.clientMessageId}
        LIMIT 1
      `);
      if (duplicateClientMessage[0]) {
        throw new CompanionConversationError(
          "IDEMPOTENCY_CONFLICT", 409, "clientMessageId already used in conversation",
        );
      }

      // counters：user + assistant 两条消息 + 1 个 event
      const counters = await tx.execute<{ next_message_seq: string; next_event_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_message_seq = next_message_seq + 2,
            next_event_seq = next_event_seq + 1,
            last_message_at = now()
        WHERE id = ${conversationId}
        RETURNING next_message_seq, next_event_seq
      `);
      const messageSeq = Number(counters[0].next_message_seq) - 2;
      const eventSeq = Number(counters[0].next_event_seq) - 1;

      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const proposalId = randomUUID();
      const userText =
        args.body.candidateId === "resume_current"
          ? `请继续当前学习：${candidate.targetSummary}`
          : `请开始一小段学习：${candidate.targetSummary}`;
      const assistantText =
        `建议：${candidate.title}\n目标：${candidate.targetSummary}\n影响：${candidate.impactSummary}\n确认后才会执行。`;

      const userBlocks = [{ type: "text", text: userText }];
      // §3.3：assistant confirmation message kind='action'，blocks = safe text +
      // 恰好一个 action_ref block（校验矩阵依赖）。
      const assistantBlocks = [
        { type: "text", text: assistantText },
        { type: "action_ref", proposalId },
      ];
      await tx.execute(sql`
        INSERT INTO companion_messages
          (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks,
           client_message_id, content_sha256)
        VALUES
          (${userMessageId}, ${conversationId}, ${args.workspaceId}, ${args.userId}, 'user',
           ${messageSeq}, 'action', ${JSON.stringify(userBlocks)}, ${args.body.clientMessageId}, ${sha256(userText)}),
          (${assistantMessageId}, ${conversationId}, ${args.workspaceId}, ${args.userId}, 'assistant',
           ${messageSeq + 1}, 'action', ${JSON.stringify(assistantBlocks)}, NULL, ${sha256(assistantText)})
      `);
      const convGen = await tx.execute<{ next_generation: string }>(sql`
        SELECT next_generation FROM companion_conversations WHERE id = ${conversationId}
      `);
      // §6.7：sourceGeneration = next_generation-1（已有 turn 的 conversation
      // 应为最近 generation；新对话无 turn → 0）。
      const sourceGeneration = Math.max(0, Number(convGen[0]?.next_generation ?? 1) - 1);
      const insertedProposal = await tx.execute<{
        expires_at: Date;
        created_at: Date;
        updated_at: Date;
      }>(sql`
        INSERT INTO companion_action_proposals
          (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
           payload, payload_sha256, title, target_summary, impact_summary, status,
           idempotency_key_hash, request_body_sha256, expires_at)
        VALUES
          (${proposalId}, ${args.workspaceId}, ${args.userId}, ${conversationId}, ${userMessageId}, ${sourceGeneration},
           ${JSON.stringify(payload)}, ${candidate.payloadSha256},
           ${candidate.title}, ${candidate.targetSummary}, ${candidate.impactSummary}, 'pending',
           ${keyHash}, ${requestBodyHash}, now() + make_interval(mins => ${PROPOSAL_TTL_MINUTES}))
        RETURNING expires_at, created_at, updated_at
      `);
      const proposalTimes = insertedProposal[0];
      await tx.execute(sql`
        UPDATE companion_messages SET action_ref = ${proposalId} WHERE id = ${assistantMessageId}
      `);
      const eventPayload = {
        proposal: {
          version: 1,
          id: proposalId,
          workspaceId: args.workspaceId,
          conversationId,
          sourceMessageId: userMessageId,
          sourceGeneration,
          kind: payload,
          payloadSha256: candidate.payloadSha256,
          title: candidate.title,
          targetSummary: candidate.targetSummary,
          impactSummary: candidate.impactSummary,
          status: "pending",
        },
      };
      await tx.execute(sql`
        INSERT INTO companion_stream_events
          (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
           type, payload, expires_at)
        VALUES
          (${conversationId}, ${eventSeq}, ${args.workspaceId}, ${args.userId}, NULL, 0, ${accountEpoch},
           'action.proposed', ${JSON.stringify(eventPayload)},
           now() + interval '24 hours')
      `);
      void eventPayload;

      return {
        version: 1,
        conversationId,
        userMessageId,
        assistantMessageId,
        proposal: {
          version: 1,
          proposalId,
          conversationId,
          sourceMessageId: userMessageId,
          sourceGeneration,
          contextGrantId: null,
          payload,
          payloadSha256: candidate.payloadSha256,
          title: candidate.title,
          targetSummary: candidate.targetSummary,
          impactSummary: candidate.impactSummary,
          requiresConfirmation: true,
          status: "pending",
          decision: null,
          actionRunId: null,
          expiresAt: new Date(proposalTimes.expires_at).toISOString(),
          decidedAt: null,
          createdAt: new Date(proposalTimes.created_at).toISOString(),
          updatedAt: new Date(proposalTimes.updated_at).toISOString(),
        },
        eventCursor: eventSeq,
      };
    },
  );
}

// ─── P5 §6.6 Proposal decision（confirm/reject 原子消费） ───────────────

import { createJob } from "../job/service.ts";
import { JobType } from "@ailearn/shared";

const NAVIGATION_KINDS = new Set(["open_review", "open_card", "open_star_map"]);

/**
 * §6.6：POST /companion/proposals/:id/decision。
 * - reject：原子写 decision，零业务副作用，返回 200 rejected；
 * - confirm：校验 pending/TTL/无 active run/幂等；纯导航同步 succeeded（200）；
 *   session/tutor 原子创建 action run + companion_action job（202 accepted）；
 * - 同 key 同 decision 返回同一结果；异参 409；已被消费返回当前状态；
 * - router 只生成 proposal，不执行任何 Learning 副作用（执行在 worker）。
 */
export async function decideCompanionProposal(args: {
  workspaceId: string;
  userId: string;
  proposalId: string;
  decision: "confirm" | "reject";
  idempotencyKey: string;
  expectedPayloadSha256?: string;
}): Promise<unknown> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const rows = await tx.execute<{
        id: string; conversation_id: string; status: string; decision: string | null;
        decision_key_hash: string | null; expires_at: Date;
        payload: { kind: string; [key: string]: unknown } | string;
        payload_sha256: string; action_run_id: string | null;
      }>(sql`
        SELECT id, conversation_id, status, decision, decision_key_hash, expires_at, payload,
               payload_sha256, action_run_id
        FROM companion_action_proposals
        WHERE id = ${args.proposalId}
        FOR UPDATE
      `);
      const proposal = rows[0];
      if (!proposal) {
        throw new CompanionConversationError("NOT_FOUND", 404, "proposal not found");
      }
      // 容错：postgres.js 原生 tag 写入的 jsonb 可能是字符串值（双重序列化
      // 历史数据），与 worker 侧同一处理。
      const proposalPayload =
        typeof proposal.payload === "string"
          ? (JSON.parse(proposal.payload) as { kind: string; [key: string]: unknown })
          : proposal.payload;
      // §2.1：idempotency key hash 对校验后的 UUID 小写 ASCII 原文计算。
      const keyHash = sha256(args.idempotencyKey.toLowerCase());

      // A decision key is globally unique. Detect reuse on another proposal
      // explicitly so the unique index cannot turn a client mistake into a
      // generic 500 response.
      const keyOwner = await tx.execute<{ id: string }>(sql`
        SELECT id FROM companion_action_proposals
        WHERE decision_key_hash = ${keyHash} AND id <> ${proposal.id}
        LIMIT 1
      `);
      if (keyOwner[0]) {
        throw new CompanionConversationError(
          "IDEMPOTENCY_CONFLICT", 409, "decision key belongs to another proposal",
        );
      }

      // 已决定：同 key 幂等返回当前状态；异参冲突
      if (proposal.decision) {
        if (proposal.decision_key_hash === keyHash) {
          const action = proposal.action_run_id
            ? (await tx.execute<{
                result_ref: string | null;
                route: unknown;
                safe_summary: string | null;
              }>(sql`
                SELECT result_ref, route, safe_summary
                FROM companion_action_runs
                WHERE id = ${proposal.action_run_id}
                LIMIT 1
              `))[0] ?? null
            : null;
          return snapshotFor({ ...proposal, payload: proposalPayload }, action);
        }
        throw new CompanionConversationError(
          "IDEMPOTENCY_CONFLICT", 409, "proposal already decided with different key",
        );
      }
      if (proposal.status !== "pending") {
        throw new CompanionConversationError(
          "ACTION_STALE", 409, "proposal not pending",
        );
      }
      if (new Date(proposal.expires_at).getTime() < Date.now()) {
        throw new CompanionConversationError("ACTION_EXPIRED", 409, "proposal expired");
      }

      if (args.decision === "reject") {
        await tx.execute(sql`
          UPDATE companion_action_proposals
          SET status = 'rejected', decision = 'reject', decided_at = now(),
              decision_key_hash = ${keyHash}, updated_at = now()
          WHERE id = ${proposal.id}
        `);
        await appendDecisionEvent(tx, args.workspaceId, args.userId, proposal, "rejected", null);
        return { version: 1, proposalId: proposal.id, status: "rejected", actionRunId: null, resultRef: null, route: null, safeSummary: null };
      }

      // confirm：conversation 无 active dialogue run
      // §6.6：confirm 必须匹配 payload hash。create 时 payload 已冻结为
      // payload_sha256（且客户端 expectedPayloadSha256 与候选比对过）；此处
      // 重算校验（含双重序列化容错），不一致即拒绝——学习动作有副作用，
      // 不能对已冻结 payload 的篡改只告警放行。
      const storedSha = sha256Utf8V1(canonicalJsonV1(proposalPayload));
      if (storedSha !== proposal.payload_sha256) {
        throw new CompanionConversationError(
          "PAYLOAD_HASH_MISMATCH", 409, "proposal payload hash does not match frozen value",
        );
      }
      if (
        args.expectedPayloadSha256 !== undefined &&
        args.expectedPayloadSha256 !== proposal.payload_sha256
      ) {
        throw new CompanionConversationError(
          "PAYLOAD_HASH_MISMATCH", 409, "expected payload hash does not match proposal",
        );
      }
      await tx.execute(sql`
        SELECT id FROM companion_conversations
        WHERE id = ${proposal.conversation_id}
        FOR UPDATE
      `);
      const active = await tx.execute<{ id: string }>(sql`
        SELECT id FROM companion_turn_runs
        WHERE conversation_id = ${proposal.conversation_id} AND status IN ('accepted', 'running')
        LIMIT 1
      `);
      if (active[0]) {
        throw new CompanionConversationError("RUN_ALREADY_ACTIVE", 409, "active dialogue run");
      }

      const kind = proposalPayload.kind;
      if (NAVIGATION_KINDS.has(kind)) {
        // 纯导航：同步完成（200 succeeded）
        const route = navigationRouteFor(kind, proposalPayload);
        await tx.execute(sql`
          UPDATE companion_action_proposals
          SET status = 'succeeded', decision = 'confirm', decided_at = now(),
              decision_key_hash = ${keyHash}, updated_at = now()
          WHERE id = ${proposal.id}
        `);
        // The synchronous response is the completion proof for navigation.
        // Do not emit action.completed here: the wire event requires a real
        // actionRunId, while navigation intentionally creates no action run.
        await appendDecisionEvent(tx, args.workspaceId, args.userId, proposal, "accepted", null);
        return {
          version: 1, proposalId: proposal.id, status: "succeeded", actionRunId: null,
          resultRef: null, route: route?.route ?? null, safeSummary: route?.safeSummary ?? "打开页面",
        };
      }

      // start_session must go through the canonical Learning Session PREPARE
      // path before the asynchronous action run is created. The old worker
      // placeholder only inserted a container row, which produced a session
      // with no Episode and could never be opened as a real learning route.
      if (kind === "start_session") {
        const origin = proposalPayload.origin;
        const keyPointId = proposalPayload.keyPointId;
        if (
          (origin !== "card" && origin !== "review" && origin !== "star_map" && origin !== "now")
          || typeof keyPointId !== "string"
        ) {
          throw new CompanionConversationError("ACTION_STALE", 409, "start session payload is stale");
        }
        try {
          await createSession(
            {
              workspaceId: args.workspaceId,
              userId: args.userId,
              origin,
              entry: { kind: "key_point", keyPointId },
              intent: "stabilize",
              preferredKeyPointId: keyPointId,
            },
            createPgSessionRepository(tx),
          );
        } catch (error) {
          if (error instanceof SessionServiceError) {
            throw new CompanionConversationError("ACTION_STALE", 409, "learning session could not be prepared");
          }
          throw error;
        }
      }

      // session/tutor：原子创建 action run + companion_action job（202 accepted）
      const actionRunId = randomUUID();
      await tx.execute(sql`
        INSERT INTO companion_action_runs
          (id, workspace_id, user_id, conversation_id, proposal_id, status)
        VALUES (${actionRunId}, ${args.workspaceId}, ${args.userId},
                ${proposal.conversation_id}, ${proposal.id}, 'accepted')
      `);
      await tx.execute(sql`
        UPDATE companion_action_proposals
        SET status = 'accepted', decision = 'confirm', decided_at = now(),
            decision_key_hash = ${keyHash}, action_run_id = ${actionRunId}, updated_at = now()
        WHERE id = ${proposal.id}
      `);
      await appendDecisionEvent(tx, args.workspaceId, args.userId, proposal, "accepted", actionRunId);
      await appendActionStartedEvent(tx, args.workspaceId, args.userId, proposal, actionRunId);

      // job 创建（payload 只传 opaque actionRunId——执行在 worker，见 P5-5）
      await createJob({
        type: JobType.COMPANION_ACTION,
        workspaceId: args.workspaceId,
        requestedBy: args.userId,
        payload: { actionRunId },
        dedupe: { payloadField: "actionRunId", value: actionRunId },
      });

      return {
        version: 1, proposalId: proposal.id, status: "accepted",
        actionRunId, resultRef: null, route: null, safeSummary: null,
      };
    },
  );
}

export function snapshotFor(
  proposal: {
    id: string;
    status: string;
    decision: string | null;
    action_run_id: string | null;
    payload: { kind: string; [key: string]: unknown };
  },
  action?: {
    result_ref: string | null;
    route: unknown;
    safe_summary: string | null;
  } | null,
): unknown {
  const actionRoute = action?.route == null
    ? null
    : typeof action.route === "string"
      ? (() => {
          try {
            return JSON.parse(action.route) as Record<string, unknown>;
          } catch {
            return null;
          }
        })()
      : action.route;
  const route = proposal.status === "succeeded"
    ? navigationRouteFor(proposal.payload.kind, proposal.payload)
    : null;
  return {
    version: 1,
    proposalId: proposal.id,
    status: proposal.status === "accepted" ? "executing" : proposal.status,
    actionRunId: proposal.action_run_id,
    resultRef: action?.result_ref ?? null,
    route: actionRoute ?? route?.route ?? null,
    safeSummary: action?.safe_summary ?? route?.safeSummary ?? null,
  };
}

/** §6.6 reload/cursor-expired recovery: proposal + current action run only. */
export async function getCompanionProposalSnapshot(args: {
  workspaceId: string;
  userId: string;
  proposalId: string;
}): Promise<{ statusCode: 200; body: unknown }> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const rows = await tx.execute<{
        id: string;
        conversation_id: string;
        source_message_id: string;
        source_generation: number;
        context_grant_id: string | null;
        payload: unknown;
        payload_sha256: string;
        title: string;
        target_summary: string;
        impact_summary: string;
        status: string;
        decision: "confirm" | "reject" | null;
        action_run_id: string | null;
        expires_at: Date;
        decided_at: Date | null;
        created_at: Date;
        updated_at: Date;
        action_id: string | null;
        action_status: string | null;
        result_message_id: string | null;
        result_ref: string | null;
        route: unknown;
        safe_summary: string | null;
        error_code: string | null;
        action_created_at: Date | null;
        action_updated_at: Date | null;
      }>(sql`
        SELECT p.id, p.conversation_id, p.source_message_id, p.source_generation,
               p.context_grant_id, p.payload, p.payload_sha256, p.title,
               p.target_summary, p.impact_summary, p.status, p.decision,
               p.action_run_id, p.expires_at, p.decided_at, p.created_at, p.updated_at,
               r.id AS action_id, r.status AS action_status, r.result_message_id,
               r.result_ref, r.route, r.safe_summary, r.error_code,
               r.created_at AS action_created_at, r.updated_at AS action_updated_at
        FROM companion_action_proposals p
        LEFT JOIN companion_action_runs r ON r.id = p.action_run_id
        WHERE p.id = ${args.proposalId}
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) throw new CompanionConversationError("NOT_FOUND", 404, "proposal not found");
      const parseObject = (value: unknown, field: string): Record<string, unknown> | null => {
        const parsed = typeof value === "string"
          ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
          : value;
        if (parsed == null) return null;
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new CompanionConversationError("INTERNAL_ERROR", 500, `invalid ${field}`);
        }
        return parsed as Record<string, unknown>;
      };
      try {
        const body = companionProposalSnapshotV1Schema.parse({
          version: 1,
          proposal: {
            version: 1,
            proposalId: row.id,
            conversationId: row.conversation_id,
            sourceMessageId: row.source_message_id,
            sourceGeneration: row.source_generation,
            contextGrantId: row.context_grant_id,
            payload: parseObject(row.payload, "proposal payload"),
            payloadSha256: row.payload_sha256,
            title: row.title,
            targetSummary: row.target_summary,
            impactSummary: row.impact_summary,
            requiresConfirmation: true,
            status: row.status,
            decision: row.decision,
            actionRunId: row.action_run_id,
            expiresAt: new Date(row.expires_at).toISOString(),
            decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          },
          actionRun: row.action_id ? {
            version: 1,
            actionRunId: row.action_id,
            proposalId: row.id,
            status: row.action_status,
            resultMessageId: row.result_message_id,
            resultRef: row.result_ref,
            route: row.route == null ? null : parseObject(row.route, "action route"),
            safeSummary: row.safe_summary,
            errorCode: row.error_code,
            createdAt: new Date(row.action_created_at!).toISOString(),
            updatedAt: new Date(row.action_updated_at!).toISOString(),
          } : null,
        });
        return { statusCode: 200 as const, body };
      } catch (error) {
        if (error instanceof CompanionConversationError) throw error;
        throw new CompanionConversationError("INTERNAL_ERROR", 500, "invalid proposal snapshot");
      }
    },
  );
}

function navigationRouteFor(kind: string, payload: Record<string, unknown>): {
  route: { kind: string; [k: string]: unknown };
  safeSummary: string;
} | null {
  switch (kind) {
    case "open_review":
      return { route: { kind: "review" }, safeSummary: "打开复习页" };
    case "open_card":
      return { route: { kind: "card", cardId: payload.cardId }, safeSummary: "打开卡片" };
    case "open_star_map":
      return { route: { kind: "star_map", keyPointId: payload.keyPointId ?? undefined }, safeSummary: "打开星图" };
    default:
      return null;
  }
}

async function appendDecisionEvent(
  tx: { execute(q: unknown): Promise<unknown[] | unknown> },
  workspaceId: string,
  userId: string,
  proposal: { id: string; conversation_id: string },
  status: string,
  actionRunId: string | null,
): Promise<void> {
  // L11：事件携带当前账号世代（global off 后旧 action 事件被客户端拒绝）。
  const accountEpoch = await getCompanionAccountEpoch(tx, userId);
  const counters = await tx.execute(sql`
    UPDATE companion_conversations SET next_event_seq = next_event_seq + 1
    WHERE id = ${proposal.conversation_id} RETURNING next_event_seq
  `);
  const seq = Number((counters as Array<{ next_event_seq: string }>)[0].next_event_seq) - 1;
  const decisionPayload = {
    proposalId: proposal.id,
    decision: status === "accepted" ? "confirm" : "reject",
    status,
    actionRunId,
  };
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
       type, payload, expires_at)
    VALUES (${proposal.conversation_id}, ${seq}, ${workspaceId}, ${userId}, NULL, 0, ${accountEpoch},
            'action.decision',
            ${JSON.stringify(decisionPayload)},
            now() + interval '24 hours')
  `);
}

async function appendActionStartedEvent(
  tx: { execute(q: unknown): Promise<unknown[] | unknown> },
  workspaceId: string,
  userId: string,
  proposal: { id: string; conversation_id: string },
  actionRunId: string,
): Promise<void> {
  // L11：事件携带当前账号世代。
  const accountEpoch = await getCompanionAccountEpoch(tx, userId);
  const counters = await tx.execute(sql`
    UPDATE companion_conversations SET next_event_seq = next_event_seq + 1
    WHERE id = ${proposal.conversation_id} RETURNING next_event_seq
  `);
  const seq = Number((counters as Array<{ next_event_seq: string }>)[0].next_event_seq) - 1;
  const startedPayload = { proposalId: proposal.id, actionRunId };
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
       type, payload, expires_at)
    VALUES (${proposal.conversation_id}, ${seq}, ${workspaceId}, ${userId}, NULL, 0, ${accountEpoch},
            'action.started',
            ${JSON.stringify(startedPayload)},
            now() + interval '24 hours')
  `);
}

async function appendActionExpiredEvent(
  tx: { execute(q: unknown): Promise<unknown[] | unknown> },
  workspaceId: string,
  userId: string,
  proposal: { id: string; conversation_id: string },
): Promise<void> {
  // L11：事件携带当前账号世代。
  const accountEpoch = await getCompanionAccountEpoch(tx, userId);
  const counters = await tx.execute(sql`
    UPDATE companion_conversations SET next_event_seq = next_event_seq + 1
    WHERE id = ${proposal.conversation_id} RETURNING next_event_seq
  `);
  const seq = Number((counters as Array<{ next_event_seq: string }>)[0].next_event_seq) - 1;
  const expiredPayload = { proposalId: proposal.id };
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
       type, payload, expires_at)
    VALUES (${proposal.conversation_id}, ${seq}, ${workspaceId}, ${userId}, NULL, 0, ${accountEpoch},
            'action.expired',
            ${JSON.stringify(expiredPayload)},
            now() + interval '24 hours')
  `);
}

// ─── P5 §6.7 Grounded tutor grant（HMAC + 5min TTL） ────────────────────

import { createHmac, randomUUID as grantRandomUUID } from "node:crypto";

const GRANT_TTL_MINUTES = 5;

function grantHmacSecret(): string {
  const configured = resolveAuthSurfaceManifestSecret();
  if (configured) return configured;
  // 与 turn-service 验证侧统一 fail-closed（2026-08-11）：
  // 移除 NODE_ENV 分支的公开常量回退（staging 常非 production，且与验证侧
  // 无条件 503 的行为矛盾）；任何环境未配置都不签发。
  throw new CompanionConversationError(
    "INTERNAL_ERROR", 503, "companion grant signing is not configured",
  );
}

/** Learning Session page adapter：只读返回当前 public context revision。 */
export async function getCompanionLearningSessionContext(args: {
  workspaceId: string;
  userId: string;
  sessionId: string;
  episodeId?: string;
}): Promise<{ statusCode: 200; body: unknown }> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const row = await loadCompanionLearningSessionContext(tx, args);
      if (!row) throw new CompanionConversationError("NOT_FOUND", 404, "learning session context not found");
      const body = companionLearningSessionContextV1Schema.parse(
        buildCompanionLearningSessionContext(row),
      );
      return { statusCode: 200 as const, body };
    },
  );
}

/**
 * §6.7：POST /companion/context-grants。
 * - pageInstanceId → episode → session 解引用（RLS 内）；
 * - permissionSnapshot 从 contextRevision 派生（bounded）；
 * - signature = domain-separated HMAC-SHA256（`companion-grant-v1|` + canonical payload）；
 * - TTL 5min；grant/signature 不入 job/日志/export（只返回给调用方与 proposal contextGrantId）。
 */
export async function createCompanionContextGrant(args: {
  workspaceId: string;
  userId: string;
  sessionId?: string;
  body: { version: 1; pageInstanceId: string; episodeId: string; contextRevision: string };
}): Promise<unknown> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const episode = await loadCompanionLearningSessionContext(tx, {
        workspaceId: args.workspaceId,
        userId: args.userId,
        sessionId: args.sessionId,
        episodeId: args.body.episodeId,
      });
      if (!episode) throw new CompanionConversationError("NOT_FOUND", 404, "episode not found");
      if (args.sessionId && episode.sessionId !== args.sessionId) {
        throw new CompanionConversationError("FORBIDDEN", 403, "episode does not belong to session");
      }
      const contextRevision = contextRevisionForCompanionLearningSession(episode);
      if (contextRevision !== args.body.contextRevision) {
        throw new CompanionConversationError("ACTION_STALE", 409, "learning session context revision mismatch");
      }
      if (
        episode.sessionStatus !== "active" ||
        episode.episodeStatus !== "active" ||
        !["scene_ready", "awaiting_response"].includes(episode.processingPhase) ||
        episode.answerLocked
      ) {
        throw new CompanionConversationError(
          "ACTION_STALE", 409, "learning session context is no longer eligible",
        );
      }
      const grantId = grantRandomUUID();
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + GRANT_TTL_MINUTES * 60_000);
      const permissionSnapshot = {
        pageInstanceId: args.body.pageInstanceId,
        pageKind: "learning_session" as const,
        capability: "grounded_tutor" as const,
        sessionId: episode.sessionId,
        episodeId: args.body.episodeId,
        cardId: episode.cardId,
        keyPointId: episode.keyPointId,
        contextRevision: args.body.contextRevision,
      };
      const permissionSnapshotHash = sha256(canonicalJson(permissionSnapshot));
      const domain = "companion-grounded-tutor-grant-v1:";
      const grantPayload = {
        version: 1 as const,
        grantId,
        userId: args.userId,
        workspaceId: args.workspaceId,
        pageInstanceId: args.body.pageInstanceId,
        pageKind: "learning_session" as const,
        capability: "grounded_tutor" as const,
        sessionId: episode.sessionId,
        episodeId: args.body.episodeId,
        cardId: episode.cardId,
        keyPointId: episode.keyPointId,
        contextRevision: args.body.contextRevision,
        permissionSnapshotHash,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      const signature = createHmac("sha256", grantHmacSecret())
        .update(domain + canonicalJson(grantPayload))
        .digest("hex");
      return companionGroundedTutorGrantV1Schema.parse({
        ...grantPayload,
        signature,
      });
    },
  );
}
