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
  learningRunTargetRevealV2Schema,
  learningTaskDraftV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  putLearningTaskDraftRequestV2Schema,
  submitTaskArtifactReceiptV2Schema,
  submitTaskArtifactV2Schema,
  recordLearningRunActivityLeaseRequestV2Schema,
} from "./learning-run-v2-contracts.ts";
import { reviewDeferRequestV2Schema, reviewDeferResultV2Schema, reviewQueueV2Schema } from "./review-queue-v2-contracts.ts";
import { roomProjectionV1Schema } from "./room-projection-contracts.ts";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfileV1Schema,
  type CompanionRoomProfilePatchV1,
} from "./companion-home-contracts.ts";
import {
  companionVoicePlaybackOutcomeResultV1Schema,
  companionVoiceSpeakResultV1Schema,
  companionVoiceTranscribeResultV1Schema,
  type CompanionVoiceSpeakRequestV1,
  type CompanionVoiceSpeakSegmentRequestV2,
} from "./companion-voice-contracts.ts";
// 伴星聊天发送链路（2026-09-18 接线）：建/复用 dialogue、发 turn、拉消息。
import {
  companionChatEnsureResultV1Schema,
  companionChatListMessagesResultV1Schema,
  companionChatSendTurnResultV1Schema,
} from "./companion-chat-desktop-contracts.ts";
import {
  companionLearningContextV1Schema,
} from "./companion-conversation-contracts.ts";
// 站内图片字节通道：来源解析把网页图片写进对象存储后，正文引用指向
// `/api/uploads/…`；渲染层够不到 API 源也不持有令牌，由 main 代取。
import {
  sourceImageGetResultV1Schema,
  type SourceImageGetRequestV1,
} from "./source-image-contracts.ts";
// 笔记图片写入通道：编辑器里粘贴/拖进来的一张图由 main 以 multipart 送到
// `POST /uploads/images`，渲染层拿回服务端确认的 `/api/uploads/…` 地址写进正文，
// 之后的读取仍走上面那条字节通道。
import {
  noteImageUploadResultV1Schema,
  type NoteImageUploadRequestV1,
} from "./note-image-upload-contracts.ts";
// 伴星中心（桌面页 20）：记忆、记忆星图、日记、人格档案与对话记录。
// 读取之外只开放记忆裁决（确认/忽略/固定/归档），没有对话发送通道。
import {
  companionDailySummaryV1Schema,
  companionActivityDeliveryV1Schema,
  companionActivityTimelineV1Schema,
  companionAuditDeleteResultV1Schema,
  companionExportResultV1Schema,
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
  type CompanionMemoryListQuery,
  type CompanionMemoryCreateInputV1,
  type CompanionMemoryCorrectInputV1,
  type CompanionActivityAckRequestV1,
  type CompanionExportKindV1,
  type CompanionHistoryQueryV1,
  type CompanionHistorySearchQueryV1,
  type CompanionPersonaPatchV1,
} from "./companion-memory-desktop-contracts.ts";
// 账号级 presence（2026-09-16 裁决 3）：在线/勿扰/离线 + 三档强度 + 静默时段。
// 只读账号状态与 onboarding 状态，不含任何记忆正文。
import {
  companionAccountStateV1Schema,
  companionOverviewSchema,
  companionAnswerModePreferenceV1Schema,
  onboardingTransitionResponseSchema,
  type CompanionAccountPatch,
  type OnboardingTransitionRequest,
} from "./companion-shell-contracts.ts";
import {
  companionInvitationSchema,
  companionJourneyBootstrapSchema,
  companionJourneySchema,
  type CompanionInvitationActionRequest,
  type CompanionJourneyActionRequest,
} from "./companion-journey-contracts.ts";
import type { MainPageContextInputV2 } from "./companion-bridge-contracts.ts";
import { authSurfaceManifestV1Schema } from "./auth-surface-manifest.ts";
import { noteDetailV1Schema } from "./note-projection-contracts.ts";
import { noteSaveReceiptV1Schema, noteSaveRequestV1Schema } from "./note-save-contracts.ts";
import {
  cardActivationReceiptDesktopV1Schema,
  cardGenerationCandidateListV1Schema,
  cardGenerationCloseResultV1Schema,
  cardGenerationJobAcceptedV1Schema,
  cardGenerationReviewResultV1Schema,
  cardGenerationRetryResultV1Schema,
  cardGenerationRunSnapshotV1Schema,
} from "./card-generation-desktop-contracts.ts";
import { candidateRevealV2Schema } from "./card-generation-v2-contracts.ts";
import {
  desktopSourceListPageSchema,
  desktopSourceDetailSchema,
  desktopSourceNotesPageSchema,
  type DesktopSourceCreateRequest,
  type DesktopSourceNoteResult,
  type DesktopSourceUpdateRequest,
  type DesktopSourceArchiveResult,
  desktopNoteListPageSchema,
  type DesktopNoteCreateRequest,
  type DesktopNoteMutationResult,
  desktopNoteVersionListSchema,
  desktopSearchPageSchema,
} from "./desktop-surface-contracts.ts";
import { objectiveListPageV3Schema, learningObjectiveSurfaceV3Schema } from "./learning-objective-surface-contracts.ts";
import { understandingTopologySnapshotV3Schema } from "./understanding-topology-v3-contracts.ts";
import { todayActivityV1Schema } from "./activity-surface-contracts.ts";
import type {
  DesktopCardGenerationActivationSelectionV1,
  DesktopCandidateReviewRequestV2,
  DesktopCreateCardGenerationRunRequestV2,
  DesktopRevealCandidateRequestV2,
  CardGenerationExposureEligibilityV1,
  CardGenerationRunSnapshotV1,
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
export const DESKTOP_IPC_SCHEMA_REVISION = "desktop-ipc-m2-2026-09-09" as const;
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
  authGetSurfaceManifest: "ailearn.v1.auth.getSurfaceManifest",
  authLogin: "ailearn.v1.auth.login",
  authRegister: "ailearn.v1.auth.register",
  authLogout: "ailearn.v1.auth.logout",
  authReauthenticate: "ailearn.v1.auth.reauthenticate",
  authChangePassword: "ailearn.v1.auth.changePassword",
  authJoinWorkspace: "ailearn.v1.auth.joinWorkspace",
  // 旧版设置页回补（2026-09-18）：档案、头像与退出工作区。
  authProfileGet: "ailearn.v1.auth.profile.get",
  authUpdateProfile: "ailearn.v1.auth.profile.update",
  authUploadAvatar: "ailearn.v1.auth.avatar.upload",
  authAvatarGet: "ailearn.v1.auth.avatar.get",
  authLeaveWorkspace: "ailearn.v1.auth.leaveWorkspace",
  workspaceList: "ailearn.v1.workspace.list",
  workspaceSwitch: "ailearn.v1.workspace.switch",
  workspaceGetCurrent: "ailearn.v1.workspace.getCurrent",
  workspaceRename: "ailearn.v1.workspace.rename",
  workspaceCreate: "ailearn.v1.workspace.create",
  // SEC-02 / ADR-0009：Owner 的邀请发出与成员管理。
  inviteCreate: "ailearn.v1.invite.create",
  inviteList: "ailearn.v1.invite.list",
  inviteRevoke: "ailearn.v1.invite.revoke",
  memberList: "ailearn.v1.member.list",
  memberRemove: "ailearn.v1.member.remove",
  // 数据维护工具：Markdown 批量导入、搜索索引漂移检测与重建。
  settingsMarkdownImport: "ailearn.v1.settings.markdownImport",
  searchDriftGet: "ailearn.v1.search.drift",
  searchReindex: "ailearn.v1.search.reindex",
  // 任务 14：作答模态偏好（跨设备账号级）。
  companionAnswerModeGet: "ailearn.v1.companion.answerMode.get",
  companionAnswerModePatch: "ailearn.v1.companion.answerMode.patch",
  capabilitiesGet: "ailearn.v1.capabilities.get",
  windowGetState: "ailearn.v1.window.getState",
  windowSetTitlebarTheme: "ailearn.v1.window.setTitlebarTheme",
  windowFocus: "ailearn.v1.window.focus",
  subscriptionsSubscribe: "ailearn.v1.subscriptions.subscribe",
  subscriptionsEvent: "ailearn.v1.subscriptions.event",
  subscriptionsUnsubscribe: "ailearn.v1.subscriptions.unsubscribe",
  roomGetProjection: "ailearn.v1.room.getProjection",
  companionHomeGetProjection: "ailearn.v1.companion.home.getProjection",
  companionRoomGetProfile: "ailearn.v1.companion.room.getProfile",
  companionRoomPatchProfile: "ailearn.v1.companion.room.patchProfile",
  companionVoiceSpeak: "ailearn.v1.companion.voice.speak",
  companionVoiceSpeakSegment: "ailearn.v1.companion.voice.speakSegment",
  companionVoicePlaybackOutcome: "ailearn.v1.companion.voice.playbackOutcome",
  companionAccountGetState: "ailearn.v1.companion.account.getState",
  companionAccountPatchState: "ailearn.v1.companion.account.patchState",
  companionOnboardingTransition: "ailearn.v1.companion.onboarding.transition",
  companionMemoryList: "ailearn.v1.companion.memory.list",
  companionMemoryStarMap: "ailearn.v1.companion.memory.starMap",
  companionMemoryConfirm: "ailearn.v1.companion.memory.confirm",
  companionMemoryPin: "ailearn.v1.companion.memory.pin",
  companionMemoryUnpin: "ailearn.v1.companion.memory.unpin",
  companionMemoryArchive: "ailearn.v1.companion.memory.archive",
  companionMemoryRestore: "ailearn.v1.companion.memory.restore",
  companionMemoryDelete: "ailearn.v1.companion.memory.delete",
  companionMemoryCreate: "ailearn.v1.companion.memory.create",
  companionMemoryCorrect: "ailearn.v1.companion.memory.correct",
  companionMemoryDismiss: "ailearn.v1.companion.memory.dismiss",
  companionMemoryConflicts: "ailearn.v1.companion.memory.conflicts",
  companionMemoryResolveConflict: "ailearn.v1.companion.memory.resolveConflict",
  companionMemoryRebuildEmbeddings: "ailearn.v1.companion.memory.rebuildEmbeddings",
  companionMemoryClear: "ailearn.v1.companion.memory.clear",
  companionMemorySummarizeRecent: "ailearn.v1.companion.memory.summarizeRecent",
  companionDailyGet: "ailearn.v1.companion.daily.get",
  companionPersonaGet: "ailearn.v1.companion.persona.get",
  companionPersonaPatch: "ailearn.v1.companion.persona.patch",
  companionPersonaReset: "ailearn.v1.companion.persona.reset",
  companionHistoryList: "ailearn.v1.companion.history.list",
  companionHistorySearch: "ailearn.v1.companion.history.search",
  companionHistoryClear: "ailearn.v1.companion.history.clear",
  companionLearningContextGet: "ailearn.v1.companion.learningContext.get",
  companionJourneyBootstrap: "ailearn.v1.companion.journey.bootstrap",
  companionJourneyGet: "ailearn.v1.companion.journey.get",
  companionInvitationAction: "ailearn.v1.companion.invitation.action",
  companionJourneyAction: "ailearn.v1.companion.journey.action",
  companionActivityTimeline: "ailearn.v1.companion.activity.timeline",
  companionActivityPresent: "ailearn.v1.companion.activity.present",
  companionActivityAck: "ailearn.v1.companion.activity.ack",
  companionBridgeSetContext: "ailearn.v1.companion.bridge.setContext",
  companionBridgeClearContext: "ailearn.v1.companion.bridge.clearContext",
  companionDataExport: "ailearn.v1.companion.data.export",
  companionAuditDelete: "ailearn.v1.companion.audit.delete",
  // 伴星聊天发送链路 + 语音转文本（2026-09-18 接线，companion-chat-desktop-contracts）。
  companionVoiceTranscribe: "ailearn.v1.companion.voice.transcribe",
  companionChatEnsureConversation: "ailearn.v1.companion.chat.ensureConversation",
  companionChatSendTurn: "ailearn.v1.companion.chat.sendTurn",
  companionChatListMessages: "ailearn.v1.companion.chat.listMessages",
  // 提案确认 + agent 导航 route 轮询（2026-09-18 补接线）。
  companionChatProposalGet: "ailearn.v1.companion.chat.proposal.get",
  companionChatProposalDecide: "ailearn.v1.companion.chat.proposal.decide",
  companionChatAgentRoutes: "ailearn.v1.companion.chat.agentRoutes.list",
  // 过程节点留痕（2026-09-19）：GET /companion/conversations/:id/run-nodes。
  companionChatRunNodes: "ailearn.v1.companion.chat.runNodes.list",
  // 停止本轮（2026-09-19）：POST /companion/runs/:id/cancel。
  companionChatCancelRun: "ailearn.v1.companion.chat.cancelRun",
  // 念头主动开场（切片④，2026-09-18）。
  companionChatOpenThought: "ailearn.v1.companion.chat.openThought",
  // LearningRun 页面只读上下文 + 一次性 grounded tutor 授权。HTTP 协议不变，
  // 这里只把既有服务端端点收进 Electron 的 typed bridge。
  companionLearningRunGetContext: "ailearn.v1.companion.learningRun.getContext",
  companionLearningRunCreateContextGrant: "ailearn.v1.companion.learningRun.createContextGrant",
  noteGet: "ailearn.v1.note.get",
  sourceList: "ailearn.v1.source.list",
  sourceCreate: "ailearn.v1.source.create",
  sourceGet: "ailearn.v1.source.get",
  sourceNotes: "ailearn.v1.source.notes",
  sourceUpdate: "ailearn.v1.source.update",
  sourceCreateNote: "ailearn.v1.source.createNote",
  sourceArchive: "ailearn.v1.source.archive",
  sourceImageGet: "ailearn.v1.source.image.get",
  noteList: "ailearn.v1.note.list",
  noteCreate: "ailearn.v1.note.create",
  noteDelete: "ailearn.v1.note.delete",
  noteRestore: "ailearn.v1.note.restore",
  noteVersions: "ailearn.v1.note.versions",
  noteVersionRestore: "ailearn.v1.note.versionRestore",
  noteImageUpload: "ailearn.v1.note.image.upload",
  objectiveList: "ailearn.v1.objective.list",
  objectiveGet: "ailearn.v1.objective.get",
  understandingGetTopology: "ailearn.v1.understanding.getTopology",
  searchGlobal: "ailearn.v1.search.global",
  noteSave: "ailearn.v1.note.save",
  // 批次 4.3：笔记协同。渲染进程不能直连 WS（sandbox + CSP + onBeforeRequest 三层
  // 硬拦截），所以下行是一条订阅事件、上行是一次性通道。
  // 只有 `noteDocSyncBlocks` 一个写入口，界面交的都是 blocks：有长连接就并进那份文档
  // （provider 自己送增量），没有就主进程取一次起点、就地差分、按 HTTP 上送。走了哪条
  // 由 `via` 如实回报；"能不能写"不在这里判，那判据只在服务端一处。
  noteDocState: "ailearn.v1.note.doc.state",
  noteDocSyncBlocks: "ailearn.v1.note.doc.syncBlocks",
  noteDocPresence: "ailearn.v1.note.doc.presence",
  noteCardGenerationStart: "ailearn.v1.note.cardGeneration.start",
  noteCardGenerationGetRun: "ailearn.v1.note.cardGeneration.getRun",
  noteCardGenerationGetCandidates: "ailearn.v1.note.cardGeneration.getCandidates",
  noteCardGenerationReview: "ailearn.v1.note.cardGeneration.review",
  noteCardGenerationExposure: "ailearn.v1.note.cardGeneration.exposure",
  noteCardGenerationLatestRun: "ailearn.v1.note.cardGeneration.latestRun",
  noteCardGenerationReveal: "ailearn.v1.note.cardGeneration.reveal",
  noteCardGenerationActivate: "ailearn.v1.note.cardGeneration.activate",
  noteCardGenerationCancel: "ailearn.v1.note.cardGeneration.cancel",
  noteCardGenerationRetry: "ailearn.v1.note.cardGeneration.retry",
  noteCardGenerationClose: "ailearn.v1.note.cardGeneration.close",
  reviewGetQueue: "ailearn.v1.review.getQueue",
  activityGetToday: "ailearn.v1.activity.getToday",
  reviewDefer: "ailearn.v1.review.defer",
  learningRunGet: "ailearn.v1.learningRun.get",
  learningRunStart: "ailearn.v1.learningRun.start",
  learningRunGetDraft: "ailearn.v1.learningRun.getDraft",
  learningRunSaveDraft: "ailearn.v1.learningRun.saveDraft",
  learningRunSubmit: "ailearn.v1.learningRun.submit",
  learningRunAction: "ailearn.v1.learningRun.action",
  learningRunGetResult: "ailearn.v1.learningRun.getResult",
  learningRunRevealTarget: "ailearn.v1.learningRun.revealTarget",
  learningRunGetReturnContract: "ailearn.v1.learningRun.getReturnContract",
  learningRunRecordActivityLease: "ailearn.v1.learningRun.recordActivityLease",
  learningRunAbandon: "ailearn.v1.learningRun.abandon",
  workspaceAiSettingsGet: "ailearn.v1.workspace.aiSettings.get",
  workspaceAiConsentUpdate: "ailearn.v1.workspace.aiConsent.update",
  workspaceAiDataPolicyUpdate: "ailearn.v1.workspace.aiDataPolicy.update",
  workspaceExport: "ailearn.v1.workspace.export",
  clipboardReadLinks: "ailearn.v1.clipboard.readLinks",
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
/**
 * Passwords the user is *choosing* (registration, password change). The API's
 * `/auth/register-v2` and `/auth/change-password` both require at least 8
 * characters; mirroring that here lets the desktop reject a short password with
 * a precise, local message instead of forwarding it and surfacing a generic
 * server validation failure. Login deliberately keeps `secretInputSchema` so
 * accounts predating this rule can still sign in.
 */
export const newPasswordSchema = z
  .string()
  .min(8)
  .max(200)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "control characters are not allowed");
/** Invite codes are pasted bearer tokens, so surrounding whitespace is stripped. */
export const inviteTokenSchema = z
  .string()
  .trim()
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
  "companion.center",
  "companion.drawer",
] as const;
export const desktopRouteKindSchema = z.enum(desktopRouteKindValues);
export type DesktopRouteKindV1 = (typeof desktopRouteKindValues)[number];

export const desktopRouteKindM1Values = ["auth.login", "auth.register"] as const;
export const desktopRouteKindM1Schema = z.enum(desktopRouteKindM1Values);
export type DesktopRouteKindM1 = (typeof desktopRouteKindM1Values)[number];

export const desktopNamespaceM2Values = [...desktopNamespaceM1Values, "room", "source", "note", "objective", "review", "learningRun", "understanding", "search", "companion", "settings"] as const;
export const desktopNamespaceM2Schema = z.enum(desktopNamespaceM2Values);
export type DesktopNamespaceM2 = (typeof desktopNamespaceM2Values)[number];
export const desktopRouteKindM2Values = [
  ...desktopRouteKindM1Values,
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
  "companion.center",
  "companion.drawer",
] as const;
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
  z.strictObject({ kind: z.literal("understanding.graph") }),
  z.strictObject({ kind: z.literal("search.global") }),
  z.strictObject({ kind: z.literal("settings.section"), section: nonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal("companion.center"),
    tab: z.enum(["memory", "dialogue", "activity", "diary", "persona"]).optional(),
    focusMemoryId: uuidSchema.optional(),
    focusMessageId: uuidSchema.optional(),
  }),
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
  z.strictObject({ version: z.literal(1), kind: z.literal("understanding.graph"), workspaceId: uuidSchema.optional() }),
]);
export type SafeReturnTargetV1 = z.infer<typeof safeReturnTargetSchema>;

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
  // Auth-form outcomes. The API answers these with distinct `error` tokens in
  // its response body; the desktop gateway maps them through so the sign-in and
  // sign-up forms can say what actually went wrong instead of collapsing every
  // 4xx into one generic sentence.
  "email_exists",
  "invite_invalid",
  "invite_expired",
  "invite_consumed",
  "workspace_limit",
  "already_member",
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

/**
 * 外部复制链接的候选提取。服务端抓取只接受 `http(s)` 地址，所以只有这种
 * 才算"当前解析支持的链接"；其它协议（ftp/file/私协议、裸域名）一律不过。
 *
 * 隐私边界：主进程读剪贴板后只把这里命中的至多 3 个地址交过 IPC，
 * 剪贴板原文（密码、笔记、私聊）永远不出主进程。
 */
const CANDIDATE_LINK_PATTERN = /https?:\/\/[^\s<>"'`，。；：！？）】》]+/gi;
/** 链接尾巴上常粘的半角标点与成对右括号，归一化时剥掉。 */
const CANDIDATE_LINK_TRAILING = /[.,;:!?)\]}'"，。；：！？）】》]+$/u;
export const MAX_CANDIDATE_LINKS = 3;
export const MAX_CANDIDATE_LINK_LENGTH = 2048;

export function extractCandidateLinks(text: string, max: number = MAX_CANDIDATE_LINKS): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.match(CANDIDATE_LINK_PATTERN) ?? []) {
    const candidate = match.replace(CANDIDATE_LINK_TRAILING, "");
    if (candidate.length === 0 || candidate.length > MAX_CANDIDATE_LINK_LENGTH) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.username !== "" || url.password !== "") continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
    if (found.length >= max) break;
  }
  return found;
}

export const clipboardReadLinksResultSchema = z.strictObject({
  urls: z.array(z.string().min(1).max(MAX_CANDIDATE_LINK_LENGTH)).max(MAX_CANDIDATE_LINKS),
});
export type ClipboardReadLinksResult = z.infer<typeof clipboardReadLinksResultSchema>;

export const actionCapabilityValues = [
  "source.read", "source.create", "source.update", "source.archive", "source.createNote",
  "note.read", "note.create", "note.save", "note.delete", "note.restore", "note.permanentDelete",
  "objective.read", "review.read", "understanding.read", "search.read",
  "card_generation.start", "card_generation.review", "card_generation.reveal", "card_generation.activate", "card_generation.cancel", "card_generation.close", "card_generation.retry",
  "learning_run.read", "learning_run.start", "learning_run.saveDraft", "learning_run.submit", "learning_run.action",
  "companion.read", "companion.sendMessage", "companion.decideProposal", "settings.read", "settings.update",
] as const;
export const actionCapabilitySchema = z.enum(actionCapabilityValues);
export type ActionCapability = (typeof actionCapabilityValues)[number];

const featureNameExtraValues = [
  "card_generation_v2", "learning_run_v2", "companion_dialogue_v1",
  "companion_journey_v2", "companion_bridge_v2", "companion_memory_vector_v1",
  "companion_memory_star_map_v1", "companion_summarizer_v1", "companion_daily_summary_v1",
  "companion_proactive_personalized_v1", "companion_pet_v1", "companion_pet_profile_v1",
  "companion_voice_dialogue_v1", "companion_streaming_voice_v1",
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

/**
 * 工作区级 AI 同意与数据策略（服务端 `/workspace/ai-*`）。
 *
 * 这是设置页「AI 数据同意」分区的**唯一**数据来源：同意是否已签署、由谁签署、
 * 以及四个真实的外发策略开关。之前这一页只有展示用 chip，没有任何写入口，
 * 因为客户端从未暴露过这些路由。
 */
export const aiDataPolicyV1Schema = z.strictObject({
  sendToExternal: z.boolean(),
  sendImageContent: z.boolean(),
  piiDetection: z.boolean(),
  auditLogging: z.boolean(),
});
export type AiDataPolicyV1 = z.infer<typeof aiDataPolicyV1Schema>;

/**
 * 本人的 AI 同意与数据外发政策（迁移 0237 起为账号级）。
 *
 * 不再有 `workspaceId` / `consentBy` / `canManage`：同意管的是"我的内容能不能送出
 * 去"，授权范围只能是本人，签署人恒等于本人，所以本人永远能改自己的——原先那个
 * `canManage` 是"由 owner 替全空间签"的产物，随空间级语义一起删除。
 */
export const workspaceAiSettingsV1Schema = z.strictObject({
  version: z.literal(1),
  /** 部署里配置了外部模型供应商 → 未签署同意时内容不得外发。 */
  requiresConsent: z.boolean(),
  consentVersion: z.string().nullable(),
  consentAt: isoTimestampSchema.nullable(),
  dataPolicy: aiDataPolicyV1Schema,
});
export type WorkspaceAiSettingsV1 = z.infer<typeof workspaceAiSettingsV1Schema>;

/**
 * 客户端签署同意时提交的版本号。服务端只校验它是 1–50 字符的非空串，
 * 所以这里给一个稳定常量，让「已签署的版本」在两端是同一个字符串。
 */
export const AI_CONSENT_VERSION = "ai-consent-v1";

/**
 * 整库导出的回执。
 *
 * 导出是"服务端出数据 + 本机写文件"两段：数据走 `GET /export/workspace`
 * （服务端 `requireOwner` 收口），落盘由主进程用系统保存对话框完成。取消既不是
 * 成功也不是失败，所以它是一个独立字段，而不是 `saved: false` 的同义词。
 */
export const workspaceExportResultV1Schema = z.strictObject({
  version: z.literal(1),
  saved: z.boolean(),
  canceled: z.boolean(),
  /** 读者刚刚在系统对话框里自己选定的落盘位置；取消时为 null。 */
  filePath: z.string().nullable(),
  bytes: nonNegativeIntSchema,
});
export type WorkspaceExportResultV1 = z.infer<typeof workspaceExportResultV1Schema>;

const workspaceSummaryShape = {
  version: z.literal(1),
  workspaceId: uuidSchema,
  name: nonEmptyStringSchema,
  role: z.enum(["owner", "member"]),
  workspaceType: z.enum(["personal", "collaborative"]),
  isPersonal: z.boolean(),
};

// ─── 旧版设置页回补（2026-09-18）─────────────────────────────────────
// 服务端链路全部早已存在（/auth/profile、/uploads/avatars、/invites、/members、
// /auth/leave-workspace、/workspaces/:id/name、/import/markdown、/search/drift、
// /search/reindex、/me/companion/answer-mode-preference）；这里只把它们的回执
// 收进 typed bridge，时间戳只作展示，不做时刻运算，因此放宽为非空字符串。

/** GET/PUT /auth/profile 的回执（displayName ≤32 字、avatarUrl ≤500 字，服务端截断）。 */
export const authProfileResultV1Schema = z.strictObject({
  version: z.literal(1),
  displayName: z.string().max(32).nullable(),
  avatarUrl: z.string().max(500).nullable(),
});
export type AuthProfileResultV1 = z.infer<typeof authProfileResultV1Schema>;

/** 头像通道上限与 API 的 MAX_AVATAR_SIZE（2MB）对齐。 */
export const AVATAR_MAX_BYTES = 2_000_000;
const AVATAR_OBJECT_KEY_PATTERN =
  /^avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:png|jpg|jpeg|gif|webp)$/;

export const avatarObjectKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(AVATAR_OBJECT_KEY_PATTERN, "invalid avatar object key");

/** POST /uploads/avatars 的回执；服务端已在同一请求里持久化 avatarUrl。 */
export const avatarUploadResultV1Schema = z.strictObject({
  version: z.literal(1),
  url: z.string().min(1).max(512).startsWith("/api/uploads/avatars/"),
  objectKey: avatarObjectKeySchema,
});
export type AvatarUploadResultV1 = z.infer<typeof avatarUploadResultV1Schema>;

/** POST /auth/leave-workspace 的回执；true 时 main 已换发并保存新令牌。 */
export const leaveWorkspaceResultV1Schema = z.strictObject({
  version: z.literal(1),
  switchedToPersonalWorkspace: z.boolean(),
});
export type LeaveWorkspaceResultV1 = z.infer<typeof leaveWorkspaceResultV1Schema>;

/** PATCH /workspaces/:id/name 的回执。 */
export const renameWorkspaceResultV1Schema = z.strictObject({
  version: z.literal(1),
  workspaceId: uuidSchema,
  name: nonEmptyStringSchema,
});
export type RenameWorkspaceResultV1 = z.infer<typeof renameWorkspaceResultV1Schema>;

/**
 * POST /workspaces 的回执：新建一个协作空间。
 *
 * 这个通道是补上来的缺口——此前生产代码没有任何创建工作区的入口，"共享"只能是
 * 把别人拉进自己的个人空间，所以 `collaborative` 类型在真实数据里一次都没出现过。
 */
export const createWorkspaceResultV1Schema = z.strictObject({
  version: z.literal(1),
  workspaceId: uuidSchema,
  name: nonEmptyStringSchema,
});
export type CreateWorkspaceResultV1 = z.infer<typeof createWorkspaceResultV1Schema>;

/** POST /invites：token 只在创建回执里出现一次。 */
export const inviteCreatedV1Schema = z.strictObject({
  version: z.literal(1),
  id: nonEmptyStringSchema,
  token: z.string().min(1).max(200),
  tokenHint: nonEmptyStringSchema,
  role: z.enum(["member", "owner"]),
  expiresAt: z.string().min(1).nullable(),
});
export type InviteCreatedV1 = z.infer<typeof inviteCreatedV1Schema>;

export const inviteStatusSchema = z.enum(["active", "consumed", "revoked", "expired"]);
export type InviteStatusV1 = z.infer<typeof inviteStatusSchema>;

export const inviteListItemV1Schema = z.strictObject({
  version: z.literal(1),
  id: nonEmptyStringSchema,
  tokenHint: nonEmptyStringSchema,
  role: z.enum(["member", "owner"]),
  status: inviteStatusSchema,
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1).nullable(),
  consumedAt: z.string().min(1).nullable(),
  consumedByEmail: z.string().min(1).nullable(),
  revokedAt: z.string().min(1).nullable(),
});
export type InviteListItemV1 = z.infer<typeof inviteListItemV1Schema>;

export const inviteListResultV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(inviteListItemV1Schema).max(100),
  total: nonNegativeIntSchema,
});
export type InviteListResultV1 = z.infer<typeof inviteListResultV1Schema>;

export const memberListItemV1Schema = z.strictObject({
  version: z.literal(1),
  userId: uuidSchema,
  email: z.string().min(1).max(320),
  role: z.enum(["owner", "member"]),
  joinedAt: z.string().min(1),
});
export type MemberListItemV1 = z.infer<typeof memberListItemV1Schema>;

export const memberListResultV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(memberListItemV1Schema).max(500),
  total: nonNegativeIntSchema,
});
export type MemberListResultV1 = z.infer<typeof memberListResultV1Schema>;

/** POST /import/markdown：完整笔记行不过桥，渲染层只需要计数。 */
export const markdownImportResultV1Schema = z.strictObject({
  version: z.literal(1),
  imported: nonNegativeIntSchema,
  failed: nonNegativeIntSchema,
});
export type MarkdownImportResultV1 = z.infer<typeof markdownImportResultV1Schema>;

/** GET /search/drift：只投影计数与结论，ID 列表留给服务端日志。 */
export const searchDriftResultV1Schema = z.strictObject({
  version: z.literal(1),
  hasDrift: z.boolean(),
  ghosts: nonNegativeIntSchema,
  missing: nonNegativeIntSchema,
  stale: nonNegativeIntSchema,
});
export type SearchDriftResultV1 = z.infer<typeof searchDriftResultV1Schema>;

/** POST /search/reindex 回执。 */
export const searchReindexResultV1Schema = z.strictObject({
  version: z.literal(1),
  deleted: nonNegativeIntSchema,
  indexedNotes: nonNegativeIntSchema,
  indexedSources: nonNegativeIntSchema,
  indexedObjectives: nonNegativeIntSchema,
  errors: nonNegativeIntSchema,
  capped: z.boolean(),
});
export type SearchReindexResultV1 = z.infer<typeof searchReindexResultV1Schema>;

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
  /**
   * How this install can carry a sign-in across restarts, so the gate can say
   * whether it is resuming a stored session and whether offering "keep me
   * signed in" would be honest.
   */
  sessionCredential: z.strictObject({
    persistence: z.enum(["safe_storage", "memory"]),
    stored: z.boolean(),
  }),
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

/**
 * 伴星会话 SSE 的单帧（§5.3 wire 事件的最小投影）。
 *
 * 主进程消费 `/companion/conversations/:id/events`，把每帧投影成这个形状转发给
 * 渲染层。刻意**不**内嵌完整的 `companionStreamEventV1Schema`：事件 union 只覆盖
 * 客户端认识的类型，而 DB 约束允许 18 种（action.started / proactive.delivery 等），
 * 用完整 union 校验会让未知类型整帧被丢弃，也会把桌面端锁死在 web 端的事件版本上。
 * 这里只保证"可安全过桥"的不变量：seq/runId/generation 类型正确、eventType 有界、
 * payload 是对象（尺寸在网关上另有限制），具体语义由渲染层按 eventType 收窄。
 */
export const companionChatStreamEventV1Schema = z.strictObject({
  /** 会话内单调的事件 seq（与 SSE id 同行）。 */
  seq: nonNegativeIntSchema,
  runId: uuidSchema.nullable(),
  generation: nonNegativeIntSchema,
  eventType: nonEmptyStringSchema,
  payload: z.record(z.unknown()),
});
export type CompanionChatStreamEventV1 = z.infer<typeof companionChatStreamEventV1Schema>;

/**
 * 笔记协同的下行帧（批次 4.3）。
 *
 * `update` 是 base64 的 yjs update。**必须带尺寸上限**：`strictObject` 只挡多余字段，
 * 挡不住一条几 MB 的正文穿过 IPC（主进程要为它做一次结构化克隆，渲染进程再解一遍）。
 * 上限与主进程 `note-doc-transport.ts` 用的是同一个常量，两边不能各写一个数。
 */
export const NOTE_DOC_BLOCKS_MAX_JSON_CHARS = 4 * 1024 * 1024;
/** 单篇笔记的块数上限：超它不是"编辑不了"而是形状不对，宁可直接拒。 */
export const NOTE_DOC_BLOCKS_MAX_COUNT = 2_000;

/** 界面上行提交的块：数组顺序就是 ordinal，所以不带编号。 */
export const noteDocSubmittedBlockV1Schema = z.strictObject({
  type: z.string().min(1).max(32),
  content: z.string().max(200_000),
  sourceRef: z.strictObject({ sourceId: uuidSchema.optional(), segmentId: uuidSchema.optional() }).nullable().optional(),
  imageAssetId: uuidSchema.nullable().optional(),
});
/** 主进程投影给界面的块：带 ordinal（下标就是它，另存一份才会和数组打架）。 */
export const noteDocProjectBlockV1Schema = noteDocSubmittedBlockV1Schema.extend({
  ordinal: nonNegativeIntSchema,
});

export const noteDocStreamEventV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("blocks"),
    blocks: z.array(noteDocProjectBlockV1Schema).max(NOTE_DOC_BLOCKS_MAX_COUNT),
    title: z.string().max(200),
    titleSource: z.string().max(16),
  }),
  z.strictObject({
    type: z.literal("status"),
    status: z.enum(["connecting", "connected", "authenticated", "disconnected", "failed"]),
    // 只读判据来自服务端的 `Authenticated("readonly")`，不是本机推断——界面把编辑器
    // 禁成只读就以这个字段为准。
    authorizedScope: z.enum(["read-write", "readonly"]).optional(),
    reason: z.enum(["permission_denied", "oversize", "invalid_update", "connection_lost"]).optional(),
  }),
  z.strictObject({
    type: z.literal("presence"),
    // awareness 状态由界面自定义，这里只保证是对象；clientId 是本机 Yjs 的 client id。
    states: z.array(z.strictObject({ clientId: z.number().int().nonnegative(), state: z.record(z.unknown()) })).max(64),
  }),
]);
export type NoteDocStreamEventV1 = z.infer<typeof noteDocStreamEventV1Schema>;

export const noteDocEventPayloadSchema = z.strictObject({
  kind: z.literal("note_doc_event"),
  noteId: uuidSchema,
  event: noteDocStreamEventV1Schema,
});
export type NoteDocEventPayloadV1 = z.infer<typeof noteDocEventPayloadSchema>;

/** API `GET /v2/notes/:id/doc-state` 的回执：能直接喂给 Y.Doc 的那份编码。只有主进程读它。 */
export const noteDocServerStateV1Schema = z.strictObject({
  update: z.string().min(1).max(NOTE_DOC_BLOCKS_MAX_JSON_CHARS),
  revision: nonNegativeIntSchema,
  backfilled: z.boolean(),
  /** 服务端此刻的 `notes.updated_at`。无增量的提交也拿它当回执时间。 */
  savedAt: isoTimestampSchema,
});
export type NoteDocServerStateV1 = z.infer<typeof noteDocServerStateV1Schema>;

/** 编辑起点：主进程把编码解成视图再交给界面（界面不碰 yjs 编码）。 */
export const noteDocStateResultV1Schema = z.strictObject({
  blocks: z.array(noteDocProjectBlockV1Schema).max(NOTE_DOC_BLOCKS_MAX_COUNT),
  title: z.string().max(200),
  titleSource: z.string().max(16),
  revision: nonNegativeIntSchema,
  /** true = 这篇建得比 0244 早，服务端给的是从行里补齐后重新编码的一份。 */
  backfilled: z.boolean(),
});
export type NoteDocStateResultV1 = z.infer<typeof noteDocStateResultV1Schema>;

/** 一次性上送（personal 空间与离线队列重连）的回执。 */
export const noteDocUploadResultV1Schema = z.strictObject({
  revision: nonNegativeIntSchema,
  /** 落盘后 `notes.updated_at`：这一条是服务端给的。 */
  savedAt: isoTimestampSchema,
});
export type NoteDocUploadResultV1 = z.infer<typeof noteDocUploadResultV1Schema>;

/**
 * 写入回执。`via` 不是给界面看的装饰：personal 空间没有长连接，写走 HTTP，
 * 让界面知道"这次是哪条路"，才不会在断连时把两件事混成一个错误。
 */
export const noteDocWriteResultV1Schema = z.strictObject({
  via: z.enum(["stream", "uploaded", "unchanged"]),
  /** 只有 uploaded 才有：服务端那份快照的 revision。 */
  revision: nonNegativeIntSchema.nullable(),
  /**
   * 这一次写入被接受的时刻，给保存行显示用。**来源按 `via` 不同**，这一点必须写明：
   *  - `uploaded`：服务端落盘后的 `notes.updated_at`；
   *  - `stream`：主进程把它并进本机文档的时刻——增量还要经 Hocuspocus 的 debounce
   *    才落盘，那一刻服务端的时间还不存在。界面在流式路径上说的是"已写入、正在同步"
   *    而不是"已保存"，就是为了不把本机接受说成服务端落盘。
   */
  savedAt: isoTimestampSchema,
});
export type NoteDocWriteResultV1 = z.infer<typeof noteDocWriteResultV1Schema>;

/** presence 只在有连接时才有意义；没连接时如实说"没共享"。 */
export const noteDocPresenceResultV1Schema = z.strictObject({
  shared: z.boolean(),
});
export type NoteDocPresenceResultV1 = z.infer<typeof noteDocPresenceResultV1Schema>;

/** Renderer-safe bridge state. Broker-owned ids and hydrated entity data stay in main. */
export const companionBridgeStateV1Schema = z.strictObject({
  version: z.literal(1),
  active: z.boolean(),
  revision: z.string().min(1).nullable(),
  expiresAt: isoTimestampSchema.nullable(),
});
export type CompanionBridgeStateV1 = z.infer<typeof companionBridgeStateV1Schema>;

export const authSurfaceManifestResultV1Schema = z.strictObject({
  manifest: authSurfaceManifestV1Schema,
  testMode: z.boolean(),
});
export type AuthSurfaceManifestResultV1 = z.infer<typeof authSurfaceManifestResultV1Schema>;

export const gatewayEventPayloadM2Schema = z.union([
  gatewayEventPayloadM1Schema,
  z.strictObject({ kind: z.literal("learning_run_changed"), runId: uuidSchema, revision: nonNegativeIntSchema }),
  z.strictObject({ kind: z.literal("card_generation_changed"), runId: uuidSchema, eventCursor: nonNegativeIntSchema, revision: nonNegativeIntSchema }),
  z.strictObject({ kind: z.literal("companion_activity_changed"), inboxSequence: nonNegativeIntSchema }),
  z.strictObject({
    kind: z.literal("companion_chat_event"),
    conversationId: uuidSchema,
    event: companionChatStreamEventV1Schema,
  }),
  noteDocEventPayloadSchema,
]);
export type GatewayEventPayloadM2 = z.infer<typeof gatewayEventPayloadM2Schema>;

export const gatewayEventPayloadSchema = z.union([
  gatewayEventPayloadM1Schema,
  z.strictObject({ kind: z.literal("learning_run_changed"), runId: uuidSchema, revision: nonNegativeIntSchema }),
  z.strictObject({ kind: z.literal("card_generation_changed"), runId: uuidSchema, eventCursor: nonNegativeIntSchema, revision: nonNegativeIntSchema }),
  z.strictObject({ kind: z.literal("companion_activity_changed"), inboxSequence: nonNegativeIntSchema }),
  z.strictObject({
    kind: z.literal("companion_chat_event"),
    conversationId: uuidSchema,
    event: companionChatStreamEventV1Schema,
  }),
  z.strictObject({ kind: z.literal("companion_delivery_changed"), conversationId: uuidSchema, cursor: cursorSchema }),
  z.strictObject({ kind: z.literal("domain_job_changed"), jobId: uuidSchema, revision: nonNegativeIntSchema }),
  noteDocEventPayloadSchema,
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
    kind: z.enum(["connection_changed", "snapshot_invalidated", "learning_run_changed", "card_generation_changed", "companion_chat_event", "companion_activity_changed", "companion_delivery_changed", "domain_job_changed", "note_doc_event"]),
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
/**
 * 伴星会话事件流（§5.3）：桌面端终于有了 SSE 消费者。
 *
 * `eventCursor` 是订阅起点（seq 独占）：`POST .../turns` 的响应带回
 * `eventCursor = turn.accepted 的 seq`，从这里挂流就只收本轮之后的事件，
 * 不会重放整段历史（事件 TTL 是 24h，从头重放代价不可接受）。缺省 0 时
 * 由主进程从事件头开始读——只在没有回合游标的降级路径使用。
 */
const companionChatSubscriptionTopicSchema = z.strictObject({
  kind: z.literal("companionChat"),
  conversationId: uuidSchema,
  eventCursor: nonNegativeIntSchema.optional(),
});
/**
 * 一篇笔记的协同订阅（批次 4.3）。主进程按 noteId 建/退 WS 连接：同一篇笔记在多个窗口
 * 打开只建一条连接，最后一个订阅者退订才关。
 */
const noteDocSubscriptionTopicSchema = z.strictObject({
  kind: z.literal("noteDoc"),
  noteId: uuidSchema,
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
  companionChatSubscriptionTopicSchema,
  z.strictObject({ kind: z.literal("companionDelivery"), cursor: cursorSchema.optional() }),
  z.strictObject({ kind: z.literal("domainJob"), jobId: uuidSchema, cursor: cursorSchema.optional() }),
]);
export type SubscriptionTopicV1 = z.infer<typeof subscriptionTopicSchema>;

export const subscriptionTopicM2Schema = z.discriminatedUnion("kind", [
  runtimeSubscriptionTopicSchema,
  workspaceSubscriptionTopicSchema,
  learningRunSubscriptionTopicSchema,
  cardGenerationSubscriptionTopicSchema,
  companionChatSubscriptionTopicSchema,
  noteDocSubscriptionTopicSchema,
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

// Note save has no renderer-controlled transport/idempotency fields.
export const desktopNoteSaveRequestV1Schema = noteSaveRequestV1Schema;
export type DesktopNoteSaveRequestV1 = z.infer<typeof desktopNoteSaveRequestV1Schema>;

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
    getSurfaceManifest(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<AuthSurfaceManifestResultV1>>;
    getState(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<SessionContextV1>>;
    login(input: { meta: RequestMetaV1; email: string; password: string; remember: boolean }): Promise<GatewayResultV1<SessionContextV1>>;
    register(input: { meta: RequestMetaV1; email: string; password: string; inviteToken?: string; displayName?: string; remember: boolean }): Promise<GatewayResultV1<SessionContextV1>>;
    logout(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<{ loggedOut: true; serverRevoked: boolean }>>;
    reauthenticate(input: { meta: RequestMetaV1; password: string }): Promise<GatewayResultV1<SessionContextV1>>;
    changePassword(input: { meta: RequestMetaV1; commandId: string; currentPassword: string; newPassword: string }): Promise<GatewayResultV1<{ changed: true; sessionsRevoked: true }>>;
    joinWorkspace(input: { meta: RequestMetaV1; inviteToken: string }): Promise<GatewayResultV1<SessionContextV1>>;
    /**
     * 旧版设置页回补：档案读写、头像与退出协作工作区。
     * 档案写入后 main 会丢弃缓存的会话，下次 getState 重新读取。
     */
    getProfile(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<AuthProfileResultV1>>;
    updateProfile(input: { meta: RequestMetaV1; displayName?: string | null; avatarUrl?: string | null }): Promise<GatewayResultV1<AuthProfileResultV1>>;
    uploadAvatar(input: { meta: RequestMetaV1; request: { version: 1; fileName: string; mimeType: string; bytesBase64: string } }): Promise<GatewayResultV1<AvatarUploadResultV1>>;
    getAvatar(input: { meta: RequestMetaV1; request: { version: 1; objectKey: string } }): Promise<GatewayResultV1<z.infer<typeof sourceImageGetResultV1Schema>>>;
    leaveWorkspace(input: { meta: RequestMetaV1; workspaceId: Uuid }): Promise<GatewayResultV1<SessionContextV1>>;
  };
  readonly workspace: {
    list(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<{ workspaces: WorkspaceSummaryV1[] }>>;
    switch(input: { meta: RequestMetaV1; workspaceId: string }): Promise<GatewayResultV1<SessionContextV1>>;
    getCurrent(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<WorkspaceContextV1>>;
    /**
     * AI 同意与数据策略。它们挂在**登录账号**上（`user_ai_settings` / `/me/ai-*`），
     * 不挂在空间上：谁读都是自己的那份，谁都能改自己的那份，所以既没有
     * `requireOwner`，也没有 `canManage`。方法名里的 `Ai` 前缀保留历史命名，
     * 真正的空间级设置仍然只走 `settings.update` 那条能力位。
     */
    getAiSettings(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<WorkspaceAiSettingsV1>>;
    updateAiConsent(input: {
      meta: RequestMetaV1;
      consentVersion: string;
    }): Promise<GatewayResultV1<WorkspaceAiSettingsV1>>;
    updateAiDataPolicy(input: {
      meta: RequestMetaV1;
      policy: AiDataPolicyV1;
    }): Promise<GatewayResultV1<WorkspaceAiSettingsV1>>;
    /**
     * 整库导出：主进程读服务端的导出数据，然后由读者在系统保存对话框里选位置
     * 并落盘。渲染进程只拿到回执，看不到也不写文件系统。
     */
    export(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<WorkspaceExportResultV1>>;
    /** PROFILE-01：重命名自己的个人工作区。 */
    rename(input: { meta: RequestMetaV1; workspaceId: Uuid; name: string }): Promise<GatewayResultV1<RenameWorkspaceResultV1>>;
    /** 新建协作空间：唯一能把别人正当地加进来的空间类型。 */
    create(input: { meta: RequestMetaV1; name: string }): Promise<GatewayResultV1<CreateWorkspaceResultV1>>;
  };
  /**
   * SEC-02 / ADR-0009：Owner 的邀请发出与成员管理。服务端 requireOwner 收口，
   * Member 调用只会得到 forbidden，界面按 membership.role 隐藏入口。
   */
  readonly invites: {
    create(input: { meta: RequestMetaV1; role: "member" | "owner"; expiresInHours?: number }): Promise<GatewayResultV1<InviteCreatedV1>>;
    list(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<InviteListResultV1>>;
    revoke(input: { meta: RequestMetaV1; inviteId: Uuid }): Promise<GatewayResultV1<{ revoked: true }>>;
  };
  readonly members: {
    list(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<MemberListResultV1>>;
    remove(input: { meta: RequestMetaV1; userId: Uuid }): Promise<GatewayResultV1<{ removed: true }>>;
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
  /**
   * 系统剪贴板里的候选链接。渲染层被权限策略挡在剪贴板外，
   * 由主进程读出并只交出其中像目标链接的地址（原文永不过桥）。
   */
  readonly clipboard: {
    readLinks(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<ClipboardReadLinksResult>>;
  };
  readonly room: {
    getProjection(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof roomProjectionV1Schema>>>;
  };
  /**
   * 「今日学习」操作日志流：按客户端日历日窗口返回当天真实操作事件与
   * 状态异常事务。数据全部来自权威表投影，与伴星日记（doc 22）同源。
   */
  readonly activity: {
    getToday(input: {
      meta: RequestMetaV1;
      /** 客户端本地日历日窗口（ISO 带时区）。缺省时服务端按自己当天查询。 */
      from?: string;
      to?: string;
    }): Promise<GatewayResultV1<z.infer<typeof todayActivityV1Schema>>>;
  };
  readonly source: {
    list(input: { meta: RequestMetaV1; cursor?: string; limit?: number; status?: string }): Promise<GatewayResultV1<z.infer<typeof desktopSourceListPageSchema>>>;
    create(input: { meta: RequestMetaV1; request: DesktopSourceCreateRequest }): Promise<GatewayResultV1<z.infer<typeof desktopSourceDetailSchema>>>;
    get(input: { meta: RequestMetaV1; sourceId: Uuid }): Promise<GatewayResultV1<z.infer<typeof desktopSourceDetailSchema>>>;
    listNotes(input: { meta: RequestMetaV1; sourceId: Uuid }): Promise<GatewayResultV1<z.infer<typeof desktopSourceNotesPageSchema>>>;
    update(input: { meta: RequestMetaV1; sourceId: Uuid; request: DesktopSourceUpdateRequest }): Promise<GatewayResultV1<z.infer<typeof desktopSourceDetailSchema>>>;
    /**
     * Starts a note from the source's parsed segments. `force` re-creates a note
     * the API already reported as identical content.
     */
    createNote(input: { meta: RequestMetaV1; sourceId: Uuid; force?: boolean }): Promise<GatewayResultV1<DesktopSourceNoteResult>>;
    /** Soft-deletes the source into `archived`; the record stays under 全部. */
    archive(input: { meta: RequestMetaV1; sourceId: Uuid }): Promise<GatewayResultV1<DesktopSourceArchiveResult>>;
    /**
     * 站内图片的原始字节。渲染层的 origin 是 `ailearn-app://`，相对路径
     * `/api/uploads/…` 会落到应用包内（404），外链又被渲染层 CSP 拦掉，所以
     * 这张图只能由 main 带 Bearer 取回，渲染层用 blob URL 显示。
     */
    getImage(input: {
      meta: RequestMetaV1;
      request: SourceImageGetRequestV1;
    }): Promise<GatewayResultV1<z.infer<typeof sourceImageGetResultV1Schema>>>;
  };
  readonly companion: {
    readonly home: {
      getProjection(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionHomeProjectionV1Schema>>>;
    };
    readonly room: {
      getProfile(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionRoomProfileV1Schema>>>;
      patchProfile(input: {
        meta: RequestMetaV1;
        request: CompanionRoomProfilePatchV1;
      }): Promise<GatewayResultV1<z.infer<typeof companionRoomProfileV1Schema>>>;
    };
    readonly voice: {
      speak(input: {
        meta: RequestMetaV1;
        request: CompanionVoiceSpeakRequestV1;
      }): Promise<GatewayResultV1<z.infer<typeof companionVoiceSpeakResultV1Schema>>>;
      speakSegment(input: {
        meta: RequestMetaV1;
        request: CompanionVoiceSpeakSegmentRequestV2;
      }): Promise<GatewayResultV1<z.infer<typeof companionVoiceSpeakResultV1Schema>>>;
      /**
       * 一段音频到底播没播成（0247）。服务端那一半只能证明"字节交给了客户端"，
       * 而"她经常没声音"里的等到超时/取段失败只发生在渲染进程这一侧。
       * 上报失败不该影响朗读，所以调用方 fire-and-forget，回执只是给统计看的。
       */
      reportPlaybackOutcome(input: {
        meta: RequestMetaV1;
        request: import("./companion-voice-contracts.ts").CompanionVoicePlaybackOutcomeRequestV1;
      }): Promise<GatewayResultV1<z.infer<typeof companionVoicePlaybackOutcomeResultV1Schema>>>;
      /**
       * 语音转文本（2026-09-18 接线）：渲染层本地录好 16kHz WAV，main 送到
       * `POST /voice/transcribe`（purpose=companion_dialogue）。本地 SenseVoice
       * （WASM）优先，这条云通道是本地引擎不可用时的兜底。
       */
      transcribe(input: {
        meta: RequestMetaV1;
        request: import("./companion-voice-contracts.ts").CompanionVoiceTranscribeRequestV1;
      }): Promise<GatewayResultV1<z.infer<typeof companionVoiceTranscribeResultV1Schema>>>;
    };
    /**
     * 聊天发送链路（2026-09-18 接线）：建/复用 dialogue → 发 turn → 轮询
     * messages 拿回复。此前桌面端只有只读的对话历史。
     */
    readonly chat: {
      ensureConversation(input: {
        meta: RequestMetaV1;
        request: import("./companion-chat-desktop-contracts.ts").CompanionChatEnsureRequestV1;
      }): Promise<GatewayResultV1<z.infer<typeof companionChatEnsureResultV1Schema>>>;
      sendTurn(input: {
        meta: RequestMetaV1;
        request: import("./companion-chat-desktop-contracts.ts").CompanionChatSendTurnRequestV1;
      }): Promise<GatewayResultV1<z.infer<typeof companionChatSendTurnResultV1Schema>>>;
      listMessages(input: {
        meta: RequestMetaV1;
        request: import("./companion-chat-desktop-contracts.ts").CompanionChatListMessagesRequestV1;
      }): Promise<GatewayResultV1<z.infer<typeof companionChatListMessagesResultV1Schema>>>;
      /** 提案快照（2026-09-18）：action 消息的确认卡数据源。 */
      getProposal(input: {
        meta: RequestMetaV1;
        request: import("./companion-chat-desktop-contracts.ts").CompanionChatProposalGetRequestV1;
      }): Promise<GatewayResultV1<import("./companion-chat-desktop-contracts.ts").CompanionChatProposalGetResultV1>>;
      /** 提案裁决（2026-09-18）：confirm 必须携带快照冻结的 payloadSha256。 */
      decideProposal(input: {
        meta: RequestMetaV1;
        request: import("./companion-chat-desktop-contracts.ts").CompanionChatProposalDecideRequestV1;
      }): Promise<GatewayResultV1<import("./companion-chat-desktop-contracts.ts").CompanionChatProposalDecideResultV1>>;
      /** agent 导航 route 轮询（2026-09-18）：按 seq 游标拉取 agent.tool 路由事件。 */
      listAgentRoutes(input: {
        meta: RequestMetaV1;
        request: import("./companion-chat-desktop-contracts.ts").CompanionAgentRoutesListRequestV1;
      }): Promise<GatewayResultV1<import("./companion-chat-desktop-contracts.ts").CompanionAgentRoutesListResultV1>>;
      /**
       * 过程节点留痕（2026-09-19）：按 seq 游标拉取 assistant.status / agent.skill /
       * agent.tool 事件 + 每轮 run 的步数与工具消耗摘要。
       */
      listRunNodes(input: {
        meta: RequestMetaV1;
        request: import("./companion-chat-desktop-contracts.ts").CompanionRunNodesListRequestV1;
      }): Promise<GatewayResultV1<import("./companion-chat-desktop-contracts.ts").CompanionRunNodesListResultV1>>;
      /** 主动开场（切片④，2026-09-18）：点击念头气泡，把她的开场消息落进会话。 */
      openThought(input: {
        meta: RequestMetaV1;
        request: import("./companion-chat-desktop-contracts.ts").CompanionChatOpenThoughtRequestV1;
      }): Promise<GatewayResultV1<import("./companion-chat-desktop-contracts.ts").CompanionChatOpenThoughtResultV1>>;
      /**
       * 停止本轮（2026-09-19）：服务端原子取消 + 写 turn.cancelled(reason=user)，
       * worker 在 fence 处把已输出的文本以 kind='cancelled' 留档。
       */
      cancelRun(input: {
        meta: RequestMetaV1;
        request: import("./companion-chat-desktop-contracts.ts").CompanionChatCancelRunRequestV1;
      }): Promise<GatewayResultV1<import("./companion-chat-desktop-contracts.ts").CompanionChatCancelRunResultV1>>;
    };
    readonly learningRun: {
      getContext(input: {
        meta: RequestMetaV1;
        runId: Uuid;
      }): Promise<GatewayResultV1<import("./companion-conversation-contracts.ts").CompanionLearningRunContextV1>>;
      createContextGrant(input: {
        meta: RequestMetaV1;
        runId: Uuid;
        request: import("./companion-conversation-contracts.ts").CreateCompanionLearningRunContextGrantRequestV1;
      }): Promise<GatewayResultV1<import("./companion-conversation-contracts.ts").CompanionGroundedTutorGrantV1>>;
    };
    /**
     * 账号级 presence 设置（GET/PATCH /me/companion）。PATCH 必须携带当前
     * revision（CAS），冲突时返回 conflict 并重新读取——不做自动重放。
     */
    readonly account: {
      getState(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionOverviewSchema>>>;
      patchState(input: {
        meta: RequestMetaV1;
        request: CompanionAccountPatch;
      }): Promise<GatewayResultV1<z.infer<typeof companionAccountStateV1Schema>>>;
      transitionOnboarding(input: {
        meta: RequestMetaV1;
        version: string;
        request: OnboardingTransitionRequest;
      }): Promise<GatewayResultV1<z.infer<typeof onboardingTransitionResponseSchema>>>;
    };
    /**
     * 伴星中心（桌面页 20）的共同记录。记忆星图与记忆列表是两套视图：
     * 星图只含已写入的长期记忆，列表可以额外要候选与归档。
     * 裁决端点都返回被改动的那一条记忆，页面据此就地更新，不重新猜状态。
     */
    readonly memory: {
      list(input: { meta: RequestMetaV1; query?: CompanionMemoryListQuery }): Promise<GatewayResultV1<z.infer<typeof companionMemoryListV1Schema>>>;
      starMap(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionMemoryStarMapV2Schema>>>;
      confirm(input: { meta: RequestMetaV1; memoryId: Uuid }): Promise<GatewayResultV1<z.infer<typeof companionMemoryItemV1Schema>>>;
      pin(input: { meta: RequestMetaV1; memoryId: Uuid }): Promise<GatewayResultV1<z.infer<typeof companionMemoryItemV1Schema>>>;
      unpin(input: { meta: RequestMetaV1; memoryId: Uuid }): Promise<GatewayResultV1<z.infer<typeof companionMemoryItemV1Schema>>>;
      archive(input: { meta: RequestMetaV1; memoryId: Uuid }): Promise<GatewayResultV1<z.infer<typeof companionMemoryItemV1Schema>>>;
      restore(input: { meta: RequestMetaV1; memoryId: Uuid }): Promise<GatewayResultV1<z.infer<typeof companionMemoryItemV1Schema>>>;
      /** 候选记忆的「忽略」与已确认记忆的「删除」是同一个服务端动作。 */
      remove(input: { meta: RequestMetaV1; memoryId: Uuid }): Promise<GatewayResultV1<{ readonly memoryItemId: Uuid }>>;
      create(input: { meta: RequestMetaV1; request: CompanionMemoryCreateInputV1 }): Promise<GatewayResultV1<z.infer<typeof companionMemoryItemV1Schema>>>;
      correct(input: { meta: RequestMetaV1; memoryId: Uuid; request: CompanionMemoryCorrectInputV1 }): Promise<GatewayResultV1<z.infer<typeof companionMemoryItemV1Schema>>>;
      dismiss(input: { meta: RequestMetaV1; memoryId: Uuid }): Promise<GatewayResultV1<z.infer<typeof companionMemoryItemV1Schema>>>;
      conflicts(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionMemoryConflictListV1Schema>>>;
      resolveConflict(input: { meta: RequestMetaV1; memoryId: Uuid; removeId: Uuid }): Promise<GatewayResultV1<z.infer<typeof companionMemoryConflictResolveResultV1Schema>>>;
      rebuildEmbeddings(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionMemoryQueueResultV1Schema>>>;
      clear(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionMemoryClearResultV1Schema>>>;
      summarizeRecent(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionMemoryQueueResultV1Schema>>>;
    };
    readonly daily: {
      get(input: { meta: RequestMetaV1; date?: string }): Promise<GatewayResultV1<z.infer<typeof companionDailySummaryV1Schema>>>;
    };
    readonly persona: {
      get(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionPersonaV1Schema>>>;
      /**
       * 保存人格档案（PATCH /companion/pet-profile，revision CAS）。请求体是
       * **整套档案**：服务端不做字段级合并，`examples` / `boundaries` 省略即被
       * 服务端默认值清空，所以要改一项也得把其余项一起提交。
       */
      patch(input: {
        meta: RequestMetaV1;
        request: CompanionPersonaPatchV1;
      }): Promise<GatewayResultV1<z.infer<typeof companionPersonaMutationV1Schema>>>;
      /** 恢复系统默认人格（POST /companion/pet-profile/reset）。 */
      reset(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionPersonaResetV1Schema>>>;
    };
    /** 产品层唯一的连续历史；内部 conversation 分段不会跨过 IPC。 */
    readonly history: {
      list(input: { meta: RequestMetaV1; query?: CompanionHistoryQueryV1 }): Promise<GatewayResultV1<z.infer<typeof companionHistoryPageV1Schema>>>;
      search(input: { meta: RequestMetaV1; query: CompanionHistorySearchQueryV1 }): Promise<GatewayResultV1<z.infer<typeof companionHistorySearchV1Schema>>>;
      clear(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionHistoryClearResultV1Schema>>>;
    };
    /** 只读学习候选；不会创建 proposal 或启动学习运行。 */
    readonly learningContext: {
      get(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionLearningContextV1Schema>>>;
    };
    readonly journey: {
      bootstrap(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionJourneyBootstrapSchema>>>;
      get(input: { meta: RequestMetaV1; journeyId: Uuid }): Promise<GatewayResultV1<z.infer<typeof companionJourneySchema>>>;
      actOnInvitation(input: { meta: RequestMetaV1; request: CompanionInvitationActionRequest }): Promise<GatewayResultV1<z.infer<typeof companionInvitationSchema>>>;
      act(input: { meta: RequestMetaV1; journeyId: Uuid; request: CompanionJourneyActionRequest }): Promise<GatewayResultV1<z.infer<typeof companionJourneySchema>>>;
    };
    readonly activity: {
      timeline(input: { meta: RequestMetaV1; before?: number }): Promise<GatewayResultV1<z.infer<typeof companionActivityTimelineV1Schema>>>;
      present(input: { meta: RequestMetaV1; deliveryId: Uuid; inboxSequence: number }): Promise<GatewayResultV1<z.infer<typeof companionActivityDeliveryV1Schema>>>;
      ack(input: { meta: RequestMetaV1; request: CompanionActivityAckRequestV1 }): Promise<GatewayResultV1<z.infer<typeof companionActivityDeliveryV1Schema>>>;
    };
    readonly bridge: {
      setContext(input: { meta: RequestMetaV1; page: MainPageContextInputV2 }): Promise<GatewayResultV1<CompanionBridgeStateV1>>;
      clearContext(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<CompanionBridgeStateV1>>;
    };
    readonly data: {
      export(input: { meta: RequestMetaV1; kind: CompanionExportKindV1 }): Promise<GatewayResultV1<z.infer<typeof companionExportResultV1Schema>>>;
      deleteAudit(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionAuditDeleteResultV1Schema>>>;
    };
    /** 任务 14：作答模态偏好（voice/silent/text/any，账号级跨设备）。 */
    readonly answerMode: {
      get(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof companionAnswerModePreferenceV1Schema>>>;
      patch(input: { meta: RequestMetaV1; preference: "voice" | "silent" | "text" | "any" }): Promise<GatewayResultV1<z.infer<typeof companionAnswerModePreferenceV1Schema>>>;
    };
  };
  readonly note: {
    list(input: { meta: RequestMetaV1; cursor?: string; limit?: number; trashed?: boolean }): Promise<GatewayResultV1<z.infer<typeof desktopNoteListPageSchema>>>;
    create(input: { meta: RequestMetaV1; request: DesktopNoteCreateRequest }): Promise<GatewayResultV1<z.infer<typeof noteDetailV1Schema>>>;
    delete(input: { meta: RequestMetaV1; noteId: Uuid }): Promise<GatewayResultV1<DesktopNoteMutationResult>>;
    restore(input: { meta: RequestMetaV1; noteId: Uuid }): Promise<GatewayResultV1<DesktopNoteMutationResult>>;
    get(input: { meta: RequestMetaV1; noteId: Uuid }): Promise<GatewayResultV1<z.infer<typeof noteDetailV1Schema>>>;
    /**
     * 协同正文（批次 4.3/4.4）。渲染进程不直连 WS，也不碰 yjs 编码：`state` 取编辑起点
     * （已经是视图），`syncBlocks` 是唯一写入口（有长连接就并进那份文档，没有就走
     * HTTP，`via` 如实回报），实时下行走 `subscriptions.subscribe({kind:"noteDoc", noteId})`
     * 的 `blocks` 帧。
     */
    readonly doc: {
      state(input: { meta: RequestMetaV1; noteId: Uuid }): Promise<GatewayResultV1<NoteDocStateResultV1>>;
      syncBlocks(input: {
        meta: RequestMetaV1;
        commandId: string;
        noteId: Uuid;
        /**
         * 缺省 = 这次只改标题，正文一个字都不动；空数组才是"把正文删光"。
         * 两者必须是两种表达，否则改名会清空笔记——那正是这一批要消灭的那类静默销毁。
         */
        blocks?: z.infer<typeof noteDocSubmittedBlockV1Schema>[];
        title?: { title: string; titleSource: "auto" | "manual" };
      }): Promise<GatewayResultV1<z.infer<typeof noteDocWriteResultV1Schema>>>;
      presence(input: {
        meta: RequestMetaV1;
        noteId: Uuid;
        state: string;
      }): Promise<GatewayResultV1<z.infer<typeof noteDocPresenceResultV1Schema>>>;
    };
    versions(input: {
      meta: RequestMetaV1;
      noteId: Uuid;
      currentVersionId: Uuid;
      limit?: number;
    }): Promise<GatewayResultV1<z.infer<typeof desktopNoteVersionListSchema>>>;
    restoreVersion(input: {
      meta: RequestMetaV1;
      noteId: Uuid;
      versionId: Uuid;
      baseVersionId: Uuid;
    }): Promise<GatewayResultV1<DesktopNoteMutationResult>>;
    save(input: {
      meta: RequestMetaV1;
      commandId: CommandMetaV1["commandId"];
      noteId: Uuid;
      request: DesktopNoteSaveRequestV1;
    }): Promise<GatewayResultV1<z.infer<typeof noteSaveReceiptV1Schema>>>;
    /**
     * 把编辑器里的一张图写进对象存储。渲染层没有会话令牌、也够不到 API 源，所以
     * 只交出文件字节；服务端确认后返回站内地址，正文里写入的就是它。
     */
    uploadImage(input: {
      meta: RequestMetaV1;
      noteId: Uuid;
      request: NoteImageUploadRequestV1;
    }): Promise<GatewayResultV1<z.infer<typeof noteImageUploadResultV1Schema>>>;
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
      exposure(input: {
        meta: RequestMetaV1;
        runId: Uuid;
        candidateId: Uuid;
        revision: number;
      }): Promise<GatewayResultV1<CardGenerationExposureEligibilityV1>>;
      latestRun(input: { meta: RequestMetaV1; noteId: Uuid }): Promise<GatewayResultV1<CardGenerationRunSnapshotV1>>;
      activate(input: {
        meta: RequestMetaV1;
        commandId: CommandMetaV1["commandId"];
        runId: Uuid;
        request: DesktopCardGenerationActivationSelectionV1;
      }): Promise<GatewayResultV1<z.infer<typeof cardActivationReceiptDesktopV1Schema>>>;
      cancel(input: { meta: RequestMetaV1; commandId: CommandMetaV1["commandId"]; runId: Uuid }): Promise<GatewayResultV1<{ version: 1; runId: Uuid; status: "cancelled" }>>;
      /**
       * 就地重试一次"质量门禁失败"的 run（2026-09-18）。
       *
       * 服务端在**同一 run** 上重跑规划与作者，复用已封存的来源——比 `start` 重开一次
       * 全新生成便宜得多。仅当服务端在恢复契约里签发 `retry_generation` 时客户端才
       * 显示该入口；服务端仍会独立校验状态与失败原因（投影不是授权）。
       */
      retry(input: { meta: RequestMetaV1; commandId: CommandMetaV1["commandId"]; runId: Uuid }): Promise<GatewayResultV1<z.infer<typeof cardGenerationRetryResultV1Schema>>>;
      close(input: { meta: RequestMetaV1; commandId: CommandMetaV1["commandId"]; runId: Uuid; expectedReviewDraftRevision: number }): Promise<GatewayResultV1<z.infer<typeof cardGenerationCloseResultV1Schema>>>;
    };
  };
  readonly objective: {
    list(input: { meta: RequestMetaV1; cursor?: string; limit?: number; lifecycle?: "active" | "archived" | "superseded" }): Promise<GatewayResultV1<z.infer<typeof objectiveListPageV3Schema>>>;
    get(input: { meta: RequestMetaV1; objectiveId: Uuid }): Promise<GatewayResultV1<z.infer<typeof learningObjectiveSurfaceV3Schema>>>;
  };
  readonly review: {
    getQueue(input: {
      meta: RequestMetaV1;
      cursor?: string;
      limit?: number;
    }): Promise<GatewayResultV1<z.infer<typeof reviewQueueV2Schema>>>;
    defer(input: { meta: RequestMetaV1; request: z.infer<typeof reviewDeferRequestV2Schema> }): Promise<
      GatewayResultV1<z.infer<typeof reviewDeferResultV2Schema>>
    >;
  };
  readonly understanding: {
    getTopology(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<z.infer<typeof understandingTopologySnapshotV3Schema>>>;
  };
  readonly search: {
    global(input: { meta: RequestMetaV1; query: string; type?: "note" | "source" | "objective"; limit?: number; offset?: number }): Promise<GatewayResultV1<z.infer<typeof desktopSearchPageSchema>>>;
    /** F-025：搜索索引漂移检测（Owner）。 */
    drift(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<SearchDriftResultV1>>;
    /** F-011：重建当前工作区搜索索引（Owner）。 */
    reindex(input: { meta: RequestMetaV1 }): Promise<GatewayResultV1<SearchReindexResultV1>>;
  };
  /** F-033 / G-006：Markdown 批量导入（Owner）。内容是 UTF-8 文本，不是 base64。 */
  readonly markdownImport: {
    run(input: { meta: RequestMetaV1; items: ReadonlyArray<{ title?: string; content: string }>; importId: string }): Promise<GatewayResultV1<MarkdownImportResultV1>>;
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
    revealTarget(input: { meta: RequestMetaV1; runId: Uuid }): Promise<GatewayResultV1<z.infer<typeof learningRunTargetRevealV2Schema>>>;
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
