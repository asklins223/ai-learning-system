import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { learningDashboardV2Schema, type LearningDashboardV2 } from "@ailearn/shared";
import { allWorkspacesStatsOverviewSchema, type AllWorkspacesStatsOverviewV1 } from "@ailearn/shared/stats-overview-contracts";
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  desktopRouteKindM2Values,
  apiConnectionStateSchema,
  capabilityProjectionSchema,
  desktopTrustChallengeRequestSchema,
  desktopTrustChallengeResponseSchema,
  desktopTrustSignatureMessage,
  deploymentConfigSchema,
  emailSchema,
  uuidSchema,
  AVATAR_MAX_BYTES,
  authProfileResultV1Schema,
  authSurfaceManifestResultV1Schema,
  avatarObjectKeySchema,
  avatarUploadResultV1Schema,
  inviteCreatedV1Schema,
  inviteListResultV1Schema,
  markdownImportResultV1Schema,
  memberListResultV1Schema,
  renameWorkspaceResultV1Schema,
  dissolveWorkspaceResultV1Schema,
  transferWorkspaceOwnershipResultV1Schema,
  type DissolveWorkspaceResultV1,
  type TransferWorkspaceOwnershipResultV1,
  createWorkspaceResultV1Schema,
  searchDriftResultV1Schema,
  searchReindexResultV1Schema,
  type AuthProfileResultV1,
  type AvatarUploadResultV1,
  type InviteCreatedV1,
  type InviteListResultV1,
  type MarkdownImportResultV1,
  type MemberListResultV1,
  type RenameWorkspaceResultV1,
  type CreateWorkspaceResultV1,
  type SearchDriftResultV1,
  type SearchReindexResultV1,
  type DesktopCreateLearningRunV2Request,
  type DesktopCardGenerationActivationSelectionV1,
  type DesktopCandidateReviewRequestV2,
  type DesktopCreateCardGenerationRunRequestV2,
  type DesktopRevealCandidateRequestV2,
  type DesktopNoteSaveRequestV1,
  type DesktopLearningRunActionRequestV2,
  type DesktopLearningRunAbandonRequestV2,
  type DesktopPutLearningTaskDraftV2Request,
  type DesktopRecordLearningRunActivityLeaseRequestV2,
  type DesktopSubmitTaskArtifactV2,
  recordLearningRunActivityLeaseOutputV2Schema,
  localApiTrustSchema,
  nonEmptyStringSchema,
  runtimeSnapshotSchema,
  sessionContextSchema,
  companionChatStreamEventV1Schema,
  type ApiConnectionStateV1,
  type CapabilityProjectionV1,
  type CompanionChatStreamEventV1,
  type DeploymentConfigV1,
  type GatewayErrorCode,
  type LocalApiTrustV1,
  type AiDataPolicyV1,
  type NativeCapabilityProjectionV1,
  type RuntimeSnapshotV1,
  type SessionContextV1,
  type WorkspaceAiSettingsV1,
  type WorkspaceContextV1,
  type WorkspaceSummaryV1,
  windowStateSnapshotV1Schema,
  workspaceAiSettingsV1Schema,
  noteDocServerStateV1Schema,
  noteDocStateResultV1Schema,
  noteDocUploadResultV1Schema,
  type NoteDocStateResultV1,
  type NoteDocStreamEventV1,
  type NoteDocUploadResultV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  createNoteDocState,
  mergeNoteDocUpdates,
  type NoteDocState,
} from "./note-doc-state.ts";
import {
  NOTE_DOC_PREFIX,
  defaultNoteDocTransport,
  noteDocStreamUrl,
  toNoteDocStreamEvent,
  type NoteDocTransport,
  type NoteDocTransportHandle,
  type NoteDocWatchHandle,
} from "./note-doc-transport.ts";
import {
  getLearningRunResultResponseV2Schema,
  learningRunTargetRevealV2Schema,
  learningRunActionResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  learningRunReturnContractV2Schema,
  learningTaskDraftV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  submitTaskArtifactReceiptV2Schema,
} from "@ailearn/shared/learning-run-v2-contracts";
import { reviewDeferRequestV2Schema, reviewDeferResultV2Schema, reviewQueueV2Schema } from "@ailearn/shared/review-queue-v2-contracts";
import { todayActivityV1Schema } from "@ailearn/shared/activity-surface-contracts";
import { roomProjectionV1Schema, type RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import {
  companionAccountGlobalOffEventV1Schema,
  companionAccountStateV1Schema,
  companionAnswerModePreferenceV1Schema,
  companionVoicePreferenceV1Schema,
  companionOverviewSchema,
  onboardingTransitionResponseSchema,
  runtimeFenceResponseSchema,
  type CompanionAccountPatch,
  type CompanionAccountGlobalOffEventV1,
  type CompanionAccountStateV1,
  type CompanionOverview,
  type OnboardingTransitionRequest,
  type OnboardingTransitionResponse,
  type RuntimeFenceResponse,
} from "@ailearn/shared/companion-shell-contracts";
import { type TtsEngineV1 } from "@ailearn/shared/tts-voice-catalog";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfileV1Schema,
  type CompanionHomeProjectionV1,
  type CompanionRoomProfilePatchV1,
  type CompanionRoomProfileV1,
} from "@ailearn/shared/companion-home-contracts";
import {
  COMPANION_VOICE_MAX_AUDIO_BYTES,
  COMPANION_VOICE_SPEAK_VOICE,
  COMPANION_VOICE_TRANSCRIBE_MAX_AUDIO_BYTES,
  companionVoicePlaybackOutcomeResultV1Schema,
  companionVoiceSpeakResultV1Schema,
  companionVoiceTranscribeResultV1Schema,
  type CompanionVoicePlaybackOutcomeRequestV1,
  type CompanionVoicePlaybackOutcomeResultV1,
  type CompanionVoiceSpeakRequestV1,
  type CompanionVoiceSpeakSegmentRequestV2,
  type CompanionVoiceSpeakResultV1,
  type CompanionVoiceTranscribeRequestV1,
  type CompanionVoiceTranscribeResultV1,
} from "@ailearn/shared/companion-voice-contracts";
import {
  companionAgentRoutesListResultV1Schema,
  companionRunNodesListResultV1Schema,
  companionChatOpenThoughtResultV1Schema,
  companionChatEnsureResultV1Schema,
  companionChatListMessagesResultV1Schema,
  companionChatProposalDecideResultV1Schema,
  companionChatProposalGetResultV1Schema,
  companionChatSendTurnResultV1Schema,
  type CompanionAgentRoutesListRequestV1,
  type CompanionAgentRoutesListResultV1,
  type CompanionChatEnsureRequestV1,
  type CompanionChatEnsureResultV1,
  type CompanionChatListMessagesRequestV1,
  type CompanionChatListMessagesResultV1,
  type CompanionChatProposalDecideRequestV1,
  type CompanionChatProposalDecideResultV1,
  type CompanionChatProposalGetRequestV1,
  type CompanionChatProposalGetResultV1,
  type CompanionChatSendTurnRequestV1,
  type CompanionChatSendTurnResultV1,
  type CompanionChatOpenThoughtRequestV1,
  type CompanionChatOpenThoughtResultV1,
  type CompanionChatCancelRunRequestV1,
  type CompanionChatCancelRunResultV1,
  companionChatCancelRunResultV1Schema,
  type CompanionRunNodesListRequestV1,
  type CompanionRunNodesListResultV1,
} from "@ailearn/shared/companion-chat-desktop-contracts";
import {
  companionGroundedTutorGrantV1Schema,
  companionLearningContextV1Schema,
  companionLearningRunContextV1Schema,
  companionStreamEventV1Schema,
  type CompanionGroundedTutorGrantV1,
  type CompanionLearningContextV1,
  type CompanionLearningRunContextV1,
  type CreateCompanionLearningRunContextGrantRequestV1,
} from "@ailearn/shared/companion-conversation-contracts";
import {
  SOURCE_IMAGE_MAX_BYTES,
  SOURCE_IMAGE_MIME_TYPES,
  sourceImageGetResultV1Schema,
  type SourceImageGetRequestV1,
  type SourceImageGetResultV1,
} from "@ailearn/shared/source-image-contracts";
import {
  NOTE_IMAGE_UPLOAD_MAX_BYTES,
  noteImageUploadResultV1Schema,
  type NoteImageUploadRequestV1,
  type NoteImageUploadResultV1,
} from "@ailearn/shared/note-image-upload-contracts";
import {
  assistantDeliveryV2Schema,
  assistantContextSnapshotV2Schema,
  mainPageContextInputV2Schema,
  type AssistantContextSnapshotV2,
  type AssistantDeliveryV2,
  type MainPageContextInputV2,
} from "@ailearn/shared/companion-bridge-contracts";
import {
  companionDailySummaryV1Schema,
  companionDailyMonthV1Schema,
  companionActivityDeliveryV1Schema,
  companionActivityTimelineV1Schema,
  companionAuditDeleteResultV1Schema,
  companionHistoryClearResultV1Schema,
  companionHistoryPageV1Schema,
  companionHistorySearchV1Schema,
  companionMemoryItemV1Schema,
  companionMemoryClearResultV1Schema,
  companionMemoryConflictListV1Schema,
  companionMemoryConflictResolveResultV1Schema,
  companionMemoryListV1Schema,
  companionMemoryQueueResultV1Schema,
  companionMemoryStarMapV2Schema,
  companionPersonaMutationV1Schema,
  companionPersonaResetV1Schema,
  companionPersonaV1Schema,
  type CompanionDailySummaryV1,
  type CompanionDailyMonthV1,
  type CompanionActivityDeliveryV1,
  type CompanionActivityTimelineV1,
  type CompanionActivityAckRequestV1,
  type CompanionAuditDeleteResultV1,
  type CompanionHistoryClearResultV1,
  type CompanionHistoryPageV1,
  type CompanionHistoryQueryV1,
  type CompanionHistorySearchQueryV1,
  type CompanionHistorySearchV1,
  type CompanionMemoryItemV1,
  type CompanionMemoryCreateInputV1,
  type CompanionMemoryCorrectInputV1,
  type CompanionMemoryListQuery,
  type CompanionMemoryListV1,
  type CompanionMemoryStarMapV2,
  type CompanionPersonaMutationV1,
  type CompanionPersonaPatchV1,
  type CompanionPersonaResetV1,
  type CompanionPersonaV1,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { companionConversationV1Schema } from "@ailearn/shared/companion-conversation-contracts";
import {
  companionInvitationSchema,
  companionJourneyBootstrapSchema,
  companionJourneySchema,
  type CompanionInvitationActionRequest,
  type CompanionInvitationV2,
  type CompanionJourneyActionRequest,
  type CompanionJourneyBootstrap,
  type CompanionJourneyV2,
} from "@ailearn/shared/companion-journey-contracts";

import { noteDetailV1Schema, type NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema, type NoteSaveReceiptV1 } from "@ailearn/shared/note-save-contracts";
import { noteShareScopeReceiptV1Schema, type NoteShareScopeV1, type NoteShareScopeReceiptV1 } from "@ailearn/shared/note-share-contracts";
import {
  desktopSourceListPageSchema,
  desktopSourceDetailSchema,
  desktopSourceCreateResultV1Schema,
  desktopSourceNotesPageSchema,
  desktopNoteListPageSchema,
  desktopNoteVersionListSchema,
  desktopSearchPageSchema,
  type DesktopSourceListPage,
  type DesktopSourceDetail,
  type DesktopSourceCreateResultV1,
  type DesktopSourceCreateRequest,
  type DesktopSourceNotesPage,
  type DesktopSourceNoteResult,
  type DesktopSourceUpdateRequest,
  type DesktopSourceArchiveResult,
  type DesktopSourceReparseResult,
  desktopSourceRestoreResultSchema,
  type DesktopSourceRestoreResult,
  type DesktopNoteListPage,
  type DesktopNoteCreateRequest,
  type DesktopNoteMutationResult,
  type DesktopNoteVersionList,
  type DesktopSearchPage,
  type DesktopAiAuditPageV1,
  desktopAiAuditPageV1Schema,
} from "@ailearn/shared/desktop-surface-contracts";
import { objectiveListPageV3Schema, learningObjectiveSurfaceV3Schema, type ObjectiveListPageV3, type LearningObjectiveSurfaceV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import { understandingTopologySnapshotV3Schema, type UnderstandingTopologySnapshotV3 } from "@ailearn/shared/understanding-topology-v3-contracts";
import {
  activateCardCandidatesRequestV2Schema,
  candidateActionCommandV2Schema,
  candidateRevealV2Schema,
  cardActivationReceiptV2Schema,
  cardPlanV2Schema,
} from "@ailearn/shared/card-generation-v2-contracts";
import {
  cardActivationReceiptDesktopV1Schema,
  cardGenerationActiveSummaryListV1Schema,
  cardGenerationCandidateListV1Schema,
  cardGenerationCloseResultV1Schema,
  cardGenerationExposureEligibilityV1Schema,
  cardGenerationJobAcceptedV1Schema,
  cardGenerationReviewResultV1Schema,
  cardGenerationRunServerViewV2Schema,
  cardGenerationRunSnapshotV1Schema,
  cardGenerationCancelResultV1Schema,
  cardGenerationRetryResultV1Schema,
  projectCardActivationReceiptV1,
  projectCardGenerationRunSnapshotV1,
  type CardGenerationRunServerViewV2,
  type CardGenerationRunSnapshotV1,
  type CardGenerationActiveSummaryV1,
  type CardGenerationActiveSummaryListV1,
  type CardGenerationCandidateListV1,
  type CardGenerationJobAcceptedV1,
  type CardGenerationReviewResultV1,
  type CardGenerationCloseResultV1,
  type CardGenerationCancelResultV1,
  type CardGenerationRetryResultV1,
  type CardGenerationExposureEligibilityV1,
  type CardActivationReceiptDesktopV1,
} from "@ailearn/shared/card-generation-desktop-contracts";
import { projectLearningDashboardToRoomProjection } from "./room-projection";
import { computeClientReviewHashV2 } from "@ailearn/shared/card-generation-v2-hashing";

// 仅供 main 进程确保内部对话分段使用。产品界面与 renderer 合同不暴露
// conversation 列表或标识，连续历史统一走 /companion/history。
const companionActivityTimelineWireSchema = z.strictObject({
  items: z.array(assistantDeliveryV2Schema.extend({ expired: z.boolean() })).max(100),
  nextCursor: z.number().int().min(0),
  serverTime: z.string().datetime({ offset: true }),
});

function projectCompanionDelivery(delivery: AssistantDeliveryV2 & { expired?: boolean }): CompanionActivityDeliveryV1 {
  const payload = delivery.payloadRef;
  const label = payload.kind === "system_event"
    ? payload.text ?? "伴星状态已更新"
    : payload.kind === "memory_item"
      ? payload.contentPreview ?? "有一条记忆候选等待查看"
      : payload.kind === "proposal"
        ? "有一项操作等待你确认"
        : payload.kind === "action_result"
          ? "伴星操作已有结果"
          : "收到一条伴星消息";
  const target: CompanionActivityDeliveryV1["target"] = payload.kind === "message"
    ? { kind: "dialogue", messageId: payload.messageId }
    : payload.kind === "proposal" || payload.kind === "action_result"
      ? { kind: "proposal", proposalId: payload.proposalId }
      : payload.kind === "memory_item"
        ? { kind: "memory", memoryId: payload.memoryItemId }
        : { kind: "none" };
  return companionActivityDeliveryV1Schema.parse({
    version: 1,
    deliveryId: delivery.deliveryId,
    inboxSequence: delivery.inboxSequence,
    state: delivery.state,
    kind: delivery.kind,
    label,
    target,
    expired: delivery.expired ?? new Date(delivery.expiresAt).getTime() <= Date.now(),
    createdAt: delivery.createdAt,
    expiresAt: delivery.expiresAt,
  });
}

const DEFAULT_API_ORIGIN = "http://127.0.0.1:4000";

const rawAuthResponseSchema = z.strictObject({
  token: nonEmptyStringSchema,
  ctx: z.strictObject({
    userId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    membershipRole: z.string().nullable().optional(),
    // The API includes the server-authoritative workspace boundary in every
    // newly issued session. Session loading reads it again from /auth/me, but
    // the strict login envelope must still accept the field.
    workspaceEpoch: z.number().int().positive().optional(),
  }),
  // `login` / `register` 会带这一份名册，`switch-workspace` **不带**（它只回 token 与 ctx）。
  // 所以它是可选的：以前写成必填，切空间每次都 `unsupported_contract` —— 服务端已经切过去
  // 并轮换掉旧会话，客户端却因为解析失败没拿到新 token，下一次请求 401、弹重认证门，
  // 重认证又是"重新登录"，于是人回到默认空间（2026-09-21 实窗量到的那条即此）。
  // 之所以还声明着而不是删掉：`strictObject` 要能收下服务端完整的登录信封，
  // 而这个数组在本文件里没有任何读取方。
  workspaces: z.array(z.strictObject({
    workspaceId: z.string().uuid(),
    workspaceName: nonEmptyStringSchema,
    role: z.enum(["owner", "member"]),
    workspaceType: z.enum(["personal", "collaborative"]),
    isPersonal: z.boolean(),
    leftAt: z.string().datetime({ offset: true }).nullable(),
  })).optional(),
  // The API also returns a CSRF token for cookie-authenticated consumers.
  // Bearer-token desktop requests do not persist or expose it, but the strict
  // response contract must accept the server's complete login envelope.
  csrfToken: nonEmptyStringSchema.optional(),
});

const rawAuthMeSchema = z.strictObject({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  email: emailSchema,
  role: z.enum(["owner", "member"]),
  displayName: nonEmptyStringSchema.nullable(),
  avatarUrl: z.string().nullable(),
  workspaceName: nonEmptyStringSchema,
  workspaceType: z.enum(["personal", "collaborative"]),
  isPersonal: z.boolean(),
  personalWorkspaceId: z.string().uuid().nullable(),
  // 0261：服务端边界令牌。**必填**——它是本机 epoch 的权威值，缺了就该按契约不符
  // 拒掉，而不是悄悄退回本地计数（那正是审查说的"数字只活在客户端"）。
  workspaceEpoch: z.number().int().positive(),
});

const rawWorkspaceListSchema = z.strictObject({
  workspaces: z.array(z.strictObject({
    workspaceId: z.string().uuid(),
    workspaceName: nonEmptyStringSchema,
    role: z.enum(["owner", "member"]),
    workspaceType: z.enum(["personal", "collaborative"]),
    isPersonal: z.boolean(),
    leftAt: z.string().datetime({ offset: true }).nullable(),
  })),
});

const rawHealthSchema = z.strictObject({
  status: z.literal("ok"),
  service: z.literal("api"),
  timestamp: z.string().datetime({ offset: true }),
});

const rawReadinessSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  service: z.literal("api"),
  timestamp: z.string().datetime({ offset: true }),
}).passthrough();

/**
 * Where a sign-in can outlive the process. Implemented by the Electron-backed
 * store in `session-credential-store.ts` and faked in tests, so the gateway
 * itself never imports `electron`.
 */
export type SessionCredentialStore = {
  /** Whether the platform can encrypt a credential at rest right now. */
  readonly available: boolean;
  /** Synchronous peek used by the runtime snapshot, before any adoption. */
  hasStored(): boolean;
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
};

/** 一篇笔记的本机文档与待发增量。 */
type NoteDocLocalSession = {
  state: NoteDocState;
  /** 是否已经从服务端取到过起点。没取到过就不能本机差分（见 `noteDocLocalSessions`）。 */
  seeded: boolean;
  revision: number;
  savedAt: string;
  /** 攒着待重发的增量，按提交顺序。 */
  pending: string[];
  /**
   * 最后一次看到这篇归属时留下的那一位。离线打开这篇时"要不要建长连接"以它为准——
   * 猜不得：猜成 shared 会给一篇「仅自己可见」的笔记开一条实时连接。
   */
  shareScope: NoteShareScopeV1 | null;
};

/**
 * 待发动量的条数上限。超它不是"再多攒一条"而是"这台机器的网络已经长到该让人
 * 知道了"——继续无声累积的话，恢复时一次要交几百条，而中间任何一条被拒都无从解释。
 */
const NOTE_DOC_PENDING_MAX = 200;

/** `syncNoteDocUpdate` 的出口：三条路各自说清自己走到了哪一步。 */
export type NoteDocSyncOutcome = {
  via: "uploaded" | "unchanged" | "queued";
  revision: number;
  savedAt: string;
};

/** 没网与"服务在但没应答"是同一类：本机那份还能接着写，权限类错误不能。 */
function isOfflineFailure(error: unknown): boolean {
  return error instanceof DesktopGatewayFailure
    && (error.code === "api_unavailable" || error.code === "network_timeout");
}

export class DesktopGatewayFailure extends Error {
  readonly code: GatewayErrorCode;
  readonly retry: "never" | "user_action" | "safe_retry" | "resync_first";
  readonly httpStatus?: number;
  readonly retryAfter?: string;
  readonly localEffect?: "credential_cleared" | "request_cancelled";

  constructor(
    code: GatewayErrorCode,
    retry: "never" | "user_action" | "safe_retry" | "resync_first",
    options: { httpStatus?: number; retryAfter?: string; localEffect?: "credential_cleared" | "request_cancelled" } = {},
  ) {
    super(code);
    this.name = "DesktopGatewayFailure";
    this.code = code;
    this.retry = retry;
    this.httpStatus = options.httpStatus;
    this.retryAfter = options.retryAfter;
    this.localEffect = options.localEffect;
  }
}

type GatewayConfiguration = {
  readonly config: DeploymentConfigV1;
  readonly pairingSecret: Buffer | null;
};

function readPairingSecret(value: string | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const secret = Buffer.from(value, "base64url");
  return secret.length >= 32 && secret.toString("base64url") === value ? secret : null;
}

function readConfiguration(env: NodeJS.ProcessEnv): { ok: true; value: GatewayConfiguration } | { ok: false; reason: "missing" | "invalid" } {
  const apiOrigin = env.DESKTOP_API_ORIGIN?.trim() || DEFAULT_API_ORIGIN;
  const expectedDomainSchemaRevision = env.AILEARN_DOMAIN_SCHEMA_REVISION?.trim();
  const configRevision = env.DESKTOP_DEPLOYMENT_CONFIG_REVISION?.trim() || "desktop-dev-config-v1";

  if (!expectedDomainSchemaRevision) return { ok: false, reason: "missing" };

  if (apiOrigin.startsWith("https://")) {
    const parsed = deploymentConfigSchema.safeParse({
      version: 1,
      mode: "remote_https",
      apiOrigin,
      expectedDomainSchemaRevision,
      configRevision,
    });
    return parsed.success ? { ok: true, value: { config: parsed.data, pairingSecret: null } } : { ok: false, reason: "invalid" };
  }

  const pairingKeyId = env.AILEARN_DESKTOP_PAIRING_KEY_ID?.trim();
  const pairingSecret = readPairingSecret(env.AILEARN_DESKTOP_PAIRING_SECRET?.trim());
  if (!pairingKeyId || !pairingSecret) return { ok: false, reason: "missing" };

  const parsed = deploymentConfigSchema.safeParse({
    version: 1,
    mode: "local_loopback",
    apiOrigin,
    localServiceTrust: "hmac_pairing_v1",
    expectedServiceId: DESKTOP_API_SERVICE_ID,
    expectedDomainSchemaRevision,
    pairingKeyId,
    configRevision,
  });
  return parsed.success ? { ok: true, value: { config: parsed.data, pairingSecret } } : { ok: false, reason: "invalid" };
}

function retryFor(code: GatewayErrorCode): DesktopGatewayFailure["retry"] {
  if (code === "api_unavailable" || code === "network_timeout") return "safe_retry";
  if (code === "result_unknown") return "resync_first";
  if (code === "api_untrusted" || code === "configuration_error") return "user_action";
  return "never";
}

/**
 * 桌面壳的本机能力。这些是**这个客户端**的事实，服务端不可能知道，所以
 * 主进程给出唯一一份，并在 capabilities.get 的边界上覆盖服务端的 fail-closed 占位。
 *
 * 判定依据是「客户端是否真的存在这条链路」，不是「平台理论上能不能做」：
 * 每一项对应一个必须存在的 IPC 通道，通道存在才算可用。这样以后接上剪贴板、
 * 通知、自动更新或 ASR 时，这里会随通道一起变成 available，不需要记得回来改常量。
 *
 * `live2d` 是唯一给不出结论的一项：模型是否真的加载成功只有渲染层知道，
 * 所以这里保持 unavailable，设置页读渲染层上报的真实状态（room-store 的
 * `live2dStatus`），不拿这个字段冒充。
 */
/**
 * 能力投影的本地有效期（M12）。取值 5 秒的判据：它要长到盖住"用户连着点几个受控按钮"
 * 这一整段（每个按钮前面那次往返就是这么被省掉的），又要短到运维在服务端翻一个
 * feature flag 之后，最坏情况只需要等一次呼吸就能在新一轮操作里生效。
 */
const CAPABILITY_CACHE_TTL_MS = 5_000;

const NATIVE_CAPABILITY_CHANNELS: Readonly<Record<keyof NativeCapabilityProjectionV1, string | null>> = {
  filePicker: null,
  clipboard: DESKTOP_IPC_CHANNELS.clipboardReadLinks,
  notifications: null,
  // ASR：2026-09-18 起接了真实语音链路——本地 SenseVoice（WASM）优先，云
  // `/voice/transcribe` 兜底，通道存在即视为可用。
  asr: DESKTOP_IPC_CHANNELS.companionVoiceTranscribe,
  updates: null,
  live2d: null,
};

function nativeCapabilities(): NativeCapabilityProjectionV1 {
  const registered = new Set<string>(Object.values(DESKTOP_IPC_CHANNELS));
  return Object.fromEntries(
    Object.entries(NATIVE_CAPABILITY_CHANNELS).map(([key, channel]) => [
      key,
      channel !== null && registered.has(channel) ? "available" : "unavailable",
    ]),
  ) as NativeCapabilityProjectionV1;
}

function parseSseSequence(block: string): number | null {
  const idLine = block.split(/\r?\n/).find((line) => line.startsWith("id:"));
  if (!idLine) return null;
  const value = Number(idLine.slice(3).trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 单帧 payload 的过桥上限：伴星事件体常态 <1KB，超过即视为异常帧丢弃。 */
const COMPANION_CHAT_EVENT_MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * 伴星 SSE 单帧 → 可过桥的最小投影（`companionChatStreamEventV1Schema`）。
 *
 * 主进程是信任边界：畸形 JSON、缺字段、payload 非对象或超限一律返回 null 丢弃，
 * 绝不把原始 SSE 文本转发给渲染层。事件类型不做白名单——DB 允许 18 种，桌面端
 * 只对认识的那几种做事，未知类型照样过桥但不渲染。
 */
export function parseCompanionSseFrame(block: string): CompanionChatStreamEventV1 | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const envelope = companionStreamEventV1Schema.safeParse(raw);
  if (!envelope.success) return null;
  const payload = envelope.data.type === "voice.segment.ready"
    ? (({ synthesisText: _privateSynthesisText, ...rendererSafe }) => rendererSafe)(envelope.data.payload)
    : envelope.data.payload;
  if (JSON.stringify(payload).length > COMPANION_CHAT_EVENT_MAX_PAYLOAD_BYTES) return null;
  const parsed = companionChatStreamEventV1Schema.safeParse({
    seq: envelope.data.seq,
    runId: envelope.data.runId,
    generation: envelope.data.generation,
    eventType: envelope.data.type,
    payload,
  });
  return parsed.success ? parsed.data : null;
}

export function parseCompanionAccountSseFrame(block: string): CompanionAccountGlobalOffEventV1 | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = companionAccountGlobalOffEventV1Schema.safeParse(JSON.parse(dataLines.join("\n")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Durable inbox frames are validated in main before becoming renderer invalidations. */
export function parseCompanionInboxSseFrame(block: string): AssistantDeliveryV2 | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = assistantDeliveryV2Schema.safeParse(JSON.parse(dataLines.join("\n")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function waitForStreamRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * SSE 断线重连的阶梯（0269 轮 M17）。
 *
 * 以前 5 条流（account / inbox / 学习轮 / 制卡 / 伴星对话）在"流自然结束"和"抛错"两条
 * 出口上都写死固定 1000 毫秒：本地 API 一停，主进程就变成每秒最多 5 次
 * 重连，而每一次 `ensureConnected()` 会把整套 HMAC 信任握手 + `/health` 再走一遍——
 * 那正好是服务在恢复期最需要喘息的时候。退避到 30s 封顶，并带 ±25% 抖动，避免五条流
 * 永远在同一毫秒一起撞上去。
 *
 * 归零点在"真的读到一帧"上（见各 watcher 里的 `streamRetryAttempt = 0`）：能收到帧就
 * 说明这条线是通的，不该再背着失败历史。
 */
/** 只为读出一个 `error` token 而碰失败响应的 body，给它一个比任何正常响应都小的上限。 */
const DOMAIN_ERROR_BODY_MAX_BYTES = 4_096;

const STREAM_RETRY_BASE_MS = 1_000;
const STREAM_RETRY_CEILING_MS = 30_000;

function streamRetryDelayMs(attempt: number): number {
  const exponential = Math.min(
    STREAM_RETRY_CEILING_MS,
    STREAM_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 10)),
  );
  // ±25% 抖动：五条流同时断开时不该同时重连。
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

function roomActiveGenerationErrorReason(error: unknown): "upstream_unavailable" | "unsupported_contract" | "permission_denied" | "stale_workspace" | "route_not_available" {
  if (error instanceof DesktopGatewayFailure) {
    if (error.code === "unsupported_contract") return "unsupported_contract";
    if (error.code === "forbidden") return "permission_denied";
    if (error.code === "stale_workspace") return "stale_workspace";
    if (error.code === "route_not_available") return "route_not_available";
  }
  return "upstream_unavailable";
}

export class DesktopGateway {
  private readonly configuration: GatewayConfiguration | null;
  private readonly configurationError: "missing" | "invalid" | null;
  private connection: ApiConnectionStateV1;
  private trust: LocalApiTrustV1;
  private token: string | null = null;
  /**
   * 这个人**进来时**在哪一个空间。重认证等于重新登录，而登录落在账号默认空间上，
   * 不在这里留一份的话，切空间会被那道门吞掉（见 `reauthenticate`）。
   */
  private sessionWorkspaceReturn: { email: string; workspaceId: string } | null = null;
  private currentSession: SessionContextV1 | null = null;
  private transportEpoch = 0;
  private workspaceEpoch = 1;
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly commandIdempotency = new Map<string, string>();
  private readonly deviceSessionId = randomUUID();
  private readonly companionAccountSessionId = randomUUID();
  private readonly companionDeliveryLeases = new Map<string, { readonly inboxSequence: number; readonly leaseToken: string }>();
  private companionBridgeContext: { readonly page: MainPageContextInputV2; snapshot: AssistantContextSnapshotV2 } | null = null;
  private companionBridgeRenewTimer: ReturnType<typeof setInterval> | null = null;
  private companionBridgeGeneration = 0;
  private readonly credentials: SessionCredentialStore | null;
  private readonly noteDocTransport: NoteDocTransport;
  /**
   * 一篇笔记在本机的那份文档，以及还没送达服务端的增量（批次 4.4 的离线那一半）。
   *
   * 为什么必须留着文档而不是每次都重新取起点：离线时取不到起点，而**没有共同祖先就
   * 不能凭空造增量**（从行里拼一棵树会被服务端判成"另一篇文档"，一改就复制块）。
   * 留着它，断网期间的提交仍然是在同一份状态上做差分，恢复后按序交上去即可。
   */
  private readonly noteDocLocalSessions = new Map<string, NoteDocLocalSession>();
  /** How the current credential is held; reported to the renderer as truth. */
  private credentialPersistence: "memory" | "safe_storage" = "memory";
  private credentialRestored = false;
  /** True while `token` came off disk, so a 401 can retire it instead of confusing the user. */
  private tokenIsRestored = false;
  private roomProjectionCache: {
    readonly etag: string;
    readonly workspaceEpoch: number;
    readonly dashboard: LearningDashboardV2;
    readonly value: RoomProjectionV1;
  } | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: {
      credentials?: SessionCredentialStore | null;
      /**
       * 协同传输的实现。默认用真的 Hocuspocus provider；测试里换成假的，才能断言
       * "该不该建这条连接"（门控）与"帧怎么转发"，而不是去连一个真服务端。
       */
      noteDocTransport?: NoteDocTransport;
    } = {},
  ) {
    this.credentials = options.credentials ?? null;
    this.noteDocTransport = options.noteDocTransport ?? defaultNoteDocTransport;
    const result = readConfiguration(env);
    const configuredTrustOrigin = result.ok && result.value.config.mode === "local_loopback"
      ? result.value.config.apiOrigin
      : DEFAULT_API_ORIGIN;
    if (result.ok) {
      this.configuration = result.value;
      this.configurationError = null;
      this.connection = { version: 1, kind: "checking", originKind: result.value.config.mode };
    } else {
      this.configuration = null;
      this.configurationError = result.reason;
      this.connection = {
        version: 1,
        kind: "configuration_error",
        reason: result.reason === "missing" ? "pairing_secret_missing" : "invalid_deployment_config",
      };
    }
    this.trust = {
      version: 1,
      state: "untrusted",
      origin: configuredTrustOrigin,
      serviceId: DESKTOP_API_SERVICE_ID,
      transportEpoch: 1,
    };
  }

  getConnectionState(): ApiConnectionStateV1 {
    return apiConnectionStateSchema.parse(this.connection);
  }

  getTrust(): LocalApiTrustV1 {
    return localApiTrustSchema.parse(this.trust);
  }

  getDeploymentConfig(): DeploymentConfigV1 | null {
    return this.configuration?.config ?? null;
  }

  getRuntimeSnapshot(windowState: RuntimeSnapshotV1["windowState"], reducedMotion: boolean): RuntimeSnapshotV1 {
    return runtimeSnapshotSchema.parse({
      version: 1,
      contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
      appId: "ailearn-desktop-client",
      appVersion: this.env.npm_package_version?.trim() || "0.1.0",
      platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
      windowState: windowStateSnapshotV1Schema.parse(windowState),
      apiConnection: this.getConnectionState(),
      nativeCapabilities: nativeCapabilities(),
      reducedMotion,
      startupRevision: 1,
      sessionCredential: {
        persistence: this.credentials?.available ? "safe_storage" : "memory",
        stored: this.credentials?.hasStored() ?? false,
      },
    });
  }

  async connect(requestId?: string): Promise<ApiConnectionStateV1> {
    if (!this.configuration) {
      this.connection = {
        version: 1,
        kind: "configuration_error",
        reason: this.configurationError === "missing" ? "pairing_secret_missing" : "invalid_deployment_config",
      };
      throw new DesktopGatewayFailure("configuration_error", retryFor("configuration_error"));
    }

    this.connection = { version: 1, kind: "checking", originKind: this.configuration.config.mode };
    try {
      if (this.configuration.config.mode === "local_loopback") await this.performLocalTrust(this.configuration, requestId);
      else await this.performRemoteHealth(this.configuration.config, requestId);
      return this.getConnectionState();
    } catch (error) {
      if (error instanceof DesktopGatewayFailure) throw error;
      this.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    }
  }

  async retryConnection(requestId?: string): Promise<ApiConnectionStateV1> {
    await this.connect(requestId);
    return this.getConnectionState();
  }

  async getHealth(requestId?: string): Promise<{ status: "ok" | "degraded"; checkedAt: string; latencyMs: number; instanceId?: string; domainSchemaRevision: string }> {
    await this.ensureConnected(requestId);
    const startedAt = Date.now();
    const result = await this.request("/health", { method: "GET" }, false, true, requestId);
    const parsed = rawHealthSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    const readiness = await this.request("/ready", { method: "GET" }, false, false, requestId, undefined, true);
    const readinessParsed = rawReadinessSchema.safeParse(readiness.body);
    if (!readinessParsed.success || (readiness.status < 300 && readinessParsed.data.status !== "ready") || (readiness.status >= 300 && readinessParsed.data.status !== "not_ready")) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    return {
      status: readinessParsed.data.status === "ready" ? "ok" : "degraded",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      instanceId: this.trust.state === "trusted" ? this.trust.instanceId : undefined,
      domainSchemaRevision: this.configuration?.config.expectedDomainSchemaRevision ?? "unknown",
    };
  }

  /**
   * Adopts a credential left by a previous launch, once per process and before
   * the first authenticated call. Adoption is lazy so app start-up never waits
   * on disk, and a failure here is never fatal — it just means anonymous.
   */
  private async restoreStoredCredential(): Promise<void> {
    if (this.credentialRestored) return;
    this.credentialRestored = true;
    const store = this.credentials;
    if (!store?.available || this.token) return;
    const stored = await store.load().catch(() => null);
    if (!stored) return;
    this.token = stored;
    this.tokenIsRestored = true;
    this.credentialPersistence = "safe_storage";
  }

  /**
   * Records the persistence decision for the credential in hand. A refused or
   * failed write degrades to memory rather than failing the sign-in.
   */
  private async persistCredential(remember: boolean): Promise<void> {
    const store = this.credentials;
    this.tokenIsRestored = false;
    if (!remember || !store?.available || !this.token) {
      this.credentialPersistence = "memory";
      if (store?.available) await store.clear().catch(() => undefined);
      return;
    }
    try {
      await store.save(this.token);
      this.credentialPersistence = "safe_storage";
    } catch {
      this.credentialPersistence = "memory";
      await store.clear().catch(() => undefined);
    }
  }

  /** Retires a credential that turned out to be dead, so it is never replayed. */
  private async discardStoredCredential(): Promise<void> {
    this.token = null;
    this.tokenIsRestored = false;
    this.currentSession = null;
    this.credentialPersistence = "memory";
    await this.credentials?.clear().catch(() => undefined);
  }

  async login(email: string, password: string, requestId?: string, remember?: boolean): Promise<SessionContextV1> {
    await this.ensureConnected(requestId);
    await this.clearCompanionBridgeContext(requestId).catch(() => undefined);
    const persist = remember ?? this.credentialPersistence === "safe_storage";
    const result = await this.request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember: persist }),
    }, false, true, requestId, "invalid_credentials");
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.commandIdempotency.clear();
    this.clearCompanionRuntimeState();
    this.token = parsed.data.token;
    this.workspaceEpoch = 1;
    this.roomProjectionCache = null;
    // 能力投影与房间投影同生命周期：换身份/换空间之后它必须重来，不能靠 epoch 相等蒙过去
    // （两处都会把 workspaceEpoch 复位成 1，复位之后"和缓存里的 epoch 一样"是必然成立）。
    this.forgetCapabilities();
    await this.persistCredential(persist);
    return this.loadSession(requestId);
  }

  async register(email: string, password: string, inviteToken?: string, displayName?: string, requestId?: string, remember?: boolean): Promise<SessionContextV1> {
    await this.ensureConnected(requestId);
    await this.clearCompanionBridgeContext(requestId).catch(() => undefined);
    const persist = remember ?? this.credentialPersistence === "safe_storage";
    const body: { email: string; password: string; inviteToken?: string; displayName?: string } = { email, password };
    if (inviteToken) body.inviteToken = inviteToken;
    if (displayName) body.displayName = displayName;
    const result = await this.request("/auth/register-v2", { method: "POST", body: JSON.stringify(body) }, false, true, requestId, "invalid_credentials");
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.commandIdempotency.clear();
    this.clearCompanionRuntimeState();
    this.token = parsed.data.token;
    this.workspaceEpoch = 1;
    this.roomProjectionCache = null;
    // 能力投影与房间投影同生命周期：换身份/换空间之后它必须重来，不能靠 epoch 相等蒙过去
    // （两处都会把 workspaceEpoch 复位成 1，复位之后"和缓存里的 epoch 一样"是必然成立）。
    this.forgetCapabilities();
    await this.persistCredential(persist);
    return this.loadSession(requestId);
  }

  async getSession(requestId?: string): Promise<SessionContextV1> {
    await this.ensureConnected(requestId);
    if (!this.token) {
      this.currentSession = sessionContextSchema.parse({
        version: 1,
        status: "anonymous",
        user: null,
        workspace: null,
        membership: null,
        capabilities: null,
        workspaceEpoch: 0,
        credentialPersistence: "none",
      });
      return this.currentSession;
    }
    return this.loadSession(requestId);
  }

  async getAuthSurfaceManifest(requestId?: string) {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/public/auth-surface-manifest",
      { method: "GET" },
      false,
      true,
      requestId,
    );
    const parsed = authSurfaceManifestResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async logout(requestId?: string): Promise<{ loggedOut: true; serverRevoked: boolean }> {
    await this.clearCompanionBridgeContext(requestId).catch(() => undefined);
    const token = this.token;
    this.token = null;
    this.currentSession = null;
    // 退登是人自己要走，下一次登录落回默认空间就是对的，不该被拖回上一个空间。
    this.sessionWorkspaceReturn = null;
    this.roomProjectionCache = null;
    this.commandIdempotency.clear();
    this.clearCompanionRuntimeState();
    this.tokenIsRestored = false;
    this.credentialPersistence = "memory";
    // Local sign-out is authoritative: the stored credential goes even when the
    // server revoke cannot be reached.
    await this.credentials?.clear().catch(() => undefined);
    if (!token) return { loggedOut: true, serverRevoked: false };
    try {
      await this.ensureConnected(requestId);
      await this.request("/auth/logout", { method: "POST" }, true, true, requestId);
      return { loggedOut: true, serverRevoked: true };
    } catch (error) {
      if (error instanceof DesktopGatewayFailure) {
        throw new DesktopGatewayFailure(error.code, error.retry, {
          httpStatus: error.httpStatus,
          retryAfter: error.retryAfter,
          localEffect: "credential_cleared",
        });
      }
      throw error;
    }
  }

  async reauthenticate(password: string, requestId?: string): Promise<SessionContextV1> {
    const current = this.currentSession ?? await this.getSession(requestId);
    if (current.status !== "authenticated") throw new DesktopGatewayFailure("reauth_required", "user_action");
    // 必须在 login 之前取：`loadSession` 会把这一位刷成"新会话所在的空间"，
    // 先登录再读就永远等于新会话，那个人刚离开的空间就查不到了。
    const wanted = this.sessionWorkspaceReturn;
    const session = await this.login(current.user.email, password, requestId);
    // 重新登录拿到的是这个账号**默认那一个**空间的会话。人本来在协作空间里，
    // 门开完却回到个人空间——切空间那一步等于被这道门吞掉了（2026-09-21 实窗量到的：
    // 成员点「验收空间 / 成员 · 只读」，服务端已经切过去，重认证之后胶囊又是个人空间）。
    // 所以门开完要把人送回他进来时那一个空间；回不去（已被移出、空间没了）不是错误，
    // 落回默认那个就行，硬抛错会让人连登录都完不成。
    if (!wanted || wanted.email !== current.user.email || session.status !== "authenticated") return session;
    if (session.workspace?.workspaceId === wanted.workspaceId) return session;
    try {
      return await this.switchWorkspace(wanted.workspaceId, requestId);
    } catch {
      return session;
    }
  }

  /**
   * ADR-0009: 已登录用户凭邀请码加入协作工作区。切换由后续的 workspace.list /
   * workspace.switch 决定，这里只负责兑换邀请码并重新读取会话。
   */
  async joinWorkspace(inviteToken: string, requestId?: string): Promise<SessionContextV1> {
    await this.ensureConnected(requestId);
    await this.request("/auth/join-workspace", {
      method: "POST",
      body: JSON.stringify({ inviteToken }),
    }, true, true, requestId);
    this.roomProjectionCache = null;
    return this.loadSession(requestId);
  }

  async changePassword(currentPassword: string, newPassword: string, requestId?: string): Promise<{ changed: true; sessionsRevoked: true }> {
    await this.ensureConnected(requestId);
    await this.clearCompanionBridgeContext(requestId).catch(() => undefined);
    await this.request("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }, true, true, requestId);
    this.token = null;
    this.currentSession = null;
    this.roomProjectionCache = null;
    this.commandIdempotency.clear();
    this.clearCompanionRuntimeState();
    this.tokenIsRestored = false;
    this.credentialPersistence = "memory";
    await this.credentials?.clear().catch(() => undefined);
    return { changed: true, sessionsRevoked: true };
  }

  // ─── 旧版设置页回补（2026-09-18）：档案 / 头像 / 退出 / 邀请 / 成员 / 导入 / 索引 ──

  /** GET /auth/me：当前档案（displayName + avatarUrl），设置页首次渲染用。 */
  async getProfile(requestId?: string): Promise<AuthProfileResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/auth/me", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = authProfileResultV1Schema.safeParse({
      version: 1,
      displayName: payload.displayName ?? null,
      avatarUrl: payload.avatarUrl ?? null,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** PUT /auth/profile：改昵称 / 清头像。回执直接来自服务端截断后的值。 */
  async updateProfile(
    fields: { displayName?: string | null; avatarUrl?: string | null },
    requestId?: string,
  ): Promise<AuthProfileResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/auth/profile", {
      method: "PUT",
      body: JSON.stringify(fields),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = authProfileResultV1Schema.safeParse({
      version: 1,
      displayName: payload.displayName ?? null,
      avatarUrl: payload.avatarUrl ?? null,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    // 会话里缓存了旧 displayName，丢掉缓存让下次 getState 重读。
    this.currentSession = null;
    return parsed.data;
  }

  /** POST /uploads/avatars（multipart）：服务端在同一请求里完成 avatarUrl 持久化。 */
  async uploadAvatar(
    request: { fileName: string; mimeType: string; bytesBase64: string },
    requestId?: string,
  ): Promise<AvatarUploadResultV1> {
    await this.ensureConnected(requestId);
    const configuration = this.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    const bytes = Buffer.from(request.bytesBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) {
      throw new DesktopGatewayFailure("validation", "user_action");
    }
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: request.mimeType }), request.fileName);
    const headers = new Headers();
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) this.activeRequests.set(requestId, controller);
    let response: Response;
    try {
      response = await fetch(new URL("/uploads/avatars", `${configuration.config.apiOrigin}/`), {
        method: "POST",
        headers,
        body: form,
        signal: controller?.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
      }
      this.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    } finally {
      if (requestId && controller && this.activeRequests.get(requestId) === controller) this.activeRequests.delete(requestId);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok && response.status === 401 && this.tokenIsRestored) {
      await this.discardStoredCredential();
    }
    if (!response.ok) throw this.mapResponseError(response.status, response.headers, undefined, body);
    const payload = (body ?? {}) as Record<string, unknown>;
    const parsed = avatarUploadResultV1Schema.safeParse({
      version: 1,
      url: payload.url,
      objectKey: payload.objectKey,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** GET /uploads/{avatars/…}：头像原始字节，形状与来源图片字节通道一致。 */
  async getAvatar(objectKey: string, requestId?: string): Promise<SourceImageGetResultV1> {
    await this.ensureConnected(requestId);
    if (!avatarObjectKeySchema.safeParse(objectKey).success) {
      throw new DesktopGatewayFailure("validation", "user_action");
    }
    const result = await this.requestBinaryBytes(
      `/uploads/${objectKey}`,
      { method: "GET" },
      { accept: "image/*", contentTypePrefix: "image/", maxBytes: AVATAR_MAX_BYTES },
      requestId,
    );
    const mimeType = result.contentType.split(";")[0].trim();
    if (!(SOURCE_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    const parsed = sourceImageGetResultV1Schema.safeParse({
      version: 1,
      mimeType,
      imageBase64: Buffer.from(result.bytes).toString("base64"),
      byteLength: result.bytes.byteLength,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * POST /auth/leave-workspace：退出协作工作区。退出的是当前空间时，服务端会
   * 撤销旧会话并签发个人空间的新令牌，这里像 switchWorkspace 一样保存它。
   */
  async leaveWorkspace(workspaceId: string, requestId?: string): Promise<SessionContextV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/auth/leave-workspace", {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    }, true, true, requestId);
    const body = (result.body ?? {}) as Record<string, unknown>;
    if (body.switchedToPersonalWorkspace === true && typeof body.token === "string" && body.token.length > 0) {
      this.token = body.token;
      this.workspaceEpoch += 1;
      await this.persistCredential(this.credentialPersistence === "safe_storage");
    }
    this.roomProjectionCache = null;
    return this.loadSession(requestId);
  }

  /** PATCH /workspaces/:id/name：重命名自己的个人工作区。 */
  async renameWorkspace(workspaceId: string, name: string, requestId?: string): Promise<RenameWorkspaceResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(`/workspaces/${workspaceId}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = renameWorkspaceResultV1Schema.safeParse({
      version: 1,
      workspaceId: payload.workspaceId,
      name: payload.name,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.currentSession = null;
    this.roomProjectionCache = null;
    return parsed.data;
  }

  /**
   * DELETE /workspaces/:id：解散一个协作空间（迁移 0276 的出口）。
   *
   * 服务端把"逐表删了多少行"原样带回来，这里只做形状校验：
   * 界面要靠这份计数说明后果，不能自己编一句"已删除"。
   * 解散掉的是**当前会话所在的空间**时会留下一个已失效的 session，
   * 所以和 rename 一样清掉本地缓存，让下一次调用重新拿上下文。
   */
  async dissolveWorkspace(workspaceId: string, requestId?: string): Promise<DissolveWorkspaceResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(`/workspaces/${workspaceId}`, {
      method: "DELETE",
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = dissolveWorkspaceResultV1Schema.safeParse({
      version: 1,
      workspaceId,
      counts: payload.counts ?? {},
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.currentSession = null;
    this.roomProjectionCache = null;
    return parsed.data;
  }

  /**
   * POST /workspaces/:id/transfer-ownership：把所有者交给某个成员。
   *
   * 服务端已经用 `requireOwner` + 会话身份收口，这里只把 `newOwnerUserId` 原样带回去：
   * 界面要说清"现在谁是所有者"，不能只说"操作成功"。
   */
  async transferWorkspaceOwnership(
    workspaceId: string,
    toUserId: string,
    requestId?: string,
  ): Promise<TransferWorkspaceOwnershipResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(`/workspaces/${workspaceId}/transfer-ownership`, {
      method: "POST",
      body: JSON.stringify({ toUserId }),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = transferWorkspaceOwnershipResultV1Schema.safeParse({
      version: 1,
      workspaceId,
      newOwnerUserId: payload.newOwnerUserId,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.currentSession = null;
    this.roomProjectionCache = null;
    return parsed.data;
  }

  /**
   * POST /workspaces：新建协作空间，并**进入它**。
   *
   * 为什么要顺手进入：邀请端点认的是"当前 session 所在的空间"（`POST /invites`
   * 取 `req.session.workspaceId`）。如果建完还留在原空间，用户下一步发邀请就会
   * 打到自己的个人空间并被 409 拒掉——新建出来的协作空间反而永远邀请不了人。
   * 进入这一步复用 switchWorkspace，因此令牌轮换、epoch 递增、投影与幂等缓存清理
   * 都走已经验过的那条路，不在服务端另造一套"创建即切换"的语义。
   */
  async createWorkspace(name: string, requestId?: string): Promise<CreateWorkspaceResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = createWorkspaceResultV1Schema.safeParse({
      version: 1,
      workspaceId: payload.workspaceId,
      name: payload.workspaceName,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    await this.switchWorkspace(parsed.data.workspaceId, requestId);
    return parsed.data;
  }

  /** POST /invites（Owner）：token 只在这一次回执里出现。 */
  async createInvite(
    options: { role: "member" | "owner"; expiresInHours?: number },
    requestId?: string,
  ): Promise<InviteCreatedV1> {
    await this.ensureConnected(requestId);
    const body: Record<string, unknown> = { role: options.role };
    if (options.expiresInHours !== undefined) body.expiresInHours = options.expiresInHours;
    const result = await this.request("/invites", {
      method: "POST",
      body: JSON.stringify(body),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = inviteCreatedV1Schema.safeParse({
      version: 1,
      id: payload.id,
      token: payload.token,
      tokenHint: payload.tokenHint,
      role: payload.role,
      expiresAt: payload.expiresAt ?? null,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** GET /invites（Owner）：邀请记录列表。 */
  async listInvites(requestId?: string): Promise<InviteListResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/invites?limit=100", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as { items?: unknown[]; total?: unknown };
    const parsed = inviteListResultV1Schema.safeParse({
      version: 1,
      items: (payload.items ?? []).map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return {
          version: 1,
          id: row.id,
          tokenHint: row.tokenHint,
          role: row.role,
          status: row.status,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt ?? null,
          consumedAt: row.consumedAt ?? null,
          consumedByEmail: row.consumedBy ?? null,
          revokedAt: row.revokedAt ?? null,
        };
      }),
      total: payload.total,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** DELETE /invites/:id（Owner）：服务端 204，回执在 main 侧拼。 */
  async revokeInvite(inviteId: string, requestId?: string): Promise<{ revoked: true }> {
    await this.ensureConnected(requestId);
    await this.request(`/invites/${inviteId}`, { method: "DELETE" }, true, true, requestId);
    return { revoked: true };
  }

  /** GET /members（Owner）：活跃成员列表。 */
  async listMembers(requestId?: string): Promise<MemberListResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/members?limit=200", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as { items?: unknown[]; total?: unknown };
    const parsed = memberListResultV1Schema.safeParse({
      version: 1,
      items: (payload.items ?? []).map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return {
          version: 1,
          userId: row.userId,
          email: row.email,
          role: row.role,
          joinedAt: row.joinedAt,
        };
      }),
      total: payload.total,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** DELETE /members/:userId（Owner）：移除成员，其会话立即失效。 */
  async removeMember(userId: string, requestId?: string): Promise<{ removed: true }> {
    await this.ensureConnected(requestId);
    await this.request(`/members/${userId}`, { method: "DELETE" }, true, true, requestId);
    return { removed: true };
  }

  /** POST /import/markdown（Owner，F-033 幂等）：完整笔记行不过桥，只报计数。 */
  async importMarkdown(
    items: ReadonlyArray<{ title?: string; content: string }>,
    importId: string,
    requestId?: string,
  ): Promise<MarkdownImportResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/import/markdown", {
      method: "POST",
      body: JSON.stringify({ items, importId }),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = markdownImportResultV1Schema.safeParse({
      version: 1,
      imported: payload.imported,
      failed: Array.isArray(payload.errors) ? payload.errors.length : 0,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** GET /search/drift（Owner，F-025）：只投影计数与结论。 */
  async getSearchDrift(requestId?: string): Promise<SearchDriftResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/search/drift", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const count = (value: unknown): number | undefined =>
      Array.isArray(value) ? value.length : typeof value === "number" ? value : undefined;
    // 「内容过期」= 标题过期 + 正文过期。只数标题会让"正文过期但标题没变"的漂移
    // 在界面上显示成 `发现漂移：缺失 0、幽灵 0、内容过期 0`——三个 0 配一句"发现漂移"，
    // 用户只能当它坏了（审计 F15 现场读到的就是这三个数）。两类过期都算进来，
    // hasDrift 与这几个计数才是同一件事。
    const staleTitles = count(payload.staleTitles) ?? 0;
    const staleBodies = count(payload.staleBodies) ?? 0;
    const parsed = searchDriftResultV1Schema.safeParse({
      version: 1,
      hasDrift: payload.hasDrift,
      ghosts: count(payload.ghosts),
      missing: count(payload.missing),
      stale: staleTitles + staleBodies,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** POST /search/reindex（Owner，F-011）：原子重建搜索投影。 */
  async reindexSearch(requestId?: string): Promise<SearchReindexResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/search/reindex", { method: "POST", body: JSON.stringify({}) }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const indexed = (payload.indexed ?? {}) as Record<string, unknown>;
    const parsed = searchReindexResultV1Schema.safeParse({
      version: 1,
      deleted: payload.deleted,
      indexedNotes: indexed.note,
      indexedSources: indexed.source,
      indexedObjectives: indexed.objective,
      errors: payload.errors,
      capped: payload.capped,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** GET/PATCH /me/companion/answer-mode-preference：作答模态偏好（账号级）。 */
  async getAnswerModePreference(requestId?: string) {
    await this.ensureConnected(requestId);
    const result = await this.request("/me/companion/answer-mode-preference", { method: "GET" }, true, true, requestId);
    const parsed = companionAnswerModePreferenceV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async setAnswerModePreference(
    preference: "voice" | "silent" | "text" | "any",
    requestId?: string,
  ) {
    await this.ensureConnected(requestId);
    const result = await this.request("/me/companion/answer-mode-preference", {
      method: "PATCH",
      body: JSON.stringify({ version: 1, preference }),
    }, true, true, requestId);
    const parsed = companionAnswerModePreferenceV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async listWorkspaces(requestId?: string): Promise<{ workspaces: WorkspaceSummaryV1[] }> {
    await this.ensureConnected(requestId);
    const result = await this.request("/auth/workspaces", { method: "GET" }, true, true, requestId);
    const parsed = rawWorkspaceListSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return { workspaces: parsed.data.workspaces.map((workspace) => this.toWorkspaceSummary(workspace)) };
  }

  async switchWorkspace(workspaceId: string, requestId?: string): Promise<SessionContextV1> {
    await this.ensureConnected(requestId);
    await this.clearCompanionBridgeContext(requestId).catch(() => undefined);
    const result = await this.request("/auth/switch-workspace", {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    }, true, true, requestId);
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.commandIdempotency.clear();
    this.clearCompanionRuntimeState();
    this.token = parsed.data.token;
    this.workspaceEpoch += 1;
    this.roomProjectionCache = null;
    await this.persistCredential(this.credentialPersistence === "safe_storage");
    return this.loadSession();
  }

  async getCurrentWorkspace(requestId?: string): Promise<WorkspaceContextV1> {
    const session = await this.getSession(requestId);
    if (session.status !== "authenticated" || !session.workspace) throw new DesktopGatewayFailure("auth_required", "user_action");
    return session.workspace;
  }

  async getCapabilities(requestId?: string): Promise<CapabilityProjectionV1> {
    /**
     * 0269 轮 M12：这条以前**每次**都打服务端。它自己是幂等只读的，代价在它的使用方式上
     * ——`requireActionCapability()` 在每个受控动作前都要读它一次（制卡的 11 个通道、建/删/
     * 存笔记、上传图像……），于是"点一个按钮"变成"先一次往返确认能不能点，再真正那一次"。
     * 实测这个端点平均 51.5 ms，也就是说每个按钮前面白垫半秒之内的延迟。
     *
     * 缓存按 `workspaceEpoch` 失效：切空间、重登都会把它复位或推进，那一刻能力必然要重算。
     * 再加一条 5s TTL 兜住"运维在服务端翻了 feature flag 但没有任何 epoch 变化"这种情况
     * ——那类翻转的传播延迟上限从"直到下次切空间"变成 5 秒。
     */
    const cached = this.cachedCapabilities;
    if (cached && cached.epoch === this.workspaceEpoch && Date.now() - cached.atMs < CAPABILITY_CACHE_TTL_MS) {
      return cached.projection;
    }
    await this.ensureConnected(requestId);
    const result = await this.request("/auth/capabilities/v1", { method: "GET" }, true, true, requestId);
    const parsed = capabilityProjectionSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    // 本机能力属于桌面壳，服务端只能给 fail-closed 占位；真正的值在这里覆盖，
    // 让「设置 → 本机能力 / 半身形象」显示的是这台机器的事实而不是猜测。
    const projection = capabilityProjectionSchema.parse({
      ...parsed.data,
      workspaceEpoch: this.workspaceEpoch,
      nativeCapabilities: nativeCapabilities(),
    });
    this.cachedCapabilities = { atMs: Date.now(), epoch: this.workspaceEpoch, projection };
    return projection;
  }

  /** 能力投影只在本机这一份缓存里活着；任何 epoch 变化或连接重来都不该再用它。 */
  private cachedCapabilities: { atMs: number; epoch: number; projection: CapabilityProjectionV1 } | null = null;

  private forgetCapabilities(): void {
    this.cachedCapabilities = null;
  }

  /**
   * 本人的 AI 同意与数据外发政策（0237 起为账号级）。
   *
   * 方法名仍叫 getWorkspaceAiSettings、IPC 通道仍是 workspace.aiSettings.get —— 那是
   * 它还是空间级时留下的名字。改名是纯粹的机械工作（contracts / desktop-ipc / preload /
   * 设置页 一起动），留作待办；这里先保证读的是对的端点、对的语义。
   */
  async getWorkspaceAiSettings(requestId?: string): Promise<WorkspaceAiSettingsV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/me/ai-settings", { method: "GET" }, true, true, requestId);
    const parsed = workspaceAiSettingsV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async updateAiConsent(consentVersion: string, requestId?: string): Promise<WorkspaceAiSettingsV1> {
    await this.ensureConnected(requestId);
    await this.request("/me/ai-consent", {
      method: "PUT",
      body: JSON.stringify({ consentVersion }),
    }, true, true, requestId);
    // 写入后重新读取：界面显示的是服务端的当前状态，不在客户端拼一份。
    return this.getWorkspaceAiSettings(requestId);
  }

  /**
   * 整库导出的数据本体。这里只负责取回来，落盘在主进程的 IPC handler 里做——
   * 网关不碰文件系统，渲染进程更碰不到。
   */
  async fetchWorkspaceExport(requestId?: string): Promise<unknown> {
    await this.ensureConnected(requestId);
    const result = await this.request("/export/workspace", { method: "GET" }, true, true, requestId);
    return result.body;
  }

  async updateAiDataPolicy(policy: AiDataPolicyV1, requestId?: string): Promise<WorkspaceAiSettingsV1> {
    await this.ensureConnected(requestId);
    await this.request("/me/ai-data-policy", {
      method: "PUT",
      body: JSON.stringify(policy),
    }, true, true, requestId);
    return this.getWorkspaceAiSettings(requestId);
  }

  /**
   * AI 外发审计日志的一页（doc 34 L3 的另一半）。服务端那条路由是 `requireOwner`，
   * 所以这条方法对成员就是 403 —— 门由服务端把，界面那侧的"是不是显示"不算门。
   * `limit/offset` 走整数化后交给服务端 clamp，客户端不自建第二套上限。
   */
  async getWorkspaceAiAuditLog(
    limit: number,
    offset: number,
    requestId?: string,
  ): Promise<DesktopAiAuditPageV1> {
    await this.ensureConnected(requestId);
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const result = await this.request(
      `/workspace/ai-audit-log?limit=${encodeURIComponent(String(safeLimit))}&offset=${encodeURIComponent(String(safeOffset))}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = desktopAiAuditPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  clearCredential(): void {
    void this.clearCompanionBridgeContext().catch(() => undefined);
    this.token = null;
    this.currentSession = null;
    this.roomProjectionCache = null;
    this.commandIdempotency.clear();
    this.clearCompanionRuntimeState();
  }

  async getReviewQueue(cursor?: string, limit = 50, requestId?: string): Promise<z.infer<typeof reviewQueueV2Schema>> {
    await this.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursor);
    query.set("limit", String(limit));
    const result = await this.request(`/reviews/v2/queue?${query.toString()}`, { method: "GET" }, true, true, requestId);
    const parsed = reviewQueueV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 方案 16 §18.1 的展示层延后：卡在 deferredUntil 之前不再出现在到期队列，
   * official nextReviewAt 不变。stale（generation 过期/已消费）映射为 conflict。
   */
  async deferReview(
    request: z.infer<typeof reviewDeferRequestV2Schema>,
    requestId?: string,
  ): Promise<z.infer<typeof reviewDeferResultV2Schema>> {
    await this.ensureConnected(requestId);
    const result = await this.request("/reviews/v2/defer", {
      method: "POST",
      body: JSON.stringify(reviewDeferRequestV2Schema.parse(request)),
    }, true, true, requestId);
    const parsed = reviewDeferResultV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 「今日学习」操作日志流（页 14 重构）。窗口由渲染层的本地日历日锚点给出；
   * 服务端只做权威表投影，网关这里只校验合同形状。
   */
  async getTodayActivity(
    from: string | undefined,
    to: string | undefined,
    requestId?: string,
  ): Promise<z.infer<typeof todayActivityV1Schema>> {
    await this.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (from !== undefined && from !== "") query.set("from", from);
    if (to !== undefined && to !== "") query.set("to", to);
    const result = await this.request(`/activity/today?${query.toString()}`, { method: "GET" }, true, true, requestId);
    const parsed = todayActivityV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 「全部空间」统计：当前账号在每个活跃空间里的同一份数字 + 合计。
   *
   * 与 `/stats/overview` 的关系：那条读的是**当前空间**（网关只持一个
   * `this.token`，空间由令牌决定），所以界面上那些"我的"数字其实只是"这个
   * 空间的"。这条按账号扇出，用来把被空间切开的个人进度并排摆出来。形状校验
   * 在这里做，与邻居同一条：解析失败按 unsupported_contract 交给上层，不猜字段。
   */
  async getAllWorkspacesStatsOverview(requestId?: string): Promise<AllWorkspacesStatsOverviewV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/stats/overview/all", { method: "GET" }, true, true, requestId);
    const parsed = allWorkspacesStatsOverviewSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async listSources(options: { status?: string; cursor?: string; limit?: number } = {}, requestId?: string): Promise<DesktopSourceListPage> {
    await this.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (options.status) query.set("status", options.status);
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.toString();
    const result = await this.request(`/sources${suffix ? `?${suffix}` : ""}`, { method: "GET" }, true, true, requestId);
    const parsed = desktopSourceListPageSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getSource(sourceId: string, requestId?: string): Promise<DesktopSourceDetail> {
    await this.ensureConnected(requestId);
    const result = await this.request(`/sources/${this.safeUuid(sourceId)}`, { method: "GET" }, true, true, requestId);
    const parsed = desktopSourceDetailSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * Captures a source. The API inserts the record and queues the parse job in one
   * transaction, then answers with the same detail shape the detail page reads —
   * so the caller can open the new source without a second round trip.
   */
  async createSource(
    request: DesktopSourceCreateRequest,
    requestId?: string,
  ): Promise<DesktopSourceCreateResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/sources",
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = desktopSourceCreateResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async listSourceNotes(sourceId: string, requestId?: string): Promise<DesktopSourceNotesPage> {
    await this.ensureConnected(requestId);
    const result = await this.request(`/sources/${this.safeUuid(sourceId)}/notes`, { method: "GET" }, true, true, requestId);
    const parsed = desktopSourceNotesPageSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * `PATCH /sources/:id` takes a title, not a status: the server owns the parse
   * state machine, so a rename can never move a source between index tabs.
   */
  async updateSourceTitle(
    sourceId: string,
    request: DesktopSourceUpdateRequest,
    requestId?: string,
  ): Promise<DesktopSourceDetail> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/sources/${this.safeUuid(sourceId)}`,
      { method: "PATCH", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = desktopSourceDetailSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * `POST /sources/:id/create-note` builds a note from the source's parsed
   * segments. It answers with raw note and version rows, so only the two ids a
   * surface needs to open the writer are kept.
   *
   * The API's 409 is two different answers, and one of them is not a failure:
   * `source_not_ready` is a state problem the reader must wait out, while
   * `duplicate_content` means the note already exists and the reader only has to
   * choose whether to make a second copy. Both are read from the body instead of
   * being flattened into one generic conflict.
   */
  async createNoteFromSource(
    sourceId: string,
    options: { force?: boolean } = {},
    requestId?: string,
  ): Promise<DesktopSourceNoteResult> {
    await this.ensureConnected(requestId);
    const suffix = options.force ? "?force=true" : "";
    const result = await this.request(
      `/sources/${this.safeUuid(sourceId)}/create-note${suffix}`,
      { method: "POST" },
      true,
      false,
      requestId,
      undefined,
      true,
    );

    if (result.status === 409) {
      const conflict = z.object({
        error: z.enum(["duplicate_content", "source_not_ready"]),
        existingNoteId: z.string().uuid().optional(),
        existingNoteTitle: z.string().optional(),
      }).passthrough().safeParse(result.body);
      if (!conflict.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      if (conflict.data.error === "duplicate_content" && conflict.data.existingNoteId) {
        return {
          kind: "duplicate",
          noteId: conflict.data.existingNoteId,
          title: conflict.data.existingNoteTitle ?? "",
        };
      }
      throw new DesktopGatewayFailure("conflict", "never", { httpStatus: result.status });
    }
    if (result.status < 200 || result.status >= 300) {
      throw this.mapResponseError(result.status, result.headers, undefined, result.body);
    }

    const created = z.object({
      note: z.object({ id: z.string().uuid(), title: z.string() }).passthrough(),
      version: z.object({ id: z.string().uuid() }).passthrough(),
    }).passthrough().safeParse(result.body);
    if (!created.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return {
      kind: "created",
      noteId: created.data.note.id,
      noteVersionId: created.data.version.id,
      title: created.data.note.title,
    };
  }

  /**
   * `DELETE /sources/:id` soft-deletes the source into `archived` and answers
   * 204, so the receipt is built here: the renderer only needs to know which
   * source left the ready index. The record stays readable under 全部.
   */
  async archiveSource(sourceId: string, requestId?: string): Promise<DesktopSourceArchiveResult> {
    await this.ensureConnected(requestId);
    await this.request(`/sources/${this.safeUuid(sourceId)}`, { method: "DELETE" }, true, true, requestId);
    return { sourceId, status: "archived" };
  }

  /**
   * `POST /sources/:id/restore`（审计 F08）：归档的逆操作。
   *
   * 回到哪一档由服务端按事实定（有片段 → `ready`，没有 → `draft`），客户端不猜；
   * 返回里带上它算出来的那一档，界面据此说清"恢复成了什么样"。
   */
  async restoreSource(sourceId: string, requestId?: string): Promise<DesktopSourceRestoreResult> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/sources/${this.safeUuid(sourceId)}/restore`,
      { method: "POST" },
      true,
      true,
      requestId,
    );
    const parsed = desktopSourceRestoreResultSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return { sourceId, status: parsed.data.status as DesktopSourceRestoreResult["status"], alreadyActive: parsed.data.alreadyActive };
  }

  /**
   * `POST /sources/:id/reparse`（doc 34 L7）：把一篇卡住的来源重新排去解析。
   *
   * 409 有两种，服务端分开报：已经有任务在跑（`reparse_in_flight`）与已归档。
   * 前者**不能**当成失败告诉用户"再点一次试试"——那正是重复付钱的路径，
   * 所以这里把它原样抛出去，由界面回一句"已经在排了"。
   */
  async reparseSource(sourceId: string, requestId?: string): Promise<DesktopSourceReparseResult> {
    await this.ensureConnected(requestId);
    const response = await this.request(
      `/sources/${this.safeUuid(sourceId)}/reparse`,
      { method: "POST" },
      true,
      true,
      requestId,
    );
    if (response.status === 409) throw new DesktopGatewayFailure("conflict", "user_action", { httpStatus: response.status });
    return { sourceId, status: "draft" };
  }

  async listNotes(options: { cursor?: string; limit?: number; trashed?: boolean } = {}, requestId?: string): Promise<DesktopNoteListPage> {
    await this.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.trashed !== undefined) query.set("trashed", options.trashed ? "true" : "false");
    const suffix = query.toString();
    const result = await this.request(`/notes${suffix ? `?${suffix}` : ""}`, { method: "GET" }, true, true, requestId);
    const parsed = desktopNoteListPageSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async listObjectives(options: { lifecycle?: "active" | "archived" | "superseded"; cursor?: string; limit?: number } = {}, requestId?: string): Promise<ObjectiveListPageV3> {
    await this.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (options.lifecycle) query.set("lifecycle", options.lifecycle);
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.toString();
    const result = await this.request(`/v2/learning-objectives${suffix ? `?${suffix}` : ""}`, { method: "GET" }, true, true, requestId);
    const parsed = objectiveListPageV3Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getObjective(objectiveId: string, requestId?: string): Promise<LearningObjectiveSurfaceV3> {
    await this.ensureConnected(requestId);
    const result = await this.request(`/v2/learning-objectives/${this.safeUuid(objectiveId)}`, { method: "GET" }, true, true, requestId);
    const parsed = learningObjectiveSurfaceV3Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getUnderstandingTopology(requestId?: string): Promise<UnderstandingTopologySnapshotV3> {
    await this.ensureConnected(requestId);
    const result = await this.request("/v3/understanding/topology", { method: "GET" }, true, true, requestId);
    const parsed = understandingTopologySnapshotV3Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async searchGlobal(queryValue: string, options: { type?: "note" | "source" | "objective"; limit?: number; cursor?: string } = {}, requestId?: string): Promise<DesktopSearchPage> {
    await this.ensureConnected(requestId);
    const query = new URLSearchParams({ q: queryValue });
    if (options.type) query.set("type", options.type);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    // 游标原样透传：它是服务端生成的 keyset 位置，主进程不解释也不重算。
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const result = await this.request(`/search?${query.toString()}`, { method: "GET" }, true, true, requestId);
    const parsed = desktopSearchPageSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getRoomProjection(requestId?: string): Promise<RoomProjectionV1> {
    await this.ensureConnected(requestId);
    let capabilityProjection: CapabilityProjectionV1 | null = null;
    try {
      capabilityProjection = await this.getCapabilities(requestId);
    } catch {
      // Dashboard content remains useful when the independent capability
      // projection is degraded. The adapter marks affected actions and
      // capture as unavailable instead of dropping the whole home snapshot.
    }
    const generationRecoveryEnabled = capabilityProjection?.actionCapabilities["card_generation.start"] === "allowed"
      && capabilityProjection.featureAvailability.card_generation_v2.state === "enabled";
    let activeGenerationSummary: CardGenerationActiveSummaryV1[] = [];
    let activeGenerationSummaryError: Parameters<typeof projectLearningDashboardToRoomProjection>[1]["activeGenerationSummaryError"];
    if (generationRecoveryEnabled) {
      try {
        const active = await this.getActiveCardGenerationSummaries(requestId);
        activeGenerationSummary = active.items;
      } catch (error) {
        activeGenerationSummaryError = roomActiveGenerationErrorReason(error);
      }
    }
    const cached = this.roomProjectionCache?.workspaceEpoch === this.workspaceEpoch
      ? this.roomProjectionCache
      : null;
    const headers = cached ? { "If-None-Match": cached.etag } : undefined;
    const result = await this.request(
      "/v2/learning-dashboard",
      { method: "GET", ...(headers ? { headers } : {}) },
      true,
      false,
      requestId,
      undefined,
      true,
    );
    if (result.status === 304) {
      if (!cached) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      // Dashboard content is unchanged, but capability and recovery reads are
      // independent. Re-project the cached dashboard so their latest state is
      // never hidden behind the dashboard ETag.
      const refreshed = roomProjectionV1Schema.parse(projectLearningDashboardToRoomProjection(
        cached.dashboard,
        {
          workspaceEpoch: this.workspaceEpoch,
          enabledRoutes: desktopRouteKindM2Values,
          capabilityProjection,
          activeGenerationSummary,
          ...(activeGenerationSummaryError ? { activeGenerationSummaryError } : {}),
        },
      ));
      this.roomProjectionCache = { ...cached, value: refreshed };
      return refreshed;
    }
    if (result.status < 200 || result.status >= 300) {
      throw this.mapResponseError(result.status, result.headers);
    }
    const dashboard = learningDashboardV2Schema.safeParse(result.body);
    if (!dashboard.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    const projection = roomProjectionV1Schema.parse(projectLearningDashboardToRoomProjection(
      dashboard.data,
      {
        workspaceEpoch: this.workspaceEpoch,
        enabledRoutes: desktopRouteKindM2Values,
        capabilityProjection,
        activeGenerationSummary,
        ...(activeGenerationSummaryError ? { activeGenerationSummaryError } : {}),
      },
    ));
    const etag = result.headers.get("etag")?.trim() || `"${dashboard.data.dashboardRevision}"`;
    this.roomProjectionCache = { etag, workspaceEpoch: this.workspaceEpoch, dashboard: dashboard.data, value: projection };
    return projection;
  }

  async getCompanionHomeProjection(requestId?: string): Promise<CompanionHomeProjectionV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/home-projection",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionHomeProjectionV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getCompanionRoomProfile(requestId?: string): Promise<CompanionRoomProfileV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/room-profile",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionRoomProfileV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async patchCompanionRoomProfile(
    request: CompanionRoomProfilePatchV1,
    requestId?: string,
  ): Promise<CompanionRoomProfileV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/room-profile",
      { method: "PATCH", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionRoomProfileV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 账号级 presence（GET /me/companion）：返回账号状态 + onboarding 状态。 */
  async getCompanionAccountOverview(requestId?: string): Promise<CompanionOverview> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/me/companion",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionOverviewSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 账号级 presence 写入（PATCH /me/companion，revision CAS）。
   * 冲突不自动重放：调用方重新 GET 后用新 revision 重试。
   */
  async patchCompanionAccountState(
    request: CompanionAccountPatch,
    requestId?: string,
  ): Promise<CompanionAccountStateV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/me/companion",
      { method: "PATCH", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionAccountStateV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 账号级 onboarding CAS 状态机。渲染层只能提交严格动作与公开版本号，
   * display permit、runId、revision 和跨设备冲突都由服务端裁决。
   */
  async transitionCompanionOnboarding(
    version: string,
    request: OnboardingTransitionRequest,
    requestId?: string,
  ): Promise<OnboardingTransitionResponse> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/me/companion/onboarding/${encodeURIComponent(version)}/transition`,
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = onboardingTransitionResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async renewCompanionRuntimeFence(
    surfaceEpoch: number,
    ttlSeconds = 120,
    requestId?: string,
  ): Promise<RuntimeFenceResponse> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/me/companion/runtime-fences",
      {
        method: "POST",
        body: JSON.stringify({
          deviceSessionId: this.deviceSessionId,
          surfaceEpoch,
          ttlSeconds,
        }),
      },
      true,
      true,
      requestId,
    );
    const parsed = runtimeFenceResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** Main-only account epoch stream. Raw SSE and device identity never cross preload. */
  async watchCompanionAccountEvents(
    afterEpoch: number,
    onEvent: (event: CompanionAccountGlobalOffEventV1) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.ensureConnected();
    const controller = new AbortController();
    let closed = false;
    let cursor = Number.isSafeInteger(afterEpoch) && afterEpoch >= 0 ? afterEpoch : 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };
    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
          const userId = this.currentSession?.status === "authenticated" ? this.currentSession.user.userId : null;
          if (cursor > 0 && userId) headers.set("Last-Event-ID", `${userId}:${cursor}`);
          const url = new URL("/me/companion/events", `${configuration.config.apiOrigin}/`);
          url.searchParams.set("after", String(cursor));
          const response = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
          if (response.status >= 300 && response.status < 400) throw new DesktopGatewayFailure("api_untrusted", "user_action");
          if (!response.ok) throw this.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const event = parseCompanionAccountSseFrame(block);
              if (!event || event.epoch <= cursor) continue;
              cursor = event.epoch;
              await onEvent(event);
            }
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  /**
   * Main-owned durable proactive inbox stream. The renderer receives only a
   * sequence invalidation and re-reads the strict timeline projection.
   */
  async watchCompanionInboxEvents(
    afterSequence: number,
    onDelivery: (delivery: AssistantDeliveryV2) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.ensureConnected();
    const controller = new AbortController();
    let closed = false;
    let cursor = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };
    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
          if (cursor > 0) headers.set("Last-Event-ID", String(cursor));
          const url = new URL("/companion/deliveries/inbox/stream", `${configuration.config.apiOrigin}/`);
          url.searchParams.set("after", String(cursor));
          const response = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
          if (response.status >= 300 && response.status < 400) throw new DesktopGatewayFailure("api_untrusted", "user_action");
          if (!response.ok) throw this.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const delivery = parseCompanionInboxSseFrame(block);
              if (!delivery || delivery.inboxSequence <= cursor) continue;
              cursor = delivery.inboxSequence;
              await onDelivery(delivery);
            }
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  private clearCompanionBridgeLocalState(): void {
    this.companionBridgeGeneration += 1;
    if (this.companionBridgeRenewTimer) clearInterval(this.companionBridgeRenewTimer);
    this.companionBridgeRenewTimer = null;
    this.companionBridgeContext = null;
  }

  private companionBridgeState(active: boolean, snapshot?: AssistantContextSnapshotV2) {
    return {
      version: 1 as const,
      active,
      revision: snapshot?.revision ?? null,
      expiresAt: snapshot?.expiresAt ?? null,
    };
  }

  private async renewCompanionBridgeContext(generation: number): Promise<void> {
    const current = this.companionBridgeContext;
    if (!current || generation !== this.companionBridgeGeneration) return;
    const result = await this.request(
      `/companion/bridge/contexts/${current.snapshot.contextId}/renew`,
      {
        method: "POST",
        body: JSON.stringify({
          contextId: current.snapshot.contextId,
          pageInstanceId: current.snapshot.pageInstanceId,
          expectedRevision: current.snapshot.revision,
        }),
      },
      true,
      true,
    );
    const parsed = assistantContextSnapshotV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    if (generation !== this.companionBridgeGeneration || !this.companionBridgeContext) return;
    this.companionBridgeContext.snapshot = parsed.data;
  }

  async setCompanionBridgeContext(
    pageInput: MainPageContextInputV2,
    requestId?: string,
  ) {
    await this.ensureConnected(requestId);
    const page = mainPageContextInputV2Schema.parse(pageInput);
    const current = this.companionBridgeContext;
    if (current && isDeepStrictEqual(current.page, page)) {
      return this.companionBridgeState(true, current.snapshot);
    }
    await this.clearCompanionBridgeContext(requestId).catch(() => this.clearCompanionBridgeLocalState());
    const generation = this.companionBridgeGeneration;
    const contextId = randomUUID();
    const pageInstanceId = randomUUID();
    const result = await this.request(
      "/companion/bridge/contexts",
      {
        method: "POST",
        body: JSON.stringify({
          contextId,
          deviceSessionId: this.deviceSessionId,
          pageInstanceId,
          accountSessionId: this.companionAccountSessionId,
          page,
        }),
      },
      true,
      true,
      requestId,
    );
    const parsed = assistantContextSnapshotV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    if (generation !== this.companionBridgeGeneration) return this.companionBridgeState(false);
    this.companionBridgeContext = { page, snapshot: parsed.data };
    this.companionBridgeRenewTimer = setInterval(() => {
      void this.renewCompanionBridgeContext(generation).catch(() => this.clearCompanionBridgeLocalState());
    }, 10_000);
    return this.companionBridgeState(true, parsed.data);
  }

  async clearCompanionBridgeContext(requestId?: string) {
    const current = this.companionBridgeContext;
    this.clearCompanionBridgeLocalState();
    if (!current || !this.token) return this.companionBridgeState(false);
    await this.request(
      `/companion/bridge/contexts/${current.snapshot.contextId}`,
      {
        method: "DELETE",
        body: JSON.stringify({
          contextId: current.snapshot.contextId,
          pageInstanceId: current.snapshot.pageInstanceId,
          expectedRevision: current.snapshot.revision,
        }),
      },
      true,
      true,
      requestId,
    );
    return this.companionBridgeState(false);
  }

  // ─── 伴星聊天发送链路 + 语音转文本（2026-09-18 接线） ────────────────────
  //
  // 服务端契约（routes.ts / companion-voice-service.ts）早已就绪，桌面端此前
  // 只有只读列表。这里的四个方法与渲染层 CompanionChatDrawer 构成完整链路：
  // 录音 → 本地 SenseVoice（WASM）转写，本地引擎不可用才落到云通道；文本
  // 或语音转写作为 turn 提交；回复靠 messages 轮询取回（SSE 是后续正规化路径）。

  /** 连续对话只复用唯一 inbox；内部 conversation id 不进入产品层。 */
  async ensureCompanionConversation(
    _request: CompanionChatEnsureRequestV1,
    requestId?: string,
  ): Promise<CompanionChatEnsureResultV1> {
    await this.ensureConnected(requestId);
    const ensureResult = await this.request(
      "/companion/inbox/ensure",
      { method: "POST", body: "{}" },
      true,
      true,
      requestId,
    );
    const conversation = companionConversationV1Schema.safeParse(ensureResult.body);
    if (!conversation.success || conversation.data.kind !== "inbox") {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    const parsed = companionChatEnsureResultV1Schema.safeParse({
      version: 1,
      conversation: conversation.data,
      created: ensureResult.status === 201,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 发送一轮（POST /companion/conversations/:id/turns，Idempotency-Key 必填）。 */
  async sendCompanionTurn(
    request: CompanionChatSendTurnRequestV1,
    requestId?: string,
  ): Promise<CompanionChatSendTurnResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/conversations/${request.conversationId}/turns`,
      { method: "POST", body: JSON.stringify(request.turn), headers: { "Idempotency-Key": request.idempotencyKey } },
      true,
      true,
      requestId,
    );
    const parsed = companionChatSendTurnResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 消息分页（GET /companion/conversations/:id/messages，升序返回）。 */
  async listCompanionChatMessages(
    request: CompanionChatListMessagesRequestV1,
    requestId?: string,
  ): Promise<CompanionChatListMessagesResultV1> {
    await this.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (request.limit != null) query.set("limit", String(request.limit));
    if (request.beforeSeq != null) query.set("beforeSeq", String(request.beforeSeq));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const result = await this.request(
      `/companion/conversations/${request.conversationId}/messages${suffix}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionChatListMessagesResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** Existing LearningRun page adapter; no new HTTP shape is introduced. */
  async getCompanionLearningRunContext(
    runId: string,
    requestId?: string,
  ): Promise<CompanionLearningRunContextV1> {
    await this.ensureConnected(requestId);
    const safeRunId = uuidSchema.parse(runId);
    const result = await this.request(
      `/learning-runs/${safeRunId}/companion-context`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionLearningRunContextV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** Read-only menu context used by the Companion Center activity feed. */
  async getCompanionLearningContext(requestId?: string): Promise<CompanionLearningContextV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/learning-context",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionLearningContextV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** Issues the server's existing five-minute, single-use grounded tutor grant. */
  async createCompanionLearningRunContextGrant(
    runId: string,
    request: CreateCompanionLearningRunContextGrantRequestV1,
    requestId?: string,
  ): Promise<CompanionGroundedTutorGrantV1> {
    await this.ensureConnected(requestId);
    const safeRunId = uuidSchema.parse(runId);
    const result = await this.request(
      `/learning-runs/${safeRunId}/companion-context-grants`,
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionGroundedTutorGrantV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 提案快照（GET /companion/proposals/:id）：确认卡数据源（含 payloadSha256）。 */
  async getCompanionChatProposal(
    request: CompanionChatProposalGetRequestV1,
    requestId?: string,
  ): Promise<CompanionChatProposalGetResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/proposals/${request.proposalId}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionChatProposalGetResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 提案裁决（POST /companion/proposals/:id/decision，Idempotency-Key 必填）。 */
  async decideCompanionChatProposal(
    request: CompanionChatProposalDecideRequestV1,
    requestId?: string,
  ): Promise<CompanionChatProposalDecideResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/proposals/${request.proposalId}/decision`,
      {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          proposalId: request.proposalId,
          decision: request.decision,
          idempotencyKey: request.idempotencyKey,
          expectedPayloadSha256: request.expectedPayloadSha256,
        }),
        headers: { "Idempotency-Key": request.idempotencyKey },
      },
      true,
      true,
      requestId,
    );
    const parsed = companionChatProposalDecideResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** agent 导航 route 轮询（GET /companion/conversations/:id/agent-routes?after=）。 */
  async listCompanionAgentRoutes(
    request: CompanionAgentRoutesListRequestV1,
    requestId?: string,
  ): Promise<CompanionAgentRoutesListResultV1> {
    await this.ensureConnected(requestId);
    const after = request.afterSeq != null ? String(request.afterSeq) : "0";
    const result = await this.request(
      `/companion/conversations/${request.conversationId}/agent-routes?after=${after}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionAgentRoutesListResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 过程节点留痕（GET /companion/conversations/:id/run-nodes?after=）。
   *
   * 与 listCompanionAgentRoutes 同形状的只读窗口：节点事件 + 每轮 run 摘要。
   * payload 原样带回，由渲染层用与实时链路同一个收敛函数折成节点。
   */
  async listCompanionRunNodes(
    request: CompanionRunNodesListRequestV1,
    requestId?: string,
  ): Promise<CompanionRunNodesListResultV1> {
    await this.ensureConnected(requestId);
    const after = request.afterSeq != null ? String(request.afterSeq) : "0";
    const result = await this.request(
      `/companion/conversations/${request.conversationId}/run-nodes?after=${after}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionRunNodesListResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 停止本轮（2026-09-19）：`POST /companion/runs/:id/cancel`。
   *
   * 服务端语义：首次 202、run 已是终态则 200 幂等——两者同一形状，客户端只看 status。
   * 请求体沿用服务端 cancel schema（`generation` 做 CAS + `reason:'user'`），不自造字段。
   */
  async cancelCompanionChatRun(
    request: CompanionChatCancelRunRequestV1,
    requestId?: string,
  ): Promise<CompanionChatCancelRunResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/runs/${request.runId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ version: 1, generation: request.generation, reason: "user" }),
      },
      true,
      true,
      requestId,
    );
    const parsed = companionChatCancelRunResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 主动开场（切片④）：POST /companion/thoughts/:id/open，落她的开场消息。 */
  async openCompanionThought(
    request: CompanionChatOpenThoughtRequestV1,
    requestId?: string,
  ): Promise<CompanionChatOpenThoughtResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/thoughts/${request.thoughtId}/open`,
      { method: "POST", body: JSON.stringify({ version: 1 }) },
      true,
      true,
      requestId,
    );
    const parsed = companionChatOpenThoughtResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 语音转文本（POST /voice/transcribe，purpose=companion_dialogue）。
   * 复用 uploadNoteImage 的 multipart fetch 语义（request() 固定 JSON
   * Content-Type，装不下 multipart）；服务端 magic-byte 校验后转 SiliconFlow。
   */
  async transcribeCompanionVoice(
    request: CompanionVoiceTranscribeRequestV1,
    requestId?: string,
  ): Promise<CompanionVoiceTranscribeResultV1> {
    await this.ensureConnected(requestId);
    const configuration = this.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    const bytes = Buffer.from(request.audioBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > COMPANION_VOICE_TRANSCRIBE_MAX_AUDIO_BYTES) {
      throw new DesktopGatewayFailure("validation", "user_action");
    }
    const form = new FormData();
    form.set("purpose", "companion_dialogue");
    form.set("language", request.language);
    form.set("durationMs", String(request.durationMs));
    form.set("file", new Blob([bytes], { type: "audio/wav" }), "companion-input.wav");

    const headers = new Headers();
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) this.activeRequests.set(requestId, controller);
    let response: Response;
    try {
      response = await fetch(new URL("/voice/transcribe", `${configuration.config.apiOrigin}/`), {
        method: "POST",
        headers,
        body: form,
        signal: controller?.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
      }
      this.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    } finally {
      if (requestId && controller && this.activeRequests.get(requestId) === controller) this.activeRequests.delete(requestId);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok && response.status === 401 && this.tokenIsRestored) {
      await this.discardStoredCredential();
    }
    if (!response.ok) throw this.mapResponseError(response.status, response.headers, undefined, body);
    const parsed = companionVoiceTranscribeResultV1Schema.safeParse(body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  // ─── 伴星中心（桌面页 20）：共同记录的读写 ──────────────────────────────
  //
  // 记忆正文是账号私有的弱事实，不是学习真相：这里只做形状校验与 workspace
  // 路由，任何一条记录都不会跨 workspace 复用。写端点（确认/固定/归档/删除）
  // 一律返回被改动的那一条，页面据此就地更新而不是重新猜状态。

  async listCompanionMemories(
    query: CompanionMemoryListQuery = {},
    requestId?: string,
  ): Promise<CompanionMemoryListV1> {
    await this.ensureConnected(requestId);
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.q) params.set("q", query.q);
    if (query.scope) params.set("scope", query.scope);
    if (query.includeCandidates) params.set("includeCandidates", "true");
    if (query.includeArchived) params.set("includeArchived", "true");
    const suffix = params.toString();
    const result = await this.request(
      `/companion/memory${suffix ? `?${suffix}` : ""}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryListV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getCompanionMemoryStarMap(requestId?: string): Promise<CompanionMemoryStarMapV2> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/memory/star-map",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryStarMapV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 候选记忆确认：服务端同一事务里写长期记忆并抬高 familiarity。 */
  async confirmCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("confirm", memoryId, requestId);
  }

  async pinCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("pin", memoryId, requestId);
  }

  async unpinCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("unpin", memoryId, requestId);
  }

  async archiveCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("archive", memoryId, requestId);
  }

  async restoreCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("restore", memoryId, requestId);
  }

  /**
   * 删除一条记忆。服务端把候选的「忽略」与已确认记忆的「删除」都实现为同一个
   * soft delete（`DELETE /companion/memory/:id`），所以桌面端也只有一条通道。
   * 响应是 204，没有正文——这里回执一个 id，页面据此把该节点从星轨上摘掉。
   */
  async deleteCompanionMemory(
    memoryId: string,
    requestId?: string,
  ): Promise<{ readonly memoryItemId: string }> {
    await this.ensureConnected(requestId);
    const id = this.safeUuid(memoryId);
    await this.request(`/companion/memory/${id}`, { method: "DELETE" }, true, true, requestId);
    return { memoryItemId: id };
  }

  async createCompanionMemory(request: CompanionMemoryCreateInputV1, requestId?: string): Promise<CompanionMemoryItemV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/memory",
      { method: "POST", body: JSON.stringify({ ...request, userStated: true, candidate: false, sourceType: "user_stated" }) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryItemV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async correctCompanionMemory(memoryId: string, request: CompanionMemoryCorrectInputV1, requestId?: string): Promise<CompanionMemoryItemV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/memory/${this.safeUuid(memoryId)}/correct`,
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryItemV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async dismissCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/memory/${this.safeUuid(memoryId)}/dismiss`,
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryItemV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async listCompanionMemoryConflicts(requestId?: string) {
    await this.ensureConnected(requestId);
    const result = await this.request("/companion/memory/conflicts", { method: "GET" }, true, true, requestId);
    const parsed = companionMemoryConflictListV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async resolveCompanionMemoryConflict(memoryId: string, removeId: string, requestId?: string) {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/memory/${this.safeUuid(memoryId)}/resolve-conflict`,
      { method: "POST", body: JSON.stringify({ removeId: this.safeUuid(removeId) }) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryConflictResolveResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async rebuildCompanionMemoryEmbeddings(requestId?: string) {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/memory/rebuild-embeddings",
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryQueueResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async clearCompanionMemories(requestId?: string) {
    await this.ensureConnected(requestId);
    const result = await this.request("/companion/memory", { method: "DELETE" }, true, true, requestId);
    const parsed = companionMemoryClearResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async summarizeRecentCompanionHistory(requestId?: string) {
    // Renderer 不接触内部 conversation id；main 只在提交 summarizer job 时解析
    // 当前内部分段，然后只回传「已排队」的稳定结果。
    const current = await this.ensureCompanionConversation({ version: 1 }, requestId);
    const result = await this.request(
      `/companion/conversations/${this.safeUuid(current.conversation.id)}/summarize`,
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryQueueResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  private async mutateCompanionMemory(
    action: "confirm" | "pin" | "unpin" | "archive" | "restore",
    memoryId: string,
    requestId?: string,
  ): Promise<CompanionMemoryItemV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/memory/${this.safeUuid(memoryId)}/${action}`,
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryItemV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 桌宠日记：只读，不触发生成；date 缺省时服务端给最近一次已生成的日记。 */
  async getCompanionDailySummary(date?: string, requestId?: string): Promise<CompanionDailySummaryV1> {
    await this.ensureConnected(requestId);
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    const suffix = params.toString();
    const result = await this.request(
      `/companion/daily${suffix ? `?${suffix}` : ""}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionDailySummaryV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 月历标记：某个月里她写过（或试过）哪几天。只读，不触发生成。 */
  async getCompanionDailyMonth(month: string, requestId?: string): Promise<CompanionDailyMonthV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/daily/month?month=${encodeURIComponent(month)}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionDailyMonthV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getCompanionPersona(requestId?: string): Promise<CompanionPersonaV1> {    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/pet-profile",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionPersonaV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 保存人格档案。服务端用 revision 做 CAS：并发写入的败者拿到 409，网关把
   * 它映射成 `conflict`，页面据此提示「同步后再试」，不做自动重放。
   */
  async patchCompanionPersona(
    request: CompanionPersonaPatchV1,
    requestId?: string,
  ): Promise<CompanionPersonaMutationV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/pet-profile",
      { method: "PATCH", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionPersonaMutationV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** 恢复系统默认人格；服务端删掉自定义行，回复是否成功由 ok 字段承担。 */
  async resetCompanionPersona(requestId?: string): Promise<CompanionPersonaResetV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/pet-profile/reset",
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionPersonaResetV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async listCompanionHistory(
    query: CompanionHistoryQueryV1 = {},
    requestId?: string,
  ): Promise<CompanionHistoryPageV1> {
    await this.ensureConnected(requestId);
    const params = new URLSearchParams();
    if (query.before) params.set("before", query.before);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.toString();
    const result = await this.request(
      `/companion/history${suffix ? `?${suffix}` : ""}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionHistoryPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async searchCompanionHistory(
    query: CompanionHistorySearchQueryV1,
    requestId?: string,
  ): Promise<CompanionHistorySearchV1> {
    await this.ensureConnected(requestId);
    const params = new URLSearchParams({ q: query.q });
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const result = await this.request(
      `/companion/history/search?${params.toString()}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionHistorySearchV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async clearCompanionHistory(requestId?: string): Promise<CompanionHistoryClearResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/history",
      { method: "DELETE" },
      true,
      true,
      requestId,
    );
    const parsed = companionHistoryClearResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getCompanionJourneyBootstrap(requestId?: string): Promise<CompanionJourneyBootstrap> {
    await this.ensureConnected(requestId);
    const result = await this.request("/companion/journey/bootstrap", { method: "GET" }, true, true, requestId);
    const parsed = companionJourneyBootstrapSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async actOnCompanionInvitation(
    request: CompanionInvitationActionRequest,
    requestId?: string,
  ): Promise<CompanionInvitationV2> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/invitation/actions",
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionInvitationSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getCompanionJourney(
    journeyId: string,
    requestId?: string,
  ): Promise<CompanionJourneyV2> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/journeys/${this.safeUuid(journeyId)}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionJourneySchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async actOnCompanionJourney(
    journeyId: string,
    request: CompanionJourneyActionRequest,
    requestId?: string,
  ): Promise<CompanionJourneyV2> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/companion/journeys/${this.safeUuid(journeyId)}/actions`,
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionJourneySchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async listCompanionActivityTimeline(
    before?: number,
    requestId?: string,
  ): Promise<CompanionActivityTimelineV1> {
    await this.ensureConnected(requestId);
    const cursor = before && before > 0 ? `&before=${Math.trunc(before)}` : "";
    const result = await this.request(
      `/companion/deliveries/timeline?limit=50${cursor}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionActivityTimelineWireSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return companionActivityTimelineV1Schema.parse({
      version: 1,
      items: parsed.data.items.map(projectCompanionDelivery),
      nextCursor: parsed.data.nextCursor,
      serverTime: parsed.data.serverTime,
    });
  }

  clearCompanionRuntimeState(): void {
    this.companionDeliveryLeases.clear();
    this.clearCompanionBridgeLocalState();
  }

  private async claimCompanionDeliveryLease(
    deliveryId: string,
    inboxSequence: number,
    requestId?: string,
  ): Promise<void> {
    const lease = { inboxSequence, leaseToken: randomUUID() };
    const claim = await this.request(
      `/companion/deliveries/${deliveryId}/lease`,
      {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          deviceSessionId: this.deviceSessionId,
          leaseToken: lease.leaseToken,
          idempotencyKey: randomUUID(),
        }),
      },
      true,
      true,
      requestId,
    );
    const claimed = assistantDeliveryV2Schema.safeParse(claim.body);
    if (!claimed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.companionDeliveryLeases.set(deliveryId, lease);
  }

  /**
   * 展示前由 main 领取跨设备租约；renderer 只拿安全投影，不接触 device session
   * 或 lease token。重复领取由本进程缓存幂等收敛。
   */
  async presentCompanionDelivery(
    deliveryId: string,
    inboxSequence: number,
    requestId?: string,
  ): Promise<CompanionActivityDeliveryV1> {
    await this.ensureConnected(requestId);
    const id = this.safeUuid(deliveryId);
    const lease = this.companionDeliveryLeases.get(id);
    if (!lease || lease.inboxSequence !== inboxSequence) {
      await this.claimCompanionDeliveryLease(id, inboxSequence, requestId);
    }
    const shown = await this.ackCompanionDelivery({ deliveryId: id, inboxSequence, transition: "displayed" }, requestId);
    return shown;
  }

  async ackCompanionDelivery(
    input: CompanionActivityAckRequestV1,
    requestId?: string,
  ): Promise<CompanionActivityDeliveryV1> {
    await this.ensureConnected(requestId);
    const id = this.safeUuid(input.deliveryId);
    const lease = this.companionDeliveryLeases.get(id);
    if (!lease || lease.inboxSequence !== input.inboxSequence) {
      throw new DesktopGatewayFailure("conflict", "resync_first");
    }
    const sendAck = (leaseToken: string) => this.request(
      `/companion/deliveries/${id}/ack`,
      {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          deliveryId: id,
          inboxSequence: input.inboxSequence,
          deviceSessionId: this.deviceSessionId,
          leaseToken,
          transition: input.transition,
          idempotencyKey: randomUUID(),
        }),
      },
      true,
      true,
      requestId,
    );
    let result;
    try {
      result = await sendAck(lease.leaseToken);
    } catch (error) {
      if (!(error instanceof DesktopGatewayFailure) || error.code !== "conflict") throw error;
      this.companionDeliveryLeases.delete(id);
      await this.claimCompanionDeliveryLease(id, input.inboxSequence, requestId);
      const renewed = this.companionDeliveryLeases.get(id);
      if (!renewed) throw new DesktopGatewayFailure("conflict", "resync_first");
      result = await sendAck(renewed.leaseToken);
    }
    const parsed = assistantDeliveryV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    if (input.transition === "acted" || input.transition === "dismissed") {
      this.companionDeliveryLeases.delete(id);
    }
    return projectCompanionDelivery(parsed.data);
  }

  async deleteCompanionAudit(requestId?: string): Promise<CompanionAuditDeleteResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/me/companion/audit", { method: "DELETE" }, true, true, requestId);
    const parsed = companionAuditDeleteResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async openCompanionExport(
    kind: "all" | "memory" | "audit",
    requestId?: string,
  ): Promise<Response> {
    await this.ensureConnected(requestId);
    const configuration = this.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    const path = kind === "all" ? "/companion/export"
      : kind === "memory" ? "/companion/memory/export"
        : "/me/companion/audit/export";
    const headers = new Headers({ Accept: kind === "all" ? "application/x-ndjson" : "application/json" });
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    let response: Response;
    try {
      response = await fetch(new URL(path, `${configuration.config.apiOrigin}/`), {
        method: "GET",
        headers,
        redirect: "manual",
      });
    } catch {
      this.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    if (!response.ok) throw this.mapResponseError(response.status, response.headers);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const expected = kind === "all" ? "application/x-ndjson" : "application/json";
    if (!contentType.startsWith(expected) || !response.body) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    return response;
  }

  /**
   * 设置 → 语音与伴星：读/写"这一身"。走 JSON 通道，回执由 IPC 层的
   * companionVoicePreferenceV1Schema 把关（服务端未设置时回 config 默认并标 explicit:false，
   * 所以这里不需要再补一层默认值）。
   */
  async getCompanionVoicePreference(requestId?: string) {
    await this.ensureConnected(requestId);
    const result = await this.request("/voice/preference", { method: "GET" }, true, true, requestId);
    const parsed = companionVoicePreferenceV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async setCompanionVoicePreference(
    input: { engine: TtsEngineV1; voice: string },
    requestId?: string,
  ) {
    await this.ensureConnected(requestId);
    const result = await this.request("/voice/preference", {
      method: "PATCH",
      body: JSON.stringify({ version: 1, ...input }),
    }, true, true, requestId);
    const parsed = companionVoicePreferenceV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async speakCompanionVoice(
    request: CompanionVoiceSpeakRequestV1,
    requestId?: string,
  ): Promise<CompanionVoiceSpeakResultV1> {
    await this.ensureConnected(requestId);
    // 只提交纯文本 + 已审核的固定 voice，响应是 raw audio/mpeg。
    const result = await this.requestAudioBytes(
      "/voice/tts",
      {
        method: "POST",
        body: JSON.stringify({ text: request.text, voice: COMPANION_VOICE_SPEAK_VOICE }),
      },
      requestId,
    );
    const parsed = companionVoiceSpeakResultV1Schema.safeParse({
      version: 1,
      mimeType: "audio/mpeg",
      audioBase64: Buffer.from(result.bytes).toString("base64"),
      byteLength: result.bytes.byteLength,
      voice: COMPANION_VOICE_SPEAK_VOICE,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async speakCompanionVoiceSegment(
    request: CompanionVoiceSpeakSegmentRequestV2,
    requestId?: string,
  ): Promise<CompanionVoiceSpeakResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.requestAudioBytes(
      "/voice/tts",
      { method: "POST", body: JSON.stringify(request) },
      requestId,
    );
    const parsed = companionVoiceSpeakResultV1Schema.safeParse({
      version: 1,
      mimeType: "audio/mpeg",
      audioBase64: Buffer.from(result.bytes).toString("base64"),
      byteLength: result.bytes.byteLength,
      voice: COMPANION_VOICE_SPEAK_VOICE,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 一段音频的播放结局上报（0247）。
   *
   * 与合成的取字节路径分开，是因为这一段音频**有没有真的响**只有渲染进程知道：
   * 合成请求成功 = 字节交出去了，之后可能等到超时、可能解码失败。调用方是
   * fire-and-forget，所以这里失败只意味着少一行统计，绝不能冒泡成"朗读中断"。
   */
  async recordCompanionVoicePlaybackOutcome(
    request: CompanionVoicePlaybackOutcomeRequestV1,
    requestId?: string,
  ): Promise<CompanionVoicePlaybackOutcomeResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/voice/tts/playback-outcome",
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = companionVoicePlaybackOutcomeResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  private async getActiveCardGenerationSummaries(requestId?: string): Promise<CardGenerationActiveSummaryListV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/v2/card-generation-runs/active",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = cardGenerationActiveSummaryListV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async getNote(noteId: string, requestId?: string): Promise<NoteDetailV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(`/v2/notes/${this.safeUuid(noteId)}`, { method: "GET" }, true, true, requestId);
    const parsed = noteDetailV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * `POST /notes` commits the note and its first version together but answers
   * with raw rows, so the created note is read back through the same projection
   * every other note read uses. A failed read-back is reported as unknown
   * rather than as a failed create: the note exists, and replaying the call
   * would leave a second one behind.
   */
  async createNote(request: DesktopNoteCreateRequest, requestId?: string): Promise<NoteDetailV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/notes",
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const created = z.object({ note: z.object({ id: z.string().uuid() }).passthrough() }).passthrough().safeParse(result.body);
    if (!created.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    try {
      return await this.getNote(created.data.note.id, requestId);
    } catch {
      throw new DesktopGatewayFailure("result_unknown", "resync_first");
    }
  }

  /**
   * `DELETE /notes/:id` soft-deletes the note and answers 204, so the receipt is
   * built here: the renderer only needs to know which note left the shelf.
   */
  async deleteNote(noteId: string, requestId?: string): Promise<DesktopNoteMutationResult> {
    await this.ensureConnected(requestId);
    await this.request(`/notes/${this.safeUuid(noteId)}`, { method: "DELETE" }, true, true, requestId);
    return { noteId, status: "deleted" };
  }

  /** `POST /notes/:id/restore` is the inverse of the soft delete. */
  async restoreNote(noteId: string, requestId?: string): Promise<DesktopNoteMutationResult> {
    await this.ensureConnected(requestId);
    await this.request(`/notes/${this.safeUuid(noteId)}/restore`, { method: "POST" }, true, true, requestId);
    return { noteId, status: "restored" };
  }

  /**
   * `GET /notes/:id/versions` answers raw version rows. The desktop projection
   * keeps the number, the timestamps and which one the note points at now, and
   * drops `createdBy` — the reader is looking at the note's own history, not at
   * the workspace's member ids.
   */
  async listNoteVersions(
    noteId: string,
    currentVersionId: string,
    limit: number,
    requestId?: string,
  ): Promise<DesktopNoteVersionList> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/notes/${this.safeUuid(noteId)}/versions?limit=${encodeURIComponent(String(limit))}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = z.object({
      items: z.array(z.object({
        id: z.string().uuid(),
        versionNo: z.number().int().min(1),
        createdAt: z.string(),
        updatedAt: z.string(),
      }).passthrough()).max(200),
    }).passthrough().safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return desktopNoteVersionListSchema.parse({
      noteId,
      total: parsed.data.items.length,
      items: parsed.data.items.map((item) => ({
        versionId: item.id,
        versionNo: item.versionNo,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        current: item.id === currentVersionId,
      })),
    });
  }

  /**
   * `POST /notes/:id/versions/:versionId/restore` points the note back at an
   * older version without creating a new one. `baseVersionId` carries the
   * caller's optimistic read, so a concurrent edit answers 409 instead of being
   * overwritten silently.
   */
  async restoreNoteVersion(
    noteId: string,
    versionId: string,
    baseVersionId: string,
    requestId?: string,
  ): Promise<DesktopNoteMutationResult> {
    await this.ensureConnected(requestId);
    await this.request(
      `/notes/${this.safeUuid(noteId)}/versions/${this.safeUuid(versionId)}/restore`,
      { method: "POST", body: JSON.stringify({ baseVersionId }) },
      true,
      true,
      requestId,
    );
    return { noteId, status: "restored" };
  }

  async saveNote(
    noteId: string,
    request: DesktopNoteSaveRequestV1,
    _commandId: string,
    requestId?: string,
  ): Promise<NoteSaveReceiptV1> {
    await this.ensureConnected(requestId);
    try {
      const result = await this.request(
        `/v2/notes/${this.safeUuid(noteId)}`,
        { method: "PATCH", body: JSON.stringify(request) },
        true,
        true,
        requestId,
      );
      const parsed = noteSaveReceiptV1Schema.safeParse(result.body);
      if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      return parsed.data;
    } catch (error) {
      // PATCH may have committed before the transport failed.  The caller
      // must re-read the Note/version and must not blindly replay the write.
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

  async startCardGenerationRun(
    request: DesktopCreateCardGenerationRunRequestV2,
    commandId: string,
    requestId?: string,
  ): Promise<CardGenerationJobAcceptedV1> {
    await this.ensureConnected(requestId);
    try {
      const result = await this.request(
        "/v2/card-generation-runs",
        {
          method: "POST",
          body: JSON.stringify(request),
          headers: { "X-Idempotency-Key": this.idempotencyKey("cardGeneration-start", commandId) },
        },
        true,
        true,
        requestId,
      );
      return cardGenerationJobAcceptedV1Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

  private async getCardGenerationRunServerView(runId: string, requestId?: string): Promise<CardGenerationRunServerViewV2> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/v2/card-generation-runs/${this.safeUuid(runId)}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    return cardGenerationRunServerViewV2Schema.parse(result.body);
  }

  async getCardGenerationRun(runId: string, requestId?: string): Promise<CardGenerationRunSnapshotV1> {
    const server = await this.getCardGenerationRunServerView(runId, requestId);
    return cardGenerationRunSnapshotV1Schema.parse(projectCardGenerationRunSnapshotV1(server));
  }

  /**
   * The note's most recent run, or null when it has never been generated. The
   * note page needs the run a feedback-carrying regeneration answers, and a
   * missing record is an ordinary state, not a failure.
   */
  async getLatestCardGenerationRun(noteId: string, requestId?: string): Promise<CardGenerationRunSnapshotV1 | null> {
    await this.ensureConnected(requestId);
    try {
      const result = await this.request(
        `/v2/notes/${this.safeUuid(noteId)}/card-generation-runs/latest`,
        { method: "GET" },
        true,
        true,
        requestId,
      );
      const server = cardGenerationRunServerViewV2Schema.parse(result.body);
      return cardGenerationRunSnapshotV1Schema.parse(projectCardGenerationRunSnapshotV1(server));
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "not_found") return null;
      throw error;
    }
  }

  private async getCardGenerationPlan(runId: string, requestId?: string) {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/v2/card-generation-runs/${this.safeUuid(runId)}/plan`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    return cardPlanV2Schema.parse(result.body);
  }

  async getCardGenerationCandidates(runId: string, requestId?: string): Promise<CardGenerationCandidateListV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      `/v2/card-generation-runs/${this.safeUuid(runId)}/candidates`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    return cardGenerationCandidateListV1Schema.parse(result.body);
  }

  /**
   * The same preflight the activation path runs, exposed to the review page so
   * the reviewer sees what revealing the answer already did to this candidate's
   * first validation instead of reading a sentence about it.
   */
  async getCardGenerationExposure(
    runId: string,
    candidateId: string,
    revision: number,
    requestId?: string,
  ): Promise<CardGenerationExposureEligibilityV1> {
    return this.getCardGenerationExposureEligibility(runId, candidateId, revision, requestId);
  }

  /** Main-only activation preflight; the renderer receives only the final receipt. */
  private async getCardGenerationExposureEligibility(
    runId: string,
    candidateId: string,
    revision: number,
    requestId?: string,
  ): Promise<CardGenerationExposureEligibilityV1> {
    await this.ensureConnected(requestId);
    const query = new URLSearchParams({ revision: String(revision) });
    const result = await this.request(
      `/v2/card-generation-runs/${this.safeUuid(runId)}/candidates/${this.safeUuid(candidateId)}/exposure?${query.toString()}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    return cardGenerationExposureEligibilityV1Schema.parse(result.body);
  }

  async reviewCardGeneration(
    runId: string,
    request: DesktopCandidateReviewRequestV2,
    commandId: string,
    requestId?: string,
  ): Promise<CardGenerationReviewResultV1> {
    await this.ensureConnected(requestId);
    try {
      const server = await this.getCardGenerationRunServerView(runId, requestId);
      const plan = await this.getCardGenerationPlan(runId, requestId);
      const body = candidateActionCommandV2Schema.parse({
        version: 2,
        runId,
        expectedCardContentEpoch: server.cardContentEpoch,
        expectedPlanVersion: plan.planVersion,
        expectedPlanHash: plan.planHash,
        expectedReviewDraftRevision: request.expectedReviewDraftRevision,
        action: request.action,
      });
      const result = await this.request(
        `/v2/card-generation-runs/${this.safeUuid(runId)}/candidate-actions`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "X-Idempotency-Key": this.idempotencyKey("cardGeneration-review", commandId) },
        },
        true,
        true,
        requestId,
      );
      const response = cardGenerationReviewResultV1Schema.parse(result.body);
      const refreshed = await this.getCardGenerationRunServerView(runId, requestId);
      if (refreshed.reviewDraftRevision !== response.reviewDraftRevision) {
        throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      }
      return response;
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

  async revealCardGenerationCandidate(
    runId: string,
    candidateId: string,
    request: DesktopRevealCandidateRequestV2,
    commandId: string,
    requestId?: string,
  ): Promise<z.infer<typeof candidateRevealV2Schema>> {
    await this.ensureConnected(requestId);
    if (request.candidateId !== candidateId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    try {
      const result = await this.request(
        `/v2/card-generation-runs/${this.safeUuid(runId)}/candidates/${this.safeUuid(candidateId)}/reveal`,
        {
          method: "POST",
          body: JSON.stringify(request),
          headers: { "X-Idempotency-Key": this.idempotencyKey("cardGeneration-reveal", commandId) },
        },
        true,
        true,
        requestId,
      );
      return candidateRevealV2Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

  async activateCardGeneration(
    runId: string,
    request: DesktopCardGenerationActivationSelectionV1,
    commandId: string,
    requestId?: string,
  ): Promise<CardActivationReceiptDesktopV1> {
    await this.ensureConnected(requestId);
    if (request.runId !== runId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    try {
      const server = await this.getCardGenerationRunServerView(runId, requestId);
      const plan = await this.getCardGenerationPlan(runId, requestId);
      // Activation confirmation must be based on current-user, exact-revision
      // server state—not renderer/session memory. Any unavailable/invalid
      // preflight fails closed before the activation POST is attempted.
      for (const selected of request.selectedCandidates) {
        const exposure = await this.getCardGenerationExposureEligibility(
          runId,
          selected.candidateId,
          selected.revision,
          requestId,
        );
        if (exposure.exposureStatus === "unknown" || exposure.initialValidationPolicyEffect === "unknown") {
          throw new DesktopGatewayFailure("result_unknown", "resync_first");
        }
      }
      const clientReviewHash = computeClientReviewHashV2({
        runId,
        expectedReviewDraftRevision: request.expectedReviewDraftRevision,
        selected: request.selectedCandidates.map((selected) => ({
          candidateId: selected.candidateId,
          revision: selected.revision,
          revisionHash: selected.revisionHash,
        })),
        reviewUiContractVersion: "review-ui-v1",
      });
      const body = activateCardCandidatesRequestV2Schema.parse({
        version: 2,
        runId,
        sourceSnapshotHash: server.sourceSnapshotHash,
        semanticSpecHash: server.semanticSpecHash,
        inputSnapshotHash: server.inputSnapshotHash,
        expectedCardContentEpoch: server.cardContentEpoch,
        planRevisionId: plan.planRevisionId,
        expectedPlanVersion: plan.planVersion,
        planHash: plan.planHash,
        selectedCandidates: request.selectedCandidates.map((selected) => ({
          ...selected,
          qualityReportHashes: [],
        })),
        existingLifecycleActions: request.existingLifecycleActions,
        expectedReviewDraftRevision: request.expectedReviewDraftRevision,
        clientReviewHash,
      });
      const result = await this.request(
        `/v2/card-generation-runs/${this.safeUuid(runId)}/activate`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "X-Idempotency-Key": this.idempotencyKey("cardGeneration-activate", commandId) },
        },
        true,
        true,
        requestId,
      );
      const receipt = cardActivationReceiptV2Schema.parse(result.body);
      return cardActivationReceiptDesktopV1Schema.parse(projectCardActivationReceiptV1(receipt));
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

  async cancelCardGeneration(runId: string, _commandId: string, requestId?: string): Promise<CardGenerationCancelResultV1> {
    await this.ensureConnected(requestId);
    try {
      const result = await this.request(
        `/v2/card-generation-runs/${this.safeUuid(runId)}/cancel`,
        { method: "POST" },
        true,
        true,
        requestId,
      );
      return cardGenerationCancelResultV1Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

  async retryCardGeneration(runId: string, _commandId: string, requestId?: string): Promise<CardGenerationRetryResultV1> {
    await this.ensureConnected(requestId);
    try {
      const result = await this.request(
        `/v2/card-generation-runs/${this.safeUuid(runId)}/retry`,
        { method: "POST" },
        true,
        true,
        requestId,
      );
      return cardGenerationRetryResultV1Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        // 与 cancel 同一纪律：网络断了不等于操作没生效，让用户先重新同步再决定。
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

  async closeCardGeneration(runId: string, expectedReviewDraftRevision: number, _commandId: string, requestId?: string): Promise<CardGenerationCloseResultV1> {
    await this.ensureConnected(requestId);
    try {
      const result = await this.request(
        `/v2/card-generation-runs/${this.safeUuid(runId)}/close`,
        {
          method: "POST",
          body: JSON.stringify({ expectedReviewDraftRevision }),
        },
        true,
        true,
        requestId,
      );
      return cardGenerationCloseResultV1Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

  async getLearningRun(runId: string, requestId?: string): Promise<z.infer<typeof learningRunPublicSnapshotV2Schema>> {
    const safeRunId = this.safeUuid(runId);
    return this.getLearningRunV2(safeRunId, `/learning-runs/${safeRunId}/v2`, learningRunPublicSnapshotV2Schema, requestId);
  }

  async watchLearningRunEvents(
    runId: string,
    onSequence: (sequence: number) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.ensureConnected();
    const safeRunId = this.safeUuid(runId);
    // Bind the main-owned stream to the same strict V2 snapshot used by the
    // query/command paths. An unknown snapshot fails closed before
    // any raw SSE payload can reach the renderer bridge.
    const streamSnapshot = await this.getLearningRun(safeRunId);
    const controller = new AbortController();
    let closed = false;
    let cursor = 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };

    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
          if (cursor > 0) headers.set("Last-Event-ID", String(cursor));
          const eventsUrl = new URL(`/learning-runs/${safeRunId}/events`, `${configuration.config.apiOrigin}/`);
          eventsUrl.searchParams.set("snapshotId", streamSnapshot.snapshotId);
          const response = await fetch(eventsUrl, {
            method: "GET",
            headers,
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status >= 300 && response.status < 400) {
            throw new DesktopGatewayFailure("api_untrusted", "user_action");
          }
          if (!response.ok) throw this.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const sequence = parseSseSequence(block);
              if (sequence !== null && sequence > cursor) {
                cursor = sequence;
                await onSequence(sequence);
              }
            }
          }
          buffer += decoder.decode();
          const sequence = parseSseSequence(buffer);
          if (sequence !== null && sequence > cursor) {
            cursor = sequence;
            await onSequence(sequence);
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  async watchCardGenerationEvents(
    runId: string,
    onSequence: (sequence: number) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.ensureConnected();
    const safeRunId = this.safeUuid(runId);
    const controller = new AbortController();
    let closed = false;
    let cursor = 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };

    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
          if (cursor > 0) headers.set("Last-Event-ID", String(cursor));
          const response = await fetch(new URL(`/v2/card-generation-runs/${safeRunId}/events/stream`, `${configuration.config.apiOrigin}/`), {
            method: "GET",
            headers,
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status >= 300 && response.status < 400) {
            throw new DesktopGatewayFailure("api_untrusted", "user_action");
          }
          if (!response.ok) throw this.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const sequence = parseSseSequence(block);
              if (sequence !== null && sequence > cursor) {
                cursor = sequence;
                await onSequence(sequence);
              }
            }
          }
          buffer += decoder.decode();
          const sequence = parseSseSequence(buffer);
          if (sequence !== null && sequence > cursor) {
            cursor = sequence;
            await onSequence(sequence);
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  /**
   * 伴星会话事件流（§5.3）：`GET /companion/conversations/:id/events`。
   *
   * 与 learningRun/cardGeneration 两条流同构（NOTIFY 唤醒 + 兜底轮询由服务端负责），
   * 区别是这里转发**事件本身**而不是"有新版本了"的信号：回复的渐进显现与逐句开口
   * 要求帧到即渲染，再让渲染层回查一次消息等于把流式的收益原路还回去。
   *
   * `eventCursor` 是订阅起点（seq 独占），来自回合响应的 `eventCursor`——从
   * turn.accepted 之后开始收，不重放历史。断线以 `Last-Event-ID` 续传；
   * 400/409（游标落在过期窗口）只允许重置为 0 重放一次，再失败即停流并报错，
   * 由渲染层的消息快照兜底。
   */
  async watchCompanionConversationEvents(
    conversationId: string,
    eventCursor: number,
    onEvent: (event: CompanionChatStreamEventV1) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.ensureConnected();
    const safeConversationId = this.safeUuid(conversationId);
    const controller = new AbortController();
    let closed = false;
    let cursor = Number.isSafeInteger(eventCursor) && eventCursor >= 0 ? eventCursor : 0;
    let resetOnce = false;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };

    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
          // 服务端 cursor 取合法较大值：query `after` 与 Last-Event-ID 并存时以
          // 大者为准（§5.3），两者给同一个值即可。
          if (cursor > 0) headers.set("Last-Event-ID", `${safeConversationId}:${cursor}`);
          const eventsUrl = new URL(
            `/companion/conversations/${safeConversationId}/events`,
            `${configuration.config.apiOrigin}/`,
          );
          eventsUrl.searchParams.set("after", String(cursor));
          const response = await fetch(eventsUrl, {
            method: "GET",
            headers,
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status === 400 || response.status === 409) {
            // INVALID_CURSOR / CURSOR_EXPIRED：窗口已过期，只能从头重放一次。
            // 渲染层按 runId/generation 过滤，重放不会污染当前回合的呈现。
            if (resetOnce) throw this.mapResponseError(response.status, response.headers);
            resetOnce = true;
            cursor = 0;
            continue;
          }
          if (response.status >= 300 && response.status < 400) {
            throw new DesktopGatewayFailure("api_untrusted", "user_action");
          }
          if (!response.ok) throw this.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const event = parseCompanionSseFrame(block);
              if (!event || event.seq <= cursor) continue;
              cursor = event.seq;
              await onEvent(event);
            }
          }
          buffer += decoder.decode();
          const tail = parseCompanionSseFrame(buffer);
          if (tail && tail.seq > cursor) {
            cursor = tail.seq;
            await onEvent(tail);
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  /**
   * 打开一篇笔记的协同连接（批次 4.3）。
   *
   * 三条约束在这里收口：
   *  - **URL 只由配置派生**（`noteDocStreamUrl`），界面传不进目标地址；
   *  - token 只在这条进程里，渲染进程看到的永远是 base64 帧；
   *  - 门控分两层，各有各的位置：空间那一层（personal 不建、只读成员不建）在
   *    `desktop-ipc.ts` 的订阅路径上判，因为那里才有当前空间的类型与角色；**篇**这一层
   *    （「仅自己可见」的不建）在这里判，判据取服务端给的归属，不取界面传进来的说法。
   *    返回 `null` 就是"这篇不该有实时连接"，调用方要能接住它——写入不受影响。
   *
   * 返回的 handle 是长生命周期对象：`stop()` 之后任何回调都不再触发（provider 已销毁），
   * 所以调用方不必自己防"关完之后迟到的帧"。
   */
  async watchNoteDocument(
    noteId: string,
    onEvent: (event: { noteId: string } & NoteDocStreamEventV1) => void | Promise<void>,
    requestId?: string,
  ): Promise<NoteDocWatchHandle | null> {
    await this.ensureConnected(requestId);
    const configuration = this.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    if (!this.token) throw new DesktopGatewayFailure("auth_required", "user_action");
    const safeNoteId = this.safeUuid(noteId);
    // 「仅自己可见」的那篇不建实时连接。顺便这一步也把编辑起点取到手了，
    // 所以它不是"为判一位而多发一次请求"——离线那条路本来就靠这次打底。
    const startingPoint = await this.getNoteDocState(safeNoteId, requestId);
    if (startingPoint.shareScope !== "shared") return null;
    let url: string;
    try {
      url = noteDocStreamUrl(configuration.config.apiOrigin);
    } catch {
      throw new DesktopGatewayFailure("configuration_error", "user_action");
    }
    let stopped = false;
    const handle = this.noteDocTransport({
      url,
      documentName: `${NOTE_DOC_PREFIX}${safeNoteId}`,
      token: this.token,
      onEvent: (event) => {
        // stop() 之后迟到的帧必须丢掉：渲染层此刻可能已经换到另一篇笔记甚至另一个空间。
        if (stopped) return;
        const wire = toNoteDocStreamEvent(event);
        if (!wire) return;
        void onEvent({ noteId: safeNoteId, ...wire });
      },
    });
    return {
      applyLocal: (update) => (stopped ? null : handle.applyLocal(update)),
      setPresence: (state) => {
        if (stopped) return;
        handle.setPresence(state);
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        handle.close();
      },
    };
  }

  /** 编辑起点：与服务端同源的那份 Y.Doc 编码。界面不能拿 blocks 自己拼一棵文档树。 */
  async getNoteDocState(noteId: string, requestId?: string): Promise<NoteDocStateResultV1> {
    await this.ensureConnected(requestId);
    const safeNoteId = this.safeUuid(noteId);
    const result = await this.request(`/v2/notes/${safeNoteId}/doc-state`, { method: "GET" }, true, true, requestId);
    const parsed = noteDocServerStateV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    // yjs 编码只活在这一层：主进程解成视图再交给界面。让界面也拿编码，就得在渲染进程
    // 再装一份 CRDT 依赖，而它要显示的本来就是块。
    // 顺手把这篇的本机会话打好底。**离线编辑的前提是"曾经拿到过起点"**：没有共同的
    // 祖先就凭空造不出增量（从行里拼一棵树会被服务端当成另一篇文档，一改就复制块）。
    // 所以取起点的那一刻（界面打开这篇）就把状态留下，而不是等第一次提交才去取——
    // 那时候可能已经没有网了。
    const session = this.noteDocLocalSession(safeNoteId);
    if (!session.seeded) {
      session.state.seed(parsed.data.update);
      session.seeded = true;
      session.revision = parsed.data.revision;
      session.savedAt = parsed.data.savedAt;
    }
    // 归属每次都记：一篇从 shared 撤回成 private 的笔记，本机下一次离线打开时
    // 要按最新那一位决定建不建连接。
    session.shareScope = parsed.data.shareScope;
    // 起点交的是**这一台机器上看到的那份状态**，不是服务端那一串原字节：本机如果已经
    // 攒了没送出去的编辑，界面重启后必须接着它们，而不是从服务端那份重开一篇、
    // 再把没送出去的改动当成别人的覆盖掉。`seed` 之后 `encodeState()` 就是两者合并的结果。
    return {
      update: session.state.encodeState(),
      revision: parsed.data.revision,
      backfilled: parsed.data.backfilled,
      shareScope: parsed.data.shareScope,
    };
  }

  /**
   * 没有长连接时的一次写入（personal 空间、只读门控之外的场景）：取一次起点、就地差分、
   * 把差出来的增量交给同一个 HTTP 口。
   *
   * 为什么不直接"把整篇 POST 上去"：那等于回到覆盖式保存，正是本轮要消灭的形状。起点
   * 是服务端那份编码，差分才有"只改动真正变过的地方"这个语义。
   */
  /**
   * 一次提交（无长连接时的那条路）：拿到起点 → 本机文档差分 → 上送。
   *
   * 三种出口要分清，界面据此说不同的话：`uploaded` 服务端已落盘；`unchanged` 这次
   * 什么都没改；`queued` 没网，改动已经攒在本机文档里、恢复后自动交。把 `queued`
   * 报成 `uploaded` 就是这次审查里"看起来存下来了"的那个错觉本身。
   *
   * 不传 `blocks`（`null`）= 这次只改标题，正文一个字都不动。
   */
  /** 列表里改名：标题写进本机那份文档的 `meta`，之后与正文走同一条上行。 */
  async syncNoteDocTitle(
    noteId: string,
    title: string,
    titleSource: string,
    requestId?: string,
  ): Promise<NoteDocSyncOutcome> {
    const safeNoteId = this.safeUuid(noteId);
    await this.ensureNoteDocSeeded(safeNoteId, requestId);
    return this.settleNoteDocUpdate(
      safeNoteId,
      this.noteDocLocalSession(safeNoteId).state.applyTitle(title, titleSource),
      requestId,
    );
  }

  /**
   * 取一次编辑起点（没取过的话）。界面打开这篇、或本机在自己那份上写一个字段之前，
   * 都要先有它——没网的时候也要，因为那时候起点的唯一来源就是本机存的那一份。
   */
  private async ensureNoteDocSeeded(safeNoteId: string, requestId?: string): Promise<void> {
    const session = this.noteDocLocalSession(safeNoteId);
    if (session.seeded) return;
    const start = await this.request(
      `/v2/notes/${safeNoteId}/doc-state`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = noteDocServerStateV1Schema.safeParse(start.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    session.state.seed(parsed.data.update);
    session.seeded = true;
    session.revision = parsed.data.revision;
    session.savedAt = parsed.data.savedAt;
    // 归属也一并留下：这条路上没走过 `getNoteDocState`，不落这一位的话，
    // 本机那份永远"不可持久化"，离线队列又只能在内存里活一次。
    session.shareScope = parsed.data.shareScope;
  }

  /**
   * 本机一条增量（或"什么都没有"）之后的同一段收尾：压队列、合并、上送、如实回报
   * 走到哪一步。正文与标题两条来源共用它——两条路"走到了哪"必须是同一个答案。
   */
  private async settleNoteDocUpdate(
    safeNoteId: string,
    produced: string | null,
    requestId?: string,
  ): Promise<NoteDocSyncOutcome> {
    const session = this.noteDocLocalSession(safeNoteId);
    if (produced !== null) {
      if (session.pending.length >= NOTE_DOC_PENDING_MAX) {
        // 不再往上堆：把"攒了多少"如实报出来，界面才能说"先联网再改"。
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      session.pending.push(produced);
    }
    if (session.pending.length === 0) {
      return { via: "unchanged", revision: session.revision, savedAt: session.savedAt };
    }
    const merged = mergeNoteDocUpdates(session.pending);
    let receipt: NoteDocUploadResultV1;
    try {
      receipt = await this.uploadNoteDocUpdate(safeNoteId, merged, requestId);
    } catch (error) {
      if (!isOfflineFailure(error)) {
        // 权限/尺寸/非法编码这类错误重发一百次也是同一个结果，不能留在队列里
        // 让它变成"每次输入都重试一次的死循环"。只退掉这一次刚压进去的那条。
        if (produced !== null) session.pending.pop();
        throw error;
      }
      return { via: "queued", revision: session.revision, savedAt: session.savedAt };
    }
    session.pending = [];
    session.revision = receipt.revision;
    session.savedAt = receipt.savedAt;
    return { via: "uploaded", revision: receipt.revision, savedAt: receipt.savedAt };
  }

  async syncNoteDocUpdate(
    noteId: string,
    update: string,
    requestId?: string,
  ): Promise<NoteDocSyncOutcome> {
    const safeNoteId = this.safeUuid(noteId);
    await this.ensureNoteDocSeeded(safeNoteId, requestId);
    return this.settleNoteDocUpdate(
      safeNoteId,
      this.noteDocLocalSession(safeNoteId).state.applyLocal(update),
      requestId,
    );
  }

  /** 长连接建立前把攒下的增量交出去：连上了还压着一批，界面上就是"已经同步"的假象。 */
  async flushNoteDocPending(noteId: string, requestId?: string): Promise<void> {
    const session = this.noteDocLocalSessions.get(this.safeUuid(noteId));
    if (!session || session.pending.length === 0) return;
    const merged = mergeNoteDocUpdates(session.pending);
    try {
      const receipt = await this.uploadNoteDocUpdate(this.safeUuid(noteId), merged, requestId);
      session.pending = [];
      session.revision = receipt.revision;
      session.savedAt = receipt.savedAt;
    } catch (error) {
      if (!isOfflineFailure(error)) {
        session.pending = [];
        throw error;
      }
      // 还是没通：留着，下一次写或下一次建连再试。
    }
  }

  /**
   * 本机这一篇的持久快照：整份文档状态 + 还没交出去的增量。
   *
   * 由 IPC 那一侧落盘——身份（哪个账号、哪个空间）只有边界层知道，网关不该自己
   * 持有一份可能过期的判据（这一轮审查里同类的问题出现过好几次）。
   */
  noteDocLocalSnapshot(noteId: string): {
    docState: string;
    pending: string[];
    revision: number;
    savedAt: string;
    shareScope: NoteShareScopeV1;
  } | null {
    const session = this.noteDocLocalSessions.get(this.safeUuid(noteId));
    // 认的是"这一份有没有一个来自服务端的祖先"（`shareScope` 只在拿到服务端起点
    // 或从盘上接回来时才有值），不认 `seeded`：从盘上接回来的那份同样该被再次落盘，
    // 否则第一次重启就把欠的增量弄丢了。
    if (!session || !session.shareScope) return null;
    return {
      docState: session.state.encodeState(),
      pending: [...session.pending],
      revision: session.revision,
      savedAt: session.savedAt,
      shareScope: session.shareScope,
    };
  }

  /**
   * 开机后把本机那一份接回来。
   *
   * 顺序上是"先并本机、再并服务端给的起点"，两个方向都是 CRDT 合并，不是谁覆盖谁：
   * 断网期间别人改过的部分会从服务端进来，我改的部分在 `pending` 里等着交。
   * 因此这里**不**把 `seeded` 置真——服务端的起点随后仍要并一次。
   */
  restoreNoteDocLocal(
    noteId: string,
    snapshot: {
      docState: string;
      pending: string[];
      revision: number;
      savedAt: string;
      shareScope: NoteShareScopeV1;
    },
  ): void {
    const safeNoteId = this.safeUuid(noteId);
    const session = this.noteDocLocalSession(safeNoteId);
    if (session.seeded) return;
    session.state.seed(snapshot.docState);
    session.pending = snapshot.pending.slice(0, NOTE_DOC_PENDING_MAX);
    session.revision = snapshot.revision;
    session.savedAt = snapshot.savedAt;
    session.shareScope = snapshot.shareScope;
  }

  /** 切空间 / 被移出时调用：另一个空间的正文绝不能接着往这篇上差分。 */
  dropNoteDocLocalSessions(): void {
    for (const session of this.noteDocLocalSessions.values()) session.state.dispose();
    this.noteDocLocalSessions.clear();
  }

  private noteDocLocalSession(noteId: string): NoteDocLocalSession {
    const existing = this.noteDocLocalSessions.get(noteId);
    if (existing) return existing;
    const created: NoteDocLocalSession = {
      state: createNoteDocState(),
      seeded: false,
      revision: 0,
      savedAt: "",
      pending: [],
      shareScope: null,
    };
    this.noteDocLocalSessions.set(noteId, created);
    return created;
  }

  /**
   * 「共享给空间」/「取消共享」。幂等：设成当前值时服务端报 `changed:false` 且不写行，
   * 所以界面点重了不会多出一次"改动"。
   */
  async setNoteShareScope(
    noteId: string,
    shareScope: NoteShareScopeV1,
    requestId?: string,
  ): Promise<NoteShareScopeReceiptV1> {
    await this.ensureConnected(requestId);
    const safeNoteId = this.safeUuid(noteId);
    const result = await this.request(
      `/v2/notes/${safeNoteId}/share-scope`,
      { method: "PATCH", body: JSON.stringify({ shareScope }) },
      true,
      true,
      requestId,
    );
    const parsed = noteShareScopeReceiptV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 一次性上送增量（personal 空间与离线队列重连用）。
   *
   * 不需要幂等键：把同一条 update 再应用一次是 Yjs 层面的空操作（服务端为此专门有一条
   * 用例），所以重发天然安全，多余的 key 反而多一套要对齐的状态。
   */
  async uploadNoteDocUpdate(
    noteId: string,
    update: string,
    requestId?: string,
  ): Promise<NoteDocUploadResultV1> {
    await this.ensureConnected(requestId);
    const safeNoteId = this.safeUuid(noteId);
    const result = await this.request(
      `/v2/notes/${safeNoteId}/doc-update`,
      { method: "POST", body: JSON.stringify({ update }) },
      true,
      true,
      requestId,
    );
    const parsed = noteDocUploadResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async startLearningRun(request: DesktopCreateLearningRunV2Request, commandId: string, requestId?: string): Promise<z.infer<typeof learningRunPublicSnapshotV2Schema>> {
    await this.ensureConnected(requestId);
    const body = { ...request, version: 2 as const, idempotencyKey: this.idempotencyKey("learningRun-start", commandId) };
    const result = await this.request("/learning-runs", { method: "POST", body: JSON.stringify(body) }, true, true, requestId);
    const parsed = learningRunPublicSnapshotV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    if (!isDeepStrictEqual(parsed.data.originV2, request.originV2)) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    return parsed.data;
  }

  async getLearningRunDraft(runId: string, taskId: string, requestId?: string): Promise<z.infer<typeof learningTaskDraftV2Schema> | null> {
    await this.ensureConnected(requestId);
    const safeRunId = this.safeUuid(runId);
    const safeTaskId = this.safeUuid(taskId);
    const result = await this.request(
      `/learning-runs/${safeRunId}/tasks/${safeTaskId}/draft/v2`,
      { method: "GET" },
      true,
      false,
      requestId,
      undefined,
      true,
    );
    if (result.status >= 300) {
      const draftNotFound = z.object({ error: z.literal("draft_not_found") }).safeParse(result.body);
      if (result.status === 404 && draftNotFound.success) return null;
      throw this.mapResponseError(result.status, result.headers);
    }
    const parsed = learningTaskDraftV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return this.ensureLearningTaskBinding(parsed.data, safeRunId, safeTaskId);
  }

  async saveLearningRunDraft(runId: string, taskId: string, request: DesktopPutLearningTaskDraftV2Request, commandId: string, requestId?: string): Promise<z.infer<typeof learningTaskDraftWriteReceiptV2Schema>> {
    await this.ensureConnected(requestId);
    const safeRunId = this.safeUuid(runId);
    const safeTaskId = this.safeUuid(taskId);
    const body = { ...request, version: 2 as const, idempotencyKey: this.idempotencyKey("learningRun-draft", commandId) };
    try {
      const result = await this.request(`/learning-runs/${safeRunId}/tasks/${safeTaskId}/draft/v2`, { method: "PUT", body: JSON.stringify(body) }, true, true, requestId);
      const parsed = learningTaskDraftWriteReceiptV2Schema.safeParse(result.body);
      if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      const receipt = this.ensureLearningTaskBinding(parsed.data, safeRunId, safeTaskId, request.snapshotId);
      if (receipt.variantId !== request.variantId) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      return receipt;
    } catch (error) {
      throw this.learningRunMutationResult(error);
    }
  }

  async submitLearningRunArtifact(runId: string, taskId: string, request: DesktopSubmitTaskArtifactV2, commandId: string, requestId?: string): Promise<z.infer<typeof submitTaskArtifactReceiptV2Schema>> {
    await this.ensureConnected(requestId);
    const safeRunId = this.safeUuid(runId);
    const safeTaskId = this.safeUuid(taskId);
    const body = { ...request, version: 2 as const, idempotencyKey: this.idempotencyKey("learningRun-submit", commandId) };
    try {
      const result = await this.request(`/learning-runs/${safeRunId}/tasks/${safeTaskId}/submissions/v2`, { method: "POST", body: JSON.stringify(body) }, true, true, requestId);
      const parsed = submitTaskArtifactReceiptV2Schema.safeParse(result.body);
      if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      return this.ensureLearningTaskBinding(parsed.data, safeRunId, safeTaskId, request.snapshotId);
    } catch (error) {
      throw this.learningRunMutationResult(error);
    }
  }

  async applyLearningRunAction(runId: string, request: DesktopLearningRunActionRequestV2, commandId: string, requestId?: string): Promise<z.infer<typeof learningRunActionResponseV2Schema>> {
    await this.ensureConnected(requestId);
    const safeRunId = this.safeUuid(runId);
    const body = { ...request, version: 2 as const, idempotencyKey: this.idempotencyKey("learningRun-action", commandId) };
    try {
      const result = await this.request(`/learning-runs/${safeRunId}/actions/v2`, { method: "POST", body: JSON.stringify(body) }, true, true, requestId);
      const parsed = learningRunActionResponseV2Schema.safeParse(result.body);
      if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      return this.ensureLearningRunBinding(parsed.data, safeRunId, request.snapshotId);
    } catch (error) {
      throw this.learningRunMutationResult(error);
    }
  }

  async getLearningRunResult(runId: string, requestId?: string): Promise<z.infer<typeof getLearningRunResultResponseV2Schema>> {
    const safeRunId = this.safeUuid(runId);
    return this.getLearningRunV2(safeRunId, `/learning-runs/${safeRunId}/result/v2`, getLearningRunResultResponseV2Schema, requestId);
  }

  async getLearningRunReturnContract(runId: string, requestId?: string): Promise<z.infer<typeof learningRunReturnContractV2Schema>> {
    const safeRunId = this.safeUuid(runId);
    return this.getLearningRunV2(safeRunId, `/learning-runs/${safeRunId}/return-contract/v2`, learningRunReturnContractV2Schema, requestId);
  }

  async revealLearningRunTarget(runId: string, requestId?: string): Promise<z.infer<typeof learningRunTargetRevealV2Schema>> {
    await this.ensureConnected(requestId);
    const safeRunId = this.safeUuid(runId);
    const result = await this.request(`/learning-runs/${safeRunId}/reveal/v2`, { method: "POST", body: "{}" }, true, true, requestId);
    const parsed = learningRunTargetRevealV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async recordLearningRunActivityLease(runId: string, request: DesktopRecordLearningRunActivityLeaseRequestV2, requestId?: string): Promise<z.infer<typeof recordLearningRunActivityLeaseOutputV2Schema>> {
    await this.ensureConnected(requestId);
    const safeRunId = this.safeUuid(runId);
    const body = {
      ...request,
      version: 2 as const,
      deviceSessionId: this.deviceSessionId,
    };
    const result = await this.request(`/learning-runs/${safeRunId}/activity-lease/v2`, { method: "POST", body: JSON.stringify(body) }, true, true, requestId);
    if (result.status !== 204) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return recordLearningRunActivityLeaseOutputV2Schema.parse({ recorded: true });
  }

  async abandonLearningRun(runId: string, request: DesktopLearningRunAbandonRequestV2, commandId: string, requestId?: string): Promise<z.infer<typeof learningRunActionResponseV2Schema>> {
    return this.applyLearningRunAction(runId, {
      version: 2,
      snapshotId: request.snapshotId,
      runRevision: request.runRevision,
      runtimeEpoch: request.runtimeEpoch,
      action: { kind: "end", abandonLockedEvidence: request.abandonLockedEvidence },
    }, commandId, requestId);
  }

  cancel(requestId: string): boolean {
    const controller = this.activeRequests.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async loadSession(requestId?: string): Promise<SessionContextV1> {
    const result = await this.request("/auth/me", { method: "GET" }, true, true, requestId);
    const parsed = rawAuthMeSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    const workspace = this.toWorkspaceContext(parsed.data);
    // 服务端是本机 epoch 的权威来源：边界一变（成员 / AI 同意 / 改名）它就变大，
    // 这里跟着走。本地切换时仍会 +1（切空间必须立刻让在途请求作废），但两者取
    // 较大值——否则"服务端抬过、本地计数还小"会让刚拿到的新 epoch 被自己覆盖回去。
    if (parsed.data.workspaceEpoch > this.workspaceEpoch) {
      this.workspaceEpoch = parsed.data.workspaceEpoch;
    }
    this.currentSession = sessionContextSchema.parse({
      version: 1,
      status: "authenticated",
      user: {
        userId: parsed.data.userId,
        email: parsed.data.email,
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      },
      workspace,
      membership: { role: parsed.data.role },
      capabilities: null,
      workspaceEpoch: this.workspaceEpoch,
      credentialPersistence: this.credentialPersistence,
    });
    // 记下"这个人现在在哪个空间"，给重认证那道门回去用（见 `reauthenticate`）。
    if (workspace) this.sessionWorkspaceReturn = { email: parsed.data.email, workspaceId: workspace.workspaceId };
    return this.currentSession;
  }

  private safeUuid(value: string): string {
    const parsed = uuidSchema.safeParse(value);
    if (!parsed.success) throw new DesktopGatewayFailure("invalid_request", "user_action");
    return parsed.data;
  }

  private idempotencyKey(operation: string, commandId: string): string {
    const key = `${operation}:${commandId}`;
    const existing = this.commandIdempotency.get(key);
    if (existing) return existing;
    const generated = randomUUID();
    this.commandIdempotency.set(key, generated);
    if (this.commandIdempotency.size > 2048) {
      const oldest = this.commandIdempotency.keys().next().value;
      if (oldest) this.commandIdempotency.delete(oldest);
    }
    return generated;
  }

  private async getLearningRunV2<T>(
    expectedRunId: string,
    path: string,
    // 输入侧写 `unknown`：带 `.default()` 的 schema 输入比输出宽（字段可省），
    // 若这里沿用默认的 `Input = Output`，T 会被推断到输入侧，调用方的返回类型
    // 就变成"字段可有可无"，与解析后的真实形状不符（审计 F28 的 checkpointReason
    // 就是这么把桌面端 typecheck 顶红的）。解析结果只以输出侧为准。
    schema: z.ZodType<T & { runId: string; snapshotId: string }, z.ZodTypeDef, unknown>,
    requestId?: string,
  ): Promise<T & { runId: string; snapshotId: string }> {
    await this.ensureConnected(requestId);
    const result = await this.request(path, { method: "GET" }, true, true, requestId);
    const parsed = schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return this.ensureLearningRunBinding(parsed.data, expectedRunId);
  }

  private ensureLearningRunBinding<T extends { runId: string; snapshotId: string }>(
    value: T,
    expectedRunId: string,
    expectedSnapshotId?: string,
  ): T {
    if (value.runId !== expectedRunId || (expectedSnapshotId !== undefined && value.snapshotId !== expectedSnapshotId)) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    return value;
  }

  private ensureLearningTaskBinding<T extends { runId: string; snapshotId: string; taskId: string }>(
    value: T,
    expectedRunId: string,
    expectedTaskId: string,
    expectedSnapshotId?: string,
  ): T {
    this.ensureLearningRunBinding(value, expectedRunId, expectedSnapshotId);
    if (value.taskId !== expectedTaskId) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return value;
  }

  private learningRunMutationResult(error: unknown): never {
    // A transport failure can happen after the API has committed a draft,
    // locked an artifact, or accepted an action.  These commands must never
    // be replayed from the renderer without first reading the authoritative
    // LearningRun state.
    if (error instanceof DesktopGatewayFailure && (error.code === "api_unavailable" || error.code === "network_timeout")) {
      throw new DesktopGatewayFailure("result_unknown", "resync_first", {
        ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      });
    }
    throw error;
  }

  private toWorkspaceSummary(value: z.infer<typeof rawWorkspaceListSchema>["workspaces"][number]): WorkspaceSummaryV1 {
    return {
      version: 1,
      workspaceId: value.workspaceId,
      name: value.workspaceName,
      role: value.role,
      workspaceType: value.workspaceType,
      isPersonal: value.isPersonal,
    };
  }

  private toWorkspaceContext(value: z.infer<typeof rawAuthMeSchema>): WorkspaceContextV1 {
    const summary = this.toWorkspaceSummary({
      workspaceId: value.workspaceId,
      workspaceName: value.workspaceName,
      role: value.role,
      workspaceType: value.workspaceType,
      isPersonal: value.isPersonal,
      leftAt: null,
    });
    return { ...summary, workspaceEpoch: this.workspaceEpoch };
  }

  private async ensureConnected(requestId?: string): Promise<void> {
    await this.restoreStoredCredential();
    if (this.connection.kind === "ready") return;
    await this.connect(requestId);
  }

  private async performLocalTrust(configuration: GatewayConfiguration, requestId?: string): Promise<void> {
    if (!configuration.pairingSecret || configuration.config.mode !== "local_loopback") {
      throw new DesktopGatewayFailure("configuration_error", "user_action");
    }
    const request = desktopTrustChallengeRequestSchema.parse({
      version: 1,
      nonce: randomBytes(32).toString("base64url"),
      ipcContractVersion: DESKTOP_IPC_CONTRACT_VERSION,
      pairingKeyId: configuration.config.pairingKeyId,
    });
    let result: { status: number; body: unknown };
    try {
      result = await this.request("/_ailearn/desktop/trust/v1/challenge", {
        method: "POST",
        body: JSON.stringify(request),
      }, false, false, requestId);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500) {
        this.connection = { version: 1, kind: "api_untrusted", reason: error.httpStatus === 401 ? "wrong_key" : "unsupported_contract" };
        throw new DesktopGatewayFailure("api_untrusted", "user_action");
      }
      throw error;
    }
    const response = desktopTrustChallengeResponseSchema.safeParse(result.body);
    if (!response.success) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "unsupported_contract" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    const value = response.data;
    if (
      value.nonce !== request.nonce ||
      value.serviceId !== DESKTOP_API_SERVICE_ID ||
      value.ipcContractVersion !== DESKTOP_IPC_CONTRACT_VERSION ||
      value.pairingKeyId !== configuration.config.pairingKeyId ||
      value.domainSchemaRevision !== configuration.config.expectedDomainSchemaRevision
    ) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "unsupported_contract" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    const expected = createHmac("sha256", configuration.pairingSecret)
      .update(desktopTrustSignatureMessage(value), "ascii")
      .digest();
    const received = Buffer.from(value.signature, "hex");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "bad_hmac" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    const health = await this.request("/health", { method: "GET" }, false, false, requestId, undefined, true);
    const healthParsed = rawHealthSchema.safeParse(health.body);
    if (health.status >= 300 || !healthParsed.success) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "unsupported_contract" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    const previousInstanceId = this.trust.state === "trusted" ? this.trust.instanceId : null;
    if (previousInstanceId && previousInstanceId !== value.instanceId) {
      // A domain idempotency key must never be replayed against a different
      // API instance/configuration revision.
      this.commandIdempotency.clear();
    }
    this.transportEpoch += 1;
    this.trust = localApiTrustSchema.parse({
      version: 1,
      state: "trusted",
      origin: configuration.config.apiOrigin,
      serviceId: DESKTOP_API_SERVICE_ID,
      pairingKeyId: value.pairingKeyId,
      instanceId: value.instanceId,
      transportEpoch: this.transportEpoch,
      verifiedAt: new Date().toISOString(),
    });
    this.connection = { version: 1, kind: "ready", instanceId: value.instanceId, schemaRevision: value.domainSchemaRevision };
  }

  private async performRemoteHealth(config: DeploymentConfigV1, requestId?: string): Promise<void> {
    const result = await this.request("/health", { method: "GET" }, false, false, requestId);
    const parsed = rawHealthSchema.safeParse(result.body);
    if (!parsed.success || parsed.data.service !== DESKTOP_API_SERVICE_ID.replace("ailearn-", "")) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    this.connection = { version: 1, kind: "ready", schemaRevision: config.expectedDomainSchemaRevision };
  }

  private async request(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    mapErrors = true,
    requestId?: string,
    unauthorizedCode?: GatewayErrorCode,
    allowHttpErrors = false,
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const configuration = this.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (authenticated && this.token) headers.set("Authorization", `Bearer ${this.token}`);
    let response: Response;
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) this.activeRequests.set(requestId, controller);
    try {
      response = await fetch(new URL(path, `${configuration.config.apiOrigin}/`), {
        ...init,
        headers,
        signal: controller?.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
      }
      this.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    } finally {
      if (requestId && controller && this.activeRequests.get(requestId) === controller) this.activeRequests.delete(requestId);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    let body: unknown = null;
    if (response.status !== 204) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    }
    if (!response.ok && response.status === 401 && this.tokenIsRestored) {
      // The credential resumed at start-up is dead (expired or revoked). Retire
      // it *before* mapping, so the caller sees `auth_required` and lands on the
      // sign-in form instead of a re-authentication prompt for an account this
      // process can no longer name.
      await this.discardStoredCredential();
    }
    if (!response.ok && mapErrors) throw this.mapResponseError(response.status, response.headers, unauthorizedCode, body);
    if (!response.ok && !allowHttpErrors) throw new DesktopGatewayFailure("api_unavailable", "safe_retry", { httpStatus: response.status });
    return { status: response.status, body, headers: response.headers };
  }

  /**
   * 原始字节读取通道：`request()` 固定 `Accept: application/json` 且总是解析
   * JSON body，承载不了 `audio/mpeg`、`image/png` 这类响应。这里复用同一
   * Bearer/AbortController/connection-state 语义，但只接受策略允许的
   * content-type，并在读取过程中按策略上限硬截断——超限立即中止响应流。
   */
  private async requestBinaryBytes(
    path: string,
    init: RequestInit,
    policy: { readonly accept: string; readonly contentTypePrefix: string; readonly maxBytes: number },
    requestId?: string,
  ): Promise<{ status: number; bytes: Uint8Array; contentType: string; headers: Headers }> {
    const configuration = this.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    const headers = new Headers(init.headers);
    headers.set("Accept", policy.accept);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) this.activeRequests.set(requestId, controller);
    try {
      const response = await fetch(new URL(path, `${configuration.config.apiOrigin}/`), {
        ...init,
        headers,
        signal: controller?.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        this.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
        throw new DesktopGatewayFailure("api_untrusted", "user_action");
      }
      if (!response.ok) {
        // 只有 403 才去碰失败体：那条路上唯一值得区分的就是"没签 AI 使用同意"。
        // 其余状态维持"按状态码分类"，取图那条 404 不会因为服务端也带了一个
        // `error` 字符串就被说成邀请码问题（这个回归是真被既有用例抓到的）。
        const errorBody = response.status === 403 ? await this.errorBodyForDomainCode(response) : undefined;
        throw this.mapResponseError(response.status, response.headers, undefined, errorBody);
      }
      const contentType = response.headers.get("content-type")?.trim().toLowerCase() ?? "";
      if (!contentType.startsWith(policy.contentTypePrefix)) {
        // 服务端失败体（JSON error）永远不进入 renderer。
        await this.discardResponseBody(response);
        throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > policy.maxBytes) {
        await this.discardResponseBody(response);
        throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      }
      return {
        status: response.status,
        bytes: await this.readBytesWithinCap(response, policy.maxBytes),
        contentType,
        headers: response.headers,
      };
    } catch (error) {
      if (error instanceof DesktopGatewayFailure) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
      }
      this.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    } finally {
      if (requestId && controller && this.activeRequests.get(requestId) === controller) this.activeRequests.delete(requestId);
    }
  }

  /** 语音朗读：`POST /voice/tts` 的 raw `audio/mpeg`。 */
  private requestAudioBytes(path: string, init: RequestInit, requestId?: string) {
    return this.requestBinaryBytes(path, init, {
      accept: "audio/mpeg",
      contentTypePrefix: "audio/",
      maxBytes: COMPANION_VOICE_MAX_AUDIO_BYTES,
    }, requestId);
  }

  /**
   * 站内图片的原始字节（`GET /api/uploads/{objectKey}`）。
   *
   * 来源解析把网页内嵌图片下载后写进对象存储，正文里的引用随之变成
   * `/api/uploads/…`。桌面渲染层跑在 `ailearn-app://` 下，这个相对路径会落到
   * 应用包内；外链地址又会被渲染层 CSP 拦掉。所以图片只能由持有令牌的 main
   * 取回，渲染层拿到 base64 后自己转 blob URL。
   *
   * 注意路径要剥掉 `/api` 前缀：正文里存的是 Web 端代理约定（`/api/*` 会被
   * Web 的边缘层转发到 API 根），而这里的 fetch 直连 API 本体，下载路由注册在
   * `GET /uploads/*`（`uploadRoutes` 无前缀挂载，见 `apps/api/src/server.ts`）。
   * 拿着 `/api/uploads/…` 原样请求会得到 404，渲染层只能显示「取不回」。对象
   * 键的形状在 IPC 入口已按 schema 收窄，这里再显式拼路由前缀，使这个通道不可
   * 能被当成任意路径代理使用。
   */
  async getSourceImage(
    request: SourceImageGetRequestV1,
    requestId?: string,
  ): Promise<SourceImageGetResultV1> {
    await this.ensureConnected(requestId);
    const result = await this.requestBinaryBytes(
      `/uploads/${request.objectKey}`,
      { method: "GET" },
      { accept: "image/*", contentTypePrefix: "image/", maxBytes: SOURCE_IMAGE_MAX_BYTES },
      requestId,
    );
    // 只放行 worker 会落盘的四种类型：服务端把别的 image/* 子类型（或带参数的
    // 变体）回给渲染层之前，先在这里收敛成合同里那一个枚举。
    const mimeType = result.contentType.split(";")[0].trim();
    if (!(SOURCE_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    const parsed = sourceImageGetResultV1Schema.safeParse({
      version: 1,
      mimeType,
      imageBase64: Buffer.from(result.bytes).toString("base64"),
      byteLength: result.bytes.byteLength,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 笔记图片上传（`POST /uploads/images`）。
   *
   * `request()` 固定 `Accept: application/json` 且把每个 body 当 JSON 送，装不下
   * multipart。这里复用同一套 Bearer / AbortController / connection-state 语义，
   * 只为这一个路由拼一次 `FormData`：服务端要 `noteId` 字段校验笔记归属，要
   * `file` 字段拿字节，两个都按它自己的合约命名。
   *
   * 渲染层给的 base64 在这里还原成字节；解码后的体积按合同上限再收一次口，避免
   * 一串形状合规但实际超限的 base64 被送出去。
   */
  async uploadNoteImage(
    noteId: string,
    request: NoteImageUploadRequestV1,
    requestId?: string,
  ): Promise<NoteImageUploadResultV1> {
    await this.ensureConnected(requestId);
    const configuration = this.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");

    const bytes = Buffer.from(request.bytesBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > NOTE_IMAGE_UPLOAD_MAX_BYTES) {
      throw new DesktopGatewayFailure("validation", "user_action");
    }

    const form = new FormData();
    form.set("noteId", noteId);
    form.set("file", new Blob([bytes], { type: request.mimeType }), request.fileName);

    const headers = new Headers();
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) this.activeRequests.set(requestId, controller);
    let response: Response;
    try {
      response = await fetch(new URL("/uploads/images", `${configuration.config.apiOrigin}/`), {
        method: "POST",
        headers,
        body: form,
        signal: controller?.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
      }
      this.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    } finally {
      if (requestId && controller && this.activeRequests.get(requestId) === controller) this.activeRequests.delete(requestId);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok && response.status === 401 && this.tokenIsRestored) {
      await this.discardStoredCredential();
    }
    if (!response.ok) throw this.mapResponseError(response.status, response.headers, undefined, body);

    // 服务端回的是 `{ assetId, url, objectKey, size, mimeType, sha256, width, height }`；
    // 只有合同里那五个字段过桥，别的连名字都不进渲染层。
    const payload = (body ?? {}) as Record<string, unknown>;
    const parsed = noteImageUploadResultV1Schema.safeParse({
      version: 1,
      url: payload.url,
      byteLength: payload.size,
      mimeType: payload.mimeType,
      width: payload.width,
      height: payload.height,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 失败响应的 body 只为"读出一个 `error` token"而读：上限 4 KB；没有 body、超限、
   * 不是 JSON 一律当"没有 token"，回落到按状态码分类。
   *
   * 二进制那条路（`requestBinaryBytes`）此前**完全不读** body，所以服务端在 403 上回的
   * `ai_consent_required` 到不了界面——"没签 AI 使用同意"和"这个账号没权限"被说成同一句
   * 话，而前一件是用户自己在设置页点一下就能解的（doc 34 L13 的下游那一半）。
   * 服务端那句原文依旧永不上屏：`mapResponseError` 只认白名单里的 token。
   */
  private async errorBodyForDomainCode(response: Response): Promise<unknown> {
    try {
      const bytes = await this.readBytesWithinCap(response, DOMAIN_ERROR_BODY_MAX_BYTES);
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return undefined;
    }
  }

  private async readBytesWithinCap(response: Response, maxBytes: number): Promise<Uint8Array> {
    const body = response.body;
    if (!body) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          // 超限立即 abort 响应流，绝不把 oversize body 读完或编码进 renderer payload。
          await reader.cancel().catch(() => undefined);
          throw new DesktopGatewayFailure("unsupported_contract", "user_action");
        }
        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // reader 已因 abort/error 失效时不需要额外处理。
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private async discardResponseBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // 已关闭或已失败的 body 无需处理。
    }
  }

  private mapResponseError(status: number, headers: Headers, unauthorizedCode?: GatewayErrorCode, body?: unknown): DesktopGatewayFailure {
    const retryAfter = retryAfterFromHeaders(headers);
    const options = { httpStatus: status, ...(retryAfter ? { retryAfter } : {}) };
    const domainCode = domainErrorCode(status, body);
    if (domainCode) return new DesktopGatewayFailure(domainCode, "never", options);
    if (status === 401) return new DesktopGatewayFailure(unauthorizedCode ?? (this.token ? "reauth_required" : "auth_required"), "user_action", options);
    // 403 上只有白名单里那一种 token 会被翻成专用码，其余一律还是 `forbidden`。
    if (status === 403) return new DesktopGatewayFailure("forbidden", "never", options);
    if (status === 404) return new DesktopGatewayFailure("not_found", "never", options);
    if (status === 409) return new DesktopGatewayFailure("conflict", "never", options);
    if (status === 429) return new DesktopGatewayFailure("rate_limited", "safe_retry", options);
    if (status >= 500) return new DesktopGatewayFailure("safe_internal_error", "user_action", options);
    return new DesktopGatewayFailure("validation", "user_action", options);
  }
}

/**
 * The API answers some failures with a small, machine-readable `error` token.
 * Only that token crosses the IPC boundary — never the server's prose — and only
 * for the tokens listed here, so an unexpected body still falls back to the
 * status-based mapping instead of inventing a category.
 *
 * 这张表只覆盖登录/邀请那一族，且只在 400/404/409/410 上生效——那些 token 的意思
 * 是路由内的（`not_found` 在邀请路上是"邀请码无效"，在取图路上是"文件没了"）。
 * 403 上另有一套：只认 `ai_consent_required` 这一个 token（见下面 `CONSENT_REQUIRED_TOKEN`），
 * 其余的 403 一律还是 `forbidden`（doc 34 L13 的下游那一半）。
 */
const AUTH_DOMAIN_ERROR_CODES: Record<string, GatewayErrorCode> = {
  email_exists: "email_exists",
  not_found: "invite_invalid",
  revoked: "invite_invalid",
  expired: "invite_expired",
  already_consumed: "invite_consumed",
  concurrent_consumption: "invite_consumed",
  workspace_limit_reached: "workspace_limit",
  already_member: "already_member",
  personal_workspace_not_shareable: "personal_workspace_not_shareable",
};

/**
 * 409 上按 token 认的**笔记**那一族，与登录那族分开写。
 *
 * 混进上面那张表迟早串味：那里的键是**路由内**的约定（同一个 `not_found` 在邀请路上
 * 是"邀请码无效"、在取图路上是"文件没了"），而这里认的是笔记文档那一件事。
 *
 * `doc_identity_mismatch` = 上行的增量与本机这份文档不是同一份历史，服务端一个字都
 * 没写（见 `apps/api/src/modules/note/collaboration.ts` 的 `applyAndReportLanded`）。不并进
 * `conflict`：那句"学习状态变了"给的下一步是同步学习队列，而这里要的是重新取一次
 * 这一篇的编辑起点。这一格存在的意义是**不许再静默**——2026-09-23 那次丢字，服务端
 * 当时回的是一句 200。
 */
const NOTE_DOMAIN_ERROR_CODES: Record<string, GatewayErrorCode> = {
  doc_identity_mismatch: "note_doc_stale",
};

/** 403 上唯一被翻成专用码的 token（doc 34 L13：没签同意不是没权限）。 */
const CONSENT_REQUIRED_TOKEN = "ai_consent_required";

function domainErrorCode(status: number, body: unknown): GatewayErrorCode | null {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const token = (body as { error?: unknown }).error;
  if (typeof token !== "string") return null;
  // 403 上只认这一个 token：登录那一族的字符串是**路由内**的约定
  // （`not_found` 在邀请那条路上意思是"邀请码无效"，在取图上意思是"文件没了"）。
  // 把它们放到 403 上一起认，就会把一次取图失败说成邀请码问题。
  if (status === 403) return token === CONSENT_REQUIRED_TOKEN ? "ai_consent_required" : null;
  if (status !== 400 && status !== 404 && status !== 409 && status !== 410) return null;
  return AUTH_DOMAIN_ERROR_CODES[token] ?? null;
}

function retryAfterFromHeaders(headers: Headers): string | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d{1,7}$/.test(value)) {
    const seconds = Number(value);
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
