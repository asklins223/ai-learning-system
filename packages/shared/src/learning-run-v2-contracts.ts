/**
 * Golden Slice Member LearningRun V2 outer wire.
 *
 * This module is the public boundary adapter around the existing V1 task,
 * draft and artifact unions. The outer run, result and return contracts are
 * version 2 and always bind the same runId, snapshotId and originV2. A V1
 * public run/result/return payload is never accepted as a V2 payload.
 */

import { z } from "zod";
import {
  artifactPayloadSchema,
  learningDraftPayloadSchema,
  learningRendererDraftStateSchema,
  learningRunActionSchema,
  learningRunOutcomeSchema,
  learningRunProjectionSchema,
  learningRunScheduleImpactSchema,
  learningTaskPublicSchema,
  projectionCheckpointSchema,
  taskIntentSchema,
} from "./learning-run-contracts.ts";
import {
  learningRunOriginV2Schema,
  learningRunReturnTargetV2Schema,
  learningRunTargetPublicV2Schema,
} from "./learning-target-v2-contracts.ts";

const v2Base = {
  version: z.literal(2),
  runId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  originV2: learningRunOriginV2Schema,
};

export const learningRunPhaseV2Schema = z.enum([
  "preparing",
  "active",
  "assessing",
  "checkpoint",
  "committing",
  "paused",
  "completed",
  "ended",
  "skipped",
  "cancelled",
  "stale",
  "recoverable_error",
]);
export type LearningRunPhaseV2 = z.infer<typeof learningRunPhaseV2Schema>;

/** Server-authorized action descriptors; renderer never infers these from phase. */
export const learningRunAllowedActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(2), kind: z.literal("pause") }),
  z.strictObject({ version: z.literal(2), kind: z.literal("resume") }),
  z.strictObject({ version: z.literal(2), kind: z.literal("switch_variant"), alternativeId: z.string().min(1).max(200) }),
  z.strictObject({ version: z.literal(2), kind: z.literal("request_hint"), level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
  z.strictObject({ version: z.literal(2), kind: z.literal("skip_task"), taskId: z.string().uuid(), confirmationRequired: z.literal(true) }),
  z.strictObject({ version: z.literal(2), kind: z.literal("skip_run"), confirmationRequired: z.literal(true) }),
  z.strictObject({ version: z.literal(2), kind: z.literal("activate_followup"), followupId: z.string().min(1).max(200) }),
  z.strictObject({ version: z.literal(2), kind: z.literal("finish_current_evidence") }),
  z.strictObject({ version: z.literal(2), kind: z.literal("finish_without_commit") }),
  z.strictObject({ version: z.literal(2), kind: z.literal("retry_prepare") }),
  z.strictObject({ version: z.literal(2), kind: z.literal("retry_assessment"), assessmentId: z.string().uuid() }),
  z.strictObject({ version: z.literal(2), kind: z.literal("retry_commit") }),
  z.strictObject({
    version: z.literal(2),
    kind: z.literal("end"),
    abandonLockedEvidence: z.boolean(),
    confirmationRequired: z.literal(true),
  }),
]);
export type LearningRunAllowedActionV2 = z.infer<typeof learningRunAllowedActionSchema>;

export const learningRunPublicSnapshotV2Schema = z
  .strictObject({
    ...v2Base,
    target: learningRunTargetPublicV2Schema,
    returnTargetV2: learningRunReturnTargetV2Schema,
    phase: learningRunPhaseV2Schema,
    runRevision: z.number().int().min(1),
    runtimeEpoch: z.number().int().min(0),
    /** Server-authoritative active time; the renderer never derives or counts it locally. */
    activeSecondsUsed: z.number().int().min(0).max(180),
    /** Frozen budget selected when the run was created; progress must use this value. */
    timeBudgetSeconds: z.number().int().min(30).max(180),
    activeTask: learningTaskPublicSchema.nullable(),
    allowedActions: z.array(learningRunAllowedActionSchema).max(32),
    publishedTargetEligibility: z.enum(["eligible", "practice_only", "blocked"]),
  })
  .superRefine((value, context) => {
    if (value.activeTask && value.activeTask.runId !== value.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["activeTask", "runId"], message: "active task is not bound to run" });
    }
    if (new Set(value.allowedActions.map((action) => JSON.stringify(action))).size !== value.allowedActions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedActions"], message: "duplicate allowed action" });
    }
  });
export type LearningRunPublicSnapshotV2 = z.infer<typeof learningRunPublicSnapshotV2Schema>;

export const putLearningTaskDraftRequestV2Schema = z
  .strictObject({
    version: z.literal(2),
    snapshotId: z.string().uuid(),
    variantId: z.string().min(1).max(200),
    variantRevision: z.number().int().min(1),
    taskRevision: z.number().int().min(1),
    expectedDraftRevision: z.number().int().min(0).nullable(),
    payload: learningDraftPayloadSchema.nullable(),
    rendererState: learningRendererDraftStateSchema,
    idempotencyKey: z.string().min(1).max(200),
  });
export type PutLearningTaskDraftRequestV2 = z.infer<typeof putLearningTaskDraftRequestV2Schema>;

export const learningTaskDraftV2Schema = z.strictObject({
  version: z.literal(2),
  runId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  taskId: z.string().uuid(),
  variantId: z.string().min(1).max(200),
  taskRevision: z.number().int().min(1),
  draftRevision: z.number().int().min(0),
  payload: learningDraftPayloadSchema.nullable(),
  rendererState: learningRendererDraftStateSchema,
  savedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});
export type LearningTaskDraftV2 = z.infer<typeof learningTaskDraftV2Schema>;

export const learningTaskDraftWriteReceiptV2Schema = z.strictObject({
  version: z.literal(2),
  runId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  taskId: z.string().uuid(),
  variantId: z.string().min(1).max(200),
  runRevision: z.number().int().min(1),
  taskRevision: z.number().int().min(1),
  draftRevision: z.number().int().min(0),
  savedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});
export type LearningTaskDraftWriteReceiptV2 = z.infer<typeof learningTaskDraftWriteReceiptV2Schema>;

export const submitTaskArtifactV2Schema = z.strictObject({
  version: z.literal(2),
  snapshotId: z.string().uuid(),
  variantId: z.string().min(1).max(200),
  variantRevision: z.number().int().min(1),
  runRevision: z.number().int().min(1),
  taskRevision: z.number().int().min(1),
  inputSchemaHash: z.string().min(1).max(200),
  payload: artifactPayloadSchema,
  baseArtifactId: z.string().uuid().optional(),
  baseRevision: z.number().int().min(0).optional(),
  idempotencyKey: z.string().min(1).max(200),
});
export type SubmitTaskArtifactV2 = z.infer<typeof submitTaskArtifactV2Schema>;

export const submitTaskArtifactReceiptV2Schema = z.strictObject({
  version: z.literal(2),
  runId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  taskId: z.string().uuid(),
  artifactId: z.string().uuid(),
  artifactRevision: z.number().int().min(1),
  artifactStatus: z.literal("locked"),
  assessment: z.strictObject({ assessmentId: z.string().uuid(), status: z.literal("queued") }),
  runRevision: z.number().int().min(1),
  taskRevision: z.number().int().min(1),
  eventCursor: z.number().int().min(0),
});
export type SubmitTaskArtifactReceiptV2 = z.infer<typeof submitTaskArtifactReceiptV2Schema>;

export const learningRunActionRequestV2Schema = z.strictObject({
  version: z.literal(2),
  snapshotId: z.string().uuid(),
  runRevision: z.number().int().min(1),
  taskRevision: z.number().int().min(1).optional(),
  runtimeEpoch: z.number().int().min(0),
  action: learningRunActionSchema,
  idempotencyKey: z.string().min(1).max(200),
});
export type LearningRunActionRequestV2 = z.infer<typeof learningRunActionRequestV2Schema>;

const learningRunActionResultV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("state_changed") }),
  z.strictObject({
    kind: z.literal("hint_revealed"),
    hintId: z.string().min(1),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string().min(1),
    exposureEventId: z.string().min(1),
    resultingTrustCeiling: z.literal("practice_only"),
  }),
  z.strictObject({ kind: z.literal("variant_switched"), previousVariantId: z.string().min(1), activeVariantId: z.string().min(1) }),
]);

export const learningRunActionResponseV2Schema = z.strictObject({
  ...v2Base,
  acceptedActionId: z.string().min(1),
  actionResult: learningRunActionResultV2Schema,
  snapshot: learningRunPublicSnapshotV2Schema,
}).superRefine((value, context) => {
  if (
    value.snapshot.runId !== value.runId
    || value.snapshot.snapshotId !== value.snapshotId
    || JSON.stringify(value.snapshot.originV2) !== JSON.stringify(value.originV2)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshot"], message: "nested snapshot binding does not match action response" });
  }
});
export type LearningRunActionResponseV2 = z.infer<typeof learningRunActionResponseV2Schema>;

export const recordLearningRunActivityLeaseRequestV2Schema = z.strictObject({
  version: z.literal(2),
  snapshotId: z.string().uuid(),
  runRevision: z.number().int().min(1),
  runtimeEpoch: z.number().int().min(0),
  deviceSessionId: z.string().min(1).max(200),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
});
export type RecordLearningRunActivityLeaseRequestV2 = z.infer<typeof recordLearningRunActivityLeaseRequestV2Schema>;

const learningRunResultCoreV2Schema = z.strictObject({
  outcome: learningRunOutcomeSchema,
  demonstratedFacets: z.array(taskIntentSchema),
  gapFacets: z.array(taskIntentSchema),
  scheduleImpact: learningRunScheduleImpactSchema,
  returnTargetV2: learningRunReturnTargetV2Schema,
  projection: learningRunProjectionSchema.optional(),
});

export const learningRunResultV2Schema = z.strictObject({
  ...v2Base,
  ...learningRunResultCoreV2Schema.shape,
});
export type LearningRunResultV2 = z.infer<typeof learningRunResultV2Schema>;

const resultResponseBaseV2 = {
  ...v2Base,
  returnTargetV2: learningRunReturnTargetV2Schema,
};

export const getLearningRunResultResponseV2Schema = z.discriminatedUnion("status", [
  z.strictObject({
    ...resultResponseBaseV2,
    status: z.literal("pending"),
    httpStatus: z.literal(202),
    phase: learningRunPhaseV2Schema,
    runRevision: z.number().int().min(1),
  }),
  z.strictObject({
    ...resultResponseBaseV2,
    status: z.literal("learning_result"),
    httpStatus: z.literal(200),
    result: learningRunResultV2Schema,
  }),
  z.strictObject({
    ...resultResponseBaseV2,
    status: z.literal("terminal_without_result"),
    httpStatus: z.literal(200),
    phase: z.enum(["ended", "cancelled", "stale"]),
    reasonCode: z.enum(["user_ended", "runtime_cancelled", "target_fingerprint_changed", "schedule_generation_changed", "permission_revoked"]),
  }),
]).superRefine((value, context) => {
  if (value.status !== "learning_result") return;
  if (
    value.result.runId !== value.runId
    || value.result.snapshotId !== value.snapshotId
    || JSON.stringify(value.result.originV2) !== JSON.stringify(value.originV2)
    || JSON.stringify(value.result.returnTargetV2) !== JSON.stringify(value.returnTargetV2)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["result"], message: "nested result binding does not match response" });
  }
});
export type GetLearningRunResultResponseV2 = z.infer<typeof getLearningRunResultResponseV2Schema>;

const returnContractBaseV2 = {
  ...v2Base,
  returnTargetV2: learningRunReturnTargetV2Schema,
};
const changedSourceV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("canonical"), canonicalEventId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("practice_only"), practiceEventId: z.string().min(1) }),
]);

export const learningRunReturnContractV2Schema = z.discriminatedUnion("status", [
  z.strictObject({
    ...returnContractBaseV2,
    status: z.literal("run_active"),
    runPhase: z.enum(["preparing", "active", "assessing", "checkpoint", "committing", "paused", "recoverable_error"]),
  }),
  z.strictObject({
    ...returnContractBaseV2,
    status: z.literal("no_projection_change"),
    sourceChange: z.strictObject({ kind: z.literal("none") }),
  }),
  z.strictObject({
    ...returnContractBaseV2,
    status: z.literal("projection_pending"),
    sourceChange: changedSourceV2Schema,
    currentCheckpoint: projectionCheckpointSchema,
    retryAfterMs: z.number().int().min(0),
  }),
  z.strictObject({
    ...returnContractBaseV2,
    status: z.literal("ready"),
    sourceChange: changedSourceV2Schema,
    targetCheckpoint: projectionCheckpointSchema,
    changeSetId: z.string().min(1),
  }),
  z.strictObject({
    ...returnContractBaseV2,
    status: z.literal("unavailable"),
    reason: z.enum(["run_not_found", "return_target_deleted", "permission_revoked", "projection_failed"]),
    fallbackTargetV2: learningRunReturnTargetV2Schema.nullable(),
  }),
]);
export type LearningRunReturnContractV2 = z.infer<typeof learningRunReturnContractV2Schema>;

/** Main-only; intentionally excludes result, checkpoint and fallback payloads. */
export const pendingReturnMarkerV2Schema = z.strictObject({
  version: z.literal(2),
  runId: z.string().uuid(),
  originV2: learningRunOriginV2Schema,
  checkedAt: z.string().datetime({ offset: true }),
});
export type PendingReturnMarkerV2 = z.infer<typeof pendingReturnMarkerV2Schema>;
