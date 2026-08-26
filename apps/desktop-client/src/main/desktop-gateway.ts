import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { learningDashboardV2Schema } from "@ailearn/shared";
import {
  DESKTOP_API_SERVICE_ID,
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
  type RuntimeSnapshotV1,
  type SessionContextV1,
  type WorkspaceContextV1,
  type WorkspaceSummaryV1,
  windowStateSnapshotV1Schema,
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
import { reviewQueueV2Schema } from "@ailearn/shared/review-queue-v2-contracts";
import { roomProjectionV1Schema, type RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import { noteDetailV1Schema, type NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema, type NoteSaveReceiptV1 } from "@ailearn/shared/note-save-contracts";
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
  private roomProjectionCache: { readonly etag: string; readonly workspaceEpoch: number; readonly value: RoomProjectionV1 } | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
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
      nativeCapabilities: {
        filePicker: "unavailable",
        clipboard: "unavailable",
        notifications: "unavailable",
        asr: "unavailable",
        updates: "unavailable",
        live2d: "unavailable",
      },
      reducedMotion,
      startupRevision: 1,
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

  async login(email: string, password: string, requestId?: string): Promise<SessionContextV1> {
    await this.ensureConnected(requestId);
    const result = await this.request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember: false }),
    }, false, true, requestId, "invalid_credentials");
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.commandIdempotency.clear();
    this.token = parsed.data.token;
    this.workspaceEpoch = 1;
    this.roomProjectionCache = null;
    return this.loadSession(requestId);
  }

  async register(email: string, password: string, inviteToken?: string, displayName?: string, requestId?: string): Promise<SessionContextV1> {
    await this.ensureConnected(requestId);
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
    return capabilityProjectionSchema.parse({ ...parsed.data, workspaceEpoch: this.workspaceEpoch });
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

  async getRoomProjection(requestId?: string): Promise<RoomProjectionV1> {
    await this.ensureConnected(requestId);
    const capabilityProjection = await this.getCapabilities(requestId);
    const generationRecoveryEnabled = capabilityProjection.actionCapabilities["card_generation.start"] === "allowed"
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
      const refreshed = roomProjectionV1Schema.parse({
        ...cached.value,
        activeGenerationSummary: activeGenerationSummaryError
          ? { state: "error", reason: activeGenerationSummaryError, retryable: true }
          : activeGenerationSummary
            ? { state: "data", data: activeGenerationSummary }
            : { state: "empty" },
        sectionStates: {
          ...cached.value.sectionStates,
          activeGenerationSummary: {
            state: activeGenerationSummaryError ? "error" : activeGenerationSummary ? "data" : "empty",
          },
        },
      });
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
    this.roomProjectionCache = { etag, workspaceEpoch: this.workspaceEpoch, value: projection };
    return projection;
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
    // query/command paths. A V1 run or an unknown snapshot fails closed before
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
      credentialPersistence: "memory",
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
    if (!response.ok && mapErrors) throw this.mapResponseError(response.status, response.headers, unauthorizedCode);
    if (!response.ok && !allowHttpErrors) throw new DesktopGatewayFailure("api_unavailable", "safe_retry", { httpStatus: response.status });
    return { status: response.status, body, headers: response.headers };
  }

  private mapResponseError(status: number, headers: Headers, unauthorizedCode?: GatewayErrorCode): DesktopGatewayFailure {
    const retryAfter = retryAfterFromHeaders(headers);
    const options = { httpStatus: status, ...(retryAfter ? { retryAfter } : {}) };
    if (status === 401) return new DesktopGatewayFailure(unauthorizedCode ?? (this.token ? "reauth_required" : "auth_required"), "user_action", options);
    if (status === 403) return new DesktopGatewayFailure("forbidden", "never", options);
    if (status === 404) return new DesktopGatewayFailure("not_found", "never", options);
    if (status === 409) return new DesktopGatewayFailure("conflict", "never", options);
    if (status === 429) return new DesktopGatewayFailure("rate_limited", "safe_retry", options);
    if (status >= 500) return new DesktopGatewayFailure("safe_internal_error", "user_action", options);
    return new DesktopGatewayFailure("validation", "user_action", options);
  }
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
