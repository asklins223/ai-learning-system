/**
 * Desktop-facing Card Generation adapters.
 *
 * The domain contracts remain the source of truth.  These schemas only make
 * the main-process boundary explicit: server run/candidate views are parsed
 * before projection, private hashes stay main-only, and renderer commands do
 * not carry transport idempotency keys.
 */

import { z } from "zod";
import {
  activateCardCandidatesRequestV2Schema,
  cardGenerationRunStatusV2Schema,
  cardGenerationFeedbackReasonV2Schema,
  cardPlanV2Schema,
  candidateActionCommandV2Schema,
  createCardGenerationRunRequestV2Schema,
  cardActivationReceiptV2Schema,
  revealCandidateRequestV2Schema,
  candidateRevealV2Schema,
  cardRejectReasonV2Schema,
  candidateActionV2Schema,
  activationIntentV2Schema,
  cardStrategyV2Schema,
  cardLearningGoalV2Schema,
  cardDetailThresholdV2Schema,
  teachingTransformationV2Schema,
  knowledgeFormV2Schema,
} from "./card-generation-v2-contracts.ts";

const uuidSchema = z.string().uuid();
const positiveIntSchema = z.number().int().min(1);
const nonNegativeIntSchema = z.number().int().min(0);
const isoTimestampSchema = z.string().datetime({ offset: true });
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const desktopCreateCardGenerationRunRequestV2Schema = createCardGenerationRunRequestV2Schema.superRefine((value, context) => {
  if (value.sourceScope.kind !== "whole_note") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceScope", "kind"],
      message: "Golden Slice only supports whole_note generation",
    });
  }
});
export type DesktopCreateCardGenerationRunRequestV2 = z.infer<typeof desktopCreateCardGenerationRunRequestV2Schema>;

export const desktopCandidateActionCommandV2Schema = candidateActionCommandV2Schema;
export type DesktopCandidateActionCommandV2 = z.infer<typeof desktopCandidateActionCommandV2Schema>;
export const desktopCandidateReviewRequestV2Schema = z.strictObject({
  version: z.literal(2),
  runId: uuidSchema,
  expectedReviewDraftRevision: positiveIntSchema,
  action: candidateActionV2Schema,
});
export type DesktopCandidateReviewRequestV2 = z.infer<typeof desktopCandidateReviewRequestV2Schema>;
export const desktopRevealCandidateRequestV2Schema = revealCandidateRequestV2Schema;
export type DesktopRevealCandidateRequestV2 = z.infer<typeof desktopRevealCandidateRequestV2Schema>;
/**
 * The reveal payload crosses IPC as the domain schema — main adds no projection
 * of its own — so the renderer's type comes from here rather than reaching into
 * the domain contract module directly.
 */
export const desktopCandidateRevealV2Schema = candidateRevealV2Schema;
export type DesktopCandidateRevealV2 = z.infer<typeof desktopCandidateRevealV2Schema>;
/** The reject vocabulary the review UI offers, taken from the action contract. */
export const desktopCardRejectReasonV2Schema = cardRejectReasonV2Schema;
export type DesktopCardRejectReasonV2 = z.infer<typeof desktopCardRejectReasonV2Schema>;
/**
 * The generation knobs the note page lets the writer set. They are the domain
 * enums verbatim: the page sends exactly the values the run contract accepts.
 */
export type DesktopCardLearningGoalV2 = z.infer<typeof cardLearningGoalV2Schema>;
export type DesktopCardDetailThresholdV2 = z.infer<typeof cardDetailThresholdV2Schema>;
export type DesktopCardStrategyV2 = z.infer<typeof cardStrategyV2Schema>;
/** Why the writer is asking for a regeneration; the run contract's own vocabulary. */
export type DesktopCardGenerationFeedbackReasonV2 = z.infer<typeof cardGenerationFeedbackReasonV2Schema>;
export const desktopActivateCardCandidatesRequestV2Schema = activateCardCandidatesRequestV2Schema.pick({
  version: true,
  runId: true,
  selectedCandidates: true,
  existingLifecycleActions: true,
  expectedReviewDraftRevision: true,
  clientReviewHash: true,
}).strict();
export type DesktopActivateCardCandidatesRequestV2 = z.infer<typeof desktopActivateCardCandidatesRequestV2Schema>;

/**
 * Renderer-safe activation selection.  Source/plan/quality closure hashes
 * stay in main; the renderer may only submit the exact public candidate
 * revision it reviewed.  Main re-reads the private closure before POSTing.
 */
export const desktopCardGenerationActivationSelectionV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  selectedCandidates: z.array(z.strictObject({
    candidateRevisionId: uuidSchema,
    candidateId: uuidSchema,
    revision: positiveIntSchema,
    revisionHash: hashSchema,
    candidateEvidenceBindingPlanHash: hashSchema,
    intent: activationIntentV2Schema,
  })).min(1).max(50),
  existingLifecycleActions: z.array(z.strictObject({
    actionId: uuidSchema,
    kind: z.enum(["keep_existing", "archive_existing"]),
    cardId: uuidSchema,
    objectiveId: uuidSchema,
    expectedPublicationRevision: positiveIntSchema,
    expectedObjectiveLifecycleEpoch: positiveIntSchema,
  })).max(50),
  expectedReviewDraftRevision: positiveIntSchema,
}).strict();
export type DesktopCardGenerationActivationSelectionV1 = z.infer<typeof desktopCardGenerationActivationSelectionV1Schema>;

export const cardGenerationJobAcceptedV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  status: cardGenerationRunStatusV2Schema,
});
export type CardGenerationJobAcceptedV1 = z.infer<typeof cardGenerationJobAcceptedV1Schema>;

export const cardGenerationSourceRefV1Schema = z.strictObject({
  noteId: uuidSchema,
  noteVersionId: uuidSchema,
});

export const cardGenerationRecoveryReasonCodeV1Schema = z.enum([
  "provider_unavailable",
  "quality_gate_failed",
  "source_outdated",
  "run_failed",
  "attention_required",
  "unknown",
]);
export type CardGenerationRecoveryReasonCodeV1 = z.infer<typeof cardGenerationRecoveryReasonCodeV1Schema>;

export const cardGenerationRecoveryRetryabilityV1Schema = z.enum([
  "new_run_allowed",
  "not_retryable",
  "resync_required",
  /**
   * 可在**同一条 run 内**重试（2026-09-18）。
   *
   * 与 `new_run_allowed` 的区别是成本与语义：`new_run_allowed` 表示"回笔记重开一次
   * 全新生成"，会重新封存来源、重跑 planner 与全部 critic（实测一次 ≈25–55s + 全额
   * token）；`retry_in_place` 表示服务端可以在**已有 run** 上派发一次重规划
   * （新 plan revision + supersede 旧候选 + 重新 author），复用已封存的来源与输入快照。
   */
  "retry_in_place",
]);
export type CardGenerationRecoveryRetryabilityV1 = z.infer<typeof cardGenerationRecoveryRetryabilityV1Schema>;

export const cardGenerationRecoveryActionV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("refresh_status"), runId: uuidSchema }),
  z.strictObject({ kind: z.literal("return_note"), route: z.literal("note.detail"), sourceRef: cardGenerationSourceRefV1Schema }),
  z.strictObject({ kind: z.literal("open_latest_note"), route: z.literal("note.detail"), sourceRef: cardGenerationSourceRefV1Schema }),
  z.strictObject({ kind: z.literal("start_new_generation"), route: z.literal("note.cardGeneration"), sourceRef: cardGenerationSourceRefV1Schema }),
  /**
   * 在同一 run 内重跑规划与作者（2026-09-18）。
   *
   * 为什么需要它：唯一候选被 critic 否决时，run 会终态化为 `needs_attention`，
   * 而此前恢复契约只签发 `return_note` / `start_new_generation` —— 用户唯一的出路是
   * **重开一次全新生成**（重新封存来源、重跑 planner、重付全部 token），而失败很可能
   * 只是 critic 的一次判断波动。这个动作让"再试一次"变成一次显式、低成本、用户可见的
   * 选择：服务端复用已封存的来源与输入快照，只重新规划与重新作者。
   *
   * 只由服务端在**确有可重试理由**时签发（见 apps/api desktop-projection），
   * 客户端不得自行构造 —— 与既有恢复动作同一纪律。
   */
  z.strictObject({ kind: z.literal("retry_generation"), runId: uuidSchema }),
]);
export type CardGenerationRecoveryActionV1 = z.infer<typeof cardGenerationRecoveryActionV1Schema>;

export const cardGenerationRecoveryProjectionV1Schema = z.strictObject({
  version: z.literal(1),
  publicReasonCode: cardGenerationRecoveryReasonCodeV1Schema,
  retryability: cardGenerationRecoveryRetryabilityV1Schema,
  allowedActions: z.array(cardGenerationRecoveryActionV1Schema).max(5),
}).superRefine((value, context) => {
  const actionKinds = new Set(value.allowedActions.map((action) => action.kind));
  if (actionKinds.size !== value.allowedActions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedActions"], message: "recovery actions must be unique" });
  }
  if (value.retryability === "new_run_allowed" && !actionKinds.has("start_new_generation")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedActions"], message: "new_run_allowed requires start_new_generation" });
  }
  // 对称约束：声明"可就地重试"就必须给出可就地重试的动作，否则用户看到
  // "可以重试"却没有任何按钮，比不给承诺更糟。
  if (value.retryability === "retry_in_place" && !actionKinds.has("retry_generation")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedActions"], message: "retry_in_place requires retry_generation" });
  }
});
export type CardGenerationRecoveryProjectionV1 = z.infer<typeof cardGenerationRecoveryProjectionV1Schema>;

const cardGenerationRecoveryRunStatuses = new Set(["needs_attention", "failed", "stale"]);

function recoveryMatchesRunStatus(status: z.infer<typeof cardGenerationRunStatusV2Schema>, recovery: CardGenerationRecoveryProjectionV1 | null): boolean {
  return cardGenerationRecoveryRunStatuses.has(status) ? recovery !== null : recovery === null;
}

/**
 * 审核是否仍然开放给用户 —— 桌面审核页、API review / activate / close 三处共用
 * 同一个定义的唯一理由：此前客户端把审核动作锁死在 `review_ready`，而服务端
 * 又把 needs_attention 的 run 一并交给审核页（它确实是最活跃的恢复态之一），
 * 两边一叠加，一个「deck gate 失败但仍有候选通过各自门禁」的 run 会拿着可保留
 * 的候选停在页面上，却一个决定按钮都不给，任务就此卡死。
 *
 * `needs_attention` 不是队列的终点：worker 在 deck gate 失败时会保留通过门禁的
 * 候选（quality_state=passed / publish_state=unpublished / review_decision 未决），
 * 并明确要求「用户仍应能保留并启用通过门禁的候选」。真正的门在候选自己身上
 * （qualityState / reviewDecision / publishState），不在 run 状态上再收一道。
 *
 * 参数收 `string` 而非 run status 枚举：两端手里的 run 状态分别来自数据库列与
 * 服务端视图，本来就是裸字符串，让调用方为了一个比较再 parse 一次只会多一处失败点。
 */
export function isCardGenerationReviewOpen(status: string): boolean {
  return status === "review_ready" || status === "needs_attention";
}

/** Main-only view of the server serializer; hashes never cross IPC. */
export const cardGenerationRunServerViewV2Schema = z.strictObject({
  runId: uuidSchema,
  noteId: uuidSchema,
  noteVersionId: uuidSchema,
  status: cardGenerationRunStatusV2Schema,
  cardContentEpoch: positiveIntSchema,
  sourceSnapshotHash: hashSchema,
  semanticSpecHash: hashSchema,
  inputSnapshotHash: hashSchema,
  generationFingerprint: hashSchema,
  currentPlanVersion: nonNegativeIntSchema,
  reviewDraftRevision: positiveIntSchema,
  sourceOutdated: z.boolean(),
  recovery: cardGenerationRecoveryProjectionV1Schema.nullable(),
  error: z.strictObject({
    code: z.string().min(1).max(100),
    message: z.string().max(500).nullable(),
  }).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type CardGenerationRunServerViewV2 = z.infer<typeof cardGenerationRunServerViewV2Schema>;

export const cardGenerationRunSnapshotV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  noteId: uuidSchema,
  noteVersionId: uuidSchema,
  status: cardGenerationRunStatusV2Schema,
  cardContentEpoch: positiveIntSchema,
  currentPlanVersion: nonNegativeIntSchema,
  reviewDraftRevision: positiveIntSchema,
  sourceOutdated: z.boolean(),
  sourceRef: cardGenerationSourceRefV1Schema,
  recovery: cardGenerationRecoveryProjectionV1Schema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).superRefine((value, context) => {
  if (!recoveryMatchesRunStatus(value.status, value.recovery)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recovery"], message: "recovery projection must match run status" });
  }
});
export type CardGenerationRunSnapshotV1 = z.infer<typeof cardGenerationRunSnapshotV1Schema>;

/** Owner-only Room/Desk recovery summary; never includes server-private hashes. */
export const cardGenerationActiveSummaryV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  noteId: uuidSchema,
  noteVersionId: uuidSchema,
  status: cardGenerationRunStatusV2Schema,
  currentPlanVersion: nonNegativeIntSchema,
  reviewDraftRevision: positiveIntSchema,
  updatedAt: isoTimestampSchema,
  recovery: cardGenerationRecoveryProjectionV1Schema.nullable(),
  route: z.strictObject({
    kind: z.literal("note.cardGeneration"),
    cardGenerationRunId: uuidSchema,
  }),
}).superRefine((value, context) => {
  if (!recoveryMatchesRunStatus(value.status, value.recovery)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recovery"], message: "recovery projection must match run status" });
  }
});
export type CardGenerationActiveSummaryV1 = z.infer<typeof cardGenerationActiveSummaryV1Schema>;

export const cardGenerationActiveSummaryListV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(cardGenerationActiveSummaryV1Schema).max(20),
});
export type CardGenerationActiveSummaryListV1 = z.infer<typeof cardGenerationActiveSummaryListV1Schema>;

/**
 * Owner activation preflight for the exact current-user candidate revision.
 * This is a safe projection: it contains no answer, evidence, or hash closure.
 */
export const cardGenerationExposureEligibilityV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  candidateId: uuidSchema,
  candidateRevisionId: uuidSchema,
  revision: positiveIntSchema,
  exposureStatus: z.enum(["not_exposed", "exposed", "unknown"]),
  initialValidationPolicyEffect: z.enum(["eligible", "wait_for_initial_validation", "unknown"]),
  lastExposedAt: isoTimestampSchema.nullable(),
});
export type CardGenerationExposureEligibilityV1 = z.infer<typeof cardGenerationExposureEligibilityV1Schema>;

export const cardGenerationCandidateV1Schema = z.strictObject({
  version: z.literal(1),
  candidateId: uuidSchema,
  candidateRevisionId: uuidSchema,
  revision: positiveIntSchema,
  runId: uuidSchema,
  planRevisionId: uuidSchema,
  planVersion: positiveIntSchema,
  planObjectiveLocalId: z.string().min(1).max(160),
  recommendation: z.strictObject({
    recommended: z.boolean(),
    reasonCodes: z.array(z.string().min(1).max(120)).max(20),
  }),
  objective: z.strictObject({
    statement: z.string().min(1).max(2000),
    publicSummary: z.string().min(1).max(1500),
    knowledgeForm: knowledgeFormV2Schema,
  }),
  front: z.strictObject({
    cue: z.string().min(1).max(2000),
    context: z.string().min(1).max(3000).optional(),
    prompt: z.string().min(1).max(2000),
    mediaRefs: z.array(z.string().min(1).max(200)).max(20).optional(),
  }),
  strategy: cardStrategyV2Schema,
  transformationKind: teachingTransformationV2Schema,
  estimatedReviewSeconds: positiveIntSchema.max(3600),
  evidenceSetHash: hashSchema,
  // Failed/checking candidates can be returned for a needs_attention run, but
  // they do not have an activation binding plan yet. Activation still keeps
  // this field strict in desktopCardGenerationActivationSelectionV1Schema.
  candidateEvidenceBindingPlanHash: hashSchema.nullable(),
  candidateRevisionHash: hashSchema,
  qualityState: z.enum(["authored", "checking", "passed", "failed"]),
  reviewDecision: z.enum(["undecided", "keep", "reject", "merged"]),
  publishState: z.enum(["unpublished", "activating", "activated", "activation_failed", "superseded", "expired"]),
  isReviewReady: z.boolean(),
});
export type CardGenerationCandidateV1 = z.infer<typeof cardGenerationCandidateV1Schema>;

export const cardGenerationCandidateListV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  candidates: z.array(cardGenerationCandidateV1Schema).max(1000),
});
export type CardGenerationCandidateListV1 = z.infer<typeof cardGenerationCandidateListV1Schema>;

export const cardGenerationPlanServerViewV2Schema = cardPlanV2Schema;
export type CardGenerationPlanServerViewV2 = z.infer<typeof cardGenerationPlanServerViewV2Schema>;

export const cardGenerationReviewResultV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  actionType: z.enum(["keep", "reject", "edit", "merge", "undo_decision", "regenerate_candidate", "replan_set"]),
  reviewDraftRevision: positiveIntSchema,
  candidateId: uuidSchema.optional(),
  feedbackReasonCodes: z.array(cardGenerationFeedbackReasonV2Schema).max(8).optional(),
});
export type CardGenerationReviewResultV1 = z.infer<typeof cardGenerationReviewResultV1Schema>;

export const cardGenerationCancelResultV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  status: z.literal("cancelled"),
});
export type CardGenerationCancelResultV1 = z.infer<typeof cardGenerationCancelResultV1Schema>;

/**
 * 就地重试的回执（2026-09-18）。
 *
 * 重试把 run 从 `needs_attention` 推回工作态，因此回执报的是**服务端确认的状态**
 * （当前实现恒为 `checking`），而不是一个乐观推断——客户端据此重新拉取状态即可。
 */
export const cardGenerationRetryResultV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  status: z.literal("checking"),
});
export type CardGenerationRetryResultV1 = z.infer<typeof cardGenerationRetryResultV1Schema>;

export const cardGenerationCloseResultV1Schema = z.strictObject({
  version: z.literal(1),
  runId: uuidSchema,
  status: z.literal("closed_without_activation"),
  reviewDraftRevision: positiveIntSchema,
});
export type CardGenerationCloseResultV1 = z.infer<typeof cardGenerationCloseResultV1Schema>;

export const cardActivationReceiptDesktopV1Schema = z.strictObject({
  version: z.literal(1),
  receiptId: uuidSchema,
  runId: uuidSchema,
  mappings: z.array(z.strictObject({
    candidateRevisionId: uuidSchema,
    cardId: uuidSchema,
    objectiveId: uuidSchema,
    objectiveRevisionId: uuidSchema,
    publicationRevision: positiveIntSchema,
    resultingEvidenceBindingSetHash: hashSchema,
  })).min(1),
  lifecycleResults: z.array(z.strictObject({
    actionId: uuidSchema,
    cardId: uuidSchema,
    objectiveId: uuidSchema,
    resultingLifecycle: z.enum(["active", "archived", "superseded"]),
    resultingLifecycleEpoch: positiveIntSchema,
  })).max(50),
  committedAt: isoTimestampSchema,
});
export type CardActivationReceiptDesktopV1 = z.infer<typeof cardActivationReceiptDesktopV1Schema>;

export function projectCardGenerationRunSnapshotV1(value: CardGenerationRunServerViewV2): CardGenerationRunSnapshotV1 {
  return cardGenerationRunSnapshotV1Schema.parse({
    version: 1,
    runId: value.runId,
    noteId: value.noteId,
    noteVersionId: value.noteVersionId,
    status: value.status,
    cardContentEpoch: value.cardContentEpoch,
    currentPlanVersion: value.currentPlanVersion,
    reviewDraftRevision: value.reviewDraftRevision,
    sourceOutdated: value.sourceOutdated,
    sourceRef: { noteId: value.noteId, noteVersionId: value.noteVersionId },
    recovery: value.recovery,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

export function projectCardActivationReceiptV1(value: z.infer<typeof cardActivationReceiptV2Schema>): CardActivationReceiptDesktopV1 {
  return cardActivationReceiptDesktopV1Schema.parse({
    version: 1,
    receiptId: value.receiptId,
    runId: value.runId,
    mappings: value.mappings.map((mapping) => ({
      candidateRevisionId: mapping.candidateRevisionId,
      cardId: mapping.cardId,
      objectiveId: mapping.objectiveId,
      objectiveRevisionId: mapping.objectiveRevisionId,
      publicationRevision: mapping.publicationRevision,
      resultingEvidenceBindingSetHash: mapping.resultingEvidenceBindingSetHash,
    })),
    lifecycleResults: value.lifecycleResults.map((result) => ({
      actionId: result.actionId,
      cardId: result.cardId,
      objectiveId: result.objectiveId,
      resultingLifecycle: result.resultingLifecycle,
      resultingLifecycleEpoch: result.resultingLifecycleEpoch,
    })),
    committedAt: value.committedAt,
  });
}
