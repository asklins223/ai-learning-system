import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { learningDashboardV2Schema, type LearningDashboardV2 } from "@ailearn/shared";
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
  type ApiConnectionStateV1,
  type CapabilityProjectionV1,
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
} from "@ailearn/shared/desktop-ipc-contracts";
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
import { todayActivityV1Schema } from "@ailearn/shared/activity-surface-contracts";
import { roomProjectionV1Schema, type RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import {
  companionAccountStateV1Schema,
  companionOverviewSchema,
  type CompanionAccountPatch,
  type CompanionAccountStateV1,
  type CompanionOverview,
} from "@ailearn/shared/companion-shell-contracts";
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
  companionVoiceSpeakResultV1Schema,
  type CompanionVoiceSpeakRequestV1,
  type CompanionVoiceSpeakResultV1,
} from "@ailearn/shared/companion-voice-contracts";
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
  companionConversationListV1Schema,
  companionDailySummaryV1Schema,
  companionMemoryItemV1Schema,
  companionMemoryListV1Schema,
  companionMemoryStarMapV1Schema,
  companionPersonaMutationV1Schema,
  companionPersonaResetV1Schema,
  companionPersonaV1Schema,
  type CompanionConversationListV1,
  type CompanionDailySummaryV1,
  type CompanionMemoryItemV1,
  type CompanionMemoryListQuery,
  type CompanionMemoryListV1,
  type CompanionMemoryStarMapV1,
  type CompanionPersonaMutationV1,
  type CompanionPersonaPatchV1,
  type CompanionPersonaResetV1,
  type CompanionPersonaV1,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { noteDetailV1Schema, type NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema, type NoteSaveReceiptV1 } from "@ailearn/shared/note-save-contracts";
import {
  desktopSourceListPageSchema,
  desktopSourceDetailSchema,
  desktopSourceNotesPageSchema,
  desktopNoteListPageSchema,
  desktopNoteVersionListSchema,
  desktopSearchPageSchema,
  type DesktopSourceListPage,
  type DesktopSourceDetail,
  type DesktopSourceCreateRequest,
  type DesktopSourceNotesPage,
  type DesktopSourceNoteResult,
  type DesktopSourceUpdateRequest,
  type DesktopSourceArchiveResult,
  type DesktopNoteListPage,
  type DesktopNoteCreateRequest,
  type DesktopNoteMutationResult,
  type DesktopNoteVersionList,
  type DesktopSearchPage,
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

const DEFAULT_API_ORIGIN = "http://127.0.0.1:4000";

const rawAuthResponseSchema = z.strictObject({
  token: nonEmptyStringSchema,
  ctx: z.strictObject({
    userId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    membershipRole: z.string().nullable().optional(),
  }),
  workspaces: z.array(z.strictObject({
    workspaceId: z.string().uuid(),
    workspaceName: nonEmptyStringSchema,
    role: z.enum(["owner", "member"]),
    workspaceType: z.enum(["personal", "collaborative"]),
    isPersonal: z.boolean(),
    leftAt: z.string().datetime({ offset: true }).nullable(),
  })),
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
const NATIVE_CAPABILITY_CHANNELS: Readonly<Record<keyof NativeCapabilityProjectionV1, string | null>> = {
  filePicker: null,
  clipboard: DESKTOP_IPC_CHANNELS.clipboardReadLinks,
  notifications: null,
  asr: null,
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

function waitForStreamRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  private currentSession: SessionContextV1 | null = null;
  private transportEpoch = 0;
  private workspaceEpoch = 1;
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly commandIdempotency = new Map<string, string>();
  private readonly deviceSessionId = randomUUID();
  private readonly credentials: SessionCredentialStore | null;
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
    options: { credentials?: SessionCredentialStore | null } = {},
  ) {
    this.credentials = options.credentials ?? null;
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
    const persist = remember ?? this.credentialPersistence === "safe_storage";
    const result = await this.request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember: persist }),
    }, false, true, requestId, "invalid_credentials");
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.commandIdempotency.clear();
    this.token = parsed.data.token;
    this.workspaceEpoch = 1;
    this.roomProjectionCache = null;
    await this.persistCredential(persist);
    return this.loadSession(requestId);
  }

  async register(email: string, password: string, inviteToken?: string, displayName?: string, requestId?: string, remember?: boolean): Promise<SessionContextV1> {
    await this.ensureConnected(requestId);
    const persist = remember ?? this.credentialPersistence === "safe_storage";
    const body: { email: string; password: string; inviteToken?: string; displayName?: string } = { email, password };
    if (inviteToken) body.inviteToken = inviteToken;
    if (displayName) body.displayName = displayName;
    const result = await this.request("/auth/register-v2", { method: "POST", body: JSON.stringify(body) }, false, true, requestId, "invalid_credentials");
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.commandIdempotency.clear();
    this.token = parsed.data.token;
    this.workspaceEpoch = 1;
    this.roomProjectionCache = null;
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

  async logout(requestId?: string): Promise<{ loggedOut: true; serverRevoked: boolean }> {
    const token = this.token;
    this.token = null;
    this.currentSession = null;
    this.roomProjectionCache = null;
    this.commandIdempotency.clear();
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
    return this.login(current.user.email, password, requestId);
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
    await this.request("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }, true, true, requestId);
    this.token = null;
    this.currentSession = null;
    this.roomProjectionCache = null;
    this.commandIdempotency.clear();
    this.tokenIsRestored = false;
    this.credentialPersistence = "memory";
    await this.credentials?.clear().catch(() => undefined);
    return { changed: true, sessionsRevoked: true };
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
    const result = await this.request("/auth/switch-workspace", {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    }, true, true, requestId);
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.commandIdempotency.clear();
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
    await this.ensureConnected(requestId);
    const result = await this.request("/auth/capabilities/v1", { method: "GET" }, true, true, requestId);
    const parsed = capabilityProjectionSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    // 本机能力属于桌面壳，服务端只能给 fail-closed 占位；真正的值在这里覆盖，
    // 让「设置 → 本机能力 / 半身形象」显示的是这台机器的事实而不是猜测。
    return capabilityProjectionSchema.parse({
      ...parsed.data,
      workspaceEpoch: this.workspaceEpoch,
      nativeCapabilities: nativeCapabilities(),
    });
  }

  async getWorkspaceAiSettings(requestId?: string): Promise<WorkspaceAiSettingsV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/workspace/ai-settings", { method: "GET" }, true, true, requestId);
    const parsed = workspaceAiSettingsV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  async updateAiConsent(consentVersion: string, requestId?: string): Promise<WorkspaceAiSettingsV1> {
    await this.ensureConnected(requestId);
    await this.request("/workspace/ai-consent", {
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
    await this.request("/workspace/ai-data-policy", {
      method: "PUT",
      body: JSON.stringify(policy),
    }, true, true, requestId);
    return this.getWorkspaceAiSettings(requestId);
  }

  clearCredential(): void {
    this.token = null;
    this.currentSession = null;
    this.roomProjectionCache = null;
    this.commandIdempotency.clear();
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
  ): Promise<DesktopSourceDetail> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/sources",
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = desktopSourceDetailSchema.safeParse(result.body);
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
    let activeGenerationSummary: CardGenerationActiveSummaryV1 | null = null;
    let activeGenerationSummaryError: Parameters<typeof projectLearningDashboardToRoomProjection>[1]["activeGenerationSummaryError"];
    if (generationRecoveryEnabled) {
      try {
        const active = await this.getActiveCardGenerationSummaries(requestId);
        activeGenerationSummary = active.items[0] ?? null;
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

  async getCompanionMemoryStarMap(requestId?: string): Promise<CompanionMemoryStarMapV1> {
    await this.ensureConnected(requestId);
    const result = await this.request(
      "/companion/memory/star-map",
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryStarMapV1Schema.safeParse(result.body);
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

  async getCompanionPersona(requestId?: string): Promise<CompanionPersonaV1> {
    await this.ensureConnected(requestId);
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

  /** 对话记录只读列表；渲染层拿不到消息正文，也没有发送通道。 */
  async listCompanionConversations(
    limit?: number,
    requestId?: string,
  ): Promise<CompanionConversationListV1> {
    await this.ensureConnected(requestId);
    const params = new URLSearchParams({ kind: "dialogue", status: "active" });
    if (limit !== undefined) params.set("limit", String(limit));
    const result = await this.request(
      `/companion/conversations?${params.toString()}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = companionConversationListV1Schema.safeParse(result.body);
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
          if (!closed) await waitForStreamRetry(1000);
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(1000);
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
          if (!closed) await waitForStreamRetry(1000);
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(1000);
        }
      }
    };
    void run();
    return stop;
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
    schema: z.ZodType<T & { runId: string; snapshotId: string }>,
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
      if (!response.ok) throw this.mapResponseError(response.status, response.headers);
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
    const domainCode = authDomainErrorCode(status, body);
    if (domainCode) return new DesktopGatewayFailure(domainCode, "never", options);
    if (status === 401) return new DesktopGatewayFailure(unauthorizedCode ?? (this.token ? "reauth_required" : "auth_required"), "user_action", options);
    if (status === 403) return new DesktopGatewayFailure("forbidden", "never", options);
    if (status === 404) return new DesktopGatewayFailure("not_found", "never", options);
    if (status === 409) return new DesktopGatewayFailure("conflict", "never", options);
    if (status === 429) return new DesktopGatewayFailure("rate_limited", "safe_retry", options);
    if (status >= 500) return new DesktopGatewayFailure("safe_internal_error", "user_action", options);
    return new DesktopGatewayFailure("validation", "user_action", options);
  }
}

/**
 * The identity API answers auth failures with a small, machine-readable `error`
 * token. Only that token crosses the IPC boundary — never the server's prose —
 * and only for the tokens listed here, so an unexpected body still falls back to
 * the status-based mapping instead of inventing a category.
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
};

function authDomainErrorCode(status: number, body: unknown): GatewayErrorCode | null {
  if (status !== 400 && status !== 404 && status !== 409 && status !== 410) return null;
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const token = (body as { error?: unknown }).error;
  if (typeof token !== "string") return null;
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
