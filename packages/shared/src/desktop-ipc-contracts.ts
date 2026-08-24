/**
 * Electron desktop boundary contracts for the first Golden Slice.
 *
 * This module intentionally contains only renderer-safe, M1 boundary data.
 * It must not import server-only modules or expose credentials, raw URLs, or
 * domain-private LearningRun/Card Generation payloads.
 */

import { z } from "zod";
import {
  CAPABILITY_IDS,
  capabilityIdSchema,
  type CapabilityId,
} from "./capability-bundle.ts";
import {
  learningRunOriginSchema,
  learningRunReturnTargetSchema,
} from "./learning-run-contracts.ts";
import {
  createLearningRunV2RequestSchema,
} from "./learning-target-v2-contracts.ts";
import {
  learningRunActionRequestV2Schema,
  learningRunActionResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  learningRunReturnContractV2Schema,
  getLearningRunResultResponseV2Schema,
  learningTaskDraftV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  putLearningTaskDraftRequestV2Schema,
  submitTaskArtifactReceiptV2Schema,
  submitTaskArtifactV2Schema,
  recordLearningRunActivityLeaseRequestV2Schema,
} from "./learning-run-v2-contracts.ts";
import { reviewQueueV2Schema } from "./review-queue-v2-contracts.ts";
import { roomProjectionV1Schema } from "./room-projection-contracts.ts";
import { noteDetailV1Schema } from "./note-projection-contracts.ts";
import { noteSaveReceiptV1Schema, noteSaveRequestV1Schema } from "./note-save-contracts.ts";
import {
  cardActivationReceiptDesktopV1Schema,
  cardGenerationCandidateListV1Schema,
  cardGenerationCloseResultV1Schema,
  cardGenerationJobAcceptedV1Schema,
  cardGenerationReviewResultV1Schema,
  cardGenerationRunSnapshotV1Schema,
} from "./card-generation-desktop-contracts.ts";
import { candidateRevealV2Schema } from "./card-generation-v2-contracts.ts";
import type {
  DesktopCardGenerationActivationSelectionV1,
  DesktopCandidateReviewRequestV2,
  DesktopCreateCardGenerationRunRequestV2,
  DesktopRevealCandidateRequestV2,
} from "./card-generation-desktop-contracts.ts";

export {
  desktopActivateCardCandidatesRequestV2Schema,
  desktopCardGenerationActivationSelectionV1Schema,
  desktopCandidateReviewRequestV2Schema,
  desktopCreateCardGenerationRunRequestV2Schema,
  desktopRevealCandidateRequestV2Schema,
} from "./card-generation-desktop-contracts.ts";
export type {
  DesktopActivateCardCandidatesRequestV2,
  DesktopCardGenerationActivationSelectionV1,
  DesktopCandidateReviewRequestV2,
  DesktopCreateCardGenerationRunRequestV2,
  DesktopRevealCandidateRequestV2,
} from "./card-generation-desktop-contracts.ts";

export const DESKTOP_IPC_CONTRACT_VERSION = "desktop-ipc-v1" as const;
export const DESKTOP_IPC_SCHEMA_REVISION = "desktop-ipc-m2-2026-08-23" as const;
export const DESKTOP_API_SERVICE_ID = "ailearn-api" as const;
export const LEARNING_ROOM_ASSET_BASE_PATH = "/assets/learning-room/v1" as const;

export const DESKTOP_IPC_CHANNELS = {
  contractGetSnapshot: "ailearn.v1.contract.getSnapshot",
  runtimeGetSnapshot: "ailearn.v1.runtime.getSnapshot",
  runtimeRetryApiConnection: "ailearn.v1.runtime.retryApiConnection",
  runtimeGetHealth: "ailearn.v1.runtime.getHealth",
  runtimeCancel: "ailearn.v1.runtime.cancel",
  navigationResolve: "ailearn.v1.navigation.resolve",
  navigationGo: "ailearn.v1.navigation.go",
  navigationBack: "ailearn.v1.navigation.back",
  navigationRestore: "ailearn.v1.navigation.restore",
  authGetState: "ailearn.v1.auth.getState",
  authLogin: "ailearn.v1.auth.login",
  authRegister: "ailearn.v1.auth.register",
  authLogout: "ailearn.v1.auth.logout",
  authReauthenticate: "ailearn.v1.auth.reauthenticate",
  authChangePassword: "ailearn.v1.auth.changePassword",
  workspaceList: "ailearn.v1.workspace.list",
  workspaceSwitch: "ailearn.v1.workspace.switch",
  workspaceGetCurrent: "ailearn.v1.workspace.getCurrent",
  capabilitiesGet: "ailearn.v1.capabilities.get",
  windowGetState: "ailearn.v1.window.getState",
  windowSetTitlebarTheme: "ailearn.v1.window.setTitlebarTheme",
  windowFocus: "ailearn.v1.window.focus",
  subscriptionsSubscribe: "ailearn.v1.subscriptions.subscribe",
  subscriptionsEvent: "ailearn.v1.subscriptions.event",
  subscriptionsUnsubscribe: "ailearn.v1.subscriptions.unsubscribe",
  roomGetProjection: "ailearn.v1.room.getProjection",
  noteGet: "ailearn.v1.note.get",
  noteSave: "ailearn.v1.note.save",
  noteCardGenerationStart: "ailearn.v1.note.cardGeneration.start",
  noteCardGenerationGetRun: "ailearn.v1.note.cardGeneration.getRun",
  noteCardGenerationGetCandidates: "ailearn.v1.note.cardGeneration.getCandidates",
  noteCardGenerationReview: "ailearn.v1.note.cardGeneration.review",
  noteCardGenerationReveal: "ailearn.v1.note.cardGeneration.reveal",
  noteCardGenerationActivate: "ailearn.v1.note.cardGeneration.activate",
  noteCardGenerationCancel: "ailearn.v1.note.cardGeneration.cancel",
  noteCardGenerationClose: "ailearn.v1.note.cardGeneration.close",
  reviewGetQueue: "ailearn.v1.review.getQueue",
  learningRunGet: "ailearn.v1.learningRun.get",
  learningRunStart: "ailearn.v1.learningRun.start",
  learningRunGetDraft: "ailearn.v1.learningRun.getDraft",
  learningRunSaveDraft: "ailearn.v1.learningRun.saveDraft",
  learningRunSubmit: "ailearn.v1.learningRun.submit",
  learningRunAction: "ailearn.v1.learningRun.action",
  learningRunGetResult: "ailearn.v1.learningRun.getResult",
  learningRunGetReturnContract: "ailearn.v1.learningRun.getReturnContract",
  learningRunRecordActivityLease: "ailearn.v1.learningRun.recordActivityLease",
  learningRunAbandon: "ailearn.v1.learningRun.abandon",
} as const;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const uuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof uuidSchema>;

export const uuidV4Schema = uuidSchema.refine(
  (value) => value[14] === "4" && /[89ab]/i.test(value[19] ?? ""),
  "expected UUID v4",
);

export const nonEmptyStringSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "control characters are not allowed");

export const opaqueIdSchema = z
  .string()
  .regex(OPAQUE_ID_PATTERN, "invalid opaque id");
export const requestIdSchema = opaqueIdSchema;
export const correlationIdSchema = opaqueIdSchema;
export const commandIdSchema = opaqueIdSchema;
export const subscriptionIdSchema = opaqueIdSchema;
export const cursorSchema = opaqueIdSchema;
export const domainIdempotencyKeySchema = opaqueIdSchema;

export const positiveIntSchema = z.number().int().min(1);
export const nonNegativeIntSchema = z.number().int().min(0);
export const isoTimestampSchema = z.string().datetime({ offset: true });
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320);
export const secretInputSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "control characters are not allowed");

function isLiteralLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.port !== "" &&
      Number(url.port) >= 1 &&
      Number(url.port) <= 65535
    );
  } catch {
    return false;
  }
}

function isExactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      !url.hostname.includes("*")
    );
  } catch {
    return false;
  }
}

export const literalLoopbackOriginSchema = z
  .string()
  .refine(isLiteralLoopbackOrigin, "expected http://127.0.0.1:<port>");
export const exactHttpsOriginSchema = z
  .string()
  .refine(isExactHttpsOrigin, "expected an exact https origin");

export const staticAssetPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "invalid relative asset path")
  .refine(
    (value) => value.split("/").every((segment) => segment !== "." && segment !== ".."),
    "path traversal is not allowed",
  );
export type StaticAssetPathV1 = z.infer<typeof staticAssetPathSchema>;

export const desktopNamespaceValues = [
  "runtime",
  "navigation",
  "auth",
  "workspace",
  "capabilities",
  "room",
  "source",
  "note",
  "objective",
  "review",
  "learningRun",
  "understanding",
  "search",
  "companion",
  "settings",
  "window",
  "subscriptions",
] as const;
export const desktopNamespaceSchema = z.enum(desktopNamespaceValues);
export type DesktopNamespaceV1 = (typeof desktopNamespaceValues)[number];

export const desktopNamespaceM1Values = [
  "runtime",
  "navigation",
  "auth",
  "workspace",
  "capabilities",
  "window",
  "subscriptions",
] as const;
export const desktopNamespaceM1Schema = z.enum(desktopNamespaceM1Values);
export type DesktopNamespaceM1 = (typeof desktopNamespaceM1Values)[number];

export const desktopRouteKindValues = [
  "auth.login",
  "auth.register",
  "room.home",
  "objective.library",
  "objective.detail",
  "source.library",
  "source.detail",
  "note.library",
  "note.detail",
  "note.cardGeneration",
  "review.queue",
  "learningRun.detail",
  "understanding.graph",
  "search.global",
  "settings.section",
  "companion.drawer",
] as const;
export const desktopRouteKindSchema = z.enum(desktopRouteKindValues);
export type DesktopRouteKindV1 = (typeof desktopRouteKindValues)[number];

export const desktopRouteKindM1Values = ["auth.login", "auth.register"] as const;
export const desktopRouteKindM1Schema = z.enum(desktopRouteKindM1Values);
export type DesktopRouteKindM1 = (typeof desktopRouteKindM1Values)[number];

export const desktopNamespaceM2Values = [...desktopNamespaceM1Values, "room", "note", "review", "learningRun"] as const;
export const desktopNamespaceM2Schema = z.enum(desktopNamespaceM2Values);
export type DesktopNamespaceM2 = (typeof desktopNamespaceM2Values)[number];
export const desktopRouteKindM2Values = [...desktopRouteKindM1Values, "room.home", "note.detail", "note.cardGeneration", "review.queue", "learningRun.detail"] as const;
export const desktopRouteKindM2Schema = z.enum(desktopRouteKindM2Values);
export type DesktopRouteKindM2 = (typeof desktopRouteKindM2Values)[number];

export const navigationReasonSchema = z.enum([
  "startup",
  "user",
  "deep_link",
  "notification",
  "compat",
  "restore",
]);
export type NavigationReasonV1 = z.infer<typeof navigationReasonSchema>;

const gateRouteSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("auth.login") }),
  z.strictObject({ kind: z.literal("auth.register") }),
]);

const workspaceRouteSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("room.home") }),
  z.strictObject({ kind: z.literal("objective.library") }),
  z.strictObject({ kind: z.literal("objective.detail"), objectiveId: uuidSchema }),
  z.strictObject({ kind: z.literal("source.library") }),
  z.strictObject({ kind: z.literal("source.detail"), sourceId: uuidSchema }),
  z.strictObject({ kind: z.literal("note.library") }),
  z.strictObject({ kind: z.literal("note.detail"), noteId: uuidSchema }),
  z.strictObject({
    kind: z.literal("note.cardGeneration"),
    cardGenerationRunId: uuidSchema,
  }),
  z.strictObject({ kind: z.literal("review.queue") }),
  z.strictObject({ kind: z.literal("learningRun.detail"), runId: uuidSchema }),
  z.strictObject({
    kind: z.literal("understanding.graph"),
    objectiveId: uuidSchema.optional(),
    lens: z.enum(["current_target", "evidence", "provenance", "issues"]).optional(),
  }),
  z.strictObject({ kind: z.literal("search.global") }),
  z.strictObject({ kind: z.literal("settings.section"), section: nonEmptyStringSchema }),
  z.strictObject({ kind: z.literal("companion.drawer"), focus: nonEmptyStringSchema.optional() }),
]);

export const desktopRouteSchema = z.union([gateRouteSchema, workspaceRouteSchema]);
export type DesktopRouteV1 = z.infer<typeof desktopRouteSchema>;

export const safeInviteHintSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("pending_invite"),
});
export type SafeInviteHintV1 = z.infer<typeof safeInviteHintSchema>;

export const safeReturnTargetSchema = z.union([
  z.strictObject({ version: z.literal(1), kind: z.literal("room.home"), workspaceId: uuidSchema.optional() }),
  z.strictObject({ version: z.literal(1), kind: z.literal("note.detail"), noteId: uuidSchema, workspaceId: uuidSchema.optional() }),
  z.strictObject({ version: z.literal(1), kind: z.literal("note.cardGeneration"), cardGenerationRunId: uuidSchema, workspaceId: uuidSchema.optional() }),
  z.strictObject({ version: z.literal(1), kind: z.literal("learningRun.detail"), runId: uuidSchema, workspaceId: uuidSchema.optional() }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("understanding.graph"),
    objectiveId: uuidSchema.optional(),
    lens: z.enum(["current_target", "evidence", "provenance", "issues"]).optional(),
    workspaceId: uuidSchema.optional(),
  }),
]);
export type SafeReturnTargetV1 = z.infer<typeof safeReturnTargetSchema>;

export const legacyRouteSchema = z.union([
  z.strictObject({ kind: z.literal("learning-card"), cardId: uuidSchema }),
  z.strictObject({ kind: z.literal("learning-objective"), objectiveId: uuidSchema }),
  z.strictObject({ kind: z.literal("learning-run"), runId: uuidSchema }),
  z.strictObject({ kind: z.literal("note-card-generation"), noteId: uuidSchema }),
]);
export type LegacyRouteV1 = z.infer<typeof legacyRouteSchema>;

export const pendingNavigationIntentSchema = z.strictObject({
  version: z.literal(1),
  targetWorkspaceId: uuidSchema,
  route: desktopRouteSchema,
  source: z.literal("deep_link"),
  receivedAt: isoTimestampSchema,
});
export type PendingNavigationIntentV1 = z.infer<typeof pendingNavigationIntentSchema>;

export const navigationEntrySchema = z.union([
  z.strictObject({
    version: z.literal(1),
    scope: z.literal("gate"),
    historyKey: nonEmptyStringSchema,
    route: gateRouteSchema,
    entryKind: navigationReasonSchema,
    correlationId: correlationIdSchema,
    sanitizedPendingIntent: pendingNavigationIntentSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    scope: z.literal("workspace"),
    historyKey: nonEmptyStringSchema,
    workspaceId: uuidSchema,
    workspaceEpoch: positiveIntSchema,
    route: workspaceRouteSchema,
    level: z.enum(["L0", "L1", "L2", "tool"]),
    entryKind: navigationReasonSchema,
    navigationOrigin: nonEmptyStringSchema,
    focusReturnKey: nonEmptyStringSchema,
    viewportRestoreRef: nonEmptyStringSchema.optional(),
    correlationId: correlationIdSchema,
  }),
]);
export type NavigationEntryV1 = z.infer<typeof navigationEntrySchema>;

export const desktopContractSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    contractVersion: z.literal(DESKTOP_IPC_CONTRACT_VERSION),
    domainSchemaRevision: nonEmptyStringSchema,
    deploymentConfigRevision: nonEmptyStringSchema,
    namespaces: z.array(desktopNamespaceSchema).min(1).max(desktopNamespaceValues.length),
    enabledRoutes: z.array(desktopRouteKindSchema).max(desktopRouteKindValues.length),
  })
  .superRefine((value, context) => {
    const namespaces = new Set(value.namespaces);
    if (namespaces.size !== value.namespaces.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["namespaces"], message: "duplicate namespace" });
    }
    const routes = new Set(value.enabledRoutes);
    if (routes.size !== value.enabledRoutes.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledRoutes"], message: "duplicate route" });
    }
    for (const route of value.enabledRoutes) {
      const namespace = route.split(".")[0];
      if (!namespace || !namespaces.has(namespace as DesktopNamespaceV1)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledRoutes"], message: `route namespace is not enabled: ${route}` });
      }
    }
  });
export type DesktopContractSnapshotV1 = z.infer<typeof desktopContractSnapshotSchema>;

export const requestMetaSchema = z.strictObject({
  version: z.literal(1),
  contractVersion: z.literal(DESKTOP_IPC_CONTRACT_VERSION),
  requestId: requestIdSchema,
  correlationId: correlationIdSchema,
  workspaceEpoch: positiveIntSchema.optional(),
  clientStartedAt: isoTimestampSchema,
});
export type RequestMetaV1 = z.infer<typeof requestMetaSchema>;

export const commandMetaSchema = z.strictObject({
  version: z.literal(1),
  commandId: commandIdSchema,
  idempotencyKey: domainIdempotencyKeySchema.optional(),
});
export type CommandMetaV1 = z.infer<typeof commandMetaSchema>;

export const gatewayErrorCodeValues = [
  "invalid_request",
  "invalid_navigation",
  "route_not_available",
  "configuration_error",
  "api_unavailable",
  "api_untrusted",
  "unsupported_contract",
  "auth_required",
  "invalid_credentials",
  "reauth_required",
  "forbidden",
  "feature_disabled",
  "not_found",
  "validation",
  "conflict",
  "rate_limited",
  "network_timeout",
  "cancelled",
  "stale_workspace",
  "result_unknown",
  "safe_internal_error",
] as const;
export const gatewayErrorCodeSchema = z.enum(gatewayErrorCodeValues);
export type GatewayErrorCode = (typeof gatewayErrorCodeValues)[number];

export const safeMessageKeyValues = [
  ...gatewayErrorCodeValues.map((code) => `error.${code}` as const),
  "field.required",
  "field.invalid",
  "field.conflict",
] as const;
export type SafeMessageKey = `error.${GatewayErrorCode}` | "field.required" | "field.invalid" | "field.conflict";
export const safeMessageKeySchema = z.string().refine(
  (value): value is SafeMessageKey => (safeMessageKeyValues as readonly string[]).includes(value),
  "unknown safe message key",
);

export const fieldErrorSchema = z.strictObject({
  path: z.array(nonEmptyStringSchema).max(16),
  code: z.enum(["required", "invalid", "conflict"]),
  messageKey: safeMessageKeySchema,
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

export const gatewayErrorSchema = z.strictObject({
  code: gatewayErrorCodeSchema,
  safeMessageKey: safeMessageKeySchema,
  retry: z.enum(["never", "user_action", "safe_retry", "resync_first"]),
  fieldErrors: z.array(fieldErrorSchema).max(64).optional(),
  retryAfter: isoTimestampSchema.optional(),
  httpStatus: z.number().int().min(400).max(499).optional(),
  localEffect: z.enum(["none", "credential_cleared", "request_cancelled"]).optional(),
});
export type GatewayErrorV1 = z.infer<typeof gatewayErrorSchema>;

export type GatewayOkV1<T> = {
  version: 1;
  ok: true;
  data: T;
  requestId: string;
  correlationId: string;
  schemaRevision: string;
  workspaceEpoch?: number;
};
export type GatewayErrV1 = {
  version: 1;
  ok: false;
  error: GatewayErrorV1;
  requestId: string;
  correlationId: string;
  schemaRevision: string;
  workspaceEpoch?: number;
};
export type GatewayResultV1<T> = GatewayOkV1<T> | GatewayErrV1;

export function gatewayResultSchema<TSchema extends z.ZodTypeAny>(dataSchema: TSchema) {
  const base = z.object({
    version: z.literal(1),
    requestId: requestIdSchema,
    correlationId: correlationIdSchema,
    schemaRevision: nonEmptyStringSchema,
    workspaceEpoch: positiveIntSchema.optional(),
  });
  return z.union([
    base.extend({ ok: z.literal(true), data: dataSchema }).strict(),
    base.extend({ ok: z.literal(false), error: gatewayErrorSchema }).strict(),
  ]);
}

export const commandReceiptResyncHintSchema = z.strictObject({
  kind: z.enum(["receipt", "entity", "run_snapshot"]),
  ref: nonEmptyStringSchema,
});

export type CommandReceiptV1<T> =
  | { version: 1; commandId: string; state: "accepted"; result?: T; serverReceiptId?: string; resyncHint?: z.infer<typeof commandReceiptResyncHintSchema> }
  | { version: 1; commandId: string; state: "committed"; result: T; serverReceiptId?: string }
  | { version: 1; commandId: string; state: "unknown"; serverReceiptId?: string; resyncHint: z.infer<typeof commandReceiptResyncHintSchema> };

export function commandReceiptSchema<TSchema extends z.ZodTypeAny>(resultSchema: TSchema) {
  const common = { version: z.literal(1), commandId: commandIdSchema };
  return z.union([
    z.strictObject({ ...common, state: z.literal("accepted"), result: resultSchema.optional(), serverReceiptId: nonEmptyStringSchema.optional(), resyncHint: commandReceiptResyncHintSchema.optional() }),
    z.strictObject({ ...common, state: z.literal("committed"), result: resultSchema, serverReceiptId: nonEmptyStringSchema.optional() }),
    z.strictObject({ ...common, state: z.literal("unknown"), serverReceiptId: nonEmptyStringSchema.optional(), resyncHint: commandReceiptResyncHintSchema }),
  ]);
}

export const apiConnectionStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(1), kind: z.literal("not_configured") }),
  z.strictObject({ version: z.literal(1), kind: z.literal("configuration_error"), reason: z.enum(["pairing_secret_missing", "pairing_secret_invalid", "invalid_deployment_config"]) }),
  z.strictObject({ version: z.literal(1), kind: z.literal("checking"), originKind: z.enum(["local_loopback", "remote_https"]) }),
  z.strictObject({ version: z.literal(1), kind: z.literal("api_unavailable"), retryAfter: isoTimestampSchema.optional() }),
  z.strictObject({ version: z.literal(1), kind: z.literal("api_untrusted"), reason: z.enum(["wrong_service", "wrong_key", "bad_hmac", "unsupported_contract"]) }),
  z.strictObject({ version: z.literal(1), kind: z.literal("ready"), instanceId: nonEmptyStringSchema.optional(), schemaRevision: nonEmptyStringSchema }),
]);
export type ApiConnectionStateV1 = z.infer<typeof apiConnectionStateSchema>;

export const localApiTrustSchema = z.discriminatedUnion("state", [
  z.strictObject({
    version: z.literal(1),
    state: z.literal("untrusted"),
    origin: literalLoopbackOriginSchema,
    serviceId: z.literal(DESKTOP_API_SERVICE_ID),
    pairingKeyId: nonEmptyStringSchema.optional(),
    instanceId: nonEmptyStringSchema.optional(),
    transportEpoch: positiveIntSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    state: z.literal("trusted"),
    origin: literalLoopbackOriginSchema,
    serviceId: z.literal(DESKTOP_API_SERVICE_ID),
    pairingKeyId: nonEmptyStringSchema,
    instanceId: nonEmptyStringSchema,
    transportEpoch: positiveIntSchema,
    verifiedAt: isoTimestampSchema,
  }),
]);
export type LocalApiTrustV1 = z.infer<typeof localApiTrustSchema>;

export const deploymentConfigSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    version: z.literal(1),
    mode: z.literal("local_loopback"),
    apiOrigin: literalLoopbackOriginSchema,
    localServiceTrust: z.literal("hmac_pairing_v1"),
    expectedServiceId: z.literal(DESKTOP_API_SERVICE_ID),
    expectedDomainSchemaRevision: nonEmptyStringSchema,
    pairingKeyId: nonEmptyStringSchema,
    configRevision: nonEmptyStringSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    mode: z.literal("remote_https"),
    apiOrigin: exactHttpsOriginSchema,
    expectedDomainSchemaRevision: nonEmptyStringSchema,
    configRevision: nonEmptyStringSchema,
  }),
]);
export type DeploymentConfigV1 = z.infer<typeof deploymentConfigSchema>;

export const desktopTrustChallengeRequestSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().regex(BASE64URL_32_BYTES_PATTERN, "nonce must be base64url-encoded 32 bytes"),
  ipcContractVersion: z.literal(DESKTOP_IPC_CONTRACT_VERSION),
  pairingKeyId: nonEmptyStringSchema,
});
export type DesktopTrustChallengeRequestV1 = z.infer<typeof desktopTrustChallengeRequestSchema>;

export const desktopTrustChallengeResponseSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().regex(BASE64URL_32_BYTES_PATTERN),
  serviceId: z.literal(DESKTOP_API_SERVICE_ID),
  ipcContractVersion: z.literal(DESKTOP_IPC_CONTRACT_VERSION),
  domainSchemaRevision: nonEmptyStringSchema,
  pairingKeyId: nonEmptyStringSchema,
  instanceId: nonEmptyStringSchema,
  algorithm: z.literal("HMAC-SHA256"),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesktopTrustChallengeResponseV1 = z.infer<typeof desktopTrustChallengeResponseSchema>;

export function desktopTrustSignatureMessage(
  response: Pick<DesktopTrustChallengeResponseV1, "nonce" | "serviceId" | "ipcContractVersion" | "domainSchemaRevision" | "pairingKeyId" | "instanceId">,
): string {
  return [
    "ailearn-local-api-trust-v1",
    response.nonce,
    response.serviceId,
    response.ipcContractVersion,
    response.domainSchemaRevision,
    response.pairingKeyId,
    response.instanceId,
  ].join("\n");
}

export const windowStateSnapshotV1Schema = z.strictObject({
  version: z.literal(1),
  state: z.enum(["visible", "hidden", "minimized"]),
  revision: nonNegativeIntSchema,
});
export type WindowStateSnapshotV1 = z.infer<typeof windowStateSnapshotV1Schema>;

export const apiHealthSnapshotSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["ok", "degraded"]),
  serviceId: z.literal(DESKTOP_API_SERVICE_ID),
  domainSchemaRevision: nonEmptyStringSchema,
  instanceId: nonEmptyStringSchema.optional(),
  checkedAt: isoTimestampSchema,
  latencyMs: nonNegativeIntSchema,
});
export type ApiHealthSnapshotV1 = z.infer<typeof apiHealthSnapshotSchema>;

export const nativeCapabilityProjectionSchema = z.strictObject({
  filePicker: z.enum(["available", "unavailable"]),
  clipboard: z.enum(["available", "unavailable"]),
  notifications: z.enum(["available", "unavailable"]),
  asr: z.enum(["available", "unavailable"]),
  updates: z.enum(["available", "unavailable"]),
  live2d: z.enum(["available", "unavailable"]),
});
export type NativeCapabilityProjectionV1 = z.infer<typeof nativeCapabilityProjectionSchema>;

export const actionCapabilityValues = [
  "source.read", "source.create", "source.update", "source.archive", "source.createNote",
  "note.read", "note.create", "note.save", "note.delete", "note.restore", "note.permanentDelete",
  "objective.read", "review.read", "understanding.read", "search.read",
  "card_generation.start", "card_generation.review", "card_generation.reveal", "card_generation.activate", "card_generation.cancel", "card_generation.close",
  "learning_run.read", "learning_run.start", "learning_run.saveDraft", "learning_run.submit", "learning_run.action",
  "companion.read", "companion.sendMessage", "companion.decideProposal", "settings.read", "settings.update",
] as const;
export const actionCapabilitySchema = z.enum(actionCapabilityValues);
export type ActionCapability = (typeof actionCapabilityValues)[number];

const featureNameExtraValues = [
  "card_generation_v2", "learning_run_v2", "learning_run_v1", "companion_dialogue_v1",
  "companion_action_bridge_v1", "companion_journey_v2", "companion_bridge_v2", "companion_memory_vector_v1",
  "companion_memory_star_map_v1", "companion_summarizer_v1", "companion_daily_summary_v1",
  "companion_proactive_personalized_v1", "companion_pet_v1", "companion_pet_profile_v1",
  "companion_voice_dialogue_v1", "companion_streaming_voice_v1", "companion_live2d_v1",
] as const;
export const featureNameValues = [...CAPABILITY_IDS, ...featureNameExtraValues] as const;
export const featureNameSchema = z.union([capabilityIdSchema, z.enum(featureNameExtraValues)]);
export type FeatureName = CapabilityId | (typeof featureNameExtraValues)[number];

export const featureAvailabilitySchema = z.strictObject({
  state: z.enum(["enabled", "disabled", "conditional", "unavailable"]),
  reason: safeMessageKeySchema.optional(),
});
export type FeatureAvailabilityV1 = z.infer<typeof featureAvailabilitySchema>;

const actionCapabilityShape = Object.fromEntries(
  actionCapabilityValues.map((key) => [key, z.enum(["allowed", "denied", "conditional"])]),
) as unknown as Record<ActionCapability, z.ZodTypeAny>;
const featureAvailabilityShape = Object.fromEntries(
  featureNameValues.map((key) => [key, featureAvailabilitySchema]),
) as unknown as Record<FeatureName, z.ZodTypeAny>;

export const capabilityProjectionSchema = z.strictObject({
  version: z.literal(1),
  revision: nonEmptyStringSchema,
  workspaceEpoch: positiveIntSchema,
  actionCapabilities: z.object(actionCapabilityShape).strict(),
  featureAvailability: z.object(featureAvailabilityShape).strict(),
  nativeCapabilities: nativeCapabilityProjectionSchema,
});
export type CapabilityProjectionV1 = z.infer<typeof capabilityProjectionSchema>;

const workspaceSummaryShape = {
  version: z.literal(1),
  workspaceId: uuidSchema,
  name: nonEmptyStringSchema,
  role: z.enum(["owner", "member"]),
  workspaceType: z.enum(["personal", "collaborative"]),
  isPersonal: z.boolean(),
};

export const workspaceSummarySchema = z
  .strictObject(workspaceSummaryShape)
  .superRefine((value, context) => {
    if (value.isPersonal !== (value.workspaceType === "personal")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["isPersonal"], message: "workspace type mismatch" });
    }
  });
export type WorkspaceSummaryV1 = z.infer<typeof workspaceSummarySchema>;

export const workspaceContextSchema = z
  .strictObject({ ...workspaceSummaryShape, workspaceEpoch: positiveIntSchema })
  .superRefine((value, context) => {
    if (value.isPersonal !== (value.workspaceType === "personal")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["isPersonal"], message: "workspace type mismatch" });
    }
  });
export type WorkspaceContextV1 = z.infer<typeof workspaceContextSchema>;

export const sessionUserSchema = z.strictObject({
  userId: uuidSchema,
  email: emailSchema,
  displayName: nonEmptyStringSchema.optional(),
});

export const sessionContextSchema = z.union([
  z.strictObject({
    version: z.literal(1),
    status: z.literal("restoring"),
    user: z.null(),
    workspace: z.null(),
    membership: z.null(),
    capabilities: z.null(),
    workspaceEpoch: nonNegativeIntSchema,
    credentialPersistence: z.enum(["none", "memory", "safe_storage"]),
    pendingNavigationIntent: pendingNavigationIntentSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("anonymous"),
    user: z.null(),
    workspace: z.null(),
    membership: z.null(),
    capabilities: z.null(),
    workspaceEpoch: nonNegativeIntSchema,
    credentialPersistence: z.literal("none"),
    pendingNavigationIntent: pendingNavigationIntentSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.enum(["authenticated", "reauth_required", "api_unavailable", "api_untrusted"]),
    user: sessionUserSchema,
    workspace: workspaceContextSchema.nullable(),
    membership: z.strictObject({ role: z.enum(["owner", "member"]) }).nullable(),
    capabilities: capabilityProjectionSchema.nullable(),
    workspaceEpoch: positiveIntSchema,
    credentialPersistence: z.enum(["memory", "safe_storage"]),
    pendingNavigationIntent: pendingNavigationIntentSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("switching_workspace"),
    user: sessionUserSchema,
    workspace: z.null(),
    membership: z.null(),
    capabilities: z.null(),
    workspaceEpoch: positiveIntSchema,
    credentialPersistence: z.enum(["memory", "safe_storage"]),
    pendingNavigationIntent: pendingNavigationIntentSchema.optional(),
  }),
]);
export type SessionContextV1 = z.infer<typeof sessionContextSchema>;

export const runtimeSnapshotSchema = z.strictObject({
  version: z.literal(1),
  contractVersion: z.literal(DESKTOP_IPC_CONTRACT_VERSION),
  appId: nonEmptyStringSchema,
  appVersion: nonEmptyStringSchema,
  platform: z.enum(["darwin", "win32", "linux"]),
  windowState: windowStateSnapshotV1Schema,
  apiConnection: apiConnectionStateSchema,
  nativeCapabilities: nativeCapabilityProjectionSchema,
  reducedMotion: z.boolean(),
  startupRevision: positiveIntSchema,
});
export type RuntimeSnapshotV1 = z.infer<typeof runtimeSnapshotSchema>;

export const navigationSnapshotSchema = z.strictObject({
  version: z.literal(1),
  current: navigationEntrySchema,
  stackRevision: nonNegativeIntSchema,
  canBack: z.boolean(),
});
export type NavigationSnapshotV1 = z.infer<typeof navigationSnapshotSchema>;

export const gatewayEventPayloadM1Schema = z.union([
  z.strictObject({ kind: z.literal("connection_changed"), state: apiConnectionStateSchema }),
  z.strictObject({ kind: z.literal("snapshot_invalidated"), scope: z.enum(["runtime", "workspace"]), ref: nonEmptyStringSchema.optional() }),
]);
export type GatewayEventPayloadM1 = z.infer<typeof gatewayEventPayloadM1Schema>;

export const gatewayEventPayloadM2Schema = z.union([
  gatewayEventPayloadM1Schema,
  z.strictObject({ kind: z.literal("learning_run_changed"), runId: uuidSchema, revision: nonNegativeIntSchema }),
  z.strictObject({ kind: z.literal("card_generation_changed"), runId: uuidSchema, eventCursor: nonNegativeIntSchema, revision: nonNegativeIntSchema }),
]);
export type GatewayEventPayloadM2 = z.infer<typeof gatewayEventPayloadM2Schema>;

export const gatewayEventPayloadSchema = z.union([
  gatewayEventPayloadM1Schema,
  z.strictObject({ kind: z.literal("learning_run_changed"), runId: uuidSchema, revision: nonNegativeIntSchema }),
  z.strictObject({ kind: z.literal("card_generation_changed"), runId: uuidSchema, eventCursor: nonNegativeIntSchema, revision: nonNegativeIntSchema }),
  z.strictObject({ kind: z.literal("companion_delivery_changed"), conversationId: uuidSchema, cursor: cursorSchema }),
  z.strictObject({ kind: z.literal("domain_job_changed"), jobId: uuidSchema, revision: nonNegativeIntSchema }),
]);
export type GatewayEventPayloadV1 = z.infer<typeof gatewayEventPayloadSchema>;

export const gatewayEventSchema = z
  .strictObject({
    version: z.literal(1),
    subscriptionId: subscriptionIdSchema,
    // Anonymous runtime connection events are intentionally scoped to epoch 0.
    // Every workspace/domain event still requires a positive authenticated epoch.
    workspaceEpoch: nonNegativeIntSchema,
    cursor: cursorSchema,
    eventRevision: nonNegativeIntSchema,
    kind: z.enum(["connection_changed", "snapshot_invalidated", "learning_run_changed", "card_generation_changed", "companion_delivery_changed", "domain_job_changed"]),
    schemaRevision: nonEmptyStringSchema,
    data: gatewayEventPayloadSchema,
  })
  .superRefine((value, context) => {
    if (value.kind !== value.data.kind) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["data", "kind"], message: "event kind mismatch" });
    }
    if (value.kind !== "connection_changed" && value.workspaceEpoch < 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceEpoch"], message: "workspace event requires authenticated epoch" });
    }
  });
export type GatewayEventV1 = z.infer<typeof gatewayEventSchema>;

const runtimeSubscriptionTopicSchema = z.strictObject({
  kind: z.literal("runtime"),
  cursor: cursorSchema.optional(),
});
const workspaceSubscriptionTopicSchema = z.strictObject({
  kind: z.literal("workspace"),
  cursor: cursorSchema.optional(),
});
const learningRunSubscriptionTopicSchema = z.strictObject({
  kind: z.literal("learningRun"),
  runId: uuidSchema,
  cursor: cursorSchema.optional(),
});
const cardGenerationSubscriptionTopicSchema = z.strictObject({
  kind: z.literal("cardGeneration"),
  runId: uuidSchema,
  cursor: cursorSchema.optional(),
});

export const subscriptionTopicM1Schema = z.discriminatedUnion("kind", [
  runtimeSubscriptionTopicSchema,
  workspaceSubscriptionTopicSchema,
]);
export type SubscriptionTopicM1 = z.infer<typeof subscriptionTopicM1Schema>;
export const subscriptionTopicSchema = z.discriminatedUnion("kind", [
  runtimeSubscriptionTopicSchema,
  workspaceSubscriptionTopicSchema,
  learningRunSubscriptionTopicSchema,
  cardGenerationSubscriptionTopicSchema,
  z.strictObject({ kind: z.literal("companionDelivery"), cursor: cursorSchema.optional() }),
  z.strictObject({ kind: z.literal("domainJob"), jobId: uuidSchema, cursor: cursorSchema.optional() }),
]);
export type SubscriptionTopicV1 = z.infer<typeof subscriptionTopicSchema>;

export const subscriptionTopicM2Schema = z.discriminatedUnion("kind", [
  runtimeSubscriptionTopicSchema,
  workspaceSubscriptionTopicSchema,
  learningRunSubscriptionTopicSchema,
  cardGenerationSubscriptionTopicSchema,
]);
export type SubscriptionTopicM2 = z.infer<typeof subscriptionTopicM2Schema>;

// Renderer input intentionally omits idempotency keys. Main owns key
// generation so replay identity cannot be forged by a page or deep link.
export const desktopCreateLearningRunV2RequestSchema = createLearningRunV2RequestSchema.omit({ idempotencyKey: true });
export type DesktopCreateLearningRunV2Request = z.infer<typeof desktopCreateLearningRunV2RequestSchema>;
export const desktopPutLearningTaskDraftV2RequestSchema = putLearningTaskDraftRequestV2Schema.omit({ idempotencyKey: true });
export type DesktopPutLearningTaskDraftV2Request = z.infer<typeof desktopPutLearningTaskDraftV2RequestSchema>;
export const desktopSubmitTaskArtifactV2Schema = submitTaskArtifactV2Schema.omit({ idempotencyKey: true });
export type DesktopSubmitTaskArtifactV2 = z.infer<typeof desktopSubmitTaskArtifactV2Schema>;
export const desktopLearningRunActionRequestV2Schema = learningRunActionRequestV2Schema.omit({ idempotencyKey: true });
export type DesktopLearningRunActionRequestV2 = z.infer<typeof desktopLearningRunActionRequestV2Schema>;
export const desktopRecordLearningRunActivityLeaseRequestV2Schema = recordLearningRunActivityLeaseRequestV2Schema.omit({ deviceSessionId: true });
export type DesktopRecordLearningRunActivityLeaseRequestV2 = z.infer<typeof desktopRecordLearningRunActivityLeaseRequestV2Schema>;
export const recordLearningRunActivityLeaseOutputV2Schema = z.strictObject({ recorded: z.literal(true) });
export type RecordLearningRunActivityLeaseOutputV2 = z.infer<typeof recordLearningRunActivityLeaseOutputV2Schema>;
export const desktopLearningRunAbandonRequestV2Schema = z.strictObject({
  version: z.literal(2),
  snapshotId: uuidSchema,
  runRevision: positiveIntSchema,
  runtimeEpoch: nonNegativeIntSchema,
  abandonLockedEvidence: z.boolean(),
});
export type DesktopLearningRunAbandonRequestV2 = z.infer<typeof desktopLearningRunAbandonRequestV2Schema>;

// Note save has no renderer-controlled transport/idempotency fields.  The
// request is still versioned so the main adapter can reject legacy payloads.
export const desktopNoteSaveRequestV1Schema = noteSaveRequestV1Schema;
export type DesktopNoteSaveRequestV1 = z.infer<typeof desktopNoteSaveRequestV1Schema>;

export const legacyStartLearningRunInputSchema = z.strictObject({
  version: z.literal(1),
  command: z.literal("learningRun.start"),
  origin: learningRunOriginSchema,
  returnTarget: learningRunReturnTargetSchema.optional(),
});
export type LegacyStartLearningRunInputV1 = z.infer<typeof legacyStartLearningRunInputSchema>;

export const legacyRouteResolutionSchema = z.strictObject({
  version: z.literal(1),
  legacyKind: z.enum(["card", "key_point"]),
  legacyId: uuidSchema,
  status: z.enum(["mapped", "gone"]),
  objectiveId: uuidSchema.nullable(),
  cardId: uuidSchema.nullable(),
});
export type LegacyRouteResolutionV1 = z.infer<typeof legacyRouteResolutionSchema>;

export const learningRoomManifestSchema = z
  .strictObject({
    version: z.literal(1),
    schemaVersion: z.literal(1),
    id: nonEmptyStringSchema,
    canonicalMode: z.literal("2d"),
    basePath: z.literal(LEARNING_ROOM_ASSET_BASE_PATH),
    assets: z.record(nonEmptyStringSchema, staticAssetPathSchema).refine(
      (assets) => Object.keys(assets).length <= 512,
      "too many assets",
    ),
  })
  .superRefine((value, context) => {
    const paths = Object.values(value.assets);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets"], message: "duplicate normalized asset path" });
    }
  });
export type LearningRoomManifestV1 = z.infer<typeof learningRoomManifestSchema>;

export type Unsubscribe = () => void;

export interface SubscriptionApiM1 {
  subscribe(input: { meta: RequestMetaV1; topic: SubscriptionTopicM1 }): Promise<GatewayResultV1<{ subscriptionId: string }>>;
  onEvent(subscriptionId: string, listener: (event: GatewayEventV1) => void): Unsubscribe;
  unsubscribe(input: { meta: RequestMetaV1; subscriptionId: string }): Promise<GatewayResultV1<{ closed: true }>>;
}

export interface SubscriptionApiM2 {
  subscribe(input: { meta: RequestMetaV1; topic: SubscriptionTopicM2 }): Promise<GatewayResultV1<{ subscriptionId: string }>>;
  onEvent(subscriptionId: string, listener: (event: GatewayEventV1) => void): Unsubscribe;
  unsubscribe(input: { meta: RequestMetaV1; subscriptionId: string }): Promise<GatewayResultV1<{ closed: true }>>;
}

export interface AILearnDesktopApiM1 {
  readonly contract: DesktopContractSnapshotV1;
  readonly runtime: {
    getSnapshot(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<RuntimeSnapshotV1>>;
    retryApiConnection(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<ApiConnectionStateV1>>;
    getHealth(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<ApiHealthSnapshotV1>>;
    cancel(input: { meta: RequestMetaV1; requestId: string }): Promise<GatewayResultV1<{ cancelled: true }>>;
  };
  readonly navigation: {
    resolve(input: { meta: RequestMetaV1; route: DesktopRouteV1; learningRunId?: Uuid }): Promise<GatewayResultV1<NavigationSnapshotV1>>;
    go(input: { meta: RequestMetaV1; route: DesktopRouteV1; entryKind: NavigationReasonV1; learningRunId?: Uuid }): Promise<GatewayResultV1<NavigationSnapshotV1>>;
    back(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<NavigationSnapshotV1>>;
    restore(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<NavigationSnapshotV1>>;
  };
  readonly auth: {
    getState(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<SessionContextV1>>;
    login(input: { meta: RequestMetaV1; email: string; password: string; remember: boolean }): Promise<GatewayResultV1<SessionContextV1>>;
    register(input: { meta: RequestMetaV1; email: string; password: string; inviteToken?: string; displayName?: string; remember: boolean }): Promise<GatewayResultV1<SessionContextV1>>;
    logout(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<{ loggedOut: true; serverRevoked: boolean }>>;
    reauthenticate(input: { meta: RequestMetaV1; password: string }): Promise<GatewayResultV1<SessionContextV1>>;
    changePassword(input: { meta: RequestMetaV1; commandId: string; currentPassword: string; newPassword: string }): Promise<GatewayResultV1<{ changed: true; sessionsRevoked: true }>>;
  };
  readonly workspace: {
    list(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<{ workspaces: WorkspaceSummaryV1[] }>>;
    switch(input: { meta: RequestMetaV1; workspaceId: string }): Promise<GatewayResultV1<SessionContextV1>>;
    getCurrent(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<WorkspaceContextV1>>;
  };
  readonly capabilities: {
    get(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<CapabilityProjectionV1>>;
  };
  readonly window: {
    getState(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<WindowStateSnapshotV1>>;
    setTitlebarTheme(input: { meta: RequestMetaV1; theme: "day" | "night" }): Promise<GatewayResultV1<{ applied: true }>>;
    focus(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<{ focused: true }>>;
  };
  readonly subscriptions: SubscriptionApiM1;
}

export interface AILearnDesktopApiM2 extends AILearnDesktopApiM1 {
  readonly subscriptions: SubscriptionApiM2;
  readonly room: {
    getProjection(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof roomProjectionV1Schema>>>;
  };
  readonly note: {
    get(input: { meta: RequestMetaV1; noteId: Uuid }): Promise<GatewayResultV1<z.infer<typeof noteDetailV1Schema>>>;
    save(input: {
      meta: RequestMetaV1;
      commandId: CommandMetaV1["commandId"];
      noteId: Uuid;
      request: DesktopNoteSaveRequestV1;
    }): Promise<GatewayResultV1<z.infer<typeof noteSaveReceiptV1Schema>>>;
    readonly cardGeneration: {
      start(input: {
        meta: RequestMetaV1;
        commandId: CommandMetaV1["commandId"];
        noteId: Uuid;
        request: DesktopCreateCardGenerationRunRequestV2;
      }): Promise<GatewayResultV1<z.infer<typeof cardGenerationJobAcceptedV1Schema>>>;
      getRun(input: { meta: RequestMetaV1; runId: Uuid }): Promise<GatewayResultV1<z.infer<typeof cardGenerationRunSnapshotV1Schema>>>;
      getCandidates(input: { meta: RequestMetaV1; runId: Uuid }): Promise<GatewayResultV1<z.infer<typeof cardGenerationCandidateListV1Schema>>>;
      review(input: {
        meta: RequestMetaV1;
        commandId: CommandMetaV1["commandId"];
        runId: Uuid;
        request: DesktopCandidateReviewRequestV2;
      }): Promise<GatewayResultV1<z.infer<typeof cardGenerationReviewResultV1Schema>>>;
      reveal(input: {
        meta: RequestMetaV1;
        commandId: CommandMetaV1["commandId"];
        runId: Uuid;
        candidateId: Uuid;
        request: DesktopRevealCandidateRequestV2;
      }): Promise<GatewayResultV1<z.infer<typeof candidateRevealV2Schema>>>;
      activate(input: {
        meta: RequestMetaV1;
        commandId: CommandMetaV1["commandId"];
        runId: Uuid;
        request: DesktopCardGenerationActivationSelectionV1;
      }): Promise<GatewayResultV1<z.infer<typeof cardActivationReceiptDesktopV1Schema>>>;
      cancel(input: { meta: RequestMetaV1; commandId: CommandMetaV1["commandId"]; runId: Uuid }): Promise<GatewayResultV1<{ version: 1; runId: Uuid; status: "cancelled" }>>;
      close(input: { meta: RequestMetaV1; commandId: CommandMetaV1["commandId"]; runId: Uuid; expectedReviewDraftRevision: number }): Promise<GatewayResultV1<z.infer<typeof cardGenerationCloseResultV1Schema>>>;
    };
  };
  readonly review: {
    getQueue(input: {
      meta: RequestMetaV1;
      cursor?: string;
      limit?: number;
    }): Promise<GatewayResultV1<z.infer<typeof reviewQueueV2Schema>>>;
  };
  readonly learningRun: {
    get(input: { meta: RequestMetaV1; runId: Uuid }): Promise<GatewayResultV1<z.infer<typeof learningRunPublicSnapshotV2Schema>>>;
    start(input: {
      meta: RequestMetaV1;
      commandId: CommandMetaV1["commandId"];
      request: DesktopCreateLearningRunV2Request;
    }): Promise<GatewayResultV1<z.infer<typeof learningRunPublicSnapshotV2Schema>>>;
    getDraft(input: { meta: RequestMetaV1; runId: Uuid; taskId: Uuid }): Promise<GatewayResultV1<z.infer<typeof learningTaskDraftV2Schema> | null>>;
    saveDraft(input: {
      meta: RequestMetaV1;
      commandId: CommandMetaV1["commandId"];
      runId: Uuid;
      taskId: Uuid;
      request: DesktopPutLearningTaskDraftV2Request;
    }): Promise<GatewayResultV1<z.infer<typeof learningTaskDraftWriteReceiptV2Schema>>>;
    submit(input: {
      meta: RequestMetaV1;
      commandId: CommandMetaV1["commandId"];
      runId: Uuid;
      taskId: Uuid;
      request: DesktopSubmitTaskArtifactV2;
    }): Promise<GatewayResultV1<z.infer<typeof submitTaskArtifactReceiptV2Schema>>>;
    action(input: {
      meta: RequestMetaV1;
      commandId: CommandMetaV1["commandId"];
      runId: Uuid;
      request: DesktopLearningRunActionRequestV2;
    }): Promise<GatewayResultV1<z.infer<typeof learningRunActionResponseV2Schema>>>;
    getResult(input: { meta: RequestMetaV1; runId: Uuid }): Promise<GatewayResultV1<z.infer<typeof getLearningRunResultResponseV2Schema>>>;
    getReturnContract(input: { meta: RequestMetaV1; runId: Uuid }): Promise<GatewayResultV1<z.infer<typeof learningRunReturnContractV2Schema>>>;
    recordActivityLease(input: {
      meta: RequestMetaV1;
      runId: Uuid;
      request: DesktopRecordLearningRunActivityLeaseRequestV2;
    }): Promise<GatewayResultV1<z.infer<typeof recordLearningRunActivityLeaseOutputV2Schema>>>;
    abandon(input: {
      meta: RequestMetaV1;
      commandId: CommandMetaV1["commandId"];
      runId: Uuid;
      request: DesktopLearningRunAbandonRequestV2;
    }): Promise<GatewayResultV1<z.infer<typeof learningRunActionResponseV2Schema>>>;
  };
}
