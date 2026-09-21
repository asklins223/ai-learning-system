import { BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  DESKTOP_IPC_SCHEMA_REVISION,
  type ActionCapability,
  apiHealthSnapshotSchema,
  apiConnectionStateSchema,
  authSurfaceManifestResultV1Schema,
  capabilityProjectionSchema,
  companionBridgeStateV1Schema,
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
  // 旧版设置页回补（2026-09-18）。
  AVATAR_MAX_BYTES,
  authProfileResultV1Schema,
  avatarObjectKeySchema,
  avatarUploadResultV1Schema,
  inviteCreatedV1Schema,
  inviteListResultV1Schema,
  markdownImportResultV1Schema,
  memberListResultV1Schema,
  NOTE_DOC_BLOCKS_MAX_COUNT,
  noteDocSubmittedBlockV1Schema,
  noteDocStateResultV1Schema,
  noteDocWriteResultV1Schema,
  noteDocPresenceResultV1Schema,
  type NoteDocWriteResultV1,
  renameWorkspaceResultV1Schema,
  createWorkspaceResultV1Schema,
  searchDriftResultV1Schema,
  searchReindexResultV1Schema,
  type DesktopRouteKindM2,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  NOTE_DOC_PRESENCE_MAX_CHARS,
  type NoteDocWatchHandle,
} from "./note-doc-transport.ts";
import { mainPageContextInputV2Schema } from "@ailearn/shared/companion-bridge-contracts";
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
  learningRunTargetRevealV2Schema,
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
  companionAnswerModePreferenceV1Schema,
  companionOverviewSchema,
  onboardingTransitionRequestSchema,
  onboardingTransitionResponseSchema,
} from "@ailearn/shared/companion-shell-contracts";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfilePatchV1Schema,
  companionRoomProfileV1Schema,
} from "@ailearn/shared/companion-home-contracts";
import {
  companionVoiceSpeakRequestV1Schema,
  companionVoiceSpeakResultV1Schema,
  companionVoiceSpeakSegmentRequestV2Schema,
  companionVoicePlaybackOutcomeRequestV1Schema,
  companionVoicePlaybackOutcomeResultV1Schema,
  companionVoiceTranscribeRequestV1Schema,
  companionVoiceTranscribeResultV1Schema,
} from "@ailearn/shared/companion-voice-contracts";
// 伴星聊天发送链路（2026-09-18）：建/复用 dialogue、发 turn、拉消息。
import {
  companionChatEnsureRequestV1Schema,
  companionChatEnsureResultV1Schema,
  companionChatListMessagesRequestV1Schema,
  companionChatListMessagesResultV1Schema,
  companionChatSendTurnRequestV1Schema,
  companionChatSendTurnResultV1Schema,
  companionChatProposalGetRequestV1Schema,
  companionChatProposalGetResultV1Schema,
  companionChatProposalDecideRequestV1Schema,
  companionChatProposalDecideResultV1Schema,
  companionAgentRoutesListRequestV1Schema,
  companionAgentRoutesListResultV1Schema,
  companionChatOpenThoughtRequestV1Schema,
  companionChatOpenThoughtResultV1Schema,
  companionChatCancelRunRequestV1Schema,
  companionChatCancelRunResultV1Schema,
  companionRunNodesListRequestV1Schema,
  companionRunNodesListResultV1Schema,
} from "@ailearn/shared/companion-chat-desktop-contracts";
import {
  companionGroundedTutorGrantV1Schema,
  companionLearningContextV1Schema,
  companionLearningRunContextV1Schema,
  createCompanionLearningRunContextGrantRequestV1Schema,
} from "@ailearn/shared/companion-conversation-contracts";
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
  companionDailyDateV1Schema,
  companionDailySummaryV1Schema,
  companionActivityAckRequestV1Schema,
  companionActivityDeliveryV1Schema,
  companionActivityTimelineV1Schema,
  companionAuditDeleteResultV1Schema,
  companionExportKindV1Schema,
  companionExportResultV1Schema,
  companionHistoryClearResultV1Schema,
  companionHistoryPageV1Schema,
  companionHistoryQueryV1Schema,
  companionHistorySearchQueryV1Schema,
  companionHistorySearchV1Schema,
  companionMemoryItemV1Schema,
  companionMemoryClearResultV1Schema,
  companionMemoryConflictListV1Schema,
  companionMemoryConflictResolveResultV1Schema,
  companionMemoryCreateInputV1Schema,
  companionMemoryCorrectInputV1Schema,
  companionMemoryListQuerySchema,
  companionMemoryListV1Schema,
  companionMemoryQueueResultV1Schema,
  companionMemoryStarMapV2Schema,
  companionPersonaMutationV1Schema,
  companionPersonaPatchV1Schema,
  companionPersonaResetV1Schema,
  companionPersonaV1Schema,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import {
  companionInvitationActionRequestSchema,
  companionInvitationSchema,
  companionJourneyActionRequestSchema,
  companionJourneyBootstrapSchema,
  companionJourneySchema,
} from "@ailearn/shared/companion-journey-contracts";
import { noteDetailV1Schema } from "@ailearn/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema } from "@ailearn/shared/note-save-contracts";
import { noteShareScopeReceiptV1Schema, noteShareScopeValuesV1, type NoteShareScopeReceiptV1 } from "@ailearn/shared/note-share-contracts";
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
import {
  MemoryNoteDocCacheStore,
  type NoteDocCacheEntryV1,
  type NoteDocCacheKey,
  type NoteDocCacheStore,
} from "./note-doc-cache-store.ts";
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
  /** 本机那份笔记文档的落盘口（决定 7：断网可编辑要能跨过重启）。 */
  readonly noteDocCache?: NoteDocCacheStore;
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
const companionVoiceSpeakSegmentInputSchema = z.strictObject({
  meta: requestMetaSchema,
  request: companionVoiceSpeakSegmentRequestV2Schema,
});
const companionVoicePlaybackOutcomeInputSchema = z.strictObject({
  meta: requestMetaSchema,
  request: companionVoicePlaybackOutcomeRequestV1Schema,
});
// 语音转文本 + 聊天链路的入参（2026-09-18）。转写的音频 base64 上限在 schema
// 与 main 侧字节解码后双重收口（10MB，与 API multipart 全局上限一致）。
const companionVoiceTranscribeInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionVoiceTranscribeRequestV1Schema,
});
const companionChatEnsureInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatEnsureRequestV1Schema,
});
const companionChatSendTurnInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatSendTurnRequestV1Schema,
});
const companionChatListMessagesInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatListMessagesRequestV1Schema,
});
// 提案确认 + agent 导航 route 轮询（2026-09-18 补接线）。
const companionChatProposalGetInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatProposalGetRequestV1Schema,
});
const companionChatProposalDecideInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatProposalDecideRequestV1Schema,
});
const companionChatAgentRoutesInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionAgentRoutesListRequestV1Schema,
});
const companionChatRunNodesInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionRunNodesListRequestV1Schema,
});
const companionChatOpenThoughtInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatOpenThoughtRequestV1Schema,
});
const companionChatCancelRunInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatCancelRunRequestV1Schema,
});
const companionLearningRunContextInputSchema = z.strictObject({
  ...m1InputBase,
  runId: uuidSchema,
});
const companionLearningRunContextGrantInputSchema = z.strictObject({
  ...m1InputBase,
  runId: uuidSchema,
  request: createCompanionLearningRunContextGrantRequestV1Schema,
});
const companionAccountPatchInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionAccountPatchSchema,
});
const companionOnboardingTransitionInputSchema = z.strictObject({
  ...m1InputBase,
  version: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  request: onboardingTransitionRequestSchema,
});
// 伴星中心（页 20）：读取按 workspace 路由，裁决端点只带一个记忆 id。
// 删除走 `DELETE`，服务端回答 204，因此回执在 main 侧自己拼。
const companionMemoryListInputSchema = z.strictObject({
  ...m1InputBase,
  query: companionMemoryListQuerySchema.optional(),
});
const companionMemoryIdInputSchema = z.strictObject({ ...m1InputBase, memoryId: uuidSchema });
const companionMemoryCreateInputSchema = z.strictObject({ ...m1InputBase, request: companionMemoryCreateInputV1Schema });
const companionMemoryCorrectInputSchema = z.strictObject({ ...m1InputBase, memoryId: uuidSchema, request: companionMemoryCorrectInputV1Schema });
const companionMemoryResolveConflictInputSchema = z.strictObject({ ...m1InputBase, memoryId: uuidSchema, removeId: uuidSchema });
const companionDailyGetInputSchema = z.strictObject({
  ...m1InputBase,
  date: companionDailyDateV1Schema.optional(),
});
const companionHistoryListInputSchema = z.strictObject({
  ...m1InputBase,
  query: companionHistoryQueryV1Schema.optional(),
});
const companionHistorySearchInputSchema = z.strictObject({
  ...m1InputBase,
  query: companionHistorySearchQueryV1Schema,
});
const companionInvitationActionInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionInvitationActionRequestSchema,
});
const companionJourneyActionInputSchema = z.strictObject({
  ...m1InputBase,
  journeyId: uuidSchema,
  request: companionJourneyActionRequestSchema,
});
const companionActivityTimelineInputSchema = z.strictObject({
  ...m1InputBase,
  before: z.number().int().positive().optional(),
});
const companionActivityPresentInputSchema = z.strictObject({
  ...m1InputBase,
  deliveryId: uuidSchema,
  inboxSequence: z.number().int().min(0),
});
const companionActivityAckInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionActivityAckRequestV1Schema,
});
const companionBridgeSetContextInputSchema = z.strictObject({
  ...m1InputBase,
  page: mainPageContextInputV2Schema,
});
const companionDataExportInputSchema = z.strictObject({
  ...m1InputBase,
  kind: companionExportKindV1Schema,
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
// ─── 笔记协同（批次 4.3）────────────────────────────────────────────
const noteDocStateInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
});
/**
 * 写入的正门。界面交的都是它眼前这份块（顺序即 ordinal）：有连接就并进那条连接的文档
 * （同一份 CRDT 状态，多个窗口共用），没有连接就主进程取一次起点、就地差分、走 HTTP。
 * 一条规则："改了就发这里"。
 */
const noteDocSyncBlocksInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  // 上限与下行帧同一处定义：两边各写一个数，迟早一边放行一边拒收。
  //
  // **缺省 = 这次只改标题，正文一个字都不动**；空数组则是"作者把正文删光了"。
  // 两者必须是两种表达：合并成一种的话，改名就会把整篇笔记清空——而那正是
  // 这一批要消灭的那类"静默销毁用户内容"。
  blocks: z.array(noteDocSubmittedBlockV1Schema).max(NOTE_DOC_BLOCKS_MAX_COUNT).optional(),
  title: z.strictObject({ title: z.string().max(200), titleSource: z.enum(["auto", "manual"]) }).optional(),
}).refine((value) => value.blocks !== undefined || value.title !== undefined, {
  // 什么都不带的提交是一次没有意义的往返（还要取一次编辑起点），直接拒。
  message: "note_doc_submit_empty",
});
const noteSetShareInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  shareScope: z.enum(noteShareScopeValuesV1),
});
const noteDocPresenceInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  // 空串 = 我离开了这篇。上限与主进程里的 awareness 检查同一个数。
  state: z.string().max(NOTE_DOC_PRESENCE_MAX_CHARS),
});
/** 一条笔记的活连接；`workspaceEpoch` 用来在切空间时识别"这条已经不作数"。 */
type NoteDocStreamEntry = {
  handle: NoteDocWatchHandle;
  workspaceEpoch: number;
  /**
   * 服务端给的读写范围，`null` = 还没收到状态帧。**写入只认 `read-write`**：
   * 把只读成员（或服务端还没开口）的提交并进本机文档、再回一句 `via:"stream"`，
   * 就是"界面以为写进去了、服务端其实没落盘"那一类假状态。判据仍然只有服务端那一处，
   * 这里只是不再把它的答复猜成正面。
   */
  authorizedScope: "read-write" | "readonly" | null;
};
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

// ─── 旧版设置页回补（2026-09-18）的入参与回执 ─────────────────────────
// 档案与头像：服务端 PUT /auth/profile 自己做截断；这里只收形状，头像字节上限
// 与 /uploads/avatars 的 2MB 对齐（base64 按 4/3 膨胀留余量）。
const authUpdateProfileInputSchema = z.strictObject({
  ...m1InputBase,
  displayName: z.string().trim().min(1).max(32).nullable().optional(),
  avatarUrl: z.string().trim().max(500).nullable().optional(),
});
const authAvatarUploadInputSchema = z.strictObject({
  ...m1InputBase,
  request: z.strictObject({
    version: z.literal(1),
    fileName: z.string().min(1).max(255),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    bytesBase64: z.string().min(1).max(Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 8),
  }),
});
const authAvatarGetInputSchema = z.strictObject({
  ...m1InputBase,
  request: z.strictObject({ version: z.literal(1), objectKey: avatarObjectKeySchema }),
});
// 工作区退出/改名 + Owner 的邀请与成员管理。
const authLeaveWorkspaceInputSchema = z.strictObject({ ...m1InputBase, workspaceId: uuidSchema });
const workspaceRenameInputSchema = z.strictObject({
  ...m1InputBase,
  workspaceId: uuidSchema,
  name: z.string().trim().min(1).max(50),
});
const workspaceCreateInputSchema = z.strictObject({
  ...m1InputBase,
  name: z.string().trim().min(1).max(50),
});
const inviteCreateInputSchema = z.strictObject({
  ...m1InputBase,
  role: z.enum(["member", "owner"]),
  expiresInHours: z.number().int().min(1).max(168).optional(),
});
const inviteRevokeInputSchema = z.strictObject({ ...m1InputBase, inviteId: uuidSchema });
const memberRemoveInputSchema = z.strictObject({ ...m1InputBase, userId: uuidSchema });
// Markdown 导入：内容是 UTF-8 文本（渲染层 File.text()），单篇 500KB、最多 100 篇。
const markdownImportInputSchema = z.strictObject({
  ...m1InputBase,
  items: z.array(z.strictObject({
    title: z.string().max(200).optional(),
    content: z.string().min(1).max(500_000),
  })).min(1).max(100),
  importId: z.string().min(1).max(100),
});
// 作答模态偏好（任务 14）。
const answerModePatchInputSchema = z.strictObject({
  ...m1InputBase,
  preference: z.enum(["voice", "silent", "text", "any"]),
});
const revokeOutputSchema = z.strictObject({ revoked: z.literal(true) });
const memberRemoveOutputSchema = z.strictObject({ removed: z.literal(true) });

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

/**
 * 空间边界守卫，**fail closed**。
 *
 * 原实现是 `meta.workspaceEpoch !== undefined && meta.workspaceEpoch !== active`，
 * 于是"调用方忘了带 epoch"= 直接放行。而 `createRequestMeta()` 不传参时就不带
 * epoch（epoch 为 0 时也会被丢掉），所以漏带是默认状态而非例外：批量 URL 采集在
 * 循环中途切空间，剩余条目会带着**新空间**的凭据（网关只持一个 `this.token`）
 * 静默落进新空间。缺 epoch 现在一律按边界失效处理。
 *
 * 只有三类通道走 `assertEpochBoundaryExempt`：握手前后（此时还没有 epoch 可带）、
 * 本身用于改变边界的（切空间/加入/退出）、以及与工作区无关的原生与窗口面。
 */
function assertEpoch(meta: RequestMetaV1, activeWorkspaceEpoch: number): void {
  if (meta.workspaceEpoch === undefined || meta.workspaceEpoch !== activeWorkspaceEpoch) {
    throw new DesktopGatewayFailure("stale_workspace", "resync_first");
  }
}

/**
 * 边界豁免：仍校验"带了就必须对"，但不带不拦。新增调用点必须在这里登记理由，
 * 否则应当走 `assertEpoch`。
 */
function assertEpochBoundaryExempt(meta: RequestMetaV1, activeWorkspaceEpoch: number): void {
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
  const noteDocCache = options.noteDocCache ?? new MemoryNoteDocCacheStore();
  /**
   * 本机那份文档的键。身份不全时返回 null，调用方一律"不读也不写"——
   * 缓存的边界就是身份的边界：没有 subjectId 的一份缓存，等于给下一个人留着
   * 上一个人的私有笔记正文。
   */
  const noteDocCacheKey = (noteId: string): NoteDocCacheKey | null =>
    activeSubjectId && activeWorkspaceId ? { subjectId: activeSubjectId, workspaceId: activeWorkspaceId, noteId } : null;

  const persistNoteDocLocal = async (noteId: string): Promise<void> => {
    const key = noteDocCacheKey(noteId);
    if (!key) return;
    const snapshot = gateway.noteDocLocalSnapshot(noteId);
    if (!snapshot) return;
    await noteDocCache.set(key, { ...snapshot, epochAtRest: activeWorkspaceEpoch, updatedAt: new Date().toISOString() });
  };
  let activeWorkspaceEpoch = 0;
  let activeSubjectId: string | null = null;
  let activeWorkspaceId: string | null = null;
  let eventRevision = 0;
  const subscriptions = new Map<string, SubscriptionRecord>();
  const trackedLearningRunIds = new Set<string>();
  const learningRunStreams = new Map<string, () => void>();
  const trackedCardGenerationRunIds = new Set<string>();
  const cardGenerationStreams = new Map<string, () => void>();
  /** 伴星会话事件流：conversationId → 停止函数（每个会话至多一条）。 */
  const companionChatStreams = new Map<string, () => void>();
  /**
   * 笔记协同流：noteId → 该笔记的连接句柄（每篇至多一条，多个窗口共用）。
   *
   * 与 SSE 那几条不同，这里存的不是"停止函数"而是句柄：界面上行的增量要交给**同一条**
   * 连接的文档，才能与订阅者共用一份 CRDT 状态。
   */
  const noteDocStreams = new Map<string, NoteDocStreamEntry>();
  /**
   * 订阅回执比连接早：`ensureNoteDocStream` 是异步建连的，界面那声"我也开着这一篇"
   * 几乎总抢在句柄就位之前到达，当场丢掉就成了"我这侧一切正常、对端永远等不到我"
   * （2026-09-22 两个真客户端实测）。所以最近一次报的状态先记在这儿，连接就位时补交。
   */
  const noteDocPresenceToReplay = new Map<string, string>();
  /** 门控判据（决定 7b）：当前空间的类型与本人角色，由 `rememberSession` 实时更新。 */
  let activeWorkspaceKind: "personal" | "collaborative" | null = null;
  let activeWorkspaceRole: "owner" | "member" | null = null;
  let stopCompanionAccountEvents: (() => void) | null = null;
  let stopCompanionInboxEvents: (() => void) | null = null;
  /**
   * 收件箱事件**合流广播**。inbox SSE 在连接时会把未 ACK 的积压**全量重放**
   * （`after=0`，实测 26 条），逐条 emit 会让渲染层在同一瞬间发起同等次数的
   * 投影重取——而主动念头气泡已经把投影刷新当成自己的触发源（方案 29 §9.15）。
   * 一段突发只广播一次，带最大的那个 sequence。
   */
  let companionInboxBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let companionInboxBroadcastSeq = 0;
  let companionInboxCursor = 0;
  let companionRuntimeFenceTimer: ReturnType<typeof setInterval> | null = null;
  let companionLifecycleGeneration = 0;
  let companionLifecycleWorkspaceEpoch = 0;
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

  const hasCompanionChatSubscription = (conversationId?: string): boolean => {
    for (const subscription of subscriptions.values()) {
      if (subscription.topic.kind !== "companionChat") continue;
      if (conversationId === undefined || subscription.topic.conversationId === conversationId) return true;
    }
    return false;
  };

  const stopCompanionChatStreams = (): void => {
    for (const stop of companionChatStreams.values()) stop();
    companionChatStreams.clear();
  };

  const stopCompanionChatStream = (conversationId: string): void => {
    const stop = companionChatStreams.get(conversationId);
    if (!stop) return;
    companionChatStreams.delete(conversationId);
    stop();
  };

  const stopCompanionLifecycle = (): void => {
    const revokeBridge = gateway.clearCompanionBridgeContext?.();
    if (revokeBridge) void revokeBridge.catch(() => undefined);
    if (companionInboxBroadcastTimer) clearTimeout(companionInboxBroadcastTimer);
    companionInboxBroadcastTimer = null;
    companionInboxBroadcastSeq = 0;
    companionLifecycleGeneration += 1;
    companionLifecycleWorkspaceEpoch = 0;
    stopCompanionAccountEvents?.();
    stopCompanionAccountEvents = null;
    stopCompanionInboxEvents?.();
    stopCompanionInboxEvents = null;
    companionInboxCursor = 0;
    if (companionRuntimeFenceTimer) clearInterval(companionRuntimeFenceTimer);
    companionRuntimeFenceTimer = null;
    gateway.clearCompanionRuntimeState?.();
  };

  const startCompanionLifecycle = async (workspaceEpoch: number): Promise<void> => {
    if (workspaceEpoch <= 0) {
      stopCompanionLifecycle();
      return;
    }
    if (companionLifecycleWorkspaceEpoch === workspaceEpoch && stopCompanionAccountEvents) return;
    stopCompanionLifecycle();
    const generation = companionLifecycleGeneration;
    companionLifecycleWorkspaceEpoch = workspaceEpoch;
    try {
      const overview = await gateway.getCompanionAccountOverview();
      if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) return;
      if (!overview.account.globalEnabled) {
        emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, workspaceEpoch);
        return;
      }
      const renewFence = async () => {
        await gateway.renewCompanionRuntimeFence(overview.account.epoch, 120);
      };
      await renewFence();
      if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) return;
      companionRuntimeFenceTimer = setInterval(() => {
        if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) return;
        void renewFence().catch(() => undefined);
      }, 60_000);
      stopCompanionAccountEvents = await gateway.watchCompanionAccountEvents(
        overview.account.epoch,
        (event) => {
          if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) return;
          stopCompanionChatStreams();
          stopCompanionLifecycle();
          emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, workspaceEpoch);
          void event;
        },
      );
      if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) {
        stopCompanionAccountEvents();
        stopCompanionAccountEvents = null;
        return;
      }
      stopCompanionInboxEvents = await gateway.watchCompanionInboxEvents(
        companionInboxCursor,
        (delivery) => {
          if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) return;
          companionInboxCursor = Math.max(companionInboxCursor, delivery.inboxSequence);
          companionInboxBroadcastSeq = Math.max(companionInboxBroadcastSeq, delivery.inboxSequence);
          if (companionInboxBroadcastTimer) return;
          companionInboxBroadcastTimer = setTimeout(() => {
            companionInboxBroadcastTimer = null;
            const inboxSequence = companionInboxBroadcastSeq;
            companionInboxBroadcastSeq = 0;
            if (generation !== companionLifecycleGeneration || workspaceEpoch !== activeWorkspaceEpoch) return;
            emit("runtime", { kind: "companion_activity_changed", inboxSequence }, workspaceEpoch);
          }, 400);
        },
      );
    } catch {
      if (generation === companionLifecycleGeneration) stopCompanionLifecycle();
      // Companion capability failure must not turn a valid auth session into a
      // false login failure. Individual surfaces expose the concrete reason.
    }
  };

  /** 退订/关窗后回收：没有订阅者的那条笔记连接不作数留着。 */
  const reconcileNoteDocStreams = (): void => {
    for (const noteId of [...noteDocStreams.keys()]) {
      if (!hasNoteDocSubscription(noteId)) stopNoteDocStream(noteId);
    }
  };

  const releaseSubscriptionsForWindow = (window: BrowserWindow): void => {
    // Window destruction is a hard sensitivity boundary. Do not let a
    // main-owned formal-assessment state survive the renderer that held the
    // task DOM, input, or Companion context.
    formalAssessmentGuard.failClosed("disconnected");
    clearSubscriptionsForWindow(window);
    if (!hasLearningRunSubscription()) stopLearningRunStreams();
    if (!hasCardGenerationSubscription()) stopCardGenerationStreams();
    if (!hasCompanionChatSubscription()) stopCompanionChatStreams();
    reconcileNoteDocStreams();
    stopCompanionLifecycle();
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

  /**
   * 伴星会话 SSE（§5.3）：每个会话维持一条流，事件逐帧转发给订阅方。
   *
   * `eventCursor` 来自回合响应（turn.accepted 的 seq），只收本轮之后的事件；
   * 同一会话已有流时不重复建连——先建的那条游标最旧，续传最完整。流的停止由
   * 订阅生命周期负责（最后一个订阅消失、窗口销毁、登出、切工作区）。
   */
  const ensureCompanionChatStream = (conversationId: string, eventCursor: number): void => {
    if (!hasCompanionChatSubscription(conversationId) || companionChatStreams.has(conversationId)) return;
    const streamWorkspaceEpoch = activeWorkspaceEpoch;
    void gateway.watchCompanionConversationEvents(
      conversationId,
      eventCursor,
      (event) => {
        if (streamWorkspaceEpoch !== activeWorkspaceEpoch) return;
        emit("companionChat", { kind: "companion_chat_event", conversationId, event }, activeWorkspaceEpoch);
      },
    ).then((stop) => {
      if (!hasCompanionChatSubscription(conversationId) || streamWorkspaceEpoch !== activeWorkspaceEpoch) {
        stop();
        return;
      }
      companionChatStreams.set(conversationId, stop);
    }).catch(() => undefined);
  };

  /**
   * 笔记协同的建连与门控（决定 7b）。
   *
   * 只在「协作空间 + 本人可写」时建那条 WS。两类不建连的场景不是"没有写入路径"，
   * 只是"没有实时传输"：
   *  - personal 空间：改一处走 `noteDocUpload` 一次性上送，离线时排队、重连后按序重发
   *    （服务端为此专门有幂等用例，重发不会算成第二次写入）；
   *  - collaborative 的只读成员：本来就不能写，正文走既有读路径。
   * 判据的**唯一**来源仍是服务端；这里只是决定要不要占一条长连接。
   */
  /**
   * 门控（决定 7b 的那一半按实测改了）：`personal` 不建连——那里物理上没有第二个人，
   * 占一条长连接只是白耗电。但**只读成员要建**：他读得到这篇（HTTP 就能读），实时看到
   * 别人的改动才是共享空间对他唯一的意义，而"谁还开着这一篇"那一排头像也要求他在场。
   * 服务端本来就会用 `Authenticated("readonly")` 告诉他（也告诉这台机器）他能不能写；
   * 主进程先前自己按角色挡在门外，等于把这道答复换成了自己的第二套判据。
   */
  const noteDocStreamAllowed = (): boolean => activeWorkspaceKind === "collaborative";

  const hasNoteDocSubscription = (noteId: string): boolean => {
    for (const subscription of subscriptions.values()) {
      if (subscription.topic.kind === "noteDoc" && subscription.topic.noteId === noteId) return true;
    }
    return false;
  };

  const stopNoteDocStream = (noteId: string): void => {
    const entry = noteDocStreams.get(noteId);
    if (!entry) return;
    noteDocStreams.delete(noteId);
    // 欠的那份在场状态跟着连接一起作废：留给下一条连接补交，就是把上一个视图的
    // "我还开着"报到下一次真正打开这篇的时候。
    noteDocPresenceToReplay.delete(noteId);
    entry.handle.stop();
  };

  const stopNoteDocStreams = (): void => {
    for (const noteId of [...noteDocStreams.keys()]) stopNoteDocStream(noteId);
    // 本机那份文档与"还没送出去的增量"一起作废：留着的话，下一次写会把上一个空间的
    // 正文差分按到这篇头上——那是跨空间的内容缝合，比丢一次编辑严重得多。
    gateway.dropNoteDocLocalSessions();
  };

  const ensureNoteDocStream = (noteId: string): void => {
    if (!noteDocStreamAllowed() || !hasNoteDocSubscription(noteId) || noteDocStreams.has(noteId)) return;
    const streamWorkspaceEpoch = activeWorkspaceEpoch;
    // 服务端的第一批帧可能在句柄入表之前就到了（建连是异步的，回调却是立刻挂上的），
    // 所以先落在闭包里，入表时一并带进去——漏掉这句答复的话，可写的那位也会被当成只读。
    let authorizedScope: "read-write" | "readonly" | null = null;
    // 连上了还压着一批离线增量，界面上就是"已经同步"的假象：先把欠的交清再建连接。
    // 交不掉（还是没网）不挡建连——那条链自己也会失败，而队列仍然原样留着。
    void gateway.flushNoteDocPending(noteId).catch(() => undefined)
      // 交完就把本机那份重写一遍：不然"已经交出去了"这件事只活在内存里，重启后又
      // 会把同一批当成还没交，白重发一遍（服务端会当空操作，但界面上的等待是真的）。
      .then(() => persistNoteDocLocal(noteId))
      .then(() => gateway.watchNoteDocument(noteId, ({ noteId: _framedByGateway, ...event }) => {
      if (streamWorkspaceEpoch !== activeWorkspaceEpoch) return;
      if (event.type === "status" && event.authorizedScope) {
        authorizedScope = event.authorizedScope;
        const entry = noteDocStreams.get(noteId);
        if (entry) entry.authorizedScope = event.authorizedScope;
      }
      emit("noteDoc", { kind: "note_doc_event", noteId, event }, activeWorkspaceEpoch);
    })).then((handle) => {
      // 服务端说这篇不该有实时连接（仅自己可见）时拿到的是 null：不建连，
      // 但写入照常——`syncNoteDocBlocks` 没连接就走 HTTP 那同一个增量口。
      if (!handle) return;
      // 建连期间可能已经退订、切了空间或改了角色——那条连接不属于这里了。
      if (!hasNoteDocSubscription(noteId) || !noteDocStreamAllowed() || streamWorkspaceEpoch !== activeWorkspaceEpoch) {
        handle.stop();
        return;
      }
      noteDocStreams.set(noteId, { handle, workspaceEpoch: streamWorkspaceEpoch, authorizedScope });
      // 订阅回执比连接早，界面上那声报名字大概率已经落过一次空。连接就位就把记下的
      // 那份补交出去，否则对端永远少一枚印章，而这在这台机器上看不出来。
      const presence = noteDocPresenceToReplay.get(noteId);
      if (presence !== undefined) handle.setPresence(presence);
    }).catch(() => undefined);
  };

  const subscriptionMatchesPayload = (topic: SubscriptionTopicM2, topicKind: SubscriptionTopicM2["kind"], payload: M2SubscriptionEvent): boolean => {
    if (topic.kind !== topicKind) return false;
    if (topic.kind === "learningRun") return payload.kind === "learning_run_changed" && topic.runId === payload.runId;
    if (topic.kind === "cardGeneration") return payload.kind === "card_generation_changed" && topic.runId === payload.runId;
    if (topic.kind === "companionChat") return payload.kind === "companion_chat_event" && topic.conversationId === payload.conversationId;
    if (topic.kind === "noteDoc") return payload.kind === "note_doc_event" && topic.noteId === payload.noteId;
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
      activeWorkspaceKind = null;
      activeWorkspaceRole = null;
      // 判据一消失，所有协同连接都要退掉：留着一条属于上一个空间的连接，
      // 就是"切了空间还在收别人的正文"。
      stopNoteDocStreams();
      return;
    }
    activeSubjectId = session.user.userId;
    activeWorkspaceId = session.workspace.workspaceId;
    const kindChanged = activeWorkspaceKind !== session.workspace.workspaceType
      || activeWorkspaceRole !== session.workspace.role;
    activeWorkspaceKind = session.workspace.workspaceType;
    activeWorkspaceRole = session.workspace.role;
    // 换空间或角色变了（member↔owner）：门控判据变了，旧连接不作数。界面上还有
    // 打开着的笔记时会重新订阅，届时按新判据决定建不建。
    if (kindChanged) stopNoteDocStreams();
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
    if (session.status === "authenticated") void startCompanionLifecycle(session.workspaceEpoch);
    else stopCompanionLifecycle();
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authGetSurfaceManifest, runtimeInputSchema, options, async (_event, _window, input) => {
    return gateway.getAuthSurfaceManifest(input.meta.requestId);
  }, undefined, authSurfaceManifestResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.authLogin, authLoginInputSchema, options, async (_event, _window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    const session = await gateway.login(input.email, input.password, input.meta.requestId, input.remember);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    void startCompanionLifecycle(session.workspaceEpoch);
    emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, activeWorkspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authRegister, authRegisterInputSchema, options, async (_event, _window, input) => {
    formalAssessmentGuard.failClosed("disconnected");
    const session = await gateway.register(input.email, input.password, input.inviteToken, input.displayName, input.meta.requestId, input.remember);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authJoinWorkspace, authJoinWorkspaceInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    const session = await gateway.joinWorkspace(input.inviteToken, input.meta.requestId);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    void startCompanionLifecycle(session.workspaceEpoch);
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
      stopCompanionChatStreams();
      stopCompanionLifecycle();
      activeWorkspaceEpoch = 0;
      if (activeSubjectId) await pendingReturnMarkerStore.clearSubject(activeSubjectId);
      // 退登要连本机那份正文一起清掉：它存的是笔记内容，不是可以留给下一个登录者的
      // 元数据。缓存键里的 subjectId 挡住了别人读到，但账号换到人这一侧也要主动删。
      if (activeSubjectId) await noteDocCache.clearSubject(activeSubjectId);
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
      stopCompanionChatStreams();
      stopCompanionLifecycle();
      if (activeSubjectId) await pendingReturnMarkerStore.clearSubject(activeSubjectId);
      // 退登要连本机那份正文一起清掉：它存的是笔记内容，不是可以留给下一个登录者的
      // 元数据。缓存键里的 subjectId 挡住了别人读到，但账号换到人这一侧也要主动删。
      if (activeSubjectId) await noteDocCache.clearSubject(activeSubjectId);
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
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authChangePassword, authChangePasswordInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    formalAssessmentGuard.failClosed("disconnected");
    const result = await gateway.changePassword(input.currentPassword, input.newPassword, input.meta.requestId);
    stopCompanionLifecycle();
    activeWorkspaceEpoch = 0;
    return result;
  }, undefined, changePasswordOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceList, runtimeInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    return gateway.listWorkspaces(input.meta.requestId);
  }, undefined, workspaceListOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceSwitch, workspaceSwitchInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    formalAssessmentGuard.failClosed("disconnected");
    stopLearningRunStreams();
    trackedLearningRunIds.clear();
    stopCardGenerationStreams();
    trackedCardGenerationRunIds.clear();
    stopCompanionChatStreams();
    stopCompanionLifecycle();
    if (activeSubjectId && activeWorkspaceId) await pendingReturnMarkerStore.clear(activeSubjectId, activeWorkspaceId);
    const session = await gateway.switchWorkspace(input.workspaceId, input.meta.requestId);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    await recoverPersistedReturnMarker(input.meta.requestId);
    void startCompanionLifecycle(session.workspaceEpoch);
    emit("workspace", { kind: "snapshot_invalidated", scope: "workspace" }, activeWorkspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceGetCurrent, runtimeInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
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

  // ─── 旧版设置页回补（2026-09-18）────────────────────────────────────
  // 档案与头像（用户级，Member 也可用；服务端各自收口归属与限流）。
  installHandler(DESKTOP_IPC_CHANNELS.authProfileGet, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    return gateway.getProfile(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, authProfileResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.authUpdateProfile, authUpdateProfileInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    return gateway.updateProfile(
      { displayName: input.displayName, avatarUrl: input.avatarUrl },
      input.meta.requestId,
    );
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, authProfileResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.authUploadAvatar, authAvatarUploadInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    return gateway.uploadAvatar(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, avatarUploadResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.authAvatarGet, authAvatarGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    return gateway.getAvatar(input.request.objectKey, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, sourceImageGetResultV1Schema);

  // 退出协作工作区是空间边界变化：回执是重读后的会话，与 joinWorkspace 同构。
  installHandler(DESKTOP_IPC_CHANNELS.authLeaveWorkspace, authLeaveWorkspaceInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
    const session = await gateway.leaveWorkspace(input.workspaceId, input.meta.requestId);
    // 退出这个空间：这个空间的本机副本一起作废。留在盘上等下一次进来，是一次没有
    // 承诺的复活——成员被移出后不该还能翻出里面的正文。
    if (activeSubjectId) await noteDocCache.clearWorkspace(activeSubjectId, input.workspaceId);
    activeWorkspaceEpoch = session.workspaceEpoch;
    rememberSession(session);
    emit("workspace", { kind: "snapshot_invalidated", scope: "workspace" }, activeWorkspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  // 个人工作区改名：改的是会话里的当前空间名，顺带丢掉会话缓存。
  installHandler(DESKTOP_IPC_CHANNELS.workspaceRename, workspaceRenameInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.renameWorkspace(input.workspaceId, input.name, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, renameWorkspaceResultV1Schema);

  // 新建协作空间。入口在房间控制的学习空间菜单里（不是设置页），所以路由门控取
  // room.home；创建不换空间，因此不触发令牌轮换。
  installHandler(DESKTOP_IPC_CHANNELS.workspaceCreate, workspaceCreateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.createWorkspace(input.name, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, createWorkspaceResultV1Schema);

  // Owner 的邀请发出与成员管理。写入全部由服务端 requireOwner 收口，
  // 这里不再复制一份角色判断，Member 调用只会得到 forbidden。
  installHandler(DESKTOP_IPC_CHANNELS.inviteCreate, inviteCreateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.createInvite(
      { role: input.role, expiresInHours: input.expiresInHours },
      input.meta.requestId,
    );
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, inviteCreatedV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.inviteList, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listInvites(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, inviteListResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.inviteRevoke, inviteRevokeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.revokeInvite(input.inviteId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, revokeOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.memberList, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listMembers(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, memberListResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.memberRemove, memberRemoveInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.removeMember(input.userId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, memberRemoveOutputSchema);

  // Markdown 批量导入（F-033 幂等，Owner）。
  installHandler(DESKTOP_IPC_CHANNELS.settingsMarkdownImport, markdownImportInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.importMarkdown(input.items, input.importId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, markdownImportResultV1Schema);

  // 搜索索引维护（F-025 / F-011，Owner）。
  installHandler(DESKTOP_IPC_CHANNELS.searchDriftGet, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getSearchDrift(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, searchDriftResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.searchReindex, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.reindexSearch(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, searchReindexResultV1Schema);

  // 作答模态偏好（任务 14，账号级跨设备）。
  installHandler(DESKTOP_IPC_CHANNELS.companionAnswerModeGet, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getAnswerModePreference(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionAnswerModePreferenceV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionAnswerModePatch, answerModePatchInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.setAnswerModePreference(input.preference, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionAnswerModePreferenceV1Schema);

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
    const account = await gateway.patchCompanionAccountState(input.request, input.meta.requestId);
    if (account.globalEnabled) void startCompanionLifecycle(activeWorkspaceEpoch);
    else stopCompanionLifecycle();
    emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, activeWorkspaceEpoch);
    return account;
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionAccountStateV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionOnboardingTransition, companionOnboardingTransitionInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.transitionCompanionOnboarding(input.version, input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, onboardingTransitionResponseSchema);

  installHandler(DESKTOP_IPC_CHANNELS.companionVoiceSpeak, companionVoiceSpeakInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.speakCompanionVoice(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionVoiceSpeakResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionVoiceSpeakSegment, companionVoiceSpeakSegmentInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.speakCompanionVoiceSegment(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionVoiceSpeakResultV1Schema);

  // 一段音频播没播成（0247）：与合成同一路由门控。渲染层是 fire-and-forget，
  // 这条链路失败只会变成"少一行统计"，不会打断朗读。
  installHandler(DESKTOP_IPC_CHANNELS.companionVoicePlaybackOutcome, companionVoicePlaybackOutcomeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.recordCompanionVoicePlaybackOutcome(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionVoicePlaybackOutcomeResultV1Schema);

  // 语音转文本 + 聊天发送链路（2026-09-18）：与其余伴星通道同一路由门控。
  installHandler(DESKTOP_IPC_CHANNELS.companionVoiceTranscribe, companionVoiceTranscribeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.transcribeCompanionVoice(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionVoiceTranscribeResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionChatEnsureConversation, companionChatEnsureInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.ensureCompanionConversation(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionChatEnsureResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionChatSendTurn, companionChatSendTurnInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.sendCompanionTurn(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionChatSendTurnResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionChatListMessages, companionChatListMessagesInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listCompanionChatMessages(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionChatListMessagesResultV1Schema);

  // 提案确认 + agent 导航 route 轮询（2026-09-18）：与其余伴星通道同一路由门控。
  installHandler(DESKTOP_IPC_CHANNELS.companionChatProposalGet, companionChatProposalGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionChatProposal(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionChatProposalGetResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionChatProposalDecide, companionChatProposalDecideInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.decideCompanionChatProposal(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionChatProposalDecideResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionChatAgentRoutes, companionChatAgentRoutesInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listCompanionAgentRoutes(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionAgentRoutesListResultV1Schema);

  // 过程节点留痕（2026-09-19）：与其余伴星只读通道同一路由门控，形状照 agent-routes。
  installHandler(DESKTOP_IPC_CHANNELS.companionChatRunNodes, companionChatRunNodesInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listCompanionRunNodes(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionRunNodesListResultV1Schema);

  // 念头主动开场（切片④，2026-09-18）：与其余伴星通道同一路由门控。
  installHandler(DESKTOP_IPC_CHANNELS.companionChatOpenThought, companionChatOpenThoughtInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.openCompanionThought(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionChatOpenThoughtResultV1Schema);

  // 停止本轮（2026-09-19）：与其余伴星通道同一路由门控。202 / 200 幂等同形状。
  installHandler(DESKTOP_IPC_CHANNELS.companionChatCancelRun, companionChatCancelRunInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.cancelCompanionChatRun(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionChatCancelRunResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionLearningRunGetContext, companionLearningRunContextInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionLearningRunContext(input.runId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionLearningRunContextV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionLearningRunCreateContextGrant, companionLearningRunContextGrantInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.createCompanionLearningRunContextGrant(input.runId, input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionGroundedTutorGrantV1Schema);

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
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryStarMapV2Schema);

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

  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryCreate, companionMemoryCreateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.createCompanionMemory(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryItemV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryCorrect, companionMemoryCorrectInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.correctCompanionMemory(input.memoryId, input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryItemV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryDismiss, companionMemoryIdInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.dismissCompanionMemory(input.memoryId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryItemV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryConflicts, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listCompanionMemoryConflicts(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryConflictListV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryResolveConflict, companionMemoryResolveConflictInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.resolveCompanionMemoryConflict(input.memoryId, input.removeId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryConflictResolveResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryRebuildEmbeddings, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.rebuildCompanionMemoryEmbeddings(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryQueueResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionMemoryClear, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.clearCompanionMemories(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryClearResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionMemorySummarizeRecent, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.summarizeRecentCompanionHistory(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionMemoryQueueResultV1Schema);

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

  installHandler(DESKTOP_IPC_CHANNELS.companionHistoryList, companionHistoryListInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listCompanionHistory(input.query ?? {}, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionHistoryPageV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionHistorySearch, companionHistorySearchInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.searchCompanionHistory(input.query, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionHistorySearchV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionHistoryClear, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.clearCompanionHistory(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionHistoryClearResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionLearningContextGet, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionLearningContext(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionLearningContextV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionJourneyBootstrap, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionJourneyBootstrap(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionJourneyBootstrapSchema);

  installHandler(DESKTOP_IPC_CHANNELS.companionInvitationAction, companionInvitationActionInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.actOnCompanionInvitation(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionInvitationSchema);

  installHandler(DESKTOP_IPC_CHANNELS.companionJourneyGet, companionJourneyActionInputSchema.pick({ meta: true, journeyId: true }), options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.getCompanionJourney(input.journeyId, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionJourneySchema);

  installHandler(DESKTOP_IPC_CHANNELS.companionJourneyAction, companionJourneyActionInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.actOnCompanionJourney(input.journeyId, input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionJourneySchema);

  installHandler(DESKTOP_IPC_CHANNELS.companionActivityTimeline, companionActivityTimelineInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.listCompanionActivityTimeline(input.before, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionActivityTimelineV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionActivityPresent, companionActivityPresentInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.presentCompanionDelivery(input.deliveryId, input.inboxSequence, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionActivityDeliveryV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionActivityAck, companionActivityAckInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.ackCompanionDelivery(input.request, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionActivityDeliveryV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionBridgeSetContext, companionBridgeSetContextInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.setCompanionBridgeContext(input.page, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionBridgeStateV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionBridgeClearContext, runtimeInputSchema, options, async (_event, _window, input) => {
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.clearCompanionBridgeContext(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionBridgeStateV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionDataExport, companionDataExportInputSchema, options, async (_event, window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const date = new Date().toISOString().slice(0, 10);
    const descriptor = input.kind === "all"
      ? { title: "导出全部伴星数据", defaultPath: `ailearn-companion-${date}.ndjson`, name: "NDJSON", extension: "ndjson" }
      : input.kind === "memory"
        ? { title: "导出伴星记忆", defaultPath: `ailearn-companion-memory-${date}.json`, name: "JSON", extension: "json" }
        : { title: "导出伴星审计记录", defaultPath: `ailearn-companion-audit-${date}.json`, name: "JSON", extension: "json" };
    const selection = await dialog.showSaveDialog(window, {
      title: descriptor.title,
      defaultPath: descriptor.defaultPath,
      filters: [{ name: descriptor.name, extensions: [descriptor.extension] }],
    });
    if (selection.canceled || !selection.filePath) {
      return { version: 1 as const, saved: false, canceled: true, fileName: null, bytes: 0 };
    }
    const response = await gateway.openCompanionExport(input.kind, input.meta.requestId);
    const partialPath = `${selection.filePath}.partial-${randomBytes(6).toString("hex")}`;
    try {
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partialPath, { flags: "wx" }));
      await rename(partialPath, selection.filePath);
      const saved = await stat(selection.filePath);
      return {
        version: 1 as const,
        saved: true,
        canceled: false,
        fileName: basename(selection.filePath),
        bytes: saved.size,
      };
    } catch {
      await rm(partialPath, { force: true }).catch(() => undefined);
      throw new DesktopGatewayFailure("safe_internal_error", "user_action");
    }
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionExportResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.companionAuditDelete, runtimeInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.deleteCompanionAudit(input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, companionAuditDeleteResultV1Schema);

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

  // ─── 笔记协同（批次 4.3 / 决定 7 的落盘部分）─────────────────────────
  installHandler(DESKTOP_IPC_CHANNELS.noteDocState, noteDocStateInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    const cacheKey = noteDocCacheKey(input.noteId);
    const cached = cacheKey ? await noteDocCache.get(cacheKey) : null;
    // 编辑起点必须有共同祖先：用 note.detail 的 blocks 自己拼一棵文档树，与库里那份
    // 没有祖先关系，两边一改就复制块。本机那份是从服务端编码长出来的，所以先把它
    // 接回来，再让服务端这次给的起点并进去。
    if (cached) gateway.restoreNoteDocLocal(input.noteId, cached);
    const result = await gateway.getNoteDocState(input.noteId, input.meta.requestId);
    await persistNoteDocLocal(input.noteId);
    return result;
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, noteDocStateResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteDocSyncBlocks, noteDocSyncBlocksInputSchema, options, async (_event, _window, input): Promise<NoteDocWriteResultV1> => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    // 可写性这里一律不判：判据只在服务端那一处（WS 侧 `Authenticated("readonly")`、
    // HTTP 侧 `requireOwner`）。这里只决定"走哪条出口"。
    // 走哪条出口只判一次（同一个表达式），因为两条出口的判据必须是同一句话：连接被服务端
    // 认定可写，才并进那份文档（服务端由 WS 落盘）；否则取起点差分后走 HTTP，让同一句
    // `requireOwner` 给出答复。只读成员现在也建连（他要看到别人的改动），所以"有连接"
    // 本身不再等于"写得进去"。
    const stream = noteDocStreams.get(input.noteId);
    const onStream = Boolean(stream && stream.workspaceEpoch === activeWorkspaceEpoch && stream.authorizedScope === "read-write");
    if (onStream && stream) {
      const update = stream.handle.applyBlocks(input.blocks ?? null, input.title);
      // 本机没产生任何增量时不报"同步中"——那一次什么都没写，报成提交过就是在骗回执。
      return update === null
        ? { via: "unchanged", revision: null, savedAt: new Date().toISOString() }
        : { via: "stream", revision: null, savedAt: new Date().toISOString() };
    }
    // 出口由网关如实报：uploaded（服务端已落盘）/ unchanged（这次没改动）/
    // queued（没网，已攒在本机文档里）。
    const receipt = await gateway.syncNoteDocBlocks(
      input.noteId,
      input.blocks ?? null,
      input.title,
      input.meta.requestId,
    );
    // 落盘跟着这次写走：`queued` 的那几条不留在内存里过夜就又没了。
    await persistNoteDocLocal(input.noteId);
    return { via: receipt.via, revision: receipt.revision, savedAt: receipt.savedAt };
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, noteDocWriteResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteSetShare, noteSetShareInputSchema, options, async (_event, _window, input): Promise<NoteShareScopeReceiptV1> => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    // 这里不判"是不是作者"：判据只在服务端那一处。界面上的禁用只是让点下去之前就知道
    // 结果，不是权限。
    return await gateway.setNoteShareScope(input.noteId, input.shareScope, input.meta.requestId);
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, noteShareScopeReceiptV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteDocPresence, noteDocPresenceInputSchema, options, (_event, _window, input) => {
    assertEpoch(input.meta, activeWorkspaceEpoch);
    // 先记下，再看有没有连接可以马上交：连接的建立是异步的（见 `noteDocPresenceToReplay`），
    // 只按"此刻有没有句柄"回答就会把第一次报名字吞掉。
    noteDocPresenceToReplay.set(input.noteId, input.state);
    const stream = noteDocStreams.get(input.noteId);
    if (!stream || stream.workspaceEpoch !== activeWorkspaceEpoch) return { shared: false as const };
    stream.handle.setPresence(input.state);
    return { shared: true as const };
  }, () => activeWorkspaceEpoch > 0 ? activeWorkspaceEpoch : undefined, noteDocPresenceResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.noteCardGenerationStart, cardGenerationStartInputSchema, options,
    async (_event, _window, input) => {
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
    assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch);
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
    if (input.topic.kind === "companionChat") {
      // eventCursor 缺省 0（无回合游标的降级路径）：主进程从头重放，渲染层
      // 按 runId/generation 过滤，不会把历史帧渲染成本轮回复。
      ensureCompanionChatStream(input.topic.conversationId, input.topic.eventCursor ?? 0);
    }
    if (input.topic.kind === "noteDoc") {
      ensureNoteDocStream(input.topic.noteId);
    }
    return { subscriptionId };
  }, undefined, subscriptionOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.subscriptionsUnsubscribe, unsubscribeInputSchema, options, (_event, window, input) => {
    const subscription = subscriptions.get(input.subscriptionId);
    if (!subscription || subscription.window !== window) throw new DesktopGatewayFailure("not_found", "never");
    subscriptions.delete(input.subscriptionId);
    if (!hasLearningRunSubscription()) stopLearningRunStreams();
    if (!hasCardGenerationSubscription()) stopCardGenerationStreams();
    // 一篇笔记可能被多个窗口同时订阅，所以不能"有一条退订就关连接"。
    reconcileNoteDocStreams();
    if (subscription.topic.kind === "companionChat" && !hasCompanionChatSubscription(subscription.topic.conversationId)) {
      stopCompanionChatStream(subscription.topic.conversationId);
    }
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

  installHandler(DESKTOP_IPC_CHANNELS.learningRunRevealTarget, learningRunGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, activeWorkspaceEpoch);
    return gateway.revealLearningRunTarget(input.runId, input.meta.requestId);
  }, undefined, learningRunTargetRevealV2Schema);

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
