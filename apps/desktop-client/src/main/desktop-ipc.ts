import { BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  DESKTOP_IPC_SCHEMA_REVISION,
  type ActionCapability,
  apiHealthSnapshotSchema,
  apiConnectionStateSchema,
  capabilityProjectionSchema,
  clipboardReadLinksResultSchema,
  desktopContractSnapshotSchema,
  desktopNamespaceM2Values,
  desktopRouteKindM2Values,
  desktopRouteSchema,
  extractCandidateLinks,
  gatewayEventSchema,
  navigationSnapshotSchema,
  sessionContextSchema,
  workspaceContextSchema,
  workspaceSummarySchema,
  type AILearnDesktopApiM2,
  type ApiHealthSnapshotV1,
  type DesktopContractSnapshotV1,
  type DesktopRouteV1,
  type GatewayErrorCode,
  type GatewayEventPayloadM2,
  type GatewayEventV1,
  type GatewayResultV1,
  type NavigationEntryV1,
  type NavigationSnapshotV1,
  type RequestMetaV1,
  type SessionContextV1,
  type SubscriptionTopicM2,
  type WindowStateSnapshotV1,
  desktopCreateLearningRunV2RequestSchema,
  desktopCreateCardGenerationRunRequestV2Schema,
  desktopCandidateReviewRequestV2Schema,
  desktopRevealCandidateRequestV2Schema,
  desktopCardGenerationActivationSelectionV1Schema,
  desktopLearningRunAbandonRequestV2Schema,
  desktopLearningRunActionRequestV2Schema,
  desktopPutLearningTaskDraftV2RequestSchema,
  desktopRecordLearningRunActivityLeaseRequestV2Schema,
  recordLearningRunActivityLeaseOutputV2Schema,
  desktopSubmitTaskArtifactV2Schema,
  desktopNoteSaveRequestV1Schema,
  commandIdSchema,
  emailSchema,
  gatewayErrorSchema,
  inviteTokenSchema,
  isoTimestampSchema,
  navigationReasonSchema,
  newPasswordSchema,
  requestIdSchema,
  requestMetaSchema,
  runtimeSnapshotSchema,
  secretInputSchema,
  subscriptionIdSchema,
  subscriptionTopicM2Schema,
  positiveIntSchema,
  uuidSchema,
  windowStateSnapshotV1Schema,
  aiDataPolicyV1Schema,
  workspaceAiSettingsV1Schema,
  workspaceExportResultV1Schema,
  type DesktopRouteKindM2,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  desktopSourceListPageSchema,
  desktopSourceCreateRequestSchema,
  desktopSourceDetailSchema,
  desktopSourceNotesPageSchema,
  desktopSourceUpdateRequestSchema,
  desktopSourceNoteResultSchema,
  desktopSourceArchiveResultSchema,
  desktopNoteListPageSchema,
  desktopNoteCreateRequestSchema,
  desktopNoteMutationResultSchema,
  desktopNoteVersionListSchema,
  desktopSearchPageSchema,
} from "@ailearn/shared/desktop-surface-contracts";
import { objectiveListPageV3Schema, learningObjectiveSurfaceV3Schema } from "@ailearn/shared/learning-objective-surface-contracts";
import { understandingTopologySnapshotV3Schema } from "@ailearn/shared/understanding-topology-v3-contracts";
import { todayActivityV1Schema } from "@ailearn/shared/activity-surface-contracts";
import {
  getLearningRunResultResponseV2Schema,
  learningRunActionResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  learningRunReturnContractV2Schema,
  learningTaskDraftV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  submitTaskArtifactReceiptV2Schema,
} from "@ailearn/shared/learning-run-v2-contracts";
import { reviewDeferRequestV2Schema, reviewDeferResultV2Schema, reviewQueueV2Schema } from "@ailearn/shared/review-queue-v2-contracts";
import { roomProjectionV1Schema } from "@ailearn/shared/room-projection-contracts";
import {
  companionAccountPatchSchema,
  companionAccountStateV1Schema,
  companionOverviewSchema,
} from "@ailearn/shared/companion-shell-contracts";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfilePatchV1Schema,
  companionRoomProfileV1Schema,
} from "@ailearn/shared/companion-home-contracts";
import {
  companionVoiceSpeakRequestV1Schema,
  companionVoiceSpeakResultV1Schema,
} from "@ailearn/shared/companion-voice-contracts";
// 站内图片字节通道：来源正文里的 `/api/uploads/…` 由 main 代取，
// 渲染层只拿 base64 转 blob URL（它的 origin 够不到 API 源）。
import {
  sourceImageGetRequestV1Schema,
  sourceImageGetResultV1Schema,
} from "@ailearn/shared/source-image-contracts";
// 笔记图片写入通道：编辑器里的图由 main 送到 `POST /uploads/images`，渲染层拿回
// 站内地址写进正文；读取那一半仍走上面的字节通道。
import {
  noteImageUploadRequestV1Schema,
  noteImageUploadResultV1Schema,
} from "@ailearn/shared/note-image-upload-contracts";
import {
  companionConversationListV1Schema,
  companionDailyDateV1Schema,
  companionDailySummaryV1Schema,
  companionMemoryItemV1Schema,
  companionMemoryListQuerySchema,
  companionMemoryListV1Schema,
  companionMemoryStarMapV1Schema,
  companionPersonaMutationV1Schema,
  companionPersonaPatchV1Schema,
  companionPersonaResetV1Schema,
  companionPersonaV1Schema,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { noteDetailV1Schema } from "@ailearn/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema } from "@ailearn/shared/note-save-contracts";
import {
  cardActivationReceiptDesktopV1Schema,
  cardGenerationCandidateListV1Schema,
  cardGenerationCancelResultV1Schema,
  cardGenerationRetryResultV1Schema,
  cardGenerationCloseResultV1Schema,
  cardGenerationExposureEligibilityV1Schema,
  cardGenerationJobAcceptedV1Schema,
  cardGenerationReviewResultV1Schema,
  cardGenerationRunSnapshotV1Schema,
} from "@ailearn/shared/card-generation-desktop-contracts";
import { candidateRevealV2Schema } from "@ailearn/shared/card-generation-v2-contracts";
import { DesktopGateway, DesktopGatewayFailure, type SessionCredentialStore } from "./desktop-gateway";
import { createSessionCredentialStore } from "./session-credential-store";
import { FormalAssessmentGuard, type CompanionDeliveryKind } from "./formal-assessment-guard";
import { recoverPendingReturnMarker, resolveLearningRunReturn, routeForLearningRunReturn } from "./learning-run-return-resolver";
import { MemoryPendingReturnMarkerStore, type PendingReturnMarkerStore } from "./pending-return-marker-store";
import type { WindowStateSnapshot } from "../shared/window-state";

type WindowResolver = (contents: WebContents, sourceUrl: string) => BrowserWindow | null;

export type DesktopIpcRegistrationOptions = {
  readonly resolveWindow: WindowResolver;
  readonly getWindowState: (window: BrowserWindow) => WindowStateSnapshot;
  readonly setTitlebarTheme: (window: BrowserWindow, theme: "day" | "night") => boolean;
  readonly getReducedMotion?: () => boolean;
  readonly gateway?: DesktopGateway;
  readonly credentials?: SessionCredentialStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly formalAssessmentGuard?: FormalAssessmentGuard;
  readonly pendingReturnMarkerStore?: PendingReturnMarkerStore;
};

const m1InputBase = { meta: requestMetaSchema };
const runtimeInputSchema = z.strictObject(m1InputBase);
const cancelInputSchema = z.strictObject({ ...m1InputBase, requestId: requestIdSchema });
const navigationResolveInputSchema = z.strictObject({ ...m1InputBase, route: desktopRouteSchema, learningRunId: uuidSchema.optional() });
const navigationGoInputSchema = z.strictObject({
  ...m1InputBase,
  route: desktopRouteSchema,
  entryKind: navigationReasonSchema,
  learningRunId: uuidSchema.optional(),
});
const authLoginInputSchema = z.strictObject({
  ...m1InputBase,
  email: emailSchema,
  password: secretInputSchema,
  remember: z.boolean(),
});
const authRegisterInputSchema = z.strictObject({
  ...m1InputBase,
  email: emailSchema,
  // 与 API 的 `/auth/register-v2` 保持一致：注册密码至少 8 位。登录不设下限，
  // 否则历史账号会被客户端挡在门外。
  password: newPasswordSchema,
  inviteToken: inviteTokenSchema.optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  remember: z.boolean(),
});
const authReauthenticateInputSchema = z.strictObject({ ...m1InputBase, password: secretInputSchema });
const authChangePasswordInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  currentPassword: secretInputSchema,
  newPassword: newPasswordSchema,
});
const authJoinWorkspaceInputSchema = z.strictObject({
  ...m1InputBase,
  inviteToken: inviteTokenSchema,
});
const workspaceSwitchInputSchema = z.strictObject({ ...m1InputBase, workspaceId: uuidSchema });
// 设置页的 AI 同意与数据策略：写入由服务端 requireOwner 收口，这里只做形状校验。
const workspaceAiConsentUpdateInputSchema = z.strictObject({
  ...m1InputBase,
  consentVersion: z.string().trim().min(1).max(50),
});
const workspaceAiDataPolicyUpdateInputSchema = z.strictObject({
  ...m1InputBase,
  policy: aiDataPolicyV1Schema,
});
const companionRoomPatchInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionRoomProfilePatchV1Schema,
});
const companionVoiceSpeakInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionVoiceSpeakRequestV1Schema,
});
const companionAccountPatchInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionAccountPatchSchema,
});
// 伴星中心（页 20）：读取按 workspace 路由，裁决端点只带一个记忆 id。
// 删除走 `DELETE`，服务端回答 204，因此回执在 main 侧自己拼。
const companionMemoryListInputSchema = z.strictObject({
  ...m1InputBase,
  query: companionMemoryListQuerySchema.optional(),
});
const companionMemoryIdInputSchema = z.strictObject({ ...m1InputBase, memoryId: uuidSchema });
const companionDailyGetInputSchema = z.strictObject({
  ...m1InputBase,
  date: companionDailyDateV1Schema.optional(),
});
const companionConversationsListInputSchema = z.strictObject({
  ...m1InputBase,
  limit: z.number().int().min(1).max(50).optional(),
});
// 人格写入：请求体是整套档案（服务端不做字段级合并），main 侧照抄同一份 schema，
// 让渲染层多带一个键也在到达服务端之前被拒。
const companionPersonaPatchInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionPersonaPatchV1Schema,
});
const companionMemoryDeleteOutputSchema = z.strictObject({ memoryItemId: uuidSchema });
const windowThemeInputSchema = z.strictObject({ ...m1InputBase, theme: z.enum(["day", "night"]) });
const subscribeInputSchema = z.strictObject({ ...m1InputBase, topic: subscriptionTopicM2Schema });
const unsubscribeInputSchema = z.strictObject({ ...m1InputBase, subscriptionId: subscriptionIdSchema });
const cancelOutputSchema = z.strictObject({ cancelled: z.literal(true) });
const logoutOutputSchema = z.strictObject({ loggedOut: z.literal(true), serverRevoked: z.boolean() });
const changePasswordOutputSchema = z.strictObject({ changed: z.literal(true), sessionsRevoked: z.literal(true) });
const workspaceListOutputSchema = z.strictObject({ workspaces: z.array(workspaceSummarySchema) });
const titlebarThemeOutputSchema = z.strictObject({ applied: z.literal(true) });
const focusOutputSchema = z.strictObject({ focused: z.literal(true) });
const subscriptionOutputSchema = z.strictObject({ subscriptionId: subscriptionIdSchema });
const closedSubscriptionOutputSchema = z.strictObject({ closed: z.literal(true) });
const reviewQueueInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional() });
// 「今日学习」操作日志流：窗口由渲染层本地日历日给出（ISO 带时区），两端各限 62h。
const activityGetTodayInputSchema = z.strictObject({
  ...m1InputBase,
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
});
const reviewDeferInputSchema = z.strictObject({ ...m1InputBase, request: reviewDeferRequestV2Schema });
const sourceListInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional(), status: z.string().min(1).max(32).optional() });
const sourceCreateInputSchema = z.strictObject({ ...m1InputBase, request: desktopSourceCreateRequestSchema });
const sourceGetInputSchema = z.strictObject({ ...m1InputBase, sourceId: uuidSchema });
const sourceNotesInputSchema = z.strictObject({ ...m1InputBase, sourceId: uuidSchema });
const sourceUpdateInputSchema = z.strictObject({
  ...m1InputBase,
  sourceId: uuidSchema,
  request: desktopSourceUpdateRequestSchema
});
const sourceCreateNoteInputSchema = z.strictObject({
  ...m1InputBase,
  sourceId: uuidSchema,
  force: z.boolean().optional()
});
const sourceArchiveInputSchema = z.strictObject({ ...m1InputBase, sourceId: uuidSchema });
const sourceImageGetInputSchema = z.strictObject({
  ...m1InputBase,
  request: sourceImageGetRequestV1Schema,
});
const noteListInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional(), trashed: z.boolean().optional() });
const noteCreateInputSchema = z.strictObject({ ...m1InputBase, request: desktopNoteCreateRequestSchema });
const noteIdInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema });
const objectiveListInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional(), lifecycle: z.enum(["active", "archived", "superseded"]).optional() });
const objectiveGetInputSchema = z.strictObject({ ...m1InputBase, objectiveId: uuidSchema });
const searchGlobalInputSchema = z.strictObject({ ...m1InputBase, query: z.string().trim().min(1).max(500), type: z.enum(["note", "source", "objective"]).optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(512).optional() });
const noteGetInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema });
// The caller names the version it is reading as current, so the history can mark
// it without a second note read; the main process never trusts it as authority.
const noteVersionsInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  currentVersionId: uuidSchema,
  limit: z.number().int().min(1).max(200).optional(),
});
const noteVersionRestoreInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  versionId: uuidSchema,
  baseVersionId: uuidSchema,
});
const noteImageUploadInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  request: noteImageUploadRequestV1Schema,
});
const noteSaveInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  request: desktopNoteSaveRequestV1Schema,
});
const cardGenerationStartInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  request: desktopCreateCardGenerationRunRequestV2Schema,
});
const cardGenerationGetRunInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema });
const cardGenerationGetCandidatesInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema });
const cardGenerationReviewInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  request: desktopCandidateReviewRequestV2Schema,
});
const cardGenerationRevealInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  candidateId: uuidSchema,
  request: desktopRevealCandidateRequestV2Schema,
});
// The same preflight the activation path runs, asked for by the review page.
const cardGenerationExposureInputSchema = z.strictObject({
  ...m1InputBase,
  runId: uuidSchema,
  candidateId: uuidSchema,
  revision: positiveIntSchema,
});
const cardGenerationActivateInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  request: desktopCardGenerationActivationSelectionV1Schema,
});
const cardGenerationCancelInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema });
const cardGenerationRetryInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema });
const cardGenerationCloseInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  expectedReviewDraftRevision: positiveIntSchema,
});
const learningRunGetInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema });
const learningRunStartInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, request: desktopCreateLearningRunV2RequestSchema });
const learningRunDraftGetInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema, taskId: uuidSchema });
const learningRunDraftSaveInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema, taskId: uuidSchema, request: desktopPutLearningTaskDraftV2RequestSchema });
const learningRunSubmitInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema, taskId: uuidSchema, request: desktopSubmitTaskArtifactV2Schema });
const learningRunActionInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema, request: desktopLearningRunActionRequestV2Schema });
const learningRunLeaseInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema, request: desktopRecordLearningRunActivityLeaseRequestV2Schema });
const learningRunAbandonInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema, request: desktopLearningRunAbandonRequestV2Schema });

type InputSchema<T> = z.ZodType<T>;
type ParsedMeta = { readonly meta: RequestMetaV1 };

type NavigationState = {
  entries: NavigationEntryV1[];
  revision: number;
};

type SubscriptionRecord = {
  readonly window: BrowserWindow;
  readonly topic: SubscriptionTopicM2;
};

type M2SubscriptionEvent = GatewayEventPayloadM2;

const navigationByWindow = new WeakMap<BrowserWindow, NavigationState>();
let registrationComplete = false;

function generatedOpaqueId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("base64url")}`;
}
function fallbackMeta(): RequestMetaV1 {
  const now = new Date().toISOString();
  return {
    version: 1,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    requestId: generatedOpaqueId("invalid-request"),
    correlationId: generatedOpaqueId("invalid-correlation"),
    clientStartedAt: now,
  };
}

function readMeta(value: unknown): RequestMetaV1 {
  if (typeof value !== "object" || value === null || !("meta" in value)) return fallbackMeta();
  const parsed = requestMetaSchema.safeParse(value.meta);
  return parsed.success ? parsed.data : fallbackMeta();
}

function errorRetryFor(code: GatewayErrorCode): "never" | "user_action" | "safe_retry" | "resync_first" {
  if (code === "api_unavailable" || code === "network_timeout" || code === "rate_limited") return "safe_retry";
  if (code === "result_unknown" || code === "stale_workspace") return "resync_first";
  if (
    code === "configuration_error" ||
    code === "api_untrusted" ||
    code === "unsupported_contract" ||
    code === "auth_required" ||
    code === "reauth_required"
  ) return "user_action";
  return "never";
}

function errorResult<T>(
  meta: RequestMetaV1,
  code: GatewayErrorCode,
  options: {
    readonly retry?: "never" | "user_action" | "safe_retry" | "resync_first";
    readonly httpStatus?: number;
    readonly retryAfter?: string;
    readonly localEffect?: "none" | "credential_cleared" | "request_cancelled";
    readonly workspaceEpoch?: number;
  } = {},
): GatewayResultV1<T> {
  const error = gatewayErrorSchema.parse({
    code,
    safeMessageKey: `error.${code}`,
    retry: options.retry ?? errorRetryFor(code),
    ...(options.httpStatus !== undefined && options.httpStatus >= 400 && options.httpStatus <= 499
      ? { httpStatus: options.httpStatus }
      : {}),
    ...(options.retryAfter ? { retryAfter: options.retryAfter } : {}),
    ...(options.localEffect ? { localEffect: options.localEffect } : {}),
  });
  return {
    version: 1,
    ok: false,
    error,
    requestId: meta.requestId,
    correlationId: meta.correlationId,
    schemaRevision: DESKTOP_IPC_SCHEMA_REVISION,
    ...(options.workspaceEpoch !== undefined ? { workspaceEpoch: options.workspaceEpoch } : {}),
  };
}

function okResult<T>(meta: RequestMetaV1, data: T, workspaceEpoch?: number): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: meta.requestId,
    correlationId: meta.correlationId,
    schemaRevision: DESKTOP_IPC_SCHEMA_REVISION,
    ...(workspaceEpoch !== undefined ? { workspaceEpoch } : {}),
  };
}

function safeWorkspaceEpoch(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("workspaceEpoch" in value)) return undefined;
  const parsed = z.number().int().min(1).safeParse(value.workspaceEpoch);
  return parsed.success ? parsed.data : undefined;
}

function mapFailure<T>(meta: RequestMetaV1, error: unknown, workspaceEpoch?: number): GatewayResultV1<T> {
  if (error instanceof DesktopGatewayFailure) {
    return errorResult(meta, error.code, {
      retry: error.retry,
      httpStatus: error.httpStatus,
      retryAfter: error.retryAfter,
      localEffect: error.localEffect,
      workspaceEpoch,
    });
  }
  if (error instanceof z.ZodError) {
    return errorResult(meta, "unsupported_contract", { workspaceEpoch });
  }
  return errorResult(meta, "safe_internal_error", { workspaceEpoch });
}

function isM1Route(route: DesktopRouteV1): route is Extract<DesktopRouteV1, { kind: "auth.login" | "auth.register" }> {
  return route.kind === "auth.login" || route.kind === "auth.register";
}

function requireM1Route(route: DesktopRouteV1): void {
  if (!isM1Route(route)) throw new DesktopGatewayFailure("route_not_available", "user_action");
}

function navigationEntry(route: DesktopRouteV1, meta: RequestMetaV1, entryKind: NavigationEntryV1["entryKind"]): NavigationEntryV1 {
  requireM1Route(route);
  const gateRoute = route as Extract<DesktopRouteV1, { kind: "auth.login" | "auth.register" }>;
  return {
    version: 1,
    scope: "gate",
    historyKey: `gate-${route.kind}`,
    route: gateRoute,
    entryKind,
    correlationId: meta.correlationId,
  };
}

function navigationState(window: BrowserWindow, meta: RequestMetaV1): NavigationState {
  const existing = navigationByWindow.get(window);
  if (existing) return existing;
  const state: NavigationState = {
    entries: [navigationEntry({ kind: "auth.login" }, meta, "startup")],
    revision: 0,
  };
  navigationByWindow.set(window, state);
  return state;
}

function navigationSnapshot(state: NavigationState): NavigationSnapshotV1 {
  return {
    version: 1,
    current: state.entries[state.entries.length - 1],
    stackRevision: state.revision,
    canBack: state.entries.length > 1,
  };
}

function contractSnapshot(gateway: DesktopGateway, env: NodeJS.ProcessEnv): DesktopContractSnapshotV1 {
  const deployment = gateway.getDeploymentConfig();
  const domainSchemaRevision = deployment?.expectedDomainSchemaRevision ?? env.AILEARN_DOMAIN_SCHEMA_REVISION?.trim() ?? "unconfigured";
  const deploymentConfigRevision = deployment?.configRevision ?? env.DESKTOP_DEPLOYMENT_CONFIG_REVISION?.trim() ?? "desktop-dev-config-v1";
  return desktopContractSnapshotSchema.parse({
    version: 1,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    domainSchemaRevision,
    deploymentConfigRevision,
    namespaces: [...desktopNamespaceM2Values],
    enabledRoutes: [...desktopRouteKindM2Values],
  });
}

function asWindowState(snapshot: WindowStateSnapshot): WindowStateSnapshotV1 {
  return windowStateSnapshotV1Schema.parse({ version: 1, state: snapshot.state, revision: snapshot.revision });
}

function readPayload<T>(input: unknown, schema: InputSchema<T>): { ok: true; value: T } | { ok: false; meta: RequestMetaV1 } {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, meta: readMeta(input) };
}

function installHandler<TInput extends ParsedMeta, TOutput>(
  channel: string,
  schema: InputSchema<TInput>,
  options: DesktopIpcRegistrationOptions,
  operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => Promise<TOutput> | TOutput,
  getWorkspaceEpoch?: (output: TOutput) => number | undefined,
  outputSchema?: z.ZodType<TOutput>,
): void {
  ipcMain.handle(channel, async (event, rawInput: unknown): Promise<GatewayResultV1<TOutput>> => {
    const parsed = readPayload(rawInput, schema);
    if (!parsed.ok) return errorResult<TOutput>(parsed.meta, "invalid_request");

    const window = options.resolveWindow(event.sender, event.senderFrame?.url ?? "");
    if (!window) return errorResult<TOutput>(parsed.value.meta, "invalid_request");

    try {
      const output = await operation(event, window, parsed.value);
      const outputValidation = outputSchema?.safeParse(output);
      if (outputValidation && !outputValidation.success) {
        throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      }
      const validatedOutput = outputValidation ? outputValidation.data : output;
      return okResult(parsed.value.meta, validatedOutput, getWorkspaceEpoch?.(validatedOutput));
    } catch (error) {
      return mapFailure<TOutput>(parsed.value.meta, error, getWorkspaceEpoch?.(undefined as TOutput));
    }
  });
}

function assertEpoch(meta: RequestMetaV1, activeWorkspaceEpoch: number): void {
  if (meta.workspaceEpoch !== undefined && meta.workspaceEpoch !== activeWorkspaceEpoch) {
    throw new DesktopGatewayFailure("stale_workspace", "resync_first");
  }
}

function requireM2Route(contract: DesktopContractSnapshotV1, route: DesktopRouteKindM2): void {
  if (!contract.enabledRoutes.includes(route)) throw new DesktopGatewayFailure("route_not_available", "user_action");
}

/**
 * 同一份数据会在多个面上出现时的路由门控（如来源图片同时出现在来源详情和
 * 笔记阅读页）。只要调用方所在的面可达即可——按单一路由收口会把另一个面上
 * 的合法读取挡在门外。
 */
function requireAnyM2Route(contract: DesktopContractSnapshotV1, routes: readonly DesktopRouteKindM2[]): void {
  if (!routes.some((route) => contract.enabledRoutes.includes(route))) {
    throw new DesktopGatewayFailure("route_not_available", "user_action");
  }
}

export function registerM1DesktopIpc(options: DesktopIpcRegistrationOptions): AILearnDesktopApiM2["contract"] {
  if (registrationComplete) throw new Error("M1 desktop IPC has already been registered");
  registrationComplete = true;

  const gateway = options.gateway ?? new DesktopGateway(options.env, {
    credentials: options.credentials ?? createSessionCredentialStore(),
  });
  const env = options.env ?? process.env;
  const contract = contractSnapshot(gateway, env);
  const formalAssessmentGuard = options.formalAssessmentGuard ?? new FormalAssessmentGuard();
  const packagedLearningRunResponseLossOperations = new Set<"draft" | "submit" | "action">();
  for (const operation of (env.AILEARN_PACKAGED_LEARNING_RUN_RESPONSE_LOSS ?? "").split(",").map((value) => value.trim())) {
    if (operation === "draft" || operation === "submit" || operation === "action") packagedLearningRunResponseLossOperations.add(operation);
  }
  const packagedLearningRunResponseLossInjected = new Set<"draft" | "submit" | "action">();
  const maybeInjectPackagedLearningRunResponseLoss = (operation: "draft" | "submit" | "action"): void => {
    if (
      env.AILEARN_PACKAGED_EVIDENCE !== "1"
      || !packagedLearningRunResponseLossOperations.has(operation)
      || packagedLearningRunResponseLossInjected.has(operation)
    ) return;
    packagedLearningRunResponseLossInjected.add(operation);
    // Evidence-only seam: the server mutation has already completed and the
    // main process has synchronized its guard/stream state, but the renderer
    // receives the same typed result-unknown contract as a lost IPC response.
    // It is never exposed through preload and is disabled for normal builds.
    throw new DesktopGatewayFailure("result_unknown", "resync_first");
  };
  if (env.AILEARN_PACKAGED_EVIDENCE === "1") {
    // This is a main-process-only observation seam for the packaged evidence
    // harness. It is intentionally absent from preload and renderer APIs so
    // formal sensitivity cannot be queried or influenced by page code.
    const evidenceGlobal = globalThis as typeof globalThis & {
      __ailearnFormalAssessmentGuardEvidence?: {
        getSnapshot: () => ReturnType<FormalAssessmentGuard["getSnapshot"]>;
        authorizeCompanionDelivery: (kind: CompanionDeliveryKind) => ReturnType<FormalAssessmentGuard["authorizeCompanionDelivery"]>;
      };
    };
    evidenceGlobal.__ailearnFormalAssessmentGuardEvidence = {
      getSnapshot: () => formalAssessmentGuard.getSnapshot(),
      authorizeCompanionDelivery: (kind) => formalAssessmentGuard.authorizeCompanionDelivery(kind),
    };
  }
  const pendingReturnMarkerStore = options.pendingReturnMarkerStore ?? new MemoryPendingReturnMarkerStore();
  let activeWorkspaceEpoch = 0;
  let activeSubjectId: string | null = null;
  let activeWorkspaceId: string | null = null;
  let eventRevision = 0;
  const subscriptions = new Map<string, SubscriptionRecord>();
  const trackedLearningRunIds = new Set<string>();
  const learningRunStreams = new Map<string, () => void>();
  const trackedCardGenerationRunIds = new Set<string>();
  const cardGenerationStreams = new Map<string, () => void>();
  const windowLifecycleBound = new WeakSet<BrowserWindow>();

  const clearSubscriptionsForWindow = (window: BrowserWindow): void => {
    for (const [subscriptionId, subscription] of subscriptions) {
      if (subscription.window === window) subscriptions.delete(subscriptionId);
    }
  };

  const hasLearningRunSubscription = (): boolean => {
    for (const subscription of subscriptions.values()) {
      if (subscription.topic.kind === "learningRun") return true;
    }
    return false;
  };

  const stopLearningRunStreams = (): void => {
    for (const stop of learningRunStreams.values()) stop();
    learningRunStreams.clear();
  };

  const hasCardGenerationSubscription = (): boolean => {
    for (const subscription of subscriptions.values()) {
      if (subscription.topic.kind === "cardGeneration") return true;
    }
    return false;
  };

  const stopCardGenerationStreams = (): void => {
    for (const stop of cardGenerationStreams.values()) stop();
    cardGenerationStreams.clear();
  };

  const releaseSubscriptionsForWindow = (window: BrowserWindow): void => {
    // Window destruction is a hard sensitivity boundary. Do not let a
    // main-owned formal-assessment state survive the renderer that held the
    // task DOM, input, or Companion context.
    formalAssessmentGuard.failClosed("disconnected");
    clearSubscriptionsForWindow(window);
    if (!hasLearningRunSubscription()) stopLearningRunStreams();
    if (!hasCardGenerationSubscription()) stopCardGenerationStreams();
  };

  const bindWindowLifecycle = (window: BrowserWindow): void => {
    if (windowLifecycleBound.has(window)) return;
    windowLifecycleBound.add(window);
    window.once("closed", () => releaseSubscriptionsForWindow(window));
    window.webContents.once("destroyed", () => releaseSubscriptionsForWindow(window));
  };

  const refreshLearningRunSubscription = async (runId: string): Promise<void> => {
    try {
      const snapshot = await gateway.getLearningRun(runId);
      syncFormalGuard(snapshot);
      emit("learningRun", { kind: "learning_run_changed", runId: snapshot.runId, revision: snapshot.runRevision }, activeWorkspaceEpoch);
    } catch {
      formalAssessmentGuard.failClosed("disconnected");
      // A later GET through the normal renderer path remains the source of
      // truth. Stream failures never forward raw SSE data or private errors.
    }
  };

  const ensureLearningRunStream = (runId: string): void => {
    trackedLearningRunIds.add(runId);
    if (!hasLearningRunSubscription() || learningRunStreams.has(runId)) return;
    const streamWorkspaceEpoch = activeWorkspaceEpoch;
    void gateway.watchLearningRunEvents(
      runId,
      async () => {
        if (streamWorkspaceEpoch !== activeWorkspaceEpoch) return;
        await refreshLearningRunSubscription(runId);
      },
    ).then((stop) => {
      if (!hasLearningRunSubscription() || streamWorkspaceEpoch !== activeWorkspaceEpoch) {
        stop();
        return;
      }
      learningRunStreams.set(runId, stop);
    }).catch(() => {
      formalAssessmentGuard.failClosed("disconnected");
    });
  };

  const ensureTrackedLearningRunStreams = (): void => {
    for (const runId of trackedLearningRunIds) ensureLearningRunStream(runId);
  };

  const refreshCardGenerationSubscription = async (runId: string, eventCursor: number): Promise<void> => {
    try {
      const snapshot = await gateway.getCardGenerationRun(runId);
      emit("cardGeneration", {
        kind: "card_generation_changed",
        runId: snapshot.runId,
        eventCursor,
        revision: snapshot.reviewDraftRevision,
      }, activeWorkspaceEpoch);
    } catch {
      // The renderer must re-query the strict run snapshot itself after a
      // stream gap. Raw SSE payloads and provider/candidate details stay main-only.
    }
  };

  const ensureCardGenerationStream = (runId: string): void => {
    trackedCardGenerationRunIds.add(runId);
    if (!hasCardGenerationSubscription() || cardGenerationStreams.has(runId)) return;
    const streamWorkspaceEpoch = activeWorkspaceEpoch;
    void gateway.watchCardGenerationEvents(
      runId,
      async (eventCursor) => {
        if (streamWorkspaceEpoch !== activeWorkspaceEpoch) return;
        await refreshCardGenerationSubscription(runId, eventCursor);
      },
    ).then((stop) => {
      if (!hasCardGenerationSubscription() || streamWorkspaceEpoch !== activeWorkspaceEpoch) {
        stop();
        return;
      }
      cardGenerationStreams.set(runId, stop);
    }).catch(() => undefined);
  };

  const ensureTrackedCardGenerationStreams = (): void => {
    for (const runId of trackedCardGenerationRunIds) ensureCardGenerationStream(runId);
  };

  const subscriptionMatchesPayload = (topic: SubscriptionTopicM2, topicKind: SubscriptionTopicM2["kind"], payload: M2SubscriptionEvent): boolean => {
    if (topic.kind !== topicKind) return false;
    if (topic.kind === "learningRun") return payload.kind === "learning_run_changed" && topic.runId === payload.runId;
    if (topic.kind === "cardGeneration") return payload.kind === "card_generation_changed" && topic.runId === payload.runId;
    return true;
  };

  const emit = (topic: SubscriptionTopicM2["kind"], payload: M2SubscriptionEvent, workspaceEpoch: number): void => {
    for (const [subscriptionId, subscription] of subscriptions) {
      if (!subscriptionMatchesPayload(subscription.topic, topic, payload) || subscription.window.isDestroyed() || subscription.window.webContents.isDestroyed()) continue;
      const event: GatewayEventV1 = gatewayEventSchema.parse({
        version: 1,
        subscriptionId,
        workspaceEpoch,
        cursor: generatedOpaqueId("cursor"),
        eventRevision: eventRevision++,
        kind: payload.kind,
        schemaRevision: DESKTOP_IPC_SCHEMA_REVISION,
        data: payload,
      });
      subscription.window.webContents.send(DESKTOP_IPC_CHANNELS.subscriptionsEvent, event);
    }
  };

  const rememberSession = (session: SessionContextV1): void => {
    if (session.status !== "authenticated" || !session.user || !session.workspace) {
      formalAssessmentGuard.failClosed("disconnected");
      activeSubjectId = null;
      activeWorkspaceId = null;
      return;
    }
    activeSubjectId = session.user.userId;
    activeWorkspaceId = session.workspace.workspaceId;
  };

  const syncFormalGuard = (snapshot: unknown): void => {
    formalAssessmentGuard.syncFromSnapshot(snapshot, gateway.getConnectionState().kind === "ready");
  };

  const syncFormalGuardFromResult = (value: unknown): void => {
    if (typeof value === "object" && value !== null && "snapshot" in value) {
      syncFormalGuard(value.snapshot);
      return;
    }
    formalAssessmentGuard.failClosed("unknown");
  };

  const requireActionCapability = async (
    // 从共享常量派生而不是就地再列一遍：此前这里手写了 6 个字面量，新增能力时
    // 必须在两处同步（漏改一处就是"共享层有、客户端永远拒绝"的静默 403）。
    capability: Extract<ActionCapability, `card_generation.${string}`>,
    requestId?: string,
  ): Promise<void> => {
    const projection = await gateway.getCapabilities(requestId);
    if (projection.actionCapabilities[capability] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
  };

  const resolveReturnContract = async (contractValue: unknown): Promise<void> => {
    const resolution = resolveLearningRunReturn(contractValue, { enabledRoutes: contract.enabledRoutes });
    if (!activeSubjectId || !activeWorkspaceId) return;
    if (resolution.kind === "pending") {
      await pendingReturnMarkerStore.set(activeSubjectId, activeWorkspaceId, resolution.marker);
    } else {
      await pendingReturnMarkerStore.clear(activeSubjectId, activeWorkspaceId);
    }
  };

  const completeFormalReleaseAfterRendererCleanup = (runId?: string): void => {
    const state = formalAssessmentGuard.getSnapshot();
    if (state.state !== "releasing" || !state.runId || state.runtimeEpoch === null) return;
    if (runId && state.runId !== runId) return;
    // A plain room.home navigation is also exposed to the shell. It is not
    // itself proof that the LearningRun Player has unmounted, so only allow
    // this fallback form after the main-owned run subscription has gone away.
    if (!runId && hasLearningRunSubscription()) return;
    formalAssessmentGuard.completeRelease({ runId: state.runId, runtimeEpoch: state.runtimeEpoch }, true);
  };

  const resolveLearningRunNavigation = async (
    runId: string,
    requestedRoute: DesktopRouteV1,
    requestId?: string,
  ): Promise<void> => {
    const contractValue = await gateway.getLearningRunReturnContract(runId, requestId);
    await resolveReturnContract(contractValue);
    const resolvedRouteKind = routeForLearningRunReturn(contractValue);
    if (!resolvedRouteKind || requestedRoute.kind !== resolvedRouteKind) {
      throw new DesktopGatewayFailure("invalid_navigation", "user_action");
    }
    // The API's V2 return contract already authorizes and resolves the
    // schedule/objective target in the current subject/workspace scope. A
    // review item may legitimately stop being due immediately after a result
    // commits, so re-reading the due-only queue here would incorrectly turn a
    // safe review return into a room fallback.
  };

  const recoverPersistedReturnMarker = async (requestId?: string): Promise<void> => {
    if (!activeSubjectId || !activeWorkspaceId) return;
    await recoverPendingReturnMarker({
      markerStore: pendingReturnMarkerStore,
      subjectId: activeSubjectId,
      workspaceId: activeWorkspaceId,
      enabledRoutes: contract.enabledRoutes,
      query: (runId) => gateway.getLearningRunReturnContract(runId, requestId),
      clearOnError: (error) => error instanceof DesktopGatewayFailure
        && ["not_found", "forbidden", "unsupported_contract"].includes(error.code),
    });
  };

  const navigationEntryForContract = (
    route: DesktopRouteV1,
    meta: RequestMetaV1,
    entryKind: NavigationEntryV1["entryKind"],
  ): NavigationEntryV1 => {
    if (isM1Route(route)) return navigationEntry(route, meta, entryKind);
    if (!contract.enabledRoutes.includes(route.kind as (typeof desktopRouteKindM2Values)[number])) {
      throw new DesktopGatewayFailure("route_not_available", "user_action");
    }
    if (!activeWorkspaceId || activeWorkspaceEpoch < 1) {
      throw new DesktopGatewayFailure("auth_required", "user_action");
    }
    const level = route.kind === "room.home" ? "L0" : route.kind === "review.queue" ? "L1" : "L2";
    return {
      version: 1,
      scope: "workspace",
      historyKey: `workspace-${route.kind}`,
      workspaceId: activeWorkspaceId,
      workspaceEpoch: activeWorkspaceEpoch,
      route,
      level,
      entryKind,
      navigationOrigin: entryKind,
      focusReturnKey: route.kind,
      correlationId: meta.correlationId,
    };
  };

  ipcMain.on(DESKTOP_IPC_CHANNELS.contractGetSnapshot, (event) => {
    const window = options.resolveWindow(event.sender, event.senderFrame?.url ?? "");
    event.returnValue = window ? contract : null;
  });

  installHandler(DESKTOP_IPC_CHANNELS.runtimeGetSnapshot, runtimeInputSchema, options, async (_event, window, input) => {
    const snapshot = gateway.getRuntimeSnapshot(
      asWindowState(options.getWindowState(window)),
      options.getReducedMotion?.() ?? false,
    );
    return runtimeSnapshotSchema.parse(snapshot);
  }, undefined, runtimeSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.runtimeRetryApiConnection, runtimeInputSchema, options, async (_event, _window, input) => {
    try {
      const state = await gateway.retryConnection(input.meta.requestId);
      const parsed = apiConnectionStateSchema.parse(state);
      if (parsed.kind !== "ready") formalAssessmentGuard.failClosed("disconnected");
      emit("runtime", { kind: "connection_changed", state: parsed }, activeWorkspaceEpoch);
      return parsed;
    } catch (error) {
      formalAssessmentGuard.failClosed("disconnected");
      throw error;
    }
  }, undefined, apiConnectionStateSchema);

  installHandler(DESKTOP_IPC_CHANNELS.runtimeGetHealth, runtimeInputSchema, options, async (_event, _window, input) => {
    const health = await gateway.getHealth(input.meta.requestId);
    const snapshot: ApiHealthSnapshotV1 = apiHealthSnapshotSchema.parse({
      version: 1,
      status: health.status,
      serviceId: DESKTOP_API_SERVICE_ID,
      domainSchemaRevision: health.domainSchemaRevision,
      ...(health.instanceId ? { instanceId: health.instanceId } : {}),
      checkedAt: health.checkedAt,
      latencyMs: health.latencyMs,
    });
    return snapshot;
  }, undefined, apiHealthSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.runtimeCancel, cancelInputSchema, options, async (_event, _window, input) => {
    if (!gateway.cancel(input.requestId)) throw new DesktopGatewayFailure("not_found", "never");
    return { cancelled: true as const };
  }, undefined, cancelOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.navigationResolve, navigationResolveInputSchema, options, async (_event, window, input) => {
    if (input.learningRunId) await resolveLearningRunNavigation(input.learningRunId, input.route, input.meta.requestId);
    const state = navigationState(window, input.meta);
    const entry = navigationEntryForContract(input.route, input.meta, "user");
    if (input.learningRunId || input.route.kind === "room.home") completeFormalReleaseAfterRendererCleanup(input.learningRunId);
    return { version: 1, current: entry, stackRevision: state.revision, canBack: state.entries.length > 1 } satisfies NavigationSnapshotV1;
  }, undefined, navigationSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.navigationGo, navigationGoInputSchema, options, async (_event, window, input) => {
    if (input.learningRunId) await resolveLearningRunNavigation(input.learningRunId, input.route, input.meta.requestId);
    const state = navigationState(window, input.meta);
    state.entries.push(navigationEntryForContract(input.route, input.meta, input.entryKind));
    state.revision += 1;
    if (input.learningRunId || input.route.kind === "room.home") completeFormalReleaseAfterRendererCleanup(input.learningRunId);
    return navigationSnapshot(state);
  }, undefined, navigationSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.navigationBack, runtimeInputSchema, options, (_event, window, input) => {
    const state = navigationState(window, input.meta);
    if (state.entries.length > 1) {
      state.entries.pop();
      state.revision += 1;
    }
    return navigationSnapshot(state);
  }, undefined, navigationSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.navigationRestore, runtimeInputSchema, options, (_event, window, input) => {
    const state = navigationState(window, input.meta);
    return navigationSnapshot(state);
  }, undefined, navigationSnapshotSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authGetState, runtimeInputSchema, options, async (_event, _window, input) => {
    const session = await gateway.getSession(input.meta.requestId);
    activeWorkspaceEpoch = session.status === "authenticated" || session.status === "reauth_required" ? session.workspaceEpoch : 0;
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authLogin, authLoginInputSchema, options, async (_event, _window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    const session = await gateway.login(input.email, input.password, input.meta.requestId, input.remember);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, activeWorkspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authRegister, authRegisterInputSchema, options, async (_event, _window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    const session = await gateway.register(input.email, input.password, input.inviteToken, input.displayName, input.meta.requestId, input.remember);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authJoinWorkspace, authJoinWorkspaceInputSchema, options, async (_event, _window, input) => {
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const session = await gateway.joinWorkspace(input.inviteToken, input.meta.requestId);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authLogout, runtimeInputSchema, options, async (_event, window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    try {
      const result = await gateway.logout(input.meta.requestId);
      stopLearningRunStreams();
      trackedLearningRunIds.clear();
      stopCardGenerationStreams();
      trackedCardGenerationRunIds.clear();
      activeWorkspaceEpoch = 0;
      if (activeSubjectId) await pendingReturnMarkerStore.clearSubject(activeSubjectId);
      activeSubjectId = null;
      activeWorkspaceId = null;
      clearSubscriptionsForWindow(window);
      return result;
    } catch (error) {
      // logout clears main-owned credentials before attempting the remote revoke;
      // local subscriptions must follow that fact even when the API is offline.
      activeWorkspaceEpoch = 0;
      stopLearningRunStreams();
      trackedLearningRunIds.clear();
      stopCardGenerationStreams();
      trackedCardGenerationRunIds.clear();
      if (activeSubjectId) await pendingReturnMarkerStore.clearSubject(activeSubjectId);
      activeSubjectId = null;
      activeWorkspaceId = null;
      clearSubscriptionsForWindow(window);
      throw error;
    }
  }, undefined, logoutOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authReauthenticate, authReauthenticateInputSchema, options, async (_event, _window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    const session = await gateway.reauthenticate(input.password, input.meta.requestId);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authChangePassword, authChangePasswordInputSchema, options, async (_event, _window, input) => {
    assertEpoch(input.meta, activeWorkspaceEpoch);
    formalAssessmentGuard.failClosed("disconnected");
    const result = await gateway.changePassword(input.currentPassword, input.newPassword, input.meta.requestId);
    activeWorkspaceEpoch = 0;
    return result;
  }, undefined, changePasswordOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceList, runtimeInputSchema, options, async (_event, _window, input) => {
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listWorkspaces(input.meta.requestId);
  }, undefined, workspaceListOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceSwitch, workspaceSwitchInputSchema, options, async (_event, _window, input) => {
    assertEpoch(input.meta, activeWorkspaceEpoch);
    formalAssessmentGuard.failClosed("disconnected");
    stopLearningRunStreams();
    trackedLearningRunIds.clear();
    stopCardGenerationStreams();
    trackedCardGenerationRunIds.clear();
    if (activeSubjectId && activeWorkspaceId) await pendingReturnMarkerStore.clear(activeSubjectId, activeWorkspaceId);
    const session = await gateway.switchWorkspace(input.workspaceId, input.meta.requestId);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    emit("workspace", { kind: "snapshot_invalidated", scope: "workspace" }, activeWorkspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceGetCurrent, runtimeInputSchema, options, async (_event, _window, input) => {
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const workspace = await gateway.getCurrentWorkspace(input.meta.requestId);
    activeWorkspaceEpoch = workspace.workspaceEpoch;
    return workspace;
  }, (output) => safeWorkspaceEpoch(output), workspaceContextSchema);

  // 设置页的「AI 数据同意」分区。写入是 Owner 专属（服务端 requireOwner 收口），
  // 读回的是服务端当前状态，因此投影与界面不会各自维护一份同意状态。
  installHandler(DESKTOP_IPC_CHANNELS.workspaceAiSettingsGet, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getWorkspaceAiSettings(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, workspaceAiSettingsV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceAiConsentUpdate, workspaceAiConsentUpdateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.updateAiConsent(input.consentVersion, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, workspaceAiSettingsV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceAiDataPolicyUpdate, workspaceAiDataPolicyUpdateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.updateAiDataPolicy(input.policy, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, workspaceAiSettingsV1Schema);

  /**
   * 整库导出。服务端出数据（`requireOwner` 收口），本机负责落盘：读者在系统
   * 保存对话框里自己选位置，主进程写文件。渲染进程只拿到回执——它既看不到
   * 文件系统，也没有任何写文件的通道。
   */
  installHandler(DESKTOP_IPC_CHANNELS.workspaceExport, runtimeInputSchema, options, async (_event, window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const payload = await gateway.fetchWorkspaceExport(input.meta.requestId);
    // 网关把解不开的响应体读成 null。导出是数据出口，宁可失败也不能让读者
    // 在系统对话框里确认之后拿到一个写着 `null` 的文件。
    if (payload === null || typeof payload !== "object") {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    const text = JSON.stringify(payload, null, 2);
    const selection = await dialog.showSaveDialog(window, {
      title: "导出工作区",
      defaultPath: `ailearn-workspace-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePath) {
      return { version: 1 as const, saved: false, canceled: true, filePath: null, bytes: 0 };
    }
    try {
      await writeFile(selection.filePath, text, "utf8");
    } catch {
      // 数据已经取回来了，失败的是本机写入（权限、磁盘、路径），所以这是一个
      // 读者可以自己重试的问题，而不是服务端错误。
      throw new DesktopGatewayFailure("safe_internal_error", "user_action");
    }
    return {
      version: 1 as const,
      saved: true,
      canceled: false,
      filePath: selection.filePath,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, workspaceExportResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.roomGetProjection, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getRoomProjection(input.meta.requestId);
  }, (output) => safeWorkspaceEpoch(output), roomProjectionV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.sourceList, sourceListInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "source.library");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listSources({ status: input.status, cursor: input.cursor, limit: input.limit }, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopSourceListPageSchema);

  // Capturing material is an owner-only write on the API, and the capability
  // projection already says so; checking it here keeps a member from filling in
  // the capture form only to be rejected at the end.
  installHandler(DESKTOP_IPC_CHANNELS.sourceCreate, sourceCreateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "source.library");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["source.create"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return gateway.createSource(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopSourceDetailSchema);

  installHandler(DESKTOP_IPC_CHANNELS.sourceGet, sourceGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getSource(input.sourceId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopSourceDetailSchema);

  installHandler(DESKTOP_IPC_CHANNELS.sourceNotes, sourceNotesInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listSourceNotes(input.sourceId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopSourceNotesPageSchema);

  // Renaming and "write a note from this source" are owner-only writes the
  // capability projection already advertises, so a member is stopped here
  // instead of after filling in a title.
  installHandler(DESKTOP_IPC_CHANNELS.sourceUpdate, sourceUpdateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["source.update"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return gateway.updateSourceTitle(input.sourceId, input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopSourceDetailSchema);

  installHandler(DESKTOP_IPC_CHANNELS.sourceCreateNote, sourceCreateNoteInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["source.createNote"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return gateway.createNoteFromSource(input.sourceId, { force: input.force }, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopSourceNoteResultSchema);

  // Archiving is the source's soft delete and the last owner-only source write
  // the capability projection advertises; checking it here keeps a member from
  // confirming an action they were never allowed to ask for.
  installHandler(DESKTOP_IPC_CHANNELS.sourceArchive, sourceArchiveInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["source.archive"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return gateway.archiveSource(input.sourceId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopSourceArchiveResultSchema);

  // 站内图片字节：来源详情的正文片段与笔记阅读页都会用到（两者共用同一份
  // `/api/uploads/…` 引用），所以只要其中一个面可达就放行。这里没有 owner 门控
  // ——能读到正文的成员就该看到正文里的图，服务端的下载路由仍会按 workspace
  // 与登记记录自行收口。
  installHandler(DESKTOP_IPC_CHANNELS.sourceImageGet, sourceImageGetInputSchema, options, async (_event, _window, input) => {
    requireAnyM2Route(contract, ["source.detail", "note.detail"]);
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getSourceImage(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, sourceImageGetResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionHomeGetProjection, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionHomeProjection(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionHomeProjectionV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionRoomGetProfile, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionRoomProfile(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionRoomProfileV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionRoomPatchProfile, companionRoomPatchInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.patchCompanionRoomProfile(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionRoomProfileV1Schema);

  // 账号级 presence（决策 3）：读当前账号状态 / 写入（revision CAS）。
  // 与其余伴星通道同一路由门控（设置入口在房间的伴星面板内）。
  installHandler(DESKTOP_IPC_CHANNELS.companionAccountGetState, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionAccountOverview(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionOverviewSchema);

  installHandler(DESKTOP_IPC_CHANNELS.companionAccountPatchState, companionAccountPatchInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.patchCompanionAccountState(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionAccountStateV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionVoiceSpeak, companionVoiceSpeakInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.speakCompanionVoice(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionVoiceSpeakResultV1Schema);

  // 伴星中心（页 20）的共同记录。与其余伴星通道同一路由门控：这些都是"书房"
  // 内的呈现，不新增导航目标，也不把记忆正文写进路由或快照。
  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryList, companionMemoryListInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listCompanionMemories(input.query ?? {}, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryListV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryStarMap, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionMemoryStarMap(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryStarMapV1Schema);

  for (const [channel, mutate] of [
    [DESKTOP_IPC_CHANNELS.companionMemoryConfirm, "confirmCompanionMemory"],
    [DESKTOP_IPC_CHANNELS.companionMemoryPin, "pinCompanionMemory"],
    [DESKTOP_IPC_CHANNELS.companionMemoryUnpin, "unpinCompanionMemory"],
    [DESKTOP_IPC_CHANNELS.companionMemoryArchive, "archiveCompanionMemory"],
    [DESKTOP_IPC_CHANNELS.companionMemoryRestore, "restoreCompanionMemory"],
  ] as const) {
    installHandler(channel, companionMemoryIdInputSchema, options, async (_event, _window, input) => {
      requireM2Route(contract, "room.home");
      assertEpoch(input.meta, activeWorkspaceEpoch);
      return gateway[mutate](input.memoryId, input.meta.requestId);
    }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryItemV1Schema);
  }

  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryDelete, companionMemoryIdInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.deleteCompanionMemory(input.memoryId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryDeleteOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.companionDailyGet, companionDailyGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionDailySummary(input.date, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionDailySummaryV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionPersonaGet, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionPersona(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionPersonaV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionPersonaPatch, companionPersonaPatchInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.patchCompanionPersona(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionPersonaMutationV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionPersonaReset, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.resetCompanionPersona(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionPersonaResetV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionConversationsList, companionConversationsListInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listCompanionConversations(input.limit, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionConversationListV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteGet, noteGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const note = await gateway.getNote(input.noteId, input.meta.requestId);
    if (activeWorkspaceId && note.workspaceId !== activeWorkspaceId) {
      throw new DesktopGatewayFailure("stale_workspace", "resync_first");
    }
    return note;
  }, undefined, noteDetailV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteList, noteListInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.library");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listNotes({ cursor: input.cursor, limit: input.limit, trashed: input.trashed }, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopNoteListPageSchema);

  // Writing a note is gated on `note.detail` (the note surfaces) plus the
  // workspace capability, so a member never fills in a title only to be
  // rejected at the end of the call.
  installHandler(DESKTOP_IPC_CHANNELS.noteCreate, noteCreateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["note.create"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return gateway.createNote(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, noteDetailV1Schema);

  // Removing and restoring a note are owner-only writes, gated the same way as
  // creating one: the note surfaces plus the workspace capability.
  installHandler(DESKTOP_IPC_CHANNELS.noteDelete, noteIdInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["note.delete"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return gateway.deleteNote(input.noteId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopNoteMutationResultSchema);

  installHandler(DESKTOP_IPC_CHANNELS.noteRestore, noteIdInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["note.restore"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return gateway.restoreNote(input.noteId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopNoteMutationResultSchema);

  // Reading a note's immutable version history is a read of the note surface.
  installHandler(DESKTOP_IPC_CHANNELS.noteVersions, noteVersionsInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listNoteVersions(
      input.noteId,
      input.currentVersionId,
      input.limit ?? 50,
      input.meta.requestId,
    );
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopNoteVersionListSchema);

  // Pointing the note back at an older version is a write of its content, so it
  // carries the same capability as saving one.
  installHandler(DESKTOP_IPC_CHANNELS.noteVersionRestore, noteVersionRestoreInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["note.save"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return gateway.restoreNoteVersion(input.noteId, input.versionId, input.baseVersionId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopNoteMutationResultSchema);

  // 往笔记正文里放一张图，写的是笔记内容，所以和保存一条版本同一道能力门控。
  // 服务端的上传路由自己另有 owner 校验，这里先挡在前面，免得非 owner 走完整个
  // 上传流程才被拒。
  installHandler(DESKTOP_IPC_CHANNELS.noteImageUpload, noteImageUploadInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["note.save"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return gateway.uploadNoteImage(input.noteId, input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, noteImageUploadResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.objectiveList, objectiveListInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "objective.library");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listObjectives({ lifecycle: input.lifecycle, cursor: input.cursor, limit: input.limit }, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, objectiveListPageV3Schema);

  installHandler(DESKTOP_IPC_CHANNELS.objectiveGet, objectiveGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "objective.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getObjective(input.objectiveId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, learningObjectiveSurfaceV3Schema);

  installHandler(DESKTOP_IPC_CHANNELS.understandingGetTopology, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "understanding.graph");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getUnderstandingTopology(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, understandingTopologySnapshotV3Schema);

  installHandler(DESKTOP_IPC_CHANNELS.searchGlobal, searchGlobalInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "search.global");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.searchGlobal(input.query, { type: input.type, limit: input.limit, cursor: input.cursor }, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, desktopSearchPageSchema);

  installHandler(DESKTOP_IPC_CHANNELS.noteSave, noteSaveInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const capabilities = await gateway.getCapabilities(input.meta.requestId);
    if (capabilities.actionCapabilities["note.save"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    const request = desktopNoteSaveRequestV1Schema.parse(input.request);
    const receipt = await gateway.saveNote(input.noteId, request, input.commandId, input.meta.requestId);
    if (activeWorkspaceId && receipt.workspaceId !== activeWorkspaceId) {
      throw new DesktopGatewayFailure("stale_workspace", "resync_first");
    }
    return receipt;
  }, undefined, noteSaveReceiptV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationStart, cardGenerationStartInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.start", input.meta.requestId);
    const request = desktopCreateCardGenerationRunRequestV2Schema.parse(input.request);
    const note = await gateway.getNote(input.noteId, input.meta.requestId);
    if (note.currentVersionId !== request.noteVersionId) {
      throw new DesktopGatewayFailure("conflict", "resync_first");
    }
    const accepted = await gateway.startCardGenerationRun(request, input.commandId, input.meta.requestId);
    ensureCardGenerationStream(accepted.runId);
    return accepted;
  }, undefined, cardGenerationJobAcceptedV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationGetRun, cardGenerationGetRunInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.start", input.meta.requestId);
    const snapshot = await gateway.getCardGenerationRun(input.runId, input.meta.requestId);
    ensureCardGenerationStream(snapshot.runId);
    return snapshot;
  }, undefined, cardGenerationRunSnapshotV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationGetCandidates, cardGenerationGetCandidatesInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.start", input.meta.requestId);
    ensureCardGenerationStream(input.runId);
    return gateway.getCardGenerationCandidates(input.runId, input.meta.requestId);
  }, undefined, cardGenerationCandidateListV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationReview, cardGenerationReviewInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.review", input.meta.requestId);
    const request = desktopCandidateReviewRequestV2Schema.parse(input.request);
    if (request.runId !== input.runId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    ensureCardGenerationStream(input.runId);
    return gateway.reviewCardGeneration(input.runId, request, input.commandId, input.meta.requestId);
  }, undefined, cardGenerationReviewResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationReveal, cardGenerationRevealInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.reveal", input.meta.requestId);
    const request = desktopRevealCandidateRequestV2Schema.parse(input.request);
    if (request.candidateId !== input.candidateId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    ensureCardGenerationStream(input.runId);
    return gateway.revealCardGenerationCandidate(input.runId, input.candidateId, request, input.commandId, input.meta.requestId);
  }, undefined, candidateRevealV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationLatestRun, noteIdInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.start", input.meta.requestId);
    return gateway.getLatestCardGenerationRun(input.noteId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, cardGenerationRunSnapshotV1Schema.nullable());

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationExposure, cardGenerationExposureInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.reveal", input.meta.requestId);
    return gateway.getCardGenerationExposure(input.runId, input.candidateId, input.revision, input.meta.requestId);
  }, undefined, cardGenerationExposureEligibilityV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationActivate, cardGenerationActivateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.activate", input.meta.requestId);
    const request = desktopCardGenerationActivationSelectionV1Schema.parse(input.request);
    if (request.runId !== input.runId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    ensureCardGenerationStream(input.runId);
    return gateway.activateCardGeneration(input.runId, request, input.commandId, input.meta.requestId);
  }, undefined, cardActivationReceiptDesktopV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationCancel, cardGenerationCancelInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.cancel", input.meta.requestId);
    ensureCardGenerationStream(input.runId);
    return gateway.cancelCardGeneration(input.runId, input.commandId, input.meta.requestId);
  }, undefined, cardGenerationCancelResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationRetry, cardGenerationRetryInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.retry", input.meta.requestId);
    // 重试会在同一 run 上重新出版本与候选，流必须跟着这条 run 走（与 cancel 同理）。
    ensureCardGenerationStream(input.runId);
    return gateway.retryCardGeneration(input.runId, input.commandId, input.meta.requestId);
  }, undefined, cardGenerationRetryResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationClose, cardGenerationCloseInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.cardGeneration");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    await requireActionCapability("card_generation.close", input.meta.requestId);
    ensureCardGenerationStream(input.runId);
    return gateway.closeCardGeneration(input.runId, input.expectedReviewDraftRevision, input.commandId, input.meta.requestId);
  }, undefined, cardGenerationCloseResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.capabilitiesGet, runtimeInputSchema, options, async (_event, _window, input) => {
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCapabilities(input.meta.requestId);
  }, (output) => safeWorkspaceEpoch(output), capabilityProjectionSchema);

  installHandler(DESKTOP_IPC_CHANNELS.windowGetState, runtimeInputSchema, options, (_event, window) => {
    return asWindowState(options.getWindowState(window));
  }, undefined, windowStateSnapshotV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.windowSetTitlebarTheme, windowThemeInputSchema, options, (_event, window, input) => {
    if (!options.setTitlebarTheme(window, input.theme)) throw new DesktopGatewayFailure("feature_disabled", "never");
    return { applied: true as const };
  }, undefined, titlebarThemeOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.windowFocus, runtimeInputSchema, options, (_event, window) => {
    window.focus();
    return { focused: true as const };
  }, undefined, focusOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.clipboardReadLinks, runtimeInputSchema, options, () => {
    // 外部复制的链接只在这里过一遍：剪贴板原文截断后提取候选地址，
    // 原文永不过桥，渲染层拿到的只有至多 3 个 http(s) 地址。
    const text = clipboard.readText().slice(0, 4000);
    return clipboardReadLinksResultSchema.parse({ urls: extractCandidateLinks(text) });
  }, undefined, clipboardReadLinksResultSchema);

  installHandler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe, subscribeInputSchema, options, (_event, window, input) => {
    if (input.topic.kind !== "runtime" && activeWorkspaceEpoch < 1) {
      throw new DesktopGatewayFailure("auth_required", "user_action");
    }
    const subscriptionId = generatedOpaqueId("subscription");
    bindWindowLifecycle(window);
    subscriptions.set(subscriptionId, { window, topic: input.topic });
    if (input.topic.kind === "learningRun") {
      ensureLearningRunStream(input.topic.runId);
      ensureTrackedLearningRunStreams();
    }
    if (input.topic.kind === "cardGeneration") {
      ensureCardGenerationStream(input.topic.runId);
      ensureTrackedCardGenerationStreams();
    }
    return { subscriptionId };
  }, undefined, subscriptionOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.subscriptionsUnsubscribe, unsubscribeInputSchema, options, (_event, window, input) => {
    const subscription = subscriptions.get(input.subscriptionId);
    if (!subscription || subscription.window !== window) throw new DesktopGatewayFailure("not_found", "never");
    subscriptions.delete(input.subscriptionId);
    if (!hasLearningRunSubscription()) stopLearningRunStreams();
    if (!hasCardGenerationSubscription()) stopCardGenerationStreams();
    return { closed: true as const };
  }, undefined, closedSubscriptionOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.reviewGetQueue, reviewQueueInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "review.queue");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getReviewQueue(input.cursor, input.limit, input.meta.requestId);
  }, undefined, reviewQueueV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.reviewDefer, reviewDeferInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "review.queue");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.deferReview(input.request, input.meta.requestId);
  }, undefined, reviewDeferResultV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.activityGetToday, activityGetTodayInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getTodayActivity(input.from, input.to, input.meta.requestId);
  }, undefined, todayActivityV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunGet, learningRunGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const snapshot = await gateway.getLearningRun(input.runId, input.meta.requestId);
    ensureLearningRunStream(snapshot.runId);
    syncFormalGuard(snapshot);
    return snapshot;
  }, undefined, learningRunPublicSnapshotV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunStart, learningRunStartInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const snapshot = await gateway.startLearningRun({ ...input.request, version: 2 }, input.commandId, input.meta.requestId);
    ensureLearningRunStream(snapshot.runId);
    syncFormalGuard(snapshot);
    emit("learningRun", { kind: "learning_run_changed", runId: snapshot.runId, revision: snapshot.runRevision }, activeWorkspaceEpoch);
    return snapshot;
  }, undefined, learningRunPublicSnapshotV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunGetDraft, learningRunDraftGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    ensureLearningRunStream(input.runId);
    return gateway.getLearningRunDraft(input.runId, input.taskId, input.meta.requestId);
  }, undefined, learningTaskDraftV2Schema.nullable());

  installHandler(DESKTOP_IPC_CHANNELS.learningRunSaveDraft, learningRunDraftSaveInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    ensureLearningRunStream(input.runId);
    const receipt = await gateway.saveLearningRunDraft(input.runId, input.taskId, input.request, input.commandId, input.meta.requestId);
    emit("learningRun", { kind: "learning_run_changed", runId: receipt.runId, revision: receipt.runRevision }, activeWorkspaceEpoch);
    maybeInjectPackagedLearningRunResponseLoss("draft");
    return receipt;
  }, undefined, learningTaskDraftWriteReceiptV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunSubmit, learningRunSubmitInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    ensureLearningRunStream(input.runId);
    const receipt = await gateway.submitLearningRunArtifact(input.runId, input.taskId, input.request, input.commandId, input.meta.requestId);
    try {
      syncFormalGuard(await gateway.getLearningRun(input.runId, input.meta.requestId));
    } catch {
      formalAssessmentGuard.failClosed("unknown");
    }
    emit("learningRun", { kind: "learning_run_changed", runId: receipt.runId, revision: receipt.runRevision }, activeWorkspaceEpoch);
    maybeInjectPackagedLearningRunResponseLoss("submit");
    return receipt;
  }, undefined, submitTaskArtifactReceiptV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunAction, learningRunActionInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    ensureLearningRunStream(input.runId);
    const response = await gateway.applyLearningRunAction(input.runId, input.request, input.commandId, input.meta.requestId);
    syncFormalGuardFromResult(response);
    emit("learningRun", { kind: "learning_run_changed", runId: response.runId, revision: response.snapshot.runRevision }, activeWorkspaceEpoch);
    maybeInjectPackagedLearningRunResponseLoss("action");
    return response;
  }, undefined, learningRunActionResponseV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunGetResult, learningRunGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    ensureLearningRunStream(input.runId);
    const result = await gateway.getLearningRunResult(input.runId, input.meta.requestId);
    // The result DTO intentionally carries no private phase field. Re-read the
    // strict public snapshot before returning it so a completed/ended run can
    // move the main-owned FormalAssessmentGuard into terminal release; a
    // transport/contract failure remains fail-closed and never unlocks the
    // Companion broker on the basis of a result-shaped payload alone.
    try {
      syncFormalGuard(await gateway.getLearningRun(input.runId, input.meta.requestId));
    } catch {
      formalAssessmentGuard.failClosed("unknown");
    }
    if (result.status === "learning_result" || result.status === "terminal_without_result") {
      // A terminal result is itself a server proof even when the immediately
      // adjacent snapshot is still one processing revision behind. Reuse the
      // main-owned key and enter the same release protocol; renderer code may
      // only complete it after its sensitive Player tree has unmounted.
      const guardState = formalAssessmentGuard.getSnapshot();
      if (guardState.state === "active" && guardState.runId === result.runId && guardState.runtimeEpoch !== null) {
        formalAssessmentGuard.beginRelease({ runId: guardState.runId, runtimeEpoch: guardState.runtimeEpoch }, true);
      }
    }
    emit("learningRun", { kind: "learning_run_changed", runId: result.runId, revision: result.status === "pending" ? result.runRevision : 0 }, activeWorkspaceEpoch);
    return result;
  }, undefined, getLearningRunResultResponseV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunGetReturnContract, learningRunGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    ensureLearningRunStream(input.runId);
    const contractValue = await gateway.getLearningRunReturnContract(input.runId, input.meta.requestId);
    await resolveReturnContract(contractValue);
    return contractValue;
  }, undefined, learningRunReturnContractV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunRecordActivityLease, learningRunLeaseInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    ensureLearningRunStream(input.runId);
    return gateway.recordLearningRunActivityLease(input.runId, input.request, input.meta.requestId);
  }, undefined, recordLearningRunActivityLeaseOutputV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunAbandon, learningRunAbandonInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    ensureLearningRunStream(input.runId);
    const response = await gateway.abandonLearningRun(input.runId, input.request, input.commandId, input.meta.requestId);
    syncFormalGuardFromResult(response);
    emit("learningRun", { kind: "learning_run_changed", runId: response.runId, revision: response.snapshot.runRevision }, activeWorkspaceEpoch);
    return response;
  }, undefined, learningRunActionResponseV2Schema);

  return contract;
}
