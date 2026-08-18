/**
 * P2 — Durable Text Conversation 共享合同（03-conversation-api-data-proactive-contract.md §2–§6）。
 *
 * 唯一 wire truth：Conversation / Message / ContentBlock / Turn / CharacterCue /
 * SSE envelope + discriminated payload / 公开错误码。所有网络/IPC/DB JSON shape
 * 均为 zod strict；类型只用 z.infer 导出；枚举未知值 fail closed。
 *
 * 长度语义：V1 全部 min/max 按 JavaScript UTF-16 code unit（text.length）计数。
 * hash：所有小写 64 位 SHA-256 复用 content-hash.ts 的 canonicalJsonV1/sha256Hex。
 */

import { z } from "zod";
import { allowedMainRouteV1Schema } from "./desktop-pet-contracts.ts";
import { allowedMainRouteV2Schema } from "./companion-bridge-contracts.ts";
import { companionAccountStateV1Schema } from "./companion-shell-contracts.ts";
import {
  characterCueEmotionV1Schema,
  characterCueIntentV1Schema,
} from "./companion-character-contracts.ts";
import { createLearningRunRequestSchema } from "./learning-run-contracts.ts";
import { createLearningRunV2RequestSchema } from "./learning-target-v2-contracts.ts";

// ─── 基础 ────────────────────────────────────────────────────────────────

export const companionHashV1Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type CompanionHashV1 = z.infer<typeof companionHashV1Schema>;

// ─── Conversation（§3.1） ────────────────────────────────────────────────

export const companionConversationV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(["dialogue", "inbox", "journey"]),
  title: z.string().min(1).max(120),
  titleSource: z.enum(["placeholder", "auto", "user", "system"]),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
}).strict();

export type CompanionConversationV1 = z.infer<typeof companionConversationV1Schema>;

// ─── Content blocks（§3.2） ───────────────────────────────────────────────

export const companionContentBlockV1Schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    type: z.literal("code"),
    language: z.string().min(1).max(40).optional(),
    code: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    type: z.literal("citation"),
    label: z.string().min(1).max(200),
    target: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("external_https"),
        href: z.string().url().max(2_000).refine((value) => new URL(value).protocol === "https:"),
      }).strict(),
      z.object({
        kind: z.literal("entity"),
        entityRef: z.string().min(1).max(240),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    type: z.literal("action_ref"),
    proposalId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("result_ref"),
    actionRunId: z.string().uuid(),
  }).strict(),
]);

export type CompanionContentBlockV1 = z.infer<typeof companionContentBlockV1Schema>;

// ─── Message（§3.3） ──────────────────────────────────────────────────────

export const companionMessageV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  seq: z.number().int().positive(),
  role: z.enum(["user", "assistant", "system"]),
  kind: z.enum([
    "text",
    "voice_transcript",
    "proactive",
    "action",
    "result",
    "error",
  ]),
  blocks: z.array(companionContentBlockV1Schema).min(1).max(32),
  runId: z.string().uuid().nullable(),
  clientMessageId: z.string().uuid().nullable(),
  // 2026-08-11：API 实际返回 contentSha256（内容校验用），契约补齐声明
  contentSha256: z.string().length(64),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
}).strict();

export type CompanionMessageV1 = z.infer<typeof companionMessageV1Schema>;

// ─── Turn run（§4.3） ─────────────────────────────────────────────────────

export const companionRunStatusV1Schema = z.enum([
  "accepted",
  "running",
  "succeeded",
  "cancel_requested",
  "cancelled",
  "failed",
  "superseded",
]);

export type CompanionRunStatusV1 = z.infer<typeof companionRunStatusV1Schema>;

export const companionTurnRunV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid().nullable(),
  generation: z.number().int().positive(),
  status: companionRunStatusV1Schema,
  phase: z.enum(["accepted", "thinking", "streaming", "acting"]).nullable(),
  previewText: z.string().max(20_000),
  previewTextSha256: companionHashV1Schema,
  lastEventSeq: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type CompanionTurnRunV1 = z.infer<typeof companionTurnRunV1Schema>;

// ─── Turn cancel（§6.5） ──────────────────────────────────────────────────

export const cancelCompanionRunRequestV1Schema = z.object({
  version: z.literal(1),
  generation: z.number().int().positive(),
  reason: z.literal("user"),
}).strict();

export const cancelCompanionRunResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  status: companionRunStatusV1Schema,
  eventCursor: z.number().int().nonnegative(),
}).strict();

export type CancelCompanionRunRequestV1 = z.infer<typeof cancelCompanionRunRequestV1Schema>;
export type CancelCompanionRunResponseV1 = z.infer<typeof cancelCompanionRunResponseV1Schema>;

// ─── Page context（§4.1） — P2 提交的 bounded 页面上下文 ───────────────────

export const companionGroundedTutorGrantPayloadV1Schema = z.object({
  version: z.literal(1),
  grantId: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  pageInstanceId: z.string().uuid(),
  pageKind: z.literal("learning_session"),
  capability: z.literal("grounded_tutor"),
  sessionId: z.string().uuid(),
  episodeId: z.string().uuid(),
  cardId: z.string().uuid(),
  keyPointId: z.string().uuid(),
  contextRevision: companionHashV1Schema,
  permissionSnapshotHash: companionHashV1Schema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export type CompanionGroundedTutorGrantPayloadV1 = z.infer<
  typeof companionGroundedTutorGrantPayloadV1Schema
>;

export const companionGroundedTutorGrantV1Schema =
  companionGroundedTutorGrantPayloadV1Schema.extend({
    signature: companionHashV1Schema,
  }).strict();

export type CompanionGroundedTutorGrantV1 = z.infer<
  typeof companionGroundedTutorGrantV1Schema
>;

export const companionPageContextV1Schema = z.discriminatedUnion("pageKind", [
  z.object({
    pageKind: z.literal("today"),
    sharing: z.literal("page_registered"),
    contextRevision: companionHashV1Schema,
  }).strict(),
  z.object({
    pageKind: z.literal("review"),
    sharing: z.enum(["page_registered", "user_selected"]),
    cardId: z.string().uuid().optional(),
    keyPointId: z.string().uuid().optional(),
    contextRevision: companionHashV1Schema,
  }).strict(),
  z.object({
    pageKind: z.literal("card"),
    sharing: z.enum(["page_registered", "user_selected"]),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid().optional(),
    contextRevision: companionHashV1Schema,
  }).strict(),
  z.object({
    pageKind: z.literal("star_map"),
    sharing: z.enum(["page_registered", "user_selected"]),
    keyPointId: z.string().uuid().optional(),
    contextRevision: companionHashV1Schema,
  }).strict(),
  z.object({
    pageKind: z.literal("learning_session"),
    sharing: z.enum(["page_registered", "user_selected"]),
    sessionId: z.string().uuid(),
    episodeId: z.string().uuid(),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid(),
    requestedCapability: z.enum(["none", "grounded_tutor"]),
    contextRevision: companionHashV1Schema,
    groundedTutorGrant: companionGroundedTutorGrantV1Schema.nullable(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.pageKind !== "learning_session") return;
  const required = value.requestedCapability === "grounded_tutor";
  if (required !== (value.groundedTutorGrant !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["groundedTutorGrant"],
      message: "grant iff grounded_tutor",
    });
  }
});

export type CompanionPageContextV1 = z.infer<typeof companionPageContextV1Schema>;

// ─── Turn create response（§4.2） ─────────────────────────────────────────

export const createCompanionTurnRequestV1Schema = z.object({
  version: z.literal(1),
  clientMessageId: z.string().uuid(),
  inputKind: z.enum(["text", "voice_transcript"]),
  blocks: z.array(companionContentBlockV1Schema).length(1),
  voiceArtifactId: z.string().uuid().optional(),
  sourceSurface: z.enum(["pet", "main", "web_fallback"]),
  supersedesGeneration: z.number().int().positive().optional(),
  context: companionPageContextV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  const textOnly = value.blocks[0]?.type === "text";
  if (!textOnly) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: "v1 turn input must be one text block" });
  }
  if ((value.inputKind === "voice_transcript") !== (value.voiceArtifactId !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["voiceArtifactId"], message: "required iff voice_transcript" });
  }
});

export type CreateCompanionTurnRequestV1 = z.infer<
  typeof createCompanionTurnRequestV1Schema
>;

export const createCompanionTurnResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  clientMessageId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  // 幂等重放已终态 run 时返回真实状态（§6.3），客户端据此决定挂 SSE 还是恢复快照。
  status: z.enum(["accepted", "running", "succeeded", "cancelled", "failed", "superseded"]),
  eventCursor: z.number().int().nonnegative(),
}).strict();

export type CreateCompanionTurnResponseV1 = z.infer<
  typeof createCompanionTurnResponseV1Schema
>;

/** 服务端持久化的 page context（§4.1）：去掉 grant signature/raw，只存 bounded refs。 */
export const companionPersistedPageContextV1Schema = z.object({
  version: z.literal(1),
  context: z.discriminatedUnion("pageKind", [
    z.object({
      pageKind: z.literal("today"),
      sharing: z.literal("page_registered"),
      contextRevision: companionHashV1Schema,
    }).strict(),
    z.object({
      pageKind: z.literal("review"),
      sharing: z.enum(["page_registered", "user_selected"]),
      cardId: z.string().uuid().optional(),
      keyPointId: z.string().uuid().optional(),
      contextRevision: companionHashV1Schema,
    }).strict(),
    z.object({
      pageKind: z.literal("card"),
      sharing: z.enum(["page_registered", "user_selected"]),
      cardId: z.string().uuid(),
      keyPointId: z.string().uuid().optional(),
      contextRevision: companionHashV1Schema,
    }).strict(),
    z.object({
      pageKind: z.literal("star_map"),
      sharing: z.enum(["page_registered", "user_selected"]),
      keyPointId: z.string().uuid().optional(),
      contextRevision: companionHashV1Schema,
    }).strict(),
    z.object({
      pageKind: z.literal("learning_session"),
      sharing: z.enum(["page_registered", "user_selected"]),
      sessionId: z.string().uuid(),
      episodeId: z.string().uuid(),
      cardId: z.string().uuid(),
      keyPointId: z.string().uuid(),
      requestedCapability: z.enum(["none", "grounded_tutor"]),
      contextRevision: companionHashV1Schema,
      groundedTutorGrant: z.object({
        grantId: z.string().uuid(),
        permissionSnapshotHash: companionHashV1Schema,
        expiresAt: z.string().datetime(),
      }).strict().nullable(),
    }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  if (value.context.pageKind !== "learning_session") return;
  if ((value.context.requestedCapability === "grounded_tutor") !== (value.context.groundedTutorGrant !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context", "groundedTutorGrant"],
      message: "persisted grant iff grounded_tutor",
    });
  }
});

export type CompanionPersistedPageContextV1 = z.infer<
  typeof companionPersistedPageContextV1Schema
>;

/** 恢复快照（§6.4）：P2–P4 两个学习动作字段为 null；P5 可恢复 durable proposal/run。 */
export const companionConversationSnapshotV1Schema = z.object({
  version: z.literal(1),
  conversation: companionConversationV1Schema,
  activeRun: companionTurnRunV1Schema.nullable(),
  latestEventSeq: z.number().int().nonnegative(),
  // These P5 schemas are declared below; lazy references avoid a module-load
  // temporal-dead-zone while keeping the exported snapshot contract unified.
  pendingProposal: z.lazy(() => pendingLearningActionProposalV1Schema).nullable(),
  activeActionRun: z.lazy(() => companionActionRunV1Schema).nullable(),
}).strict();

export type CompanionConversationSnapshotV1 = z.infer<
  typeof companionConversationSnapshotV1Schema
>;

// ─── Character cue（§4.4，wire 版；区别于 P1 表现层 characterCueV1Schema） ──

export const companionCharacterCueV1Schema = z.object({
  version: z.literal(1),
  intent: z.enum([
    "acknowledge",
    "listen",
    "think",
    "explain",
    "encourage",
    "celebrate",
    "uncertain",
    "warn",
    "sleep",
  ]),
  emotion: z.enum(["neutral", "happy", "curious", "concerned", "surprised"]),
  intensity: z.number().min(0).max(1),
  durationMs: z.number().int().min(100).max(10_000).optional(),
}).strict();

export type CompanionCharacterCueV1 = z.infer<typeof companionCharacterCueV1Schema>;

// ─── P5 Learning action（§4.5）— 供 SSE union 编译；P2/P3 不创建 proposal ──

export const companionActionRunV1Schema = z.object({
  version: z.literal(1),
  actionRunId: z.string().uuid(),
  proposalId: z.string().uuid(),
  status: z.enum(["accepted", "running", "succeeded", "failed", "cancelled"]),
  resultMessageId: z.string().uuid().nullable(),
  resultRef: z.string().min(1).max(240).nullable(),
  route: allowedMainRouteV1Schema.nullable(),
  safeSummary: z.string().min(1).max(240).nullable(),
  errorCode: z.string().min(1).max(80).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

// ─── P5 §4.5 Learning action proposal（第一批冻结） ─────────────────────

/**
 * 方案 16 §18 plan_understanding_route 工具的请求合同（与
 * POST /understanding/routes/plan 的 routePlanBodySchema 同构；共享侧为
 * canonical，projection-routes 从此导入，禁止再本地复制一份）。
 */
export const understandingRoutePlanRequestV1Schema = z.object({
  version: z.literal(1),
  intent: z.enum(["repair_gap", "prepare_review", "explore_neighbors"]),
  targetKeyPointId: z.string().uuid().optional(),
  maxSteps: z.number().int().min(1).max(5),
  lens: z.enum(["current_target", "evidence", "provenance", "issues"]),
  filter: z.object({
    showArchived: z.boolean(),
    sourceId: z.string().uuid().optional(),
    cardId: z.string().uuid().optional(),
    relationKinds: z.array(z.string()).optional(),
  }).passthrough(),
  expectedCheckpointToken: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
});
export type UnderstandingRoutePlanRequestV1 = z.infer<typeof understandingRoutePlanRequestV1Schema>;

/** §18.1 AssistantMemoryItemV1 kind（与 memory-service 一致；22 方案新增 episodic）。 */
export const assistantMemoryKindV1Schema = z.enum([
  "preference",
  "goal",
  "learning_context",
  "interaction_note",
  "episodic",
]);

/** §18.1 defer_review 展示层 reason code（不修改 official dueAt）。 */
export const deferReviewReasonCodeV1Schema = z.enum([
  "user_requested",
  "temporary_unavailable",
]);

export const proposedLearningActionPayloadV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resume_session"), sessionId: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal("start_session"),
    origin: z.enum(["card", "review", "star_map", "now"]),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid(),
  }).strict(),
  z.object({ kind: z.literal("open_review") }).strict(),
  z.object({ kind: z.literal("open_card"), cardId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("open_star_map"), keyPointId: z.string().uuid().optional() }).strict(),
  z.object({
    kind: z.literal("ask_grounded_tutor"),
    sessionId: z.string().uuid(),
    episodeId: z.string().uuid(),
    question: z.string().min(1).max(4_000),
  }).strict(),
  // 方案 16 §18：统一 LearningRun 工具（menu 候选直连 LearningRun API；
  // 同步执行，confirm 后 proposal 直接 succeeded + resultRef=runId）。
  z.object({
    kind: z.literal("start_learning_run"),
    request: createLearningRunRequestSchema,
  }).strict(),
  z.object({
    kind: z.literal("resume_learning_run"),
    runId: z.string().uuid(),
  }).strict(),
  // Plan 23 CS-06：V2 学习运行（originV2 → createRunV2；pet 不自建 origin/参数）。
  z.object({
    kind: z.literal("start_learning_run_v2"),
    request: createLearningRunV2RequestSchema,
  }).strict(),
  // ── 方案 16 §18.1 工具网关（第二批：Orchestrator 动作工具全集） ──
  // 全部为"用户确认后才执行"的业务动作；导航类同步 succeeded，业务类
  // 事务内确定性执行（执行函数见 learning-action-bridge.ts）。
  z.object({
    kind: z.literal("pause_learning_run"),
    runId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("switch_task_variant"),
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    alternativeId: z.string().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal("request_hint_level"),
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }).strict(),
  z.object({
    kind: z.literal("defer_review"),
    scheduleId: z.string().uuid(),
    // 乐观并发：schedule.generation 不匹配 → 409 ACTION_STALE。
    scheduleGeneration: z.number().int().nonnegative(),
    deferredUntil: z.string().datetime(),
    reasonCode: deferReviewReasonCodeV1Schema,
  }).strict(),
  z.object({
    kind: z.literal("plan_understanding_route"),
    request: understandingRoutePlanRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal("focus_graph_node"),
    keyPointId: z.string().uuid(),
    lens: z.enum(["current_target", "evidence", "provenance", "issues"]),
  }).strict(),
  z.object({
    kind: z.literal("restore_graph_viewport"),
    runId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("open_conversation_history"),
    assistantSessionId: z.string().uuid().optional(),
  }).strict(),
  z.object({
    kind: z.literal("propose_memory_candidate"),
    memoryKind: assistantMemoryKindV1Schema,
    value: z.string().min(1).max(4_000),
    sourceMessageId: z.string().uuid(),
  }).strict(),
  z.object({
    // revision = 目标记忆 updatedAt 的 epoch millis（单调 CAS 令牌；
    // 记忆无独立 revision 列，见 assistant-memory 表）。
    kind: z.literal("confirm_or_reject_memory"),
    memoryId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    decision: z.enum(["confirm", "reject"]),
  }).strict(),
  z.object({
    kind: z.literal("delete_assistant_memory"),
    memoryId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  }).strict(),
]);

export const companionActionProposalV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  conversationId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  sourceGeneration: z.number().int().nonnegative(),
  contextGrantId: z.string().uuid().nullable(),
  payload: proposedLearningActionPayloadV1Schema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  requiresConfirmation: z.literal(true),
  status: z.enum(["pending", "rejected", "accepted", "executing", "succeeded", "failed", "expired"]),
  decision: z.enum(["confirm", "reject"]).nullable(),
  actionRunId: z.string().uuid().nullable(),
  expiresAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const pendingLearningActionProposalV1Schema = companionActionProposalV1Schema.extend({
  status: z.literal("pending"),
  decision: z.null(),
  actionRunId: z.null(),
  decidedAt: z.null(),
}).strict();

export const companionProposalSnapshotV1Schema = z.object({
  version: z.literal(1),
  proposal: companionActionProposalV1Schema,
  actionRun: companionActionRunV1Schema.nullable(),
}).strict();

export type CompanionProposalSnapshotV1 = z.infer<typeof companionProposalSnapshotV1Schema>;

export const companionMenuCandidateIdV1Schema = z.enum([
  "resume_current",
  "start_short",
  "learning_run_resume",
  "learning_run_start",
]);

// ─── P5 §6.7 Menu proposal create（只接受 resume/start 两类） ──────────

export const createMenuProposalRequestV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid().optional(),
  clientMessageId: z.string().uuid(),
  candidateId: companionMenuCandidateIdV1Schema,
  expectedContextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSurface: z.enum(["pet", "main", "web_fallback"]),
}).strict();

// ── 方案 16 §18.1：通用工具 proposal 请求（Orchestrator 网关入口） ──
export const createToolProposalRequestV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid().optional(),
  clientMessageId: z.string().uuid(),
  payload: proposedLearningActionPayloadV1Schema,
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  sourceSurface: z.enum(["pet", "main", "web_fallback"]),
}).strict();
export type CreateToolProposalRequestV1 = z.infer<typeof createToolProposalRequestV1Schema>;

export const createMenuProposalResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  proposal: pendingLearningActionProposalV1Schema,
  eventCursor: z.number().int().positive(),
}).strict();
export type CreateMenuProposalResponseV1 = z.infer<typeof createMenuProposalResponseV1Schema>;

// ─── P5 §6.6 Proposal decision（confirm/reject） ────────────────────────

export const proposalDecisionRequestV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  decision: z.enum(["confirm", "reject"]),
  idempotencyKey: z.string().uuid(),
  // §6.6：confirm 必须匹配 payload hash。可选以兼容旧调用方；提供时必须
  // 与服务端冻结的 payload_sha256 精确一致，否则拒绝。
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const proposalDecisionResponseV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  status: z.enum(["rejected", "accepted", "executing", "succeeded", "failed"]),
  actionRunId: z.string().uuid().nullable(),
  resultRef: z.string().min(1).max(240).nullable(),
  // 2026-08-15：服务端 navigationRouteFor 返回 V2 合同（§18 新导航 kind 的
  // lens/restoreRun/assistantSessionId 是 V1 strict 之外的新键）——decision
  // 响应必须用 V2 route schema，否则 focus_graph_node 等确认后客户端
  // parse 502 INVALID_DECISION_RESPONSE。
  route: allowedMainRouteV2Schema.nullable(),
  safeSummary: z.string().min(1).max(240).nullable(),
}).strict();
export type ProposalDecisionResponseV1 = z.infer<typeof proposalDecisionResponseV1Schema>;

// ─── P5 §6.7 Learning menu context（只读） ──────────────────────────────

export const companionLearningContextV1Schema = z.object({
  version: z.literal(1),
  contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  resumeCandidate: z.object({
    candidateId: z.literal("resume_current"),
    title: z.string().min(1).max(80),
    targetSummary: z.string().min(1).max(160),
    impactSummary: z.string().min(1).max(240),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).nullable(),
  startCandidate: z.object({
    candidateId: z.literal("start_short"),
    title: z.string().min(1).max(80),
    targetSummary: z.string().min(1).max(160),
    impactSummary: z.string().min(1).max(240),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).nullable(),
  // 方案 16 §18：统一 LearningRun 菜单候选（learning_run_v1 生产入口）。
  learningRunResumeCandidate: z.object({
    candidateId: z.literal("learning_run_resume"),
    runId: z.string().uuid(),
    title: z.string().min(1).max(80),
    targetSummary: z.string().min(1).max(160),
    impactSummary: z.string().min(1).max(240),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).nullable(),
  learningRunStartCandidate: z.object({
    candidateId: z.literal("learning_run_start"),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid(),
    title: z.string().min(1).max(80),
    targetSummary: z.string().min(1).max(160),
    impactSummary: z.string().min(1).max(240),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    // Plan 23 CS-05/CS-06：V2 字段（可选；兼容 V1 客户端跳过）。
    objectiveId: z.string().uuid().optional(),
    originV2: createLearningRunV2RequestSchema.shape.originV2.optional(),
  }).nullable(),
}).strict();

export type CompanionLearningContextV1 = z.infer<typeof companionLearningContextV1Schema>;

// ─── P5 §6.7 Grounded tutor grant（HMAC 5min TTL） ──────────────────────

export const createCompanionContextGrantRequestV1Schema = z.object({
  version: z.literal(1),
  pageInstanceId: z.string().uuid(),
  episodeId: z.string().uuid(),
  contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/**
 * 当前 Learning Session 的只读 page adapter 快照。
 *
 * `contextRevision` 由服务端根据 session/episode/card/key point 的当前
 * public projection 计算；客户端只能回传它，不能自行构造授权内容。
 */
export const companionLearningSessionContextV1Schema = z.object({
  version: z.literal(1),
  pageKind: z.literal("learning_session"),
  sharing: z.literal("page_registered"),
  sessionId: z.string().uuid(),
  episodeId: z.string().uuid(),
  cardId: z.string().uuid(),
  keyPointId: z.string().uuid(),
  requestedCapability: z.literal("none"),
  contextRevision: companionHashV1Schema,
  groundedTutorGrant: z.null(),
}).strict();

export type CompanionLearningSessionContextV1 = z.infer<
  typeof companionLearningSessionContextV1Schema
>;



// ─── P5 §6.7 Classifier 冻结（companion-action-router-v1，578 bytes） ───

export const COMPANION_ACTION_ROUTER_V1_PROMPT =
  "你是学习伴星的动作意图分类器。只判断用户是否明确请求一个可用动作，不回答问题，不生成任何 ID、参数、路线或解释。\n" +
  "可选 intent 只有：none、resume_current、start_short、open_review、open_current_card、open_star_map、ask_grounded_tutor。\n" +
  "如果用户只是在讨论、提问、假设、否定、引用别人、表达未来可能性，或请求不明确，选择 none。\n" +
  "只有 availableIntents 中为 true 的动作才可选择；否则选择 none。\n" +
  "输出必须严格符合给定 JSON schema，不得添加字段。";
export const COMPANION_ACTION_ROUTER_V1_SHA256 =
  "99122a340328bbf248e3f3e434d27eebd6445226db6c2e0f1bb50543555b0dde";

// ─── P5 §9.4 Router 输出 schema（03 合同冻结；worker classifier 只输出
//      intent/confidence，不输出 payload/ID/route）───────────────────────

export const companionActionIntentV1Schema = z.object({
  version: z.literal(1),
  intent: z.enum([
    "none",
    "resume_current",
    "start_short",
    "open_review",
    "open_current_card",
    "open_star_map",
    "ask_grounded_tutor",
  ]),
  confidence: z.number().min(0).max(1),
}).strict();

export type CompanionActionIntentV1 = z.infer<typeof companionActionIntentV1Schema>;

/** §9.4 classifier 唯一 user message：原始 user text + availableIntents，不传 history。 */
export const companionActionClassifierInputV1Schema = z.object({
  version: z.literal(1),
  userText: z.string().min(1).max(4_000),
  availableIntents: z.object({
    resume_current: z.boolean(),
    start_short: z.boolean(),
    open_review: z.boolean(),
    open_current_card: z.boolean(),
    open_star_map: z.boolean(),
    ask_grounded_tutor: z.boolean(),
  }).strict(),
}).strict();

export type CompanionActionClassifierInputV1 = z.infer<
  typeof companionActionClassifierInputV1Schema
>;

/** §9.4 预检：bounded action lexeme（NFC/trim/lowercase 后匹配）。 */
export const COMPANION_ACTION_LEXEMES = [
  "继续", "恢复", "开始", "打开", "进入", "回到", "带我去", "帮我开始", "帮我继续",
  "continue", "resume", "start", "open", "go to",
] as const;

/** §9.4 参数固定：classifier 用 temperature 0 / maxTokens 80 / json。 */
export const COMPANION_ACTION_ROUTER_OPTIONS = Object.freeze({
  capability: "text_generation",
  temperature: 0,
  maxTokens: 80,
  // 2026-08-12（契约收口）：统一为 ChatOptions 类型允许的字面值 "json_object"
  // （wire 上即 response_format:{type:"json_object"}；文档 §9.4 的 "json" 是
  // JSON 模式语义描述）。此前 worker 本地双份定义用 "json_object"、shared
  // 用 "json"，两处注释互相矛盾——worker 已收口到本常量。
  responseFormat: "json_object",
  promptVersion: "companion-action-router-v1",
} as const);

// ─── P2 §5.2/§6.9 恢复块：错误码 + 16 事件 discriminated union + limits ──

export const companionPublicErrorCodeV1Schema = z.enum([
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONVERSATION_LIMIT_REACHED",
  "IDEMPOTENCY_CONFLICT",
  "RUN_ALREADY_ACTIVE",
  "STALE_GENERATION",
  "CURSOR_EXPIRED",
  "INVALID_CURSOR",
  "RATE_LIMITED",
  // 2026-08-11：SSE 连接数上限（companion-events.ts / account-events.ts 429）
  "TOO_MANY_CONNECTIONS",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "TURN_CANCELLED",
  "VOICE_PERMISSION_DENIED",
  "VOICE_AUDIO_TOO_LARGE",
  "VOICE_UNSUPPORTED_FORMAT",
  "ASR_FAILED",
  "TTS_FAILED",
  "ACTION_CONFIRMATION_REQUIRED",
  "ACTION_EXPIRED",
  "ACTION_STALE",
  // 2026-08-12+（15a-E）：学习快捷方式错误码细分——context 变化/无进行中会话/无候选
  "CONTEXT_STALE",
  "NO_ACTIVE_SESSION",
  "NO_CANDIDATE",
  "PAYLOAD_HASH_MISMATCH",
  "INTERNAL_ERROR",
]);

export const companionErrorV1Schema = z.object({
  version: z.literal(1),
  error: companionPublicErrorCodeV1Schema,
  message: z.string().min(1).max(240),
  recoverable: z.boolean(),
  requestId: z.string().min(1).max(120),
}).strict();

export const COMPANION_P2_LIMITS = Object.freeze({
  composerMaxChars: 4_000,
  serverHardMaxChars: 20_000,
  deltaMaxChars: 2_000,
  blocksPerMessage: 32,
});



// envelope 的 strict：base 字段展开进每个 union 分支，分支整体 .strict()，
// 未知顶层字段被分支拒绝（§5.1 唯一 wire truth）。不能用 z.intersection +
// base.strict()：intersection 的两个 schema 都作用于含 type/payload 的完整对象。
const companionStreamEventBaseShapeV1 = {
  version: z.literal(1),
  eventId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  generation: z.number().int().nonnegative(),
  accountEpoch: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
} as const;

// SSE 的 character.cue 必须与方案 13 §9.6 / 03 §4.4 的高层语义 cue 合同一致
// （intent/emotion 为固定 enum，含 durationMs），不复用 presentation 名。
const characterCuePayloadV1Schema = z.object({
  version: z.literal(1),
  intent: characterCueIntentV1Schema,
  emotion: characterCueEmotionV1Schema,
  intensity: z.number().min(0).max(1),
  durationMs: z.number().int().positive().optional(),
}).strict();

const actionProposedProposalV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  sourceGeneration: z.number().int().nonnegative(),
  kind: proposedLearningActionPayloadV1Schema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  status: z.enum(["pending", "rejected", "accepted", "executing", "succeeded", "failed", "expired"]),
}).strict();

export const companionStreamEventV1Schema = z.discriminatedUnion("type", [
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("turn.accepted"), payload: z.object({
    clientMessageId: z.string().uuid(), userMessageId: z.string().uuid(), status: z.literal("accepted"),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.status"), payload: z.object({
    status: z.enum(["thinking", "acting"]), safeLabel: z.string().min(1).max(240),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.delta"), payload: z.object({
    appendFrom: z.number().int().nonnegative(), textDelta: z.string().min(1).max(2_000),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.final"), payload: z.object({
    messageId: z.string().uuid(), textLength: z.number().int().nonnegative(),
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    messageContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    // 22 方案 §12.3/§14.5/§16.3：本轮真正使用的记忆引用，仅 UI 展示。
    memoryRefs: z.array(z.object({
      memoryId: z.string().uuid(),
      kind: z.string().min(1).max(64),
      content: z.string().min(1).max(80),
    }).strict()).max(3).optional(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("character.cue"), payload: z.object({
    cue: characterCuePayloadV1Schema,
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.proposed"), payload: z.object({
    proposal: actionProposedProposalV1Schema,
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.decision"), payload: z.object({
    proposalId: z.string().uuid(), decision: z.enum(["confirm", "reject"]),
    status: z.enum(["accepted", "rejected"]), actionRunId: z.string().uuid().nullable(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.expired"), payload: z.object({
    proposalId: z.string().uuid(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.started"), payload: z.object({
    proposalId: z.string().uuid(), actionRunId: z.string().uuid(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.completed"), payload: z.object({
    actionRunId: z.string().uuid(), resultRef: z.string().min(1).max(240).nullable(),
    route: allowedMainRouteV1Schema.nullable(), safeSummary: z.string().min(1).max(240),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.failed"), payload: z.object({
    actionRunId: z.string().uuid(), code: z.string().min(1).max(80), recoverable: z.boolean(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("voice.segment.ready"), payload: z.object({
    segmentId: z.string().regex(/^[a-f0-9]{64}$/), ordinal: z.number().int().min(1).max(20),
    text: z.string().min(1).max(160), textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    // 15b 二期：段级情感（段内最后一个控制类标签，如 excited/laughing；无则省略）——live2d 协同预留
    emotion: z.string().min(1).max(64).optional(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("proactive.delivery"), payload: z.object({
    deliveryId: z.string().uuid(), messageId: z.string().uuid(), expiresAt: z.string().datetime(),
    contentPolicy: z.enum(["content", "content_hidden"]),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("proactive.delivery.updated"), payload: z.object({
    deliveryId: z.string().uuid(), status: z.enum(["shown", "suppressed", "dismissed", "expired"]),
    contentClaimed: z.boolean(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("turn.cancelled"), payload: z.object({
    reason: z.enum(["user", "superseded", "shutdown", "timeout"]),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("error"), payload: z.object({
    code: companionPublicErrorCodeV1Schema, recoverable: z.boolean(), requestId: z.string().min(1).max(120).optional(),
  }).strict() }).strict(),
  ]);

export type CompanionStreamEventV1 = z.infer<typeof companionStreamEventV1Schema>;

// ─── P2/P3 恢复：bootstrap + TTS request + 错误码 type ──────────────────

export type CompanionPublicErrorCodeV1 = z.infer<typeof companionPublicErrorCodeV1Schema>;

export const companionTtsRequestV1Schema = z.object({
  version: z.literal(1),
  profileId: z.literal("companion-default-v1"),
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(20),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const companionBootstrapFeaturesV1Schema = z.object({
  // §6.0：petSurface 是能力投影（boolean），不是恒 true 字面量。
  petSurface: z.boolean(),
  textConversation: z.boolean(),
  voiceDialogue: z.boolean(),
  live2d: z.boolean(),
  learningActions: z.boolean(),
  streamingVoice: z.boolean(),
}).strict();

export type CompanionBootstrapFeaturesV1 = z.infer<typeof companionBootstrapFeaturesV1Schema>;

export const companionBootstrapResponseV1Schema = z.object({
  version: z.literal(1),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  account: companionAccountStateV1Schema,
  features: companionBootstrapFeaturesV1Schema,
  serverTime: z.string().datetime(),
}).strict();

// ─── P6 §13 流式 TTS 请求（句子级，每稳定句一条流） ─────────────────────

export const companionTtsStreamRequestV1Schema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(200),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(1).max(160),
  voice: z.string().min(1).max(120).optional(),
  // 2026-08-12（伴星语音设置）：语速（"-30%" | "+0%" | "+30%"）。
  rate: z.string().min(1).max(16).optional(),
  // 15b：TTS 引擎选择（缺省 = config tts.engine；前端通常不传，由服务端决定）。
  engine: z.enum(["qwen", "edge"]).optional(),
}).strict();
