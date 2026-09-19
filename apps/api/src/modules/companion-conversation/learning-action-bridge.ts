/**
 * P5 §6.7：Learning menu context adapter（只读）。
 *
 * GET /companion/learning-context：只调用 LearningRun/Objective Surface 的只读
 * public adapter，
 * 零 canonical write、零 conversation write、零模型调用。
 * - learningRunResumeCandidate：最近 active LearningRun（null → disabled）；
 * - learningRunStartCandidate：最近可创建的 LearningRun（null → disabled）；
 * - contextRevision：候选快照的 canonical JSON sha256（稳定 revision）；
 * - payloadSha256：候选 payload 的 canonical JSON sha256（proposal create 时精确匹配）。
 * 所有文本字段净化（控制字符/空白压缩）后再截断到合同上限。
 */

import { sql } from "drizzle-orm";
import { companionGroundedTutorGrantV1Schema, companionLearningRunContextV1Schema, companionProposalSnapshotV1Schema, proposedLearningActionPayloadV1Schema, } from "@ailearn/shared";
import { sha256Utf8V1, canonicalJsonV1 } from "@ailearn/shared/content-hash";
import type { CompanionLearningContextV1, LearningRunOriginV2 } from "@ailearn/shared";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
// Plan 23 CS-05/CS-06：Objective Surface 派生 companion 上下文（不再依赖 V1 card_key_points.claim）。
import {
  listObjectiveSurfacesV3,
  type SurfaceContext,
} from "../learning-objectives/surface-service.ts";
import { deliver } from "./delivery-service.ts";
import { resolveAuthSurfaceManifestSecret } from "../companion-shell/auth-surface.ts";
import { getCompanionAccountEpoch } from "./companion-account-epoch.ts";
import {
  buildCompanionLearningRunContext,
  contextRevisionForCompanionLearningRun,
  isCompanionLearningRunTutorEligible,
  loadCompanionLearningRunContext,
} from "./learning-run-context.ts";
// LearningRun 工具在 decision 事务内同步执行；confirm 后 proposal 直接
// succeeded + resultRef=runId。
import { applyAction, createRunV2, getRunPublicView, type CreateLearningRunV2Request } from "../learning-runs/run-service.ts";
import { LearningRunServiceError } from "../learning-runs/run-errors.ts";
// 方案 16 §18.1：工具网关第二批执行单元（确定性、同事务）。
import { createUnderstandingRoutePlan } from "../understanding/route-plan-service.ts";
import { deferReviewSchedule } from "../review/review-defer-service.ts";
import { createJob } from "../job/service.ts";
import {
  confirmMemory,
  deleteMemory,
  getMemory,
  upsertMemory,
  type MemoryKindV2,
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
 * LearningRun 候选的合同已经携带创建/恢复所需的最小引用。
 */
type ResolvedCompanionContextInternal = CompanionLearningContextV1;

function toPublicContext(ctx: ResolvedCompanionContextInternal): CompanionLearningContextV1 {
  return {
    version: ctx.version,
    contextRevision: ctx.contextRevision,
    learningRunResumeCandidate: ctx.learningRunResumeCandidate,
    learningRunStartCandidate: ctx.learningRunStartCandidate,
  };
}

/**
 * Plan 23 CS-05/CS-06：V2 run 请求的 originV2 类型守卫。
 * pet 不自建 origin 对象；以下仅作 narrow，保证下游 createRunV2 类型安全。
 */
function isLearningRunOriginV2(value: unknown): value is LearningRunOriginV2 {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "card" || kind === "review" || kind === "today" || kind === "star_map" || kind === "onboarding";
}

/**
 * Plan 23 CS-05/CS-06：从 Objective Surface 主 action 构造 V2 run 请求。
 * 绝不从 claim/summary 自推断 run 参数；所有参数都来自 Surface 的 typed action。
 *
 * 返回 null 表示当前 action 不适合菜单创建（如 none / refresh）。
 */
function buildStartPayloadV2(
  surface: Awaited<ReturnType<typeof listObjectiveSurfacesV3>>["items"][number],
): {
  request: {
    originV2: LearningRunOriginV2;
    goal: "stabilize" | "clarify" | "repair" | "transfer" | "explore";
    idempotencyKey: string;
    requestedTimeBudgetSeconds?: number;
    responsePreference?: "adaptive" | "voice" | "text" | "structured";
  };
} | null {
  const objectiveId = surface.objectiveId;
  switch (surface.primaryAction.kind) {
    case "create_run": {
      return {
        request: {
          ...surface.primaryAction.start,
          idempotencyKey: `pet-menu-v2:${objectiveId}`,
        },
      };
    }
    case "create_review_run": {
      return {
        request: {
          ...surface.primaryAction.start,
          idempotencyKey: `pet-menu-v2:${objectiveId}`,
        },
      };
    }
    case "resume_run": {
      // resume 语义走 resume_learning_run；create 入口仍需一个 create 语义。
      return null;
    }
    case "view_successor":
      // view_successor 不是可"创建 run"的 action；菜单不展示。
      return null;
    case "refresh":
    case "practice_only":
    case "none":
      // 这些 action 不适合 pet 菜单创建 run。
      return null;
    default:
      return null;
  }
  return null;
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
  // 当前候选只从 Objective Surface 派生，不能从已删除的 Session/Episode 表回退。
  const surfaceCtx: SurfaceContext = {
    workspaceId: args.workspaceId,
    userId: args.userId,
  };
  const objectiveLimit = 5;
  const { items: objectives } = await listObjectiveSurfacesV3(tx, surfaceCtx, {
    limit: objectiveLimit,
    lifecycle: "active",
  });

  // 排序：resume_run > create_run > create_review_run > 其他；同一优先级
  // 按 surface 顺位（已在 listObjectiveSurfacesV3 按 created_at DESC 返回）。
  const rank = (kind: string): number => {
    switch (kind) {
      case "resume_run": return 0;
      case "create_run": return 1;
      case "create_review_run": return 2;
      case "view_successor": return 3;
      case "practice_only": return 4;
      case "refresh": return 5;
      default: return 6;
    }
  };
  const sorted = [...objectives].sort((a, b) => rank(a.primaryAction.kind) - rank(b.primaryAction.kind));

  // resume：带 activeRun 的第一个 Objective（typed resume_run）。
  let learningRunResumeCandidate: CompanionLearningContextV1["learningRunResumeCandidate"] = null;
  const resumeObjective = sorted.find((s) => s.personal.activeRun);
  if (resumeObjective) {
    const runId = resumeObjective.personal.activeRun!.runId;
    const label = resumeObjective.content.conceptLabel;
    const title = sanitizeText(label ?? "", 80) || "继续本次巩固";
    const summaryPreview = resumeObjective.content.publicSummary.split("\n")[0] ?? "";
    const payload = { kind: "resume_learning_run", runId };
    learningRunResumeCandidate = {
      candidateId: "learning_run_resume",
      runId,
      title,
      targetSummary: sanitizeText(summaryPreview || `继续：${title}`, 160),
      impactSummary: "恢复当前学习运行",
      payloadSha256: sha256Utf8V1(canonicalJsonV1(payload)),
    };
  }

  // start：可执行的第一个 Objective（typed create_run / create_review_run）。
  let learningRunStartCandidate: CompanionLearningContextV1["learningRunStartCandidate"] = null;
  const actionableObjective = sorted.find((s) => {
    const k = s.primaryAction.kind;
    return k === "create_run" || k === "create_review_run" || k === "resume_run";
  });
  if (actionableObjective) {
    const label = actionableObjective.content.conceptLabel;
    const claimText = label ?? "";
    const payloadV2 = buildStartPayloadV2(actionableObjective);
    const v2Payload = payloadV2 ? {
      kind: "start_learning_run_v2" as const,
      request: payloadV2.request,
    } : null;
    if (v2Payload && isLearningRunOriginV2(v2Payload.request.originV2)) {
      learningRunStartCandidate = {
      candidateId: "learning_run_start",
      title: sanitizeText(claimText, 80)
        || (actionableObjective.primaryAction.kind === "create_review_run" ? "开始复习" : "开始验证"),
      targetSummary: sanitizeText(actionableObjective.content.publicSummary.split("\n")[0]
        || `开始：${claimText}`, 160),
      impactSummary: actionableObjective.personal.review?.status === "due"
        ? "完成复习运行，恢复记忆曲线"
        : "创建一次学习运行，完成后按真实结果安排复习",
      payloadSha256: sha256Utf8V1(canonicalJsonV1(v2Payload)),
      objectiveId: actionableObjective.objectiveId,
      originV2: v2Payload.request.originV2,
      };
    }
  }

  const contextRevision = sha256Utf8V1(
    canonicalJsonV1({ learningRunResumeCandidate, learningRunStartCandidate }),
  );
  return {
    version: 1,
    contextRevision,
    learningRunResumeCandidate,
    learningRunStartCandidate,
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
import { reclaimExpiredCompanionProposals } from "./companion-proposal-expiry.ts";

const PROPOSAL_TTL_MINUTES = 5; // §6.7：resume/start 默认 5min（纯导航 10min）

function menuProposalRequestHash(body: {
  version: 1;
  conversationId?: string;
  clientMessageId: string;
  candidateId: "learning_run_resume" | "learning_run_start";
  expectedContextRevision: string;
  expectedPayloadSha256: string;
  sourceSurface: "pet" | "main";
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
    candidateId: "learning_run_resume" | "learning_run_start";
    expectedContextRevision: string;
    expectedPayloadSha256: string;
    sourceSurface: "pet" | "main";
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
      const candidate = args.body.candidateId === "learning_run_resume"
        ? context.learningRunResumeCandidate
        : context.learningRunStartCandidate;
      if (!candidate) {
        // 2026-08-12+（15a-E）：细分 code——前端据此显示"当前没有进行中的学习/
        // 没有可开始的学习"（此前 ACTION_STALE 无法区分）。
        throw new CompanionConversationError(
          args.body.candidateId === "learning_run_resume"
            ? "NO_ACTIVE_RUN"
            : "NO_CANDIDATE", 409, "candidate unavailable",
        );
      }
      if (candidate.payloadSha256 !== args.body.expectedPayloadSha256) {
        throw new CompanionConversationError(
          "ACTION_STALE", 409, "payload hash mismatch",
        );
      }
      // 服务端重新构造候选 payload，并精确验证其 sha256。
      let payload: { kind: string; [k: string]: unknown };
      if (args.body.candidateId === "learning_run_resume") {
        const runId = context.learningRunResumeCandidate?.runId;
        if (!runId) {
          throw new CompanionConversationError("NO_ACTIVE_RUN", 409, "active learning run disappeared");
        }
        payload = { kind: "resume_learning_run", runId };
      } else {
        const start = context.learningRunStartCandidate;
        if (!start || !start.objectiveId || !start.originV2) {
          throw new CompanionConversationError("NO_CANDIDATE", 409, "learning candidate disappeared");
        }
        const idempotencyKey = `pet-menu-v2:${start.objectiveId}`;
        payload = {
          kind: "start_learning_run_v2",
          request: {
            originV2: start.originV2,
            goal: "stabilize",
            idempotencyKey,
            requestedTimeBudgetSeconds: 180,
          },
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
          args.body.candidateId === "learning_run_resume"
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
    sourceSurface: "pet" | "main";
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
        result_ref: string | null;
        result_route: unknown;
        result_safe_summary: string | null;
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
               p.result_ref, p.result_route, p.result_safe_summary,
               p.expires_at, p.decided_at, p.created_at, p.updated_at,
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
            resultRef: row.result_ref,
            route: row.result_route,
            safeSummary: row.result_safe_summary,
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
        // §8.5：先原子回收过期 pending（TTL 5min → expired + action.expired 事件
        // + 挂起 run/工具调用终结）。必须在 active run 校验**之前**执行：Agent run
        // 在等待确认期间保持 waiting_for_confirmation（仍属 active），先判 active
        // 会让回收永不触发——过期后该 conversation 的新 turn / 新 proposal 一律被
        // 409 拒死，用户既无法确认也无法继续对话。
        await reclaimExpiredCompanionProposals(tx, {
          workspaceId: args.workspaceId,
          userId: args.userId,
          conversationId,
        });
        const active = await tx.execute<{ id: string }>(sql`
          SELECT id FROM companion_turn_runs
          WHERE conversation_id = ${conversationId} AND status IN ('accepted', 'running', 'waiting_for_confirmation', 'cancel_requested')
          LIMIT 1
        `);
        if (active[0]) {
          throw new CompanionConversationError("RUN_ALREADY_ACTIVE", 409, "active dialogue run");
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
           idempotency_key_hash, request_body_sha256, expires_at, origin)
        VALUES
          (${proposalId}, ${args.workspaceId}, ${args.userId}, ${conversationId}, ${userMessageId}, ${sourceGeneration},
           ${JSON.stringify(args.payload)}, ${args.payloadSha256},
           ${args.title}, ${args.targetSummary}, ${args.impactSummary}, 'pending',
           ${keyHash}, ${args.requestBodyHash}, now() + make_interval(mins => ${PROPOSAL_TTL_MINUTES}),
           'menu')
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
            // 方案 16 §14.3：proposal 创建后入 inbox（pet 自身发起的 proposal 已有
      // 本地确认卡，避免重复展示；main 发起的需要推送给 pet）。
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
  sourceSurface: "pet" | "main";
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
    sourceSurface: "pet" | "main";
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

import { type LearningRunActionV1, type UnderstandingRoutePlanRequestV1 } from "@ailearn/shared";

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
 * §5（Agent 方案）：确认窗口过期后的补偿回收。
 *
 * decideCompanionProposal 在事务内发现 TTL 已过时抛出 ACTION_EXPIRED，事务整体
 * 回滚——挂起的 run 仍是 waiting_for_confirmation，该 conversation 之后所有 turn
 * 都会被 409 RUN_ALREADY_ACTIVE 拒死。这里在独立事务中提交回收（proposal →
 * expired、工具调用 → expired、run → failed），再原样抛出原始 409 给调用方。
 */
async function releaseExpiredProposalForDecision(args: {
  workspaceId: string;
  userId: string;
  proposalId: string;
}): Promise<void> {
  const conversationId = await withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const rows = await tx.execute<{ conversation_id: string }>(sql`
        SELECT conversation_id FROM companion_action_proposals
        WHERE id = ${args.proposalId}
        LIMIT 1
      `);
      return rows[0]?.conversation_id ?? null;
    },
  );
  if (!conversationId) return;
  await withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    (tx) => reclaimExpiredCompanionProposals(tx, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      conversationId,
    }),
  );
}

/**
 * §6.6：POST /companion/proposals/:id/decision。
 * - reject：原子写 decision，零业务副作用，返回 200 rejected；
 * - confirm：校验 pending/TTL/无 active run/幂等；纯导航同步 succeeded（200）；
 *   当前 LearningRun/记忆/路线工具均在同一事务内完成；
 * - 同 key 同 decision 返回同一结果；异参 409；已被消费返回当前状态；
 * - router 只生成 proposal，不执行任何 Learning 副作用（执行在 worker）。
 */
export async function decideCompanionProposal(args: {
  workspaceId: string;
  userId: string;
  proposalId: string;
  decision: "confirm" | "reject";
  idempotencyKey: string;
  expectedPayloadSha256: string;
}): Promise<unknown> {
  const result = await withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const rows = await tx.execute<{
        id: string; conversation_id: string; status: string; decision: string | null;
        decision_key_hash: string | null; expires_at: Date;
        payload: { kind: string; [key: string]: unknown } | string;
        payload_sha256: string;
        result_ref: string | null;
        result_route: unknown;
        result_safe_summary: string | null;
        origin: string | null;
        agent_run_id: string | null;
        agent_tool_call_id: string | null;
      }>(sql`
        SELECT id, conversation_id, status, decision, decision_key_hash, expires_at, payload,
               payload_sha256, result_ref, result_route, result_safe_summary,
               origin, agent_run_id, agent_tool_call_id
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
          return snapshotFor({ ...proposal, payload: proposalPayload });
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
        await appendDecisionEvent(tx, args.workspaceId, args.userId, proposal, "rejected");
        return { version: 1, proposalId: proposal.id, status: "rejected", resultRef: null, route: null, safeSummary: null };
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
      if (args.expectedPayloadSha256 !== proposal.payload_sha256) {
        throw new CompanionConversationError(
          "PAYLOAD_HASH_MISMATCH", 409, "expected payload hash does not match proposal",
        );
      }
      if (proposal.origin === "agent_tool" && proposal.agent_run_id) {
        const epochRows = await tx.execute<{
          run_account_epoch: number;
          account_epoch: number;
          global_enabled: boolean;
        }>(sql`
          SELECT r.account_epoch AS run_account_epoch,
                 COALESCE(s.epoch, 0) AS account_epoch,
                 COALESCE(s.global_enabled, true) AS global_enabled
          FROM companion_turn_runs r
          LEFT JOIN user_companion_account_state s ON s.user_id = r.user_id
          WHERE r.id = ${proposal.agent_run_id}
          LIMIT 1
        `);
        const epoch = epochRows[0];
        if (!epoch || !epoch.global_enabled || Number(epoch.run_account_epoch) !== Number(epoch.account_epoch)) {
          throw new CompanionConversationError("ACTION_STALE", 409, "agent run is no longer current");
        }
      }
      await tx.execute(sql`
        SELECT id FROM companion_conversations
        WHERE id = ${proposal.conversation_id}
        FOR UPDATE
      `);
      // 显式 ::uuid 转型：菜单/路由 proposal 的 agent_run_id 为 NULL，而裸参数出现在
      // `$n IS NULL` 中时 PostgreSQL 无法从该表达式推断类型（另一处 `id <> $n` 是
      // **另一个**占位符，不能替它定型），于是报 42P18 could not determine data type
      // of parameter $2——非 Agent proposal 的 confirm 因此必然 500。
      const active = await tx.execute<{ id: string }>(sql`
        SELECT id FROM companion_turn_runs
        WHERE conversation_id = ${proposal.conversation_id} AND status IN ('accepted', 'running', 'waiting_for_confirmation')
          AND (
            ${proposal.agent_run_id}::uuid IS NULL
            OR id <> ${proposal.agent_run_id}::uuid
            OR status <> 'waiting_for_confirmation'
          )
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
        await tx.execute(sql`
          UPDATE companion_action_proposals
          SET result_route = ${JSON.stringify(route?.route ?? null)},
              result_safe_summary = ${route?.safeSummary ?? "打开页面"}
          WHERE id = ${proposal.id}
        `);
        await appendDecisionEvent(tx, args.workspaceId, args.userId, proposal, "accepted");
        await deliverActionResultForProposal(tx, args.workspaceId, args.userId, proposal.id);
        return {
          version: 1, proposalId: proposal.id, status: "succeeded",
          resultRef: null, route: route?.route ?? null, safeSummary: route?.safeSummary ?? "打开页面",
        };
      }

      // LearningRun 工具（同步执行，事务内完成）。
      if (kind === "start_learning_run_v2" || kind === "resume_learning_run") {
        let runId: string;
        let safeSummary: string;
        if (kind === "start_learning_run_v2") {
          const request = proposalPayload.request as CreateLearningRunV2Request | undefined;
          if (!request || typeof request !== "object" || !("originV2" in request)) {
            throw new CompanionConversationError("ACTION_STALE", 409, "learning run v2 payload is stale");
          }
          try {
            const run = await createRunV2(tx, {
              workspaceId: args.workspaceId,
              userId: args.userId,
              request: request as CreateLearningRunV2Request,
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
        await appendDecisionEvent(tx, args.workspaceId, args.userId, proposal, "accepted");
        await deliverActionResultForProposal(tx, args.workspaceId, args.userId, proposal.id);
        return {
          version: 1, proposalId: proposal.id, status: "succeeded",
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
      // propose_memory_candidate 分支已删除：契约要求调用方提供 sourceMessageId，
      // 而该 id 由本服务在 proposal 创建事务内生成，任何 producer 都无法满足 ⇒ 该
      // kind 不可实现。候选记忆由 worker memory-extractor + delivery 气泡产生，用户
      // 经下面的 confirm_or_reject_memory 确认或拒绝。
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

      // ── 2026-09-19：auto-set / auto-fill 工具（guided 档提案确认后的执行分支）──
      // full 档不走这里：worker 侧 requiresConfirmation=false 直接执行
      // （companion-agent-runtime.executeDirectTool）。两处执行口径保持一致：
      // 记忆写入统一走 upsertMemory 的"用户明确陈述"路径。
      if (kind === "save_memory" || kind === "set_pet_activeness") {
        const actionScope = { workspaceId: args.workspaceId, userId: args.userId };
        if (kind === "save_memory") {
          const memoryKind = proposalPayload.memoryKind;
          const content = proposalPayload.content;
          if (
            typeof memoryKind !== "string" ||
            !(["preference", "goal", "learning_context", "interaction_note", "episodic"] as const).includes(memoryKind as MemoryKindV2) ||
            typeof content !== "string" || content.length === 0
          ) {
            throw new CompanionConversationError("ACTION_STALE", 409, "memory payload is stale");
          }
          const saved = await upsertMemory(tx, actionScope, {
            kind: memoryKind as MemoryKindV2,
            content: content.slice(0, 200),
            userStated: true,
            candidate: false,
            importance: 0.8,
            confidence: 0.9,
            scope: "workspace",
            sourceType: "user_stated",
          });
          return succeedSyncProposal(tx, args.workspaceId, args.userId, proposal, keyHash, saved.memoryItemId, null, "已保存记忆");
        }
        const activeness = proposalPayload.activeness;
        if (activeness !== "quiet" && activeness !== "moderate" && activeness !== "active") {
          throw new CompanionConversationError("ACTION_STALE", 409, "activeness payload is stale");
        }
        const updated = await tx.execute<{ id: string }>(sql`
          UPDATE pet_profiles
          SET activeness = ${activeness}, revision = revision + 1, updated_at = now()
          WHERE workspace_id = ${args.workspaceId}
            AND user_id = ${args.userId}
          RETURNING id
        `);
        if (updated.length === 0) {
          throw new CompanionConversationError("NOT_FOUND", 404, "pet profile not found");
        }
        return succeedSyncProposal(tx, args.workspaceId, args.userId, proposal, keyHash, null, null, "已更新伴星活跃度");
      }

      throw new CompanionConversationError(
        "ACTION_STALE", 409, "unsupported companion action",
      );
    },
  ).catch(async (error: unknown) => {
    // The decision transaction rolled back because the confirmation TTL already
    // elapsed. Release the parked agent run in a committed transaction so the
    // conversation can accept the next turn, then surface the original 409.
    if (error instanceof CompanionConversationError && error.code === "ACTION_EXPIRED") {
      await releaseExpiredProposalForDecision(args);
    }
    throw error;
  });

  // Agent proposals are not terminal chat actions. Once the decision is
  // committed, enqueue the original run with the proposal id so the worker
  // can feed the frozen decision back into the same bounded loop. The
  // run-status fence makes retries and late duplicate decisions harmless.
  const continuation = await withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const rows = await tx.execute<{
        origin: string | null;
        agent_run_id: string | null;
        agent_tool_call_id: string | null;
        status: string;
        decision: string | null;
        run_status: string | null;
        waiting_proposal_id: string | null;
      }>(sql`
        SELECT p.origin, p.agent_run_id, p.agent_tool_call_id, p.status, p.decision,
               r.status AS run_status, r.waiting_proposal_id
        FROM companion_action_proposals p
        LEFT JOIN companion_turn_runs r ON r.id = p.agent_run_id
        WHERE p.id = ${args.proposalId}
        LIMIT 1
      `);
      const row = rows[0];
      if (!row || row.origin !== "agent_tool" || !row.agent_run_id || !row.agent_tool_call_id || !row.decision) {
        return null;
      }
      const body = result as { status?: string; resultRef?: unknown; safeSummary?: unknown; route?: unknown };
      const safeSummary = typeof body.safeSummary === "string"
        ? body.safeSummary
        : row.decision === "reject" ? "用户拒绝了这次操作" : "操作已完成";
      await tx.execute(sql`
        UPDATE companion_agent_tool_calls
        SET status = ${row.decision === "confirm" ? "succeeded" : "failed"},
            result_ref = ${typeof body.resultRef === "string" ? body.resultRef : null},
            result_safe_summary = ${safeSummary},
            updated_at = now()
        WHERE run_id = ${row.agent_run_id} AND tool_call_id = ${row.agent_tool_call_id}
      `);
      if (row.run_status !== "waiting_for_confirmation" || row.waiting_proposal_id !== args.proposalId) {
        return null;
      }
      return {
        runId: row.agent_run_id,
        proposalId: args.proposalId,
      };
    },
  );
  if (continuation) {
    await createJob({
      type: "companion_agent",
      workspaceId: args.workspaceId,
      requestedBy: args.userId,
      payload: { runId: continuation.runId, proposalId: continuation.proposalId },
      // Dedupe on proposalId, never on runId: the ORIGINAL turn job also carries
      // `{ runId }` and no proposalId. While that job is still pending (lease
      // reaped, or a fail→retry backoff) or still running (the window between
      // the proposal commit and the job's success update), a runId-keyed dedupe
      // returns THAT job instead of creating the continuation — the confirmed
      // decision is never injected, or no job exists at all while the run has
      // already been flipped back to 'accepted', wedging the conversation.
      dedupe: { payloadField: "proposalId", value: continuation.proposalId },
    });
    await withWorkspaceTransaction(
      { workspaceId: args.workspaceId, userId: args.userId },
      (tx) => tx.execute(sql`
        UPDATE companion_turn_runs
        SET status = 'accepted', waiting_proposal_id = NULL, updated_at = now()
        WHERE id = ${continuation.runId}
          AND status = 'waiting_for_confirmation'
          AND waiting_proposal_id = ${continuation.proposalId}
      `),
    );
  }
  return result;
}

export function snapshotFor(
  proposal: {
    id: string;
    status: string;
    decision: string | null;
    result_ref: string | null;
    result_route: unknown;
    result_safe_summary: string | null;
    payload: { kind: string; [key: string]: unknown };
  },
): unknown {
  const resultRoute = proposal.result_route == null
    ? null
    : typeof proposal.result_route === "string"
      ? (() => {
          try {
            return JSON.parse(proposal.result_route) as Record<string, unknown>;
          } catch {
            return null;
          }
        })()
      : proposal.result_route;
  const route = proposal.status === "succeeded"
    ? navigationRouteFor(proposal.payload.kind, proposal.payload)
    : null;
  return {
    version: 1,
    proposalId: proposal.id,
    status: proposal.status === "accepted" ? "executing" : proposal.status,
    resultRef: proposal.result_ref,
    route: resultRoute ?? route?.route ?? null,
    safeSummary: proposal.result_safe_summary ?? route?.safeSummary ?? null,
  };
}

/** §6.6 reload/cursor-expired recovery for a synchronous proposal. */
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
        result_ref: string | null;
        result_route: unknown;
        result_safe_summary: string | null;
        expires_at: Date;
        decided_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(sql`
        SELECT p.id, p.conversation_id, p.source_message_id, p.source_generation,
               p.context_grant_id, p.payload, p.payload_sha256, p.title,
               p.target_summary, p.impact_summary, p.status, p.decision,
               p.result_ref, p.result_route, p.result_safe_summary,
               p.expires_at, p.decided_at, p.created_at, p.updated_at
        FROM companion_action_proposals p
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
            expiresAt: new Date(row.expires_at).toISOString(),
            decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          },
        });
        return { statusCode: 200 as const, body };
      } catch (error) {
        if (error instanceof CompanionConversationError) throw error;
        throw new CompanionConversationError("INTERNAL_ERROR", 500, "invalid proposal snapshot");
      }
    },
  );
}

/** §18 同步工具成功收尾：proposal → succeeded + decision 事件。 */
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
      payloadRef: { kind: "action_result", proposalId },
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
        decision_key_hash = ${keyHash}, result_ref = ${resultRef},
        result_route = ${JSON.stringify(route ?? null)},
        result_safe_summary = ${safeSummary}, updated_at = now()
    WHERE id = ${proposal.id}
  `);
  await appendDecisionEvent(tx, workspaceId, userId, proposal, "accepted");
  await deliverActionResultForProposal(tx, workspaceId, userId, proposal.id);
  return {
    version: 1, proposalId: proposal.id, status: "succeeded",
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

/** LearningRun 页面适配器：仅返回仍可安全进入 Grounded Tutor 的当前 task。 */
export async function getCompanionLearningRunContext(args: {
  workspaceId: string;
  userId: string;
  runId: string;
}): Promise<{ statusCode: 200; body: unknown }> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const row = await loadCompanionLearningRunContext(tx, args);
      if (!row) throw new CompanionConversationError("NOT_FOUND", 404, "learning run context not found");
      if (!isCompanionLearningRunTutorEligible(row)) {
        throw new CompanionConversationError("ACTION_STALE", 409, "learning run context is no longer eligible");
      }
      return {
        statusCode: 200 as const,
        body: companionLearningRunContextV1Schema.parse(buildCompanionLearningRunContext(row)),
      };
    },
  );
}

/**
 * LearningRun 专用的一次性授权。签名绑定 snapshotId 与 active task，随后由
 * turn create 在同一 RLS 事务内重新读取并消费，避免旧页面对已切换任务续用。
 */
export async function createCompanionLearningRunContextGrant(args: {
  workspaceId: string;
  userId: string;
  runId: string;
  body: { version: 1; pageInstanceId: string; taskId: string; contextRevision: string };
}): Promise<unknown> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const run = await loadCompanionLearningRunContext(tx, args);
      if (!run) throw new CompanionConversationError("NOT_FOUND", 404, "learning run not found");
      const contextRevision = contextRevisionForCompanionLearningRun(run);
      if (contextRevision !== args.body.contextRevision) {
        throw new CompanionConversationError("CONTEXT_STALE", 409, "learning run context revision mismatch");
      }
      const taskId = run.taskId;
      if (!isCompanionLearningRunTutorEligible(run) || taskId === null || taskId !== args.body.taskId) {
        throw new CompanionConversationError("ACTION_STALE", 409, "learning run context is no longer eligible");
      }

      const grantId = grantRandomUUID();
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + GRANT_TTL_MINUTES * 60_000);
      const permissionSnapshot = {
        pageInstanceId: args.body.pageInstanceId,
        pageKind: "learning_run" as const,
        capability: "grounded_tutor" as const,
        runId: run.runId,
        snapshotId: run.snapshotId,
        taskId,
        contextRevision: args.body.contextRevision,
      };
      const permissionSnapshotHash = sha256(canonicalJson(permissionSnapshot));
      const grantPayload = {
        version: 1 as const,
        grantId,
        userId: args.userId,
        workspaceId: args.workspaceId,
        pageInstanceId: args.body.pageInstanceId,
        pageKind: "learning_run" as const,
        capability: "grounded_tutor" as const,
        runId: run.runId,
        snapshotId: run.snapshotId,
        taskId,
        contextRevision: args.body.contextRevision,
        permissionSnapshotHash,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      const signature = createHmac("sha256", grantHmacSecret())
        .update(`companion-grounded-tutor-grant-v1:${canonicalJson(grantPayload)}`)
        .digest("hex");
      return companionGroundedTutorGrantV1Schema.parse({ ...grantPayload, signature });
    },
  );
}
