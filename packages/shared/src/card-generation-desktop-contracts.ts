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
  candidateActionV2Schema,
  activationIntentV2Schema,
  cardStrategyV2Schema,
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
]);
export type CardGenerationRecoveryRetryabilityV1 = z.infer<typeof cardGenerationRecoveryRetryabilityV1Schema>;

export const cardGenerationRecoveryActionV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("refresh_status"), runId: uuidSchema }),
  z.strictObject({ kind: z.literal("return_note"), route: z.literal("note.detail"), sourceRef: cardGenerationSourceRefV1Schema }),
  z.strictObject({ kind: z.literal("open_latest_note"), route: z.literal("note.detail"), sourceRef: cardGenerationSourceRefV1Schema }),
  z.strictObject({ kind: z.literal("start_new_generation"), route: z.literal("note.cardGeneration"), sourceRef: cardGenerationSourceRefV1Schema }),
]);
export type CardGenerationRecoveryActionV1 = z.infer<typeof cardGenerationRecoveryActionV1Schema>;

export const cardGenerationRecoveryProjectionV1Schema = z.strictObject({
  version: z.literal(1),
  publicReasonCode: cardGenerationRecoveryReasonCodeV1Schema,
  retryability: cardGenerationRecoveryRetryabilityV1Schema,
  allowedActions: z.array(cardGenerationRecoveryActionV1Schema).max(4),
}).superRefine((value, context) => {
  const actionKinds = new Set(value.allowedActions.map((action) => action.kind));
  if (actionKinds.size !== value.allowedActions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedActions"], message: "recovery actions must be unique" });
  }
  if (value.retryability === "new_run_allowed" && !actionKinds.has("start_new_generation")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedActions"], message: "new_run_allowed requires start_new_generation" });
  }
});
export type CardGenerationRecoveryProjectionV1 = z.infer<typeof cardGenerationRecoveryProjectionV1Schema>;

const cardGenerationRecoveryRunStatuses = new Set(["needs_attention", "failed", "stale"]);

function recoveryMatchesRunStatus(status: z.infer<typeof cardGenerationRunStatusV2Schema>, recovery: CardGenerationRecoveryProjectionV1 | null): boolean {
  return cardGenerationRecoveryRunStatuses.has(status) ? recovery !== null : recovery === null;
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
