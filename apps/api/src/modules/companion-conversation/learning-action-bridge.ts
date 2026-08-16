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
import { companionGroundedTutorGrantV1Schema, companionLearningSessionContextV1Schema, companionProposalSnapshotV1Schema, proposedLearningActionPayloadV1Schema, } from "@ailearn/shared";
import { sha256Utf8V1, canonicalJsonV1 } from "@ailearn/shared/content-hash";
import type { CompanionLearningContextV1 } from "@ailearn/shared";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { deliver } from "./delivery-service.ts";
import { resolveAuthSurfaceManifestSecret } from "../companion-shell/auth-surface.ts";
import { getCompanionAccountEpoch } from "./companion-account-epoch.ts";
import {
  buildCompanionLearningSessionContext,
  contextRevisionForCompanionLearningSession,
  loadCompanionLearningSessionContext,
} from "./learning-session-context.ts";
// 方案 16 §18：LearningRun 工具在 decision 事务内同步执行（与 start_session
// 的 PREPARE 同模式；confirm 后 proposal 直接 succeeded + resultRef=runId）。
import { applyAction, createRun, getRunPublicView } from "../learning-runs/run-service.ts";
import { LearningRunServiceError } from "../learning-runs/run-errors.ts";
// 方案 16 §18.1：工具网关第二批执行单元（确定性、同事务）。
import { createUnderstandingRoutePlan } from "../understanding/route-plan-service.ts";
import { deferReviewSchedule } from "../review/review-defer-service.ts";
import {
  confirmMemory,
  deleteMemory,
  getMemory,
  upsertMemory,
} from "./memory-service.ts";

function sanitizeText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * resolveCompanionLearningContextInTransaction 的内部返回：除公开候选外，附带
 * 已查出、供 proposal create 无重复查询地构造 payload 的最小引用 id。
 * resumeCandidate/startCandidate 的合同不携带这些 id，故在内部透传。
 */
interface ResolvedCompanionContextInternal extends CompanionLearningContextV1 {
  resumeSessionId: string | null;
  startCardId: string | null;
  startKeyPointId: string | null;
}

function toPublicContext(ctx: ResolvedCompanionContextInternal): CompanionLearningContextV1 {
  return {
    version: ctx.version,
    contextRevision: ctx.contextRevision,
    resumeCandidate: ctx.resumeCandidate,
    startCandidate: ctx.startCandidate,
    learningRunResumeCandidate: ctx.learningRunResumeCandidate,
    learningRunStartCandidate: ctx.learningRunStartCandidate,
  };
}

async function resolveCompanionLearningContextInTransaction(
  tx: ApiTransaction,
  args: {
    workspaceId: string;
    userId: string;
  },
): Promise<ResolvedCompanionContextInternal> {
  // This helper deliberately accepts the caller's transaction. Proposal
  // creation must validate the read-only context and perform all writes under
  // the same RLS snapshot; opening a nested transaction here would leave a
  // race between validation and insertion.
  // 四个根查询读不同表、互不依赖：同一事务内并发发出（repeatable-read
  // 快照一致），之后的条件 follow-up（episode/title/claim）再串行基于结果执行。
  const [sessions, startRows, runResumeRows, runStartRows] = await Promise.all([
    // resume：最近 active session + 其 episode 的 key point
    tx.execute<{ id: string; intent: string }>(sql`
      SELECT s.id, s.intent
      FROM learning_sessions s
      WHERE s.workspace_id = ${args.workspaceId}
        AND s.user_id = ${args.userId}
        AND s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 1
    `),
    // start：最近 episode 的 key point + card（构造 start_session payload）
    tx.execute<{
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
    `),
    // 方案 16 §18：LearningRun resume——最近非终态 learning_run
    //（含 preparing/active/assessing/checkpoint/committing/paused/
    // recoverable_error；sandbox 不参与桌宠菜单）。
    tx.execute<{ id: string; key_point_id: string }>(sql`
      SELECT r.id, r.key_point_id
      FROM learning_runs r
      WHERE r.workspace_id = ${args.workspaceId}
        AND r.user_id = ${args.userId}
        AND r.phase NOT IN ('completed', 'ended', 'skipped', 'cancelled', 'stale')
        AND r.sandbox_namespace_id IS NULL
      ORDER BY r.created_at DESC
      LIMIT 1
    `),
    // start：最近有 key point 的卡（构造 start_learning_run 候选；幂等键
    // 按 keyPoint 稳定——重复确认重放同一 Run，不会重复创建）。
    tx.execute<{
      key_point_id: string;
      card_id: string;
      claim: string | null;
    }>(sql`
      SELECT k.id AS key_point_id, k.card_id, k.claim
      FROM card_key_points k
      WHERE k.workspace_id = ${args.workspaceId}
      ORDER BY k.updated_at DESC
      LIMIT 1
    `),
  ]);

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

  let learningRunResumeCandidate: CompanionLearningContextV1["learningRunResumeCandidate"] = null;
  if (runResumeRows[0]) {
    const titleRows = await tx.execute<{ claim: string | null }>(sql`
      SELECT k.claim FROM card_key_points k
      WHERE k.id = ${runResumeRows[0].key_point_id} AND k.workspace_id = ${args.workspaceId}
      LIMIT 1
    `);
    const title = sanitizeText(titleRows[0]?.claim ?? "", 80) || "继续当前学习";
    const payload = { kind: "resume_learning_run", runId: runResumeRows[0].id };
    learningRunResumeCandidate = {
      candidateId: "learning_run_resume",
      runId: runResumeRows[0].id,
      title,
      targetSummary: sanitizeText(`继续学习：${title}`, 160),
      impactSummary: "恢复当前学习运行",
      payloadSha256: sha256Utf8V1(canonicalJsonV1(payload)),
    };
  }

  let learningRunStartCandidate: CompanionLearningContextV1["learningRunStartCandidate"] = null;
  if (runStartRows[0]) {
    const claim = runStartRows[0].claim ?? "";
    const title = sanitizeText(claim, 80) || "开始三分钟巩固";
    const idempotencyKey = `pet-menu:${runStartRows[0].key_point_id}`;
    const payload = {
      kind: "start_learning_run",
      request: {
        version: 1,
        origin: {
          kind: "card",
          cardId: runStartRows[0].card_id,
          keyPointId: runStartRows[0].key_point_id,
        },
        goal: "stabilize",
        clientRequestId: idempotencyKey,
        idempotencyKey,
      },
    };
    learningRunStartCandidate = {
      candidateId: "learning_run_start",
      cardId: runStartRows[0].card_id,
      keyPointId: runStartRows[0].key_point_id,
      title,
      targetSummary: sanitizeText(`用三分钟巩固：${title}`, 160),
      impactSummary: "创建一次三分钟学习运行，完成后按真实结果安排复习",
      payloadSha256: sha256Utf8V1(canonicalJsonV1(payload)),
    };
  }

  const contextRevision = sha256Utf8V1(
    canonicalJsonV1({ resumeCandidate, startCandidate, learningRunResumeCandidate, learningRunStartCandidate }),
  );
  return {
    version: 1,
    contextRevision,
    resumeCandidate,
    startCandidate,
    learningRunResumeCandidate,
    learningRunStartCandidate,
    // PERF-WN: 透传已查出的引用 id，避免 proposal create 侧重复 SELECT。
    resumeSessionId: sessions[0]?.id ?? null,
    startCardId: startRows[0]?.card_id ?? null,
    startKeyPointId: startRows[0]?.key_point_id ?? null,
  };
}

export async function resolveCompanionLearningContext(args: {
  workspaceId: string;
  userId: string;
}): Promise<CompanionLearningContextV1> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    (tx) => resolveCompanionLearningContextInTransaction(tx, args).then(toPublicContext),
  );
}

// ─── P5 §6.7 Menu proposal create（原子事务） ───────────────────────────

import { randomUUID } from "node:crypto";
import { canonicalJsonV1 as canonicalJson, sha256Utf8V1 as sha256 } from "@ailearn/shared/content-hash";
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
  candidateId: "resume_current" | "start_short" | "learning_run_resume" | "learning_run_start";
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
    candidateId: "resume_current" | "start_short" | "learning_run_resume" | "learning_run_start";
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
      const requestBodyHash = menuProposalRequestHash(args.body);


      // 重算 context（同事务只读）
      const context = await resolveCompanionLearningContextInTransaction(tx, {
        workspaceId: args.workspaceId,
        userId: args.userId,
      });
      if (context.contextRevision !== args.body.expectedContextRevision) {
        throw new CompanionConversationError(
          "CONTEXT_STALE", 409, "context revision mismatch",
        );
      }
      const candidate =
        args.body.candidateId === "resume_current"
          ? context.resumeCandidate
          : args.body.candidateId === "learning_run_resume"
            ? context.learningRunResumeCandidate
            : args.body.candidateId === "learning_run_start"
              ? context.learningRunStartCandidate
              : context.startCandidate;
      if (!candidate) {
        // 2026-08-12+（15a-E）：细分 code——前端据此显示"当前没有进行中的学习/
        // 没有可开始的学习"（此前 ACTION_STALE 无法区分）。
        throw new CompanionConversationError(
          args.body.candidateId === "resume_current" || args.body.candidateId === "learning_run_resume"
            ? "NO_ACTIVE_SESSION"
            : "NO_CANDIDATE", 409, "candidate unavailable",
        );
      }
      if (candidate.payloadSha256 !== args.body.expectedPayloadSha256) {
        throw new CompanionConversationError(
          "ACTION_STALE", 409, "payload hash mismatch",
        );
      }
      // 服务端重新构造候选 payload（引用来自只读查询），并精确验证其 sha256
      // 与候选 payloadSha256/expected 一致（§6.7：payload 完全由服务端构造）。
      // PERF-WN: 复用 context 解析时已查出的引用 id，不再为构造 payload 重复
      // SELECT learning_sessions/learning_runs/card_key_points/learning_episodes。
      let payload: { kind: string; [k: string]: unknown };
      if (args.body.candidateId === "resume_current") {
        if (!context.resumeSessionId) {
          throw new CompanionConversationError("NO_ACTIVE_SESSION", 409, "active learning session disappeared");
        }
        payload = { kind: "resume_session", sessionId: context.resumeSessionId };
      } else if (args.body.candidateId === "learning_run_resume") {
        const runId = context.learningRunResumeCandidate?.runId;
        if (!runId) {
          throw new CompanionConversationError("NO_ACTIVE_SESSION", 409, "active learning run disappeared");
        }
        payload = { kind: "resume_learning_run", runId };
      } else if (args.body.candidateId === "learning_run_start") {
        const cardId = context.learningRunStartCandidate?.cardId;
        const keyPointId = context.learningRunStartCandidate?.keyPointId;
        if (!cardId || !keyPointId) {
          throw new CompanionConversationError("NO_CANDIDATE", 409, "learning candidate disappeared");
        }
        const idempotencyKey = `pet-menu:${keyPointId}`;
        payload = {
          kind: "start_learning_run",
          request: {
            version: 1,
            origin: {
              kind: "card",
              cardId,
              keyPointId,
            },
            goal: "stabilize",
            clientRequestId: idempotencyKey,
            idempotencyKey,
          },
        };
      } else {
        if (!context.startCardId || !context.startKeyPointId) {
          throw new CompanionConversationError("NO_CANDIDATE", 409, "learning candidate disappeared");
        }
        payload = {
          kind: "start_session",
          origin: "now",
          cardId: context.startCardId,
          keyPointId: context.startKeyPointId,
        };
      }
      const payloadHash = sha256(canonicalJson(payload));
      if (payloadHash !== args.body.expectedPayloadSha256) {
        throw new CompanionConversationError(
          "ACTION_STALE", 409, "payload hash mismatch",
        );
      }

      return createCompanionProposalInTransaction(tx, {
        workspaceId: args.workspaceId,
        userId: args.userId,
        conversationId: args.body.conversationId,
        clientMessageId: args.body.clientMessageId,
        idempotencyKey: args.idempotencyKey,
        requestBodyHash,
        payload,
        payloadSha256: payloadHash,
        title: candidate.title,
        targetSummary: candidate.targetSummary,
        impactSummary: candidate.impactSummary,
        userText:
          args.body.candidateId === "resume_current"
            ? `请继续当前学习：${candidate.targetSummary}`
            : `请开始一小段学习：${candidate.targetSummary}`,
        sourceSurface: args.body.sourceSurface,
      });

    },
  );
}

/**
 * §6.7/§18.1：proposal 原子创建（menu 与 tool 网关共用事务体）。
 * 同一 RLS 事务：幂等检查（同 key 同 requestBodyHash 重放同 response）→
 * conversation 校验/创建 → 原子插入 user action message + assistant
 * confirmation（带 action_ref）+ pending proposal + action.proposed event。
 * 任何验证失败零写入。
 */
async function createCompanionProposalInTransaction(
  tx: ApiTransaction,
  args: {
    workspaceId: string;
    userId: string;
    conversationId?: string;
    clientMessageId: string;
    idempotencyKey: string;
    requestBodyHash: string;
    payload: { kind: string; [key: string]: unknown };
    payloadSha256: string;
    title: string;
    targetSummary: string;
    impactSummary: string;
    userText: string;
    sourceSurface: "pet" | "main" | "web_fallback";
  },
): Promise<unknown> {
  // L11：事件携带当前账号世代（global off 后旧 action 事件被客户端拒绝）。
  const accountEpoch = await getCompanionAccountEpoch(tx, args.userId);
  // 幂等：同 key 同 body 返回同 response；异 body 冲突
  // §2.1：idempotency key hash 对校验后的 UUID 小写 ASCII 原文计算。
  const keyHash = sha256(args.idempotencyKey.toLowerCase());
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
        if (row.request_body_sha256 !== args.requestBodyHash) {
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
      // conversation：提供时校验；缺省时原子创建 dialogue
      let conversationId = args.conversationId;
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
        // 轻微·18（round-4）：批量 append expired 事件。原逐行 appendActionExpiredEvent
        // （每行 getCompanionAccountEpoch + counter UPDATE RETURNING + INSERT = 3×N RTT）。
        // 因 expired 行均属同一 conversation/同一 user，account_epoch 共享、seq 由单次
        // counter UPDATE +N 后本地递推、INSERT 用多行 VALUES——降为 3 次 RTT（有界）。
        await appendActionExpiredEventsBatch(tx, args.workspaceId, args.userId, conversationId, expired);
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
                  ${args.title.slice(0, 80)}, 'auto', 'active')
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
          AND client_message_id = ${args.clientMessageId}
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
      const userText = args.userText;
      const assistantText =
        `建议：${args.title}\n目标：${args.targetSummary}\n影响：${args.impactSummary}\n确认后才会执行。`;

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
           ${messageSeq}, 'action', ${JSON.stringify(userBlocks)}, ${args.clientMessageId}, ${sha256(userText)}),
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
           ${JSON.stringify(args.payload)}, ${args.payloadSha256},
           ${args.title}, ${args.targetSummary}, ${args.impactSummary}, 'pending',
           ${keyHash}, ${args.requestBodyHash}, now() + make_interval(mins => ${PROPOSAL_TTL_MINUTES}))
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
          kind: args.payload,
          payloadSha256: args.payloadSha256,
          title: args.title,
          targetSummary: args.targetSummary,
          impactSummary: args.impactSummary,
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

      // 方案 16 §14.3：proposal 创建后入 inbox（pet 自身发起的 proposal 已有
      // 本地确认卡，避免重复展示；main/web_fallback 发起的需要推送给 pet）。
      if (args.sourceSurface !== "pet") {
        await deliver(
          tx,
          { workspaceId: args.workspaceId, userId: args.userId },
          {
            assistantSessionId: null,
            kind: "proposal",
            payloadRef: { kind: "proposal", proposalId },
            dedupeKey: `proposal:${proposalId}`,
            expiresAt: new Date(proposalTimes.expires_at),
          },
          new Date(proposalTimes.created_at),
        );
      }

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
          payload: args.payload,
          payloadSha256: args.payloadSha256,
          title: args.title,
          targetSummary: args.targetSummary,
          impactSummary: args.impactSummary,
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
}


// ─── 方案 16 §18.1：通用工具 proposal（Orchestrator 网关入口） ───────────

function toolProposalRequestHash(body: {
  version: 1;
  conversationId?: string;
  clientMessageId: string;
  payloadSha256: string;
  title: string;
  targetSummary: string;
  impactSummary: string;
  sourceSurface: "pet" | "main" | "web_fallback";
}): string {
  return sha256(canonicalJson({
    version: body.version,
    conversationId: body.conversationId ?? null,
    clientMessageId: body.clientMessageId,
    payloadSha256: body.payloadSha256,
    title: body.title,
    targetSummary: body.targetSummary,
    impactSummary: body.impactSummary,
    sourceSurface: body.sourceSurface,
  }));
}

/**
 * §18.1：POST /companion/tool-proposals — Orchestrator/桌宠工具网关入口。
 * payload 全量按共享合同校验（fail closed）；服务端重算 payloadSha256 并
 * 冻结；title/summaries 净化截断。同 key 同 body 幂等返回同 response，
 * 异 body 409（复用 §6.7 proposal 原子事务体）。
 */
export async function createCompanionToolProposal(args: {
  workspaceId: string;
  userId: string;
  body: {
    version: 1;
    conversationId?: string;
    clientMessageId: string;
    payload: { kind: string; [key: string]: unknown };
    title: string;
    targetSummary: string;
    impactSummary: string;
    sourceSurface: "pet" | "main" | "web_fallback";
  };
  idempotencyKey: string;
}): Promise<unknown> {
  const parsed = proposedLearningActionPayloadV1Schema.safeParse(args.body.payload);
  if (!parsed.success) {
    throw new CompanionConversationError(
      "INVALID_REQUEST", 400, "tool payload does not match the proposal contract",
    );
  }
  const payload = parsed.data as unknown as { kind: string; [key: string]: unknown };
  const payloadSha256 = sha256Utf8V1(canonicalJsonV1(payload));
  const title = sanitizeText(args.body.title, 80);
  const targetSummary = sanitizeText(args.body.targetSummary, 160);
  const impactSummary = sanitizeText(args.body.impactSummary, 240);
  if (!title || !targetSummary || !impactSummary) {
    throw new CompanionConversationError(
      "INVALID_REQUEST", 400, "title/targetSummary/impactSummary are required",
    );
  }
  const requestBodyHash = toolProposalRequestHash({
    version: 1,
    conversationId: args.body.conversationId,
    clientMessageId: args.body.clientMessageId,
    payloadSha256,
    title,
    targetSummary,
    impactSummary,
    sourceSurface: args.body.sourceSurface,
  });
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    (tx) => createCompanionProposalInTransaction(tx, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      conversationId: args.body.conversationId,
      clientMessageId: args.body.clientMessageId,
      idempotencyKey: args.idempotencyKey,
      requestBodyHash,
      payload,
      payloadSha256,
      title,
      targetSummary,
      impactSummary,
      userText: `请执行：${title}`,
      sourceSurface: args.body.sourceSurface,
    }),
  );
}

// ─── P5 §6.6 Proposal decision（confirm/reject 原子消费） ───────────────

import { createJob } from "../job/service.ts";
import { JobType, type LearningRunActionV1, type UnderstandingRoutePlanRequestV1 } from "@ailearn/shared";

// §18.1 导航工具（纯导航同步 succeeded）；业务工具在下方分支同步执行。
const NAVIGATION_KINDS = new Set([
  "open_review",
  "open_card",
  "open_star_map",
  "focus_graph_node",
  "restore_graph_viewport",
  "open_conversation_history",
]);

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
        await deliverActionResultForProposal(tx, args.workspaceId, args.userId, proposal.id);
        return {
          version: 1, proposalId: proposal.id, status: "succeeded", actionRunId: null,
          resultRef: null, route: route?.route ?? null, safeSummary: route?.safeSummary ?? "打开页面",
        };
      }

      // 方案 16 §18：LearningRun 工具（同步执行，事务内完成）。
      if (kind === "start_learning_run" || kind === "resume_learning_run") {
        let runId: string;
        let safeSummary: string;
        if (kind === "start_learning_run") {
          const request = proposalPayload.request as Record<string, unknown> | undefined;
          if (!request || typeof request !== "object") {
            throw new CompanionConversationError("ACTION_STALE", 409, "learning run payload is stale");
          }
          try {
            const run = await createRun(tx, {
              workspaceId: args.workspaceId,
              userId: args.userId,
              request: request as never,
            });
            runId = run.runId;
            safeSummary = "学习运行已创建";
          } catch (error) {
            if (error instanceof LearningRunServiceError) {
              throw new CompanionConversationError("ACTION_STALE", 409, "learning run could not be prepared");
            }
            throw error;
          }
        } else {
          const runIdRaw = proposalPayload.runId;
          if (typeof runIdRaw !== "string") {
            throw new CompanionConversationError("ACTION_STALE", 409, "learning run payload is stale");
          }
          try {
            const run = await getRunPublicView(tx, {
              workspaceId: args.workspaceId,
              userId: args.userId,
              runId: runIdRaw,
            });
            runId = run.runId;
            safeSummary = "学习运行已恢复";
          } catch (error) {
            if (error instanceof LearningRunServiceError) {
              throw new CompanionConversationError("ACTION_STALE", 409, "learning run could not be resumed");
            }
            throw error;
          }
        }
        await tx.execute(sql`
          UPDATE companion_action_proposals
          SET status = 'succeeded', decision = 'confirm', decided_at = now(),
              decision_key_hash = ${keyHash}, updated_at = now()
          WHERE id = ${proposal.id}
        `);
        await appendDecisionEvent(tx, args.workspaceId, args.userId, proposal, "accepted", null);
        await deliverActionResultForProposal(tx, args.workspaceId, args.userId, proposal.id);
        return {
          version: 1, proposalId: proposal.id, status: "succeeded", actionRunId: null,
          resultRef: runId, route: null, safeSummary,
        };
      }

      // ── 方案 16 §18.1：LearningRun 运行时工具（pause/request_hint/switch_variant） ──
      // exposure-first：hint 只在用户确认后揭示（伴星模型不得自行生成题目提示）。
      if (kind === "pause_learning_run" || kind === "request_hint_level" || kind === "switch_task_variant") {
        const runId = proposalPayload.runId;
        const taskId = proposalPayload.taskId;
        if (typeof runId !== "string") {
          throw new CompanionConversationError("ACTION_STALE", 409, "learning run payload is stale");
        }
        let action: LearningRunActionV1;
        let safeSummary: string;
        if (kind === "pause_learning_run") {
          action = { kind: "pause" };
          safeSummary = "学习运行已暂停";
        } else if (kind === "request_hint_level") {
          const level = proposalPayload.level;
          if (typeof taskId !== "string" || (level !== 1 && level !== 2 && level !== 3)) {
            throw new CompanionConversationError("ACTION_STALE", 409, "hint payload is stale");
          }
          action = { kind: "request_hint", level };
          safeSummary = "已揭示提示（本题降级为练习）";
        } else {
          const alternativeId = proposalPayload.alternativeId;
          if (typeof taskId !== "string" || typeof alternativeId !== "string") {
            throw new CompanionConversationError("ACTION_STALE", 409, "variant payload is stale");
          }
          action = { kind: "switch_variant", alternativeId };
          safeSummary = "已切换题目变体";
        }
        try {
          const run = await getRunPublicView(tx, {
            workspaceId: args.workspaceId,
            userId: args.userId,
            runId,
          });
          // §18：payload 的 taskId 必须匹配当前 active task（applyAction 只作用于
          // 当前任务；不匹配即 stale，绝不作用于其他任务）。
          if (typeof taskId === "string" && run.activeTaskId !== null && run.activeTaskId !== taskId) {
            throw new CompanionConversationError("ACTION_STALE", 409, "task is not the active task");
          }
          await applyAction(tx, {
            workspaceId: args.workspaceId,
            userId: args.userId,
            runId,
            runRevision: run.revision,
            runtimeEpoch: run.runtimeEpoch,
            action,
            idempotencyKey: `pet-tool:${proposal.id}:${kind}`,
          });
        } catch (error) {
          if (error instanceof LearningRunServiceError || error instanceof CompanionConversationError) {
            throw new CompanionConversationError("ACTION_STALE", 409, "learning run action could not be applied");
          }
          throw error;
        }
        return succeedSyncProposal(tx, args.workspaceId, args.userId, proposal, keyHash, runId, null, safeSummary);
      }

      // ── §18.1：plan_understanding_route（确定性选路，事务内） ──
      if (kind === "plan_understanding_route") {
        const request = proposalPayload.request;
        if (!request || typeof request !== "object") {
          throw new CompanionConversationError("ACTION_STALE", 409, "route plan payload is stale");
        }
        const plan = await createUnderstandingRoutePlan(
          tx,
          { workspaceId: args.workspaceId, userId: args.userId },
          request as UnderstandingRoutePlanRequestV1,
        );
        if (plan.status !== "ok") {
          throw new CompanionConversationError("ACTION_STALE", 409, "route plan is stale");
        }
        return succeedSyncProposal(tx, args.workspaceId, args.userId, proposal, keyHash, plan.routePlanId, null, "已规划复习路线");
      }

      // ── §18.1：defer_review（只写展示层 user_deferred_until） ──
      if (kind === "defer_review") {
        const payload = proposalPayload as unknown as {
          scheduleId: string;
          scheduleGeneration: number;
          deferredUntil: string;
          reasonCode: "user_requested" | "temporary_unavailable";
        };
        const outcome = await deferReviewSchedule(tx, { workspaceId: args.workspaceId, userId: args.userId }, {
          scheduleId: payload.scheduleId,
          scheduleGeneration: payload.scheduleGeneration,
          deferredUntil: new Date(payload.deferredUntil),
          reasonCode: payload.reasonCode,
        });
        if (outcome.status === "not_found") {
          throw new CompanionConversationError("NOT_FOUND", 404, "review schedule not found");
        }
        if (outcome.status !== "ok") {
          throw new CompanionConversationError("ACTION_STALE", 409, "review schedule generation changed");
        }
        return succeedSyncProposal(tx, args.workspaceId, args.userId, proposal, keyHash, outcome.scheduleId, null, "已延后复习提醒（不算完成复习）");
      }

      // ── §18.1：记忆工具（确定性 API 同事务执行；revision = updatedAt epoch ms） ──
      if (kind === "propose_memory_candidate") {
        const payload = proposalPayload as unknown as {
          memoryKind: "preference" | "goal" | "learning_context" | "interaction_note" | "episodic";
          value: string;
        };
        const item = await upsertMemory(tx, { workspaceId: args.workspaceId, userId: args.userId }, {
          kind: payload.memoryKind,
          content: payload.value,
          sourceEventId: undefined,
          sourceSessionId: undefined,
          userStated: false,
          candidate: true,
        });
        return succeedSyncProposal(tx, args.workspaceId, args.userId, proposal, keyHash, item.memoryItemId, null, "已记录记忆候选");
      }
      if (kind === "confirm_or_reject_memory" || kind === "delete_assistant_memory") {
        const payload = proposalPayload as unknown as {
          memoryId: string;
          revision: number;
          decision?: "confirm" | "reject";
        };
        const memoryId = payload.memoryId;
        const memory = await getMemory(tx, { workspaceId: args.workspaceId, userId: args.userId }, memoryId);
        if (!memory || new Date(memory.updatedAt).getTime() !== payload.revision) {
          throw new CompanionConversationError("ACTION_STALE", 409, "memory revision changed");
        }
        const scope = { workspaceId: args.workspaceId, userId: args.userId };
        if (kind === "confirm_or_reject_memory") {
          if (payload.decision === "confirm") {
            const confirmed = await confirmMemory(tx, scope, memoryId);
            if (!confirmed) throw new CompanionConversationError("NOT_FOUND", 404, "memory not found");
            return succeedSyncProposal(tx, args.workspaceId, args.userId, proposal, keyHash, memoryId, null, "记忆已确认");
          }
          const rejected = await deleteMemory(tx, scope, memoryId);
          if (!rejected) throw new CompanionConversationError("NOT_FOUND", 404, "memory not found");
          return succeedSyncProposal(tx, args.workspaceId, args.userId, proposal, keyHash, memoryId, null, "记忆已拒绝");
        }
        const deleted = await deleteMemory(tx, scope, memoryId);
        if (!deleted) throw new CompanionConversationError("NOT_FOUND", 404, "memory not found");
        return succeedSyncProposal(tx, args.workspaceId, args.userId, proposal, keyHash, memoryId, null, "记忆已删除");
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
      await appendDecisionAndActionStartedEvents(tx, args.workspaceId, args.userId, proposal, "accepted", actionRunId);

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

/** §18 同步工具成功收尾：proposal → succeeded + decision 事件（不建 actionRun）。 */
/** 同步工具成功收尾后向 pet inbox 投递 action_result（§14.3）。 */
async function deliverActionResultForProposal(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  proposalId: string,
): Promise<void> {
  await deliver(
    tx,
    { workspaceId, userId },
    {
      assistantSessionId: null,
      kind: "action_result",
      payloadRef: { kind: "action_result", actionRunId: proposalId },
      dedupeKey: `action_result:${proposalId}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  );
}

async function succeedSyncProposal(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  proposal: { id: string; conversation_id: string },
  keyHash: string,
  resultRef: string | null,
  route: unknown,
  safeSummary: string,
): Promise<unknown> {
  await tx.execute(sql`
    UPDATE companion_action_proposals
    SET status = 'succeeded', decision = 'confirm', decided_at = now(),
        decision_key_hash = ${keyHash}, updated_at = now()
    WHERE id = ${proposal.id}
  `);
  await appendDecisionEvent(tx, workspaceId, userId, proposal, "accepted", null);
  await deliverActionResultForProposal(tx, workspaceId, userId, proposal.id);
  return {
    version: 1, proposalId: proposal.id, status: "succeeded", actionRunId: null,
    resultRef, route: route ?? null, safeSummary,
  };
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
    case "focus_graph_node":
      return {
        route: { kind: "star_map", keyPointId: payload.keyPointId, lens: payload.lens },
        safeSummary: "聚焦知识节点",
      };
    case "restore_graph_viewport":
      return { route: { kind: "star_map", restoreRun: payload.runId }, safeSummary: "恢复星图视口" };
    case "open_conversation_history":
      return {
        route: { kind: "conversation", assistantSessionId: payload.assistantSessionId ?? undefined },
        safeSummary: "打开对话历史",
      };
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

/**
 * PERF（api-learning #11）：把 confirm 路径上背靠背的 appendDecisionEvent +
 * appendActionStartedEvent（各 3 次 RTT：account_epoch + counter UPDATE + INSERT，
 * 共 6 次）合并为一次批量写入：account_epoch 只取一次、counter 一次 +2、两行
 * VALUES 单 INSERT。seq/字段与逐调用 appendDecisionEvent/appendActionStartedEvent
 * 完全一致（decision 在前取 baseSeq，started 在后取 baseSeq+1）。
 */
async function appendDecisionAndActionStartedEvents(
  tx: { execute(q: unknown): Promise<unknown[] | unknown> },
  workspaceId: string,
  userId: string,
  proposal: { id: string; conversation_id: string },
  status: string,
  actionRunId: string,
): Promise<void> {
  // L11：事件携带当前账号世代（global off 后旧 action 事件被客户端拒绝）。
  const accountEpoch = await getCompanionAccountEpoch(tx, userId);
  const counters = await tx.execute(sql`
    UPDATE companion_conversations SET next_event_seq = next_event_seq + 2
    WHERE id = ${proposal.conversation_id} RETURNING next_event_seq
  `);
  const baseSeq = Number((counters as Array<{ next_event_seq: string }>)[0].next_event_seq) - 2;
  const decisionPayload = {
    proposalId: proposal.id,
    decision: status === "accepted" ? "confirm" : "reject",
    status,
    actionRunId,
  };
  const startedPayload = { proposalId: proposal.id, actionRunId };
  const tuples = [
    sql`(${proposal.conversation_id}, ${baseSeq}, ${workspaceId}, ${userId}, NULL, 0, ${accountEpoch},
         'action.decision', ${JSON.stringify(decisionPayload)}, now() + interval '24 hours')`,
    sql`(${proposal.conversation_id}, ${baseSeq + 1}, ${workspaceId}, ${userId}, NULL, 0, ${accountEpoch},
         'action.started', ${JSON.stringify(startedPayload)}, now() + interval '24 hours')`,
  ];
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
       type, payload, expires_at)
    VALUES ${sql.join(tuples, sql`, `)}
  `);
}

type ExpiredProposalRow = {
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
        throw new CompanionConversationError("CONTEXT_STALE", 409, "learning session context revision mismatch");
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
