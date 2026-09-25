import { createHmac } from "node:crypto";
import * as Y from "yjs";
import {
  emptyNoteDoc,
  projectNoteBlocks,
  setNoteTitle,
  snapshotOf,
  syncNoteBlocksForEditor,
  writeNoteBlocks,
} from "./test-support/note-doc-test-doc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CONTRACT_VERSION,
  actionCapabilityValues,
  capabilityProjectionSchema,
  desktopTrustSignatureMessage,
  featureNameValues,
} from "@ailearn/shared/desktop-ipc-contracts";
import { learningDashboardV2Schema } from "@ailearn/shared";
import {
  learningRunActionResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  submitTaskArtifactReceiptV2Schema,
} from "@ailearn/shared/learning-run-v2-contracts";
import { noteDetailV1Schema } from "@ailearn/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema } from "@ailearn/shared/note-save-contracts";
import { cardGenerationActiveSummaryListV1Schema } from "@ailearn/shared/card-generation-desktop-contracts";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfilePatchV1Schema,
  companionRoomProfileV1Schema,
} from "@ailearn/shared/companion-home-contracts";
import {
  COMPANION_VOICE_MAX_AUDIO_BYTES,
  COMPANION_VOICE_SPEAK_VOICE,
  companionVoiceSpeakResultV1Schema,
} from "@ailearn/shared/companion-voice-contracts";
import {
  SOURCE_IMAGE_MAX_BYTES,
  sourceImageGetResultV1Schema,
} from "@ailearn/shared/source-image-contracts";
import type { GatewayErrorCode } from "@ailearn/shared/desktop-ipc-contracts";
import {
  DesktopGateway,
  DesktopGatewayFailure,
  parseCompanionAccountSseFrame,
  parseCompanionInboxSseFrame,
  parseCompanionSseFrame,
} from "./desktop-gateway";

const pairingSecret = Buffer.alloc(32, 9);
const pairingSecretEncoded = pairingSecret.toString("base64url");

function environment(): NodeJS.ProcessEnv {
  return {
    DESKTOP_API_ORIGIN: "http://127.0.0.1:4000",
    AILEARN_DESKTOP_PAIRING_KEY_ID: "desktop-key-1",
    AILEARN_DESKTOP_PAIRING_SECRET: pairingSecretEncoded,
    AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test",
  };
}

function trustResponse(request: Record<string, unknown>): Response {
  const unsigned = {
    version: 1 as const,
    nonce: request.nonce as string,
    serviceId: DESKTOP_API_SERVICE_ID,
    ipcContractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    domainSchemaRevision: "domain-v2-test",
    pairingKeyId: "desktop-key-1",
    instanceId: "instance-1",
    algorithm: "HMAC-SHA256" as const,
  };
  const signature = createHmac("sha256", pairingSecret)
    .update(desktopTrustSignatureMessage(unsigned), "ascii")
    .digest("hex");
  return new Response(JSON.stringify({ ...unsigned, signature }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function healthResponse(): Response {
  return new Response(JSON.stringify({
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString(),
  }), { status: 200 });
}

const V2_SNAPSHOT = learningRunPublicSnapshotV2Schema.parse({
  version: 2,
  runId: "00000000-0000-4000-8000-000000000001",
  snapshotId: "00000000-0000-4000-8000-000000000002",
  originV2: {
    kind: "card",
    cardId: "00000000-0000-4000-8000-000000000003",
    objectiveId: "00000000-0000-4000-8000-000000000004",
  },
  target: {
    objectiveId: "00000000-0000-4000-8000-000000000004",
    objectiveRevision: 1,
    cardId: "00000000-0000-4000-8000-000000000003",
    publicationRevision: 1,
    cardRevision: 1,
    publicPayloadHash: "a".repeat(64),
    publicSummary: "Public summary",
    semanticTargetFingerprint: "b".repeat(64),
    targetRevisionHash: "c".repeat(64),
  },
  returnTargetV2: {
    kind: "card",
    cardId: "00000000-0000-4000-8000-000000000003",
    objectiveId: "00000000-0000-4000-8000-000000000004",
  },
  phase: "preparing",
  runRevision: 1,
  runtimeEpoch: 1,
  activeSecondsUsed: 0,
  timeBudgetSeconds: 180,
  activeTask: null,
  allowedActions: [{ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true }],
  publishedTargetEligibility: "eligible",
});

const MUTATION_TASK_ID = "00000000-0000-4000-8000-000000000201";
const MUTATION_DRAFT_REQUEST = {
  version: 2 as const,
  snapshotId: V2_SNAPSHOT.snapshotId,
  variantId: "variant-1",
  variantRevision: 1,
  taskRevision: 1,
  expectedDraftRevision: null,
  payload: { kind: "text" as const, text: "draft evidence" },
  rendererState: { kind: "text" as const, selectionStart: 13, selectionEnd: 13 },
};
const MUTATION_SUBMIT_REQUEST = {
  version: 2 as const,
  snapshotId: V2_SNAPSHOT.snapshotId,
  variantId: "variant-1",
  variantRevision: 1,
  runRevision: 1,
  taskRevision: 1,
  inputSchemaHash: "input-schema-v1",
  payload: { kind: "text" as const, text: "trusted evidence" },
};
const MUTATION_ACTION_REQUEST = {
  version: 2 as const,
  snapshotId: V2_SNAPSHOT.snapshotId,
  runRevision: 1,
  runtimeEpoch: 1,
  action: { version: 2 as const, kind: "end" as const, abandonLockedEvidence: false, confirmationRequired: true as const },
};
const MUTATION_DRAFT_RECEIPT = learningTaskDraftWriteReceiptV2Schema.parse({
  version: 2,
  runId: V2_SNAPSHOT.runId,
  snapshotId: V2_SNAPSHOT.snapshotId,
  taskId: MUTATION_TASK_ID,
  variantId: MUTATION_DRAFT_REQUEST.variantId,
  runRevision: 1,
  taskRevision: 1,
  draftRevision: 1,
  savedAt: "2026-08-23T00:00:01.000Z",
  expiresAt: "2026-08-23T00:05:01.000Z",
});
const MUTATION_SUBMIT_RECEIPT = submitTaskArtifactReceiptV2Schema.parse({
  version: 2,
  runId: V2_SNAPSHOT.runId,
  snapshotId: V2_SNAPSHOT.snapshotId,
  taskId: MUTATION_TASK_ID,
  artifactId: "00000000-0000-4000-8000-000000000202",
  artifactRevision: 1,
  artifactStatus: "locked",
  assessment: { assessmentId: "00000000-0000-4000-8000-000000000203", status: "queued" },
  runRevision: 1,
  taskRevision: 1,
  eventCursor: 1,
});
const MUTATION_ACTION_RESPONSE = learningRunActionResponseV2Schema.parse({
  version: 2,
  runId: V2_SNAPSHOT.runId,
  snapshotId: V2_SNAPSHOT.snapshotId,
  originV2: V2_SNAPSHOT.originV2,
  acceptedActionId: "action-1",
  actionResult: { kind: "state_changed" },
  snapshot: V2_SNAPSHOT,
});

const ROOM_DASHBOARD = learningDashboardV2Schema.parse({
  version: 2,
  snapshotAt: "2026-08-23T00:00:00.000Z",
  dashboardRevision: "dashboard-rev-1",
  counts: { notes: 0, activeObjectives: 0, activeRuns: 0, reviewsDue: 0, needsRepair: 0 },
  activeRuns: [],
  mode: "first_use",
  primaryFocus: null,
  queue: [],
  recentObjectives: [],
  suggestedNote: null,
  degradation: null,
});

const ROOM_CAPABILITY = capabilityProjectionSchema.parse({
  version: 1,
  revision: "desktop-capability-v1:test",
  workspaceEpoch: 1,
  actionCapabilities: Object.fromEntries(actionCapabilityValues.map((key) => [key, key === "learning_run.start" ? "allowed" : "denied"])),
  featureAvailability: Object.fromEntries(featureNameValues.map((key) => [key, key === "learning_run_v2" ? { state: "enabled" } : { state: "disabled", reason: "error.feature_disabled" }])),
  nativeCapabilities: {
    filePicker: "unavailable",
    clipboard: "unavailable",
    notifications: "unavailable",
    asr: "unavailable",
    updates: "unavailable",
    live2d: "unavailable",
  },
});

const OWNER_ROOM_CAPABILITY = capabilityProjectionSchema.parse({
  ...ROOM_CAPABILITY,
  actionCapabilities: {
    ...ROOM_CAPABILITY.actionCapabilities,
    "card_generation.start": "allowed",
  },
  featureAvailability: {
    ...ROOM_CAPABILITY.featureAvailability,
    card_generation_v2: { state: "enabled" },
  },
});

const ACTIVE_GENERATION_SUMMARIES = cardGenerationActiveSummaryListV1Schema.parse({
  version: 1,
  items: [{
    version: 1,
    runId: "00000000-0000-4000-8000-000000000020",
    noteId: "00000000-0000-4000-8000-000000000010",
    noteVersionId: "00000000-0000-4000-8000-000000000012",
    status: "planning",
    currentPlanVersion: 0,
    reviewDraftRevision: 1,
    updatedAt: "2026-08-23T00:00:01.000Z",
    recovery: null,
    route: { kind: "note.cardGeneration", cardGenerationRunId: "00000000-0000-4000-8000-000000000020" },
  }],
});

const NOTE_DETAIL = noteDetailV1Schema.parse({
  version: 1,
  noteId: "00000000-0000-4000-8000-000000000010",
  workspaceId: "00000000-0000-4000-8000-000000000011",
  title: "真实 Note",
  titleSource: "manual",
  sourceId: null,
  currentVersionId: "00000000-0000-4000-8000-000000000012",
  currentVersion: {
    versionId: "00000000-0000-4000-8000-000000000012",
    noteId: "00000000-0000-4000-8000-000000000010",
    versionNo: 1,
    contentHash: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    blocks: [{ ordinal: 0, type: "paragraph", content: "正文" }],
  },
  // 归属两态是详情的一部分：列表与详情都要说得出"别人看不看得到这篇"。
  shareScope: "private",
  permissions: { canRead: true, canEdit: false, canSave: false, canShare: true },
  revision: "00000000-0000-4000-8000-000000000012",
  snapshotAt: "2026-08-23T00:00:00.000Z",
});

const NOTE_SAVE_RECEIPT = noteSaveReceiptV1Schema.parse({
  version: 1,
  status: "committed",
  noteId: NOTE_DETAIL.noteId,
  workspaceId: NOTE_DETAIL.workspaceId,
  baseVersionId: NOTE_DETAIL.currentVersionId,
  versionId: "00000000-0000-4000-8000-000000000013",
  currentVersionId: "00000000-0000-4000-8000-000000000013",
  versionNo: 2,
  revision: "00000000-0000-4000-8000-000000000013",
  savedAt: "2026-08-23T00:00:03.000Z",
});

const COMPANION_ROOM_PROFILE = companionRoomProfileV1Schema.parse({
  version: 1,
  revision: 3,
  unlockedDecorIds: ["keepsake.first-note", "keepsake.first-review"],
  equippedDecorBySlot: {
    desk: "keepsake.first-note",
    shelf: null,
    window: null,
    rest: "keepsake.first-review",
  },
  unlockedEffectIds: ["effect.page-ribbon"],
  equippedEffectId: "effect.page-ribbon",
  proactiveMuted: false,
  updatedAt: "2026-08-23T00:00:03.000Z",
});

const COMPANION_HOME_PROJECTION = companionHomeProjectionV1Schema.parse({
  version: 1,
  snapshotAt: "2026-08-23T00:00:04.000Z",
  profileSummary: {
    name: "小岚",
    activeness: "moderate",
    boundaries: {
      allowPlayful: true,
      allowNudgeLearning: true,
      allowVoiceTags: false,
      catchphrase: "慢慢来。",
    },
    familiarity: 0.65,
    interactionCount: 12,
    source: "saved_profile",
  },
  memorySummary: {
    confirmedCount: 4,
    candidateCount: 1,
    updatedAt: "2026-08-23T00:00:02.000Z",
  },
  proactiveCue: {
    text: "今天还有一张复习卡。",
    expiresAt: "2026-08-23T00:10:00.000Z",
    revision: 2,
  },
  roomProfile: COMPANION_ROOM_PROFILE,
});

const COMPANION_ROOM_PATCH = companionRoomProfilePatchV1Schema.parse({
  version: 1,
  revision: 3,
  equippedDecorBySlot: {
    rest: null,
    window: "keepsake.first-note",
  },
  equippedEffectId: null,
  proactiveMuted: false,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseCompanionSseFrame（伴星 SSE 帧的过桥门槛）", () => {
  const frame = (payload: Record<string, unknown>, seq = 7): string =>
    `id: 2de8a3e9-f127-4089-80d5-ede6dd980d53:${seq}\nevent: companion\ndata: ${JSON.stringify({
      version: 1,
      eventId: `2de8a3e9-f127-4089-80d5-ede6dd980d53:${seq}`,
      seq,
      workspaceId: "97550966-adf4-47fa-8d91-f83eae9ebfc0",
      conversationId: "2de8a3e9-f127-4089-80d5-ede6dd980d53",
      runId: "f3bb3bf9-e241-4360-8b0f-faee864032c0",
      generation: 1,
      accountEpoch: 0,
      createdAt: "2026-09-19T03:30:10.000Z",
      ...payload,
    })}\n\n`;

  it("合法帧投影成最小形状（seq/runId/generation/事件类型/payload）", () => {
    const parsed = parseCompanionSseFrame(frame({ type: "assistant.delta", payload: { appendFrom: 0, textDelta: "你好" } }));
    expect(parsed).toEqual({
      seq: 7,
      runId: "f3bb3bf9-e241-4360-8b0f-faee864032c0",
      generation: 1,
      eventType: "assistant.delta",
      payload: { appendFrom: 0, textDelta: "你好" },
    });
  });

  it("心跳注释帧与空帧直接丢弃", () => {
    expect(parseCompanionSseFrame(": heartbeat 1789788618000\n\n")).toBeNull();
    expect(parseCompanionSseFrame("")).toBeNull();
  });

  it("畸形 JSON / 缺字段 / payload 不合分支合同一律丢弃（不透传原始帧）", () => {
    expect(parseCompanionSseFrame("data: {not json}\n\n")).toBeNull();
    // 事件类型缺失同样丢弃（没有类型的帧渲染层无从处理）。
    expect(parseCompanionSseFrame(frame({ payload: { textDelta: "x" } }))).toBeNull();
    // 主进程按 shared 分支 schema 严格校验 payload：assistant.delta 缺 appendFrom
    // 不再"放行给渲染层收窄"，而是整个丢弃（方案 §5 过桥门槛）。
    expect(parseCompanionSseFrame(frame({ type: "assistant.delta", payload: { textDelta: "x" } }))).toBeNull();
    expect(parseCompanionSseFrame(frame({ type: "assistant.delta", payload: { appendFrom: 0, textDelta: "x" } }))?.seq).toBe(7);
    expect(parseCompanionSseFrame('data: {"seq":1}\n\n')).toBeNull();
    expect(parseCompanionSseFrame(frame({ type: "assistant.delta", payload: "不是对象" }))).toBeNull();
    expect(parseCompanionSseFrame(frame({ type: "assistant.delta", payload: null }))).toBeNull();
  });

  it("payload 超过 16KB 的异常帧被拦下", () => {
    const huge = { type: "assistant.delta", payload: { appendFrom: 0, textDelta: "甲".repeat(20_000) } };
    expect(parseCompanionSseFrame(frame(huge))).toBeNull();
  });
});

describe("伴星壳层 SSE 帧校验", () => {
  it("只接受严格的账号关闭事件", () => {
    const event = {
      version: 1,
      type: "account.global_off",
      userId: "00000000-0000-4000-8000-000000000011",
      epoch: 4,
    };
    expect(parseCompanionAccountSseFrame(`data: ${JSON.stringify(event)}\n\n`)?.epoch).toBe(4);
    expect(parseCompanionAccountSseFrame(`data: ${JSON.stringify({ ...event, token: "leak" })}\n\n`)).toBeNull();
  });

  it("只接受严格的 durable inbox delivery", () => {
    const delivery = {
      version: 2,
      deliveryId: "00000000-0000-4000-8000-000000000021",
      assistantSessionId: null,
      userId: "00000000-0000-4000-8000-000000000011",
      workspaceId: "00000000-0000-4000-8000-000000000012",
      inboxSequence: 9,
      dedupeKey: "delivery:test:9",
      state: "queued",
      kind: "system_event",
      payloadRef: { kind: "system_event", systemEventId: "companion.updated:9", text: "状态已更新" },
      displayLease: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(parseCompanionInboxSseFrame(`id: 9\nevent: assistant.delivery\ndata: ${JSON.stringify(delivery)}\n\n`)?.inboxSequence).toBe(9);
    expect(parseCompanionInboxSseFrame(`data: ${JSON.stringify({ ...delivery, authToken: "leak" })}\n\n`)).toBeNull();
    expect(parseCompanionInboxSseFrame("data: {broken}\n\n")).toBeNull();
  });
});

describe("DesktopGateway", () => {
  it("starts untrusted with transport epoch zero and rejects missing pairing config", () => {
    const gateway = new DesktopGateway(environment());
    expect(gateway.getTrust()).toMatchObject({ state: "untrusted", transportEpoch: 1 });

    const unconfigured = new DesktopGateway({ DESKTOP_API_ORIGIN: "http://127.0.0.1:4000" });
    expect(unconfigured.getConnectionState()).toEqual({
      version: 1,
      kind: "configuration_error",
      reason: "pairing_secret_missing",
    });
  });

  it("trusts the exact local API challenge before any domain request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/challenge")) {
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return trustResponse(request);
      }
      expect(String(input)).toBe("http://127.0.0.1:4000/health");
      return healthResponse();
    });

    const gateway = new DesktopGateway(environment());
    await expect(gateway.connect()).resolves.toMatchObject({ kind: "ready", instanceId: "instance-1" });
    expect(gateway.getTrust()).toMatchObject({ state: "trusted", instanceId: "instance-1", transportEpoch: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps login 401 to invalid_credentials instead of auth_required", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ error: "invalid credentials" }), { status: 401 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.login("student@example.com", "wrong-password", "request-login")).rejects.toMatchObject({
      code: "invalid_credentials",
    } satisfies Partial<DesktopGatewayFailure>);
  });

  const authDomainCases: [number, string, GatewayErrorCode][] = [
    [409, "email_exists", "email_exists"],
    [400, "email_exists", "email_exists"],
    [409, "already_consumed", "invite_consumed"],
    [409, "concurrent_consumption", "invite_consumed"],
    [404, "not_found", "invite_invalid"],
    [410, "revoked", "invite_invalid"],
    [410, "expired", "invite_expired"],
    [409, "workspace_limit_reached", "workspace_limit"],
    [409, "already_member", "already_member"],
    // 审计 F31：这个 token 以前不在表里，落进通用 conflict，被翻成"这条学习状态
    // 已经发生变化"——说的不是这件事。现在它有自己的码与文案。
    [409, "personal_workspace_not_shareable", "personal_workspace_not_shareable"],
  ];

  it.each(authDomainCases)("maps register %i/%s onto the %s auth code", async (status, token, code) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ error: token }), { status });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.register("student@example.com", "long-enough-password", undefined, undefined, "request-register"))
      .rejects.toMatchObject({ code } satisfies Partial<DesktopGatewayFailure>);
  });

  it("keeps unknown auth error tokens on the status-based mapping", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      // Fastify's own validation envelope: no machine-readable domain token.
      return new Response(JSON.stringify({ error: "Bad Request", message: "password: too small" }), { status: 400 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.register("student@example.com", "short", undefined, undefined, "request-register"))
      .rejects.toMatchObject({ code: "validation" } satisfies Partial<DesktopGatewayFailure>);
  });

  describe("session credential persistence", () => {
    const SESSION_USER_ID = "00000000-0000-4000-8000-000000000011";
    const SESSION_WORKSPACE_ID = "00000000-0000-4000-8000-000000000012";

    const authEnvelope = (token: string) => ({
      token,
      ctx: { userId: SESSION_USER_ID, workspaceId: SESSION_WORKSPACE_ID, membershipRole: "owner" },
      workspaces: [{
        workspaceId: SESSION_WORKSPACE_ID,
        workspaceName: "书房",
        role: "owner",
        workspaceType: "personal",
        isPersonal: true,
        leftAt: null,
      }],
    });

    const meEnvelope = {
      userId: SESSION_USER_ID,
      workspaceId: SESSION_WORKSPACE_ID,
      email: "student@example.com",
      role: "owner",
      displayName: null,
      avatarUrl: null,
      workspaceName: "书房",
      workspaceType: "personal",
      isPersonal: true,
      personalWorkspaceId: SESSION_WORKSPACE_ID,
      // 0261：服务端边界令牌（本机 epoch 的权威值）。
      workspaceEpoch: 1,
    };

    function fakeStore(initial: string | null = null, available = true) {
      const state = { token: initial, saves: [] as string[], clears: 0 };
      return {
        state,
        store: {
          available,
          hasStored: () => state.token !== null,
          load: async () => state.token,
          save: async (token: string) => { state.token = token; state.saves.push(token) },
          clear: async () => { state.token = null; state.clears += 1 },
        },
      };
    }

    function routeAuth(record: { loginBody?: string }) {
      return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (url.endsWith("/auth/login")) {
          record.loginBody = String(init?.body);
          return new Response(JSON.stringify(authEnvelope("issued-token")), { status: 200 });
        }
        if (url.endsWith("/auth/me")) return new Response(JSON.stringify(meEnvelope), { status: 200 });
        if (url.endsWith("/auth/logout")) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
    }

    it("reports memory persistence and no stored session when the platform cannot encrypt", async () => {
      const { store } = fakeStore(null, false);
      const gateway = new DesktopGateway(environment(), { credentials: store });
      expect(gateway.getRuntimeSnapshot(
        { version: 1, revision: 1, state: "visible" },
        false,
      ).sessionCredential).toEqual({ persistence: "memory", stored: false });
    });

    it("adopts a stored credential before the first authenticated call", async () => {
      const { store } = fakeStore("stored-token");
      const seen: (string | null)[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (url.endsWith("/auth/me")) {
          seen.push(new Headers(init?.headers).get("Authorization"));
          return new Response(JSON.stringify(meEnvelope), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const gateway = new DesktopGateway(environment(), { credentials: store });
      await expect(gateway.getSession()).resolves.toMatchObject({
        status: "authenticated",
        credentialPersistence: "safe_storage",
      });
      expect(seen).toEqual(["Bearer stored-token"]);
    });

    it("persists the issued token only when the user keeps the choice", async () => {
      const record: { loginBody?: string } = {};
      vi.spyOn(globalThis, "fetch").mockImplementation(routeAuth(record));

      const keep = fakeStore();
      const kept = new DesktopGateway(environment(), { credentials: keep.store });
      await kept.login("student@example.com", "long-enough-password", "request-a", true);
      expect(JSON.parse(record.loginBody!)).toMatchObject({ remember: true });
      expect(keep.state.saves).toEqual(["issued-token"]);

      const sessionOnly = fakeStore("stale-token");
      const discarded = new DesktopGateway(environment(), { credentials: sessionOnly.store });
      await discarded.login("student@example.com", "long-enough-password", "request-b", false);
      expect(JSON.parse(record.loginBody!)).toMatchObject({ remember: false });
      expect(sessionOnly.state.saves).toEqual([]);
      expect(sessionOnly.state.clears).toBeGreaterThan(0);
    });

    it("degrades to memory and clears the file when the write fails", async () => {
      const state = { clears: 0 };
      const gateway = new DesktopGateway(environment(), {
        credentials: {
          available: true,
          hasStored: () => false,
          load: async () => null,
          save: async () => { throw new Error("disk full") },
          clear: async () => { state.clears += 1 },
        },
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(routeAuth({}));

      await expect(gateway.login("student@example.com", "long-enough-password", "request-c", true)).resolves.toMatchObject({
        credentialPersistence: "memory",
      });
      expect(state.clears).toBeGreaterThan(0);
    });

    it("retires a dead stored credential and asks for a fresh sign-in", async () => {
      const { store, state } = fakeStore("expired-token");
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      });

      const gateway = new DesktopGateway(environment(), { credentials: store });
      // `auth_required`, not `reauth_required`: there is no account to re-confirm,
      // so the renderer must fall back to the sign-in form.
      await expect(gateway.getSession()).rejects.toMatchObject({ code: "auth_required" } satisfies Partial<DesktopGatewayFailure>);
      expect(state.token).toBeNull();
      expect(state.clears).toBe(1);
    });

    it("signs out locally, and offline, once the stored credential is in hand", async () => {
      const { store, state } = fakeStore("stored-token");
      let serverReachable = true;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (!serverReachable) throw new TypeError("network down");
        if (url.endsWith("/auth/me")) return new Response(JSON.stringify(meEnvelope), { status: 200 });
        return new Response(null, { status: 204 });
      });

      const gateway = new DesktopGateway(environment(), { credentials: store });
      await gateway.getSession();
      serverReachable = false;
      await expect(gateway.logout("request-d")).rejects.toBeInstanceOf(DesktopGatewayFailure);
      expect(state.token).toBeNull();
      expect(state.clears).toBeGreaterThan(0);
    });

    it("still drops a stored credential that a sign-out never adopted", async () => {
      const { store, state } = fakeStore("stored-token");
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(null, { status: 204 });
      });

      const gateway = new DesktopGateway(environment(), { credentials: store });
      await expect(gateway.logout("request-e")).resolves.toEqual({ loggedOut: true, serverRevoked: false });
      expect(state.token).toBeNull();
      expect(state.clears).toBe(1);
    });
  });

  it("redeems an invite through /auth/join-workspace and reloads the session", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/auth/join-workspace")) {
        requested.push(String(init?.body));
        return new Response(JSON.stringify({ workspaceId: "00000000-0000-4000-8000-000000000099", workspaceName: "Studio", role: "member" }), { status: 200 });
      }
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({
          userId: "00000000-0000-4000-8000-000000000011",
          workspaceId: "00000000-0000-4000-8000-000000000099",
          email: "student@example.com",
          role: "member",
          displayName: null,
          avatarUrl: null,
          workspaceName: "Studio",
          workspaceType: "collaborative",
          isPersonal: false,
          personalWorkspaceId: null,
          workspaceEpoch: 1,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.joinWorkspace("invite-token-1", "request-join")).resolves.toMatchObject({
      status: "authenticated",
      workspace: { workspaceId: "00000000-0000-4000-8000-000000000099" },
    });
    expect(requested).toEqual([JSON.stringify({ inviteToken: "invite-token-1" })]);
  });

  it("uses only strict V2 paths and keeps main-owned idempotency stable per command", async () => {
    const requestedIdempotencyKeys: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.includes("/reviews/v2/queue")) {
        return new Response(JSON.stringify({ version: 2, items: [], total: 0, nextCursor: null }), { status: 200 });
      }
      if (url.endsWith("/learning-runs")) {
        const body = JSON.parse(String(init?.body)) as { idempotencyKey: string };
        requestedIdempotencyKeys.push(body.idempotencyKey);
        return new Response(JSON.stringify(V2_SNAPSHOT), { status: 201 });
      }
      if (url.endsWith("/learning-runs/00000000-0000-4000-8000-000000000001/v2")) {
        return new Response(JSON.stringify(V2_SNAPSHOT), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.getReviewQueue()).resolves.toEqual({ version: 2, items: [], total: 0, nextCursor: null });
    await expect(gateway.getLearningRun(V2_SNAPSHOT.runId)).resolves.toEqual(V2_SNAPSHOT);
    const request = {
      version: 2 as const,
      originV2: V2_SNAPSHOT.originV2,
      goal: "clarify" as const,
    };
    await gateway.startLearningRun(request, "command-1");
    await gateway.startLearningRun(request, "command-1");
    expect(requestedIdempotencyKeys).toHaveLength(2);
    expect(requestedIdempotencyKeys[0]).toBe(requestedIdempotencyKeys[1]);
  });

  it("maps LearningRun mutation response loss to resync_first without an internal replay", async () => {
    const mutationAttempts = new Map<string, number>();
    const mutationKeys = new Map<string, string[]>();
    const mutationResponse = (kind: string, init: RequestInit, body: unknown): Response => {
      const attempt = (mutationAttempts.get(kind) ?? 0) + 1;
      mutationAttempts.set(kind, attempt);
      const requestBody = JSON.parse(String(init.body)) as { idempotencyKey: string };
      mutationKeys.set(kind, [...(mutationKeys.get(kind) ?? []), requestBody.idempotencyKey]);
      if (attempt === 1) throw new TypeError(`${kind} connection closed after write`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith(`/learning-runs/${V2_SNAPSHOT.runId}/tasks/${MUTATION_TASK_ID}/draft/v2`)) {
        return mutationResponse("draft", init ?? {}, MUTATION_DRAFT_RECEIPT);
      }
      if (url.endsWith(`/learning-runs/${V2_SNAPSHOT.runId}/tasks/${MUTATION_TASK_ID}/submissions/v2`)) {
        return mutationResponse("submit", init ?? {}, MUTATION_SUBMIT_RECEIPT);
      }
      if (url.endsWith(`/learning-runs/${V2_SNAPSHOT.runId}/actions/v2`)) {
        return mutationResponse("action", init ?? {}, MUTATION_ACTION_RESPONSE);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();

    await expect(gateway.saveLearningRunDraft(V2_SNAPSHOT.runId, MUTATION_TASK_ID, MUTATION_DRAFT_REQUEST, "command-draft"))
      .rejects.toMatchObject({ code: "result_unknown", retry: "resync_first" });
    await expect(gateway.saveLearningRunDraft(V2_SNAPSHOT.runId, MUTATION_TASK_ID, MUTATION_DRAFT_REQUEST, "command-draft"))
      .resolves.toEqual(MUTATION_DRAFT_RECEIPT);

    await expect(gateway.submitLearningRunArtifact(V2_SNAPSHOT.runId, MUTATION_TASK_ID, MUTATION_SUBMIT_REQUEST, "command-submit"))
      .rejects.toMatchObject({ code: "result_unknown", retry: "resync_first" });
    await expect(gateway.submitLearningRunArtifact(V2_SNAPSHOT.runId, MUTATION_TASK_ID, MUTATION_SUBMIT_REQUEST, "command-submit"))
      .resolves.toEqual(MUTATION_SUBMIT_RECEIPT);

    await expect(gateway.applyLearningRunAction(V2_SNAPSHOT.runId, MUTATION_ACTION_REQUEST, "command-action"))
      .rejects.toMatchObject({ code: "result_unknown", retry: "resync_first" });
    await expect(gateway.applyLearningRunAction(V2_SNAPSHOT.runId, MUTATION_ACTION_REQUEST, "command-action"))
      .resolves.toEqual(MUTATION_ACTION_RESPONSE);

    expect(mutationAttempts).toEqual(new Map([["draft", 2], ["submit", 2], ["action", 2]]));
    for (const keys of mutationKeys.values()) {
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    }
  });

  it("rejects a V1 learning run response at the gateway boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ version: 1, runId: V2_SNAPSHOT.runId }), { status: 200 });
    });
    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.getLearningRun(V2_SNAPSHOT.runId)).rejects.toMatchObject({ code: "unsupported_contract" });
  });

  it("keeps activity lease telemetry main-owned and treats only HTTP 204 as recorded", async () => {
    let leaseBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith(`/learning-runs/${V2_SNAPSHOT.runId}/activity-lease/v2`)) {
        leaseBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.recordLearningRunActivityLease(V2_SNAPSHOT.runId, {
      version: 2,
      snapshotId: V2_SNAPSHOT.snapshotId,
      runRevision: 1,
      runtimeEpoch: 1,
      startedAt: "2026-08-23T00:00:00.000Z",
      endedAt: "2026-08-23T00:00:01.000Z",
    }, "lease-request")).resolves.toEqual({ recorded: true });
    expect(leaseBody).toMatchObject({
      version: 2,
      snapshotId: V2_SNAPSHOT.snapshotId,
      deviceSessionId: expect.any(String),
    });
    expect(leaseBody).not.toHaveProperty("idempotencyKey");
  });

  it("maps only draft_not_found to a nullable draft and preserves other 404s", async () => {
    const taskId = "00000000-0000-4000-8000-000000000201";
    const missingRunId = "00000000-0000-4000-8000-000000000202";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith(`/learning-runs/${V2_SNAPSHOT.runId}/tasks/${taskId}/draft/v2`)) {
        return new Response(JSON.stringify({ error: "draft_not_found", message: "没有已保存的草稿" }), { status: 404 });
      }
      if (url.endsWith(`/learning-runs/${missingRunId}/tasks/${taskId}/draft/v2`)) {
        return new Response(JSON.stringify({ error: "not_found", message: "运行不存在" }), { status: 404 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.getLearningRunDraft(V2_SNAPSHOT.runId, taskId)).resolves.toBeNull();
    await expect(gateway.getLearningRunDraft(missingRunId, taskId)).rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
  });

  it("rejects valid-looking V2 responses whose route, origin, task, or snapshot binding drifts", async () => {
    const otherRunId = "00000000-0000-4000-8000-000000000101";
    const otherSnapshotId = "00000000-0000-4000-8000-000000000102";
    const otherTaskId = "00000000-0000-4000-8000-000000000103";
    const expectedTaskId = "00000000-0000-4000-8000-000000000105";
    const wrongOriginSnapshot = {
      ...V2_SNAPSHOT,
      originV2: {
        kind: "card" as const,
        cardId: "00000000-0000-4000-8000-000000000104",
        objectiveId: V2_SNAPSHOT.originV2.objectiveId,
      },
    };
    const wrongActionSnapshot = { ...V2_SNAPSHOT, snapshotId: otherSnapshotId };
    const draftRequest = {
      version: 2 as const,
      snapshotId: V2_SNAPSHOT.snapshotId,
      variantId: "variant-1",
      variantRevision: 1,
      taskRevision: 1,
      expectedDraftRevision: null,
      payload: null,
      rendererState: { kind: "text" as const, selectionStart: 0, selectionEnd: 0 },
    };
    const actionRequest = {
      version: 2 as const,
      snapshotId: V2_SNAPSHOT.snapshotId,
      runRevision: 1,
      runtimeEpoch: 1,
      action: { version: 2 as const, kind: "end" as const, abandonLockedEvidence: false, confirmationRequired: true as const },
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/learning-runs")) {
        return new Response(JSON.stringify(wrongOriginSnapshot), { status: 201 });
      }
      if (url.endsWith(`/learning-runs/${V2_SNAPSHOT.runId}/v2`)) {
        return new Response(JSON.stringify({ ...V2_SNAPSHOT, runId: otherRunId, snapshotId: otherSnapshotId }), { status: 200 });
      }
      if (url.endsWith(`/learning-runs/${V2_SNAPSHOT.runId}/result/v2`)) {
        return new Response(JSON.stringify({
          version: 2,
          runId: otherRunId,
          snapshotId: otherSnapshotId,
          originV2: V2_SNAPSHOT.originV2,
          returnTargetV2: V2_SNAPSHOT.returnTargetV2,
          status: "pending",
          httpStatus: 202,
          phase: "assessing",
          runRevision: 1,
        }), { status: 202 });
      }
      if (url.includes(`/learning-runs/${V2_SNAPSHOT.runId}/tasks/`) && url.endsWith("/draft/v2")) {
        return new Response(JSON.stringify({
          version: 2,
          runId: V2_SNAPSHOT.runId,
          snapshotId: V2_SNAPSHOT.snapshotId,
          taskId: otherTaskId,
          variantId: draftRequest.variantId,
          runRevision: 1,
          taskRevision: 1,
          draftRevision: 1,
          savedAt: "2026-08-23T00:00:01.000Z",
          expiresAt: "2026-08-23T00:05:01.000Z",
        }), { status: 200 });
      }
      if (url.endsWith(`/learning-runs/${V2_SNAPSHOT.runId}/actions/v2`)) {
        return new Response(JSON.stringify({
          version: 2,
          runId: V2_SNAPSHOT.runId,
          snapshotId: otherSnapshotId,
          originV2: V2_SNAPSHOT.originV2,
          acceptedActionId: "action-1",
          actionResult: { kind: "state_changed" },
          snapshot: wrongActionSnapshot,
        }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.startLearningRun({ version: 2, originV2: V2_SNAPSHOT.originV2, goal: "clarify" }, "command-start"))
      .rejects.toMatchObject({ code: "unsupported_contract" });
    await expect(gateway.getLearningRun(V2_SNAPSHOT.runId)).rejects.toMatchObject({ code: "unsupported_contract" });
    await expect(gateway.getLearningRunResult(V2_SNAPSHOT.runId)).rejects.toMatchObject({ code: "unsupported_contract" });
    await expect(gateway.saveLearningRunDraft(V2_SNAPSHOT.runId, expectedTaskId, draftRequest, "command-draft"))
      .rejects.toMatchObject({ code: "unsupported_contract" });
    await expect(gateway.applyLearningRunAction(V2_SNAPSHOT.runId, actionRequest, "command-action"))
      .rejects.toMatchObject({ code: "unsupported_contract" });
  });

  it("projects the real dashboard and reuses a matching ETag without crossing workspace epochs", async () => {
    let dashboardRequests = 0;
    let secondRequestIfNoneMatch: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/auth/capabilities/v1")) {
        return new Response(JSON.stringify(ROOM_CAPABILITY), { status: 200 });
      }
      if (url.endsWith("/v2/learning-dashboard")) {
        dashboardRequests += 1;
        if (dashboardRequests === 2) {
          secondRequestIfNoneMatch = new Headers(init?.headers).get("If-None-Match");
          return new Response(null, { status: 304, headers: { ETag: '"dashboard-rev-1"' } });
        }
        return new Response(JSON.stringify(ROOM_DASHBOARD), {
          status: 200,
          headers: { ETag: '"dashboard-rev-1"' },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const first = await gateway.getRoomProjection();
    const second = await gateway.getRoomProjection();
    expect(first).toEqual(second);
    expect(first.dashboardRevision).toBe("dashboard-rev-1");
    expect(first.recentActivitySummary).toMatchObject({ state: "error" });
    expect("librarySummary" in first).toBe(false);
    expect("suggestedNoteSummary" in first).toBe(false);
    expect(first.captureCapability).toMatchObject({ state: "disabled", reason: "capability_denied" });
    expect(secondRequestIfNoneMatch).toBe('"dashboard-rev-1"');
  });

  it("keeps confirmed dashboard content when the capability projection is degraded", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/auth/capabilities/v1")) return new Response(null, { status: 503 });
      if (url.endsWith("/v2/learning-dashboard")) {
        return new Response(JSON.stringify(ROOM_DASHBOARD), { status: 200, headers: { ETag: '"dashboard-rev-1"' } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const projection = await gateway.getRoomProjection();
    expect(projection.dashboardRevision).toBe("dashboard-rev-1");
    expect(projection.captureCapability).toEqual({ state: "unavailable", reason: "projection_unavailable" });
    expect(projection.primaryFocus).toEqual({ state: "empty" });
  });

  it("reprojects cached dashboard content when capabilities recover behind a 304", async () => {
    let capabilityRequests = 0;
    let dashboardRequests = 0;
    const recoveredCapability = capabilityProjectionSchema.parse({
      ...ROOM_CAPABILITY,
      actionCapabilities: { ...ROOM_CAPABILITY.actionCapabilities, "source.create": "allowed" },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/auth/capabilities/v1")) {
        capabilityRequests += 1;
        return capabilityRequests === 1
          ? new Response(null, { status: 503 })
          : new Response(JSON.stringify(recoveredCapability), { status: 200 });
      }
      if (url.endsWith("/v2/learning-dashboard")) {
        dashboardRequests += 1;
        return dashboardRequests === 1
          ? new Response(JSON.stringify(ROOM_DASHBOARD), { status: 200, headers: { ETag: '"dashboard-rev-1"' } })
          : new Response(null, { status: 304, headers: { ETag: '"dashboard-rev-1"' } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const degraded = await gateway.getRoomProjection();
    const recovered = await gateway.getRoomProjection();
    expect(degraded.captureCapability).toEqual({ state: "unavailable", reason: "projection_unavailable" });
    expect(recovered.captureCapability).toEqual({ state: "enabled" });
    expect(recovered.dashboardRevision).toBe(degraded.dashboardRevision);
  });

  it("queries the Owner-only active generation summary and keeps it on dashboard 304", async () => {
    let activeRequests = 0;
    let activeAuthorization: string | null = null;
    let dashboardRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/auth/capabilities/v1")) {
        return new Response(JSON.stringify(OWNER_ROOM_CAPABILITY), { status: 200 });
      }
      if (url.endsWith("/v2/card-generation-runs/active")) {
        activeRequests += 1;
        activeAuthorization = new Headers(init?.headers).get("Authorization");
        return new Response(JSON.stringify(ACTIVE_GENERATION_SUMMARIES), { status: 200 });
      }
      if (url.endsWith("/v2/learning-dashboard")) {
        dashboardRequests += 1;
        if (dashboardRequests === 2) return new Response(null, { status: 304, headers: { ETag: '"dashboard-rev-1"' } });
        return new Response(JSON.stringify(ROOM_DASHBOARD), { status: 200, headers: { ETag: '"dashboard-rev-1"' } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    Object.defineProperty(gateway, "token", { value: "test-owner-token", writable: true });
    const first = await gateway.getRoomProjection();
    const second = await gateway.getRoomProjection();
    expect(activeRequests).toBe(2);
    expect(activeAuthorization).toBe("Bearer test-owner-token");
    expect(first.activeGenerationSummary).toEqual({ state: "data", data: ACTIVE_GENERATION_SUMMARIES.items });
    expect(second.activeGenerationSummary).toEqual(first.activeGenerationSummary);
  });

  it("bridges companion home reads and room-profile CAS updates through strict API contracts", async () => {
    const companionRequests: Array<{
      readonly path: string;
      readonly method: string;
      readonly body: unknown;
    }> = [];
    let homeProjectionBody: unknown = COMPANION_HOME_PROJECTION;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/companion/home-projection") {
        companionRequests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify(homeProjectionBody), { status: 200 });
      }
      if (url.pathname === "/companion/room-profile") {
        companionRequests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify(COMPANION_ROOM_PROFILE), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();

    await expect(gateway.getCompanionHomeProjection("request-companion-home"))
      .resolves.toEqual(COMPANION_HOME_PROJECTION);
    await expect(gateway.getCompanionRoomProfile("request-companion-room"))
      .resolves.toEqual(COMPANION_ROOM_PROFILE);
    await expect(gateway.patchCompanionRoomProfile(COMPANION_ROOM_PATCH, "request-companion-patch"))
      .resolves.toEqual(COMPANION_ROOM_PROFILE);

    expect(companionRequests).toEqual([
      { path: "/companion/home-projection", method: "GET", body: null },
      { path: "/companion/room-profile", method: "GET", body: null },
      { path: "/companion/room-profile", method: "PATCH", body: COMPANION_ROOM_PATCH },
    ]);

    homeProjectionBody = { ...COMPANION_HOME_PROJECTION, memoryText: "must stay server-side" };
    await expect(gateway.getCompanionHomeProjection("request-companion-invalid"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });
  });

  it("routes companion onboarding through the strict account CAS transition", async () => {
    const sent: unknown[] = [];
    const state = {
      onboardingVersion: "home-v2-v1",
      revision: 1,
      offerStatus: "offered",
      activeRun: {
        runId: "run-home-v2-1",
        entryMode: "first_run",
        runStatus: "in_progress",
        stepId: "welcome",
        resumeTokenRef: "resume-home-v2-1",
        resumeWorkspaceRef: "00000000-0000-4000-8000-000000000099",
        expiresAt: "2026-09-19T01:00:00.000Z",
      },
      updatedAt: "2026-09-19T00:00:00.000Z",
    } as const;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/me/companion/onboarding/home-v2-v1/transition") {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ won: true, state }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.transitionCompanionOnboarding("home-v2-v1", { action: "start" }))
      .resolves.toEqual({ won: true, state });
    expect(sent).toEqual([{ action: "start" }]);
  });

  it("loads the companion activity timeline newest-first without reusing the inbox after cursor", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/companion/deliveries/timeline") {
        requested.push(url.search);
        return new Response(JSON.stringify({ items: [], nextCursor: 0, serverTime: "2026-09-19T00:00:00.000Z" }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.listCompanionActivityTimeline()).resolves.toMatchObject({ version: 1, items: [], nextCursor: 0 });
    await expect(gateway.listCompanionActivityTimeline(42)).resolves.toMatchObject({ version: 1, items: [], nextCursor: 0 });
    expect(requested).toEqual(["?limit=50", "?limit=50&before=42"]);
  });

  it("reads the strict, side-effect-free companion learning context", async () => {
    const requested: string[] = [];
    const context = {
      version: 1,
      contextRevision: "a".repeat(64),
      learningRunResumeCandidate: null,
      learningRunStartCandidate: null,
    } as const;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/companion/learning-context") {
        requested.push(init?.method ?? "GET");
        return new Response(JSON.stringify(context), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.getCompanionLearningContext()).resolves.toEqual(context);
    expect(requested).toEqual(["GET"]);
  });

  it("speaks companion cues through POST /voice/tts with raw audio-only wire rules", async () => {
    const ttsRequests: Array<{
      readonly path: string;
      readonly method: string;
      readonly accept: string | null;
      readonly contentType: string | null;
      readonly authorization: string | null;
      readonly body: unknown;
    }> = [];
    const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/voice/tts") {
        const headers = new Headers(init?.headers);
        ttsRequests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          accept: headers.get("Accept"),
          contentType: headers.get("Content-Type"),
          authorization: headers.get("Authorization"),
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return new Response(audioBytes, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    Object.defineProperty(gateway, "token", { value: "test-voice-token", writable: true });

    const request = { version: 1 as const, text: "今天还有一张复习卡。" };
    const spoken = await gateway.speakCompanionVoice(request, "request-companion-voice");
    expect(spoken).toEqual({
      version: 1,
      mimeType: "audio/mpeg",
      audioBase64: "SUQzBA==",
      byteLength: audioBytes.byteLength,
      voice: COMPANION_VOICE_SPEAK_VOICE,
    });
    // 返回值必须是冻结合同的 strict parse 结果，可直接回传 renderer。
    expect(companionVoiceSpeakResultV1Schema.parse(spoken)).toEqual(spoken);

    expect(ttsRequests).toEqual([{
      path: "/voice/tts",
      method: "POST",
      accept: "audio/mpeg",
      contentType: "application/json",
      authorization: "Bearer test-voice-token",
      body: { text: request.text, voice: "zh-CN-XiaoxiaoNeural" },
    }]);
  });

  it("fails closed on non-audio, oversized and failed companion voice responses", async () => {
    const ttsRequests: string[] = [];
    let ttsResponse = (): Response => new Response(JSON.stringify({ error: "TTS_FAILED", recoverable: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/voice/tts") {
        ttsRequests.push(url.pathname);
        return ttsResponse();
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const request = { version: 1 as const, text: "慢慢来。" };

    // 200 JSON（非音频）响应绝不能被当作音频接受。
    await expect(gateway.speakCompanionVoice(request, "request-voice-json"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 超限 body：即使没有 content-length 也必须按字节硬截断。
    ttsResponse = () => new Response(new Uint8Array(COMPANION_VOICE_MAX_AUDIO_BYTES + 1), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
    await expect(gateway.speakCompanionVoice(request, "request-voice-oversized"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 声明了超限 content-length 的音频响应同样在读取前被拒绝。
    ttsResponse = () => new Response(new Uint8Array([0x49, 0x44, 0x33]), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(COMPANION_VOICE_MAX_AUDIO_BYTES + 1),
      },
    });
    await expect(gateway.speakCompanionVoice(request, "request-voice-declared-oversized"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 服务端 502 是可恢复失败，不是 crash，也不把 JSON error body 透给 renderer。
    ttsResponse = () => new Response(JSON.stringify({ error: "TTS_FAILED", recoverable: true }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
    await expect(gateway.speakCompanionVoice(request, "request-voice-502"))
      .rejects.toMatchObject({ code: "safe_internal_error", retry: "user_action", httpStatus: 502 });

    expect(ttsRequests).toEqual([
      "/voice/tts",
      "/voice/tts",
      "/voice/tts",
      "/voice/tts",
    ]);
  });

  const sourceImageObjectKey =
    "11111111-1111-4111-8111-111111111111/sources/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.png";

  it("reads an in-app source image over GET /uploads with the session token", async () => {
    const imageRequests: Array<{
      readonly path: string;
      readonly method: string;
      readonly accept: string | null;
      readonly authorization: string | null;
    }> = [];
    // 真 PNG 头：这条通道只搬运字节，不做任何解码。
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === `/uploads/${sourceImageObjectKey}`) {
        const headers = new Headers(init?.headers);
        imageRequests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          accept: headers.get("Accept"),
          authorization: headers.get("Authorization"),
        });
        return new Response(imageBytes, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    Object.defineProperty(gateway, "token", { value: "test-image-token", writable: true });

    const image = await gateway.getSourceImage(
      { version: 1, objectKey: sourceImageObjectKey },
      "request-source-image",
    );
    expect(image).toEqual({
      version: 1,
      mimeType: "image/png",
      imageBase64: "iVBORw0KGgo=",
      byteLength: imageBytes.byteLength,
    });
    // 返回值必须是冻结合同的 strict parse 结果，可直接回传 renderer。
    expect(sourceImageGetResultV1Schema.parse(image)).toEqual(image);

    expect(imageRequests).toEqual([{
      path: `/uploads/${sourceImageObjectKey}`,
      method: "GET",
      accept: "image/*",
      authorization: "Bearer test-image-token",
    }]);
  });

  it("fails closed on non-image, unsupported, oversized and missing source images", async () => {
    let imageResponse = (): Response => new Response(JSON.stringify({ error: "not_found" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname.startsWith("/uploads/")) return imageResponse();
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    Object.defineProperty(gateway, "token", { value: "test-image-token", writable: true });
    const request = { version: 1 as const, objectKey: sourceImageObjectKey };

    // 200 JSON（非图片）响应绝不能被当作图片接受。
    await expect(gateway.getSourceImage(request, "request-image-json"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // image/* 里不被合同承认的子类型（这里 svg 可携带脚本）同样 fail closed。
    imageResponse = () => new Response(new Uint8Array([0x3c, 0x73, 0x76, 0x67]), {
      status: 200,
      headers: { "Content-Type": "image/svg+xml" },
    });
    await expect(gateway.getSourceImage(request, "request-image-svg"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 超限 body：即使没有 content-length 也必须按字节硬截断。
    imageResponse = () => new Response(new Uint8Array(SOURCE_IMAGE_MAX_BYTES + 1), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
    await expect(gateway.getSourceImage(request, "request-image-oversized"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 声明了超限 content-length 的图片同样在读取前被拒绝。
    imageResponse = () => new Response(new Uint8Array([0x89, 0x50]), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(SOURCE_IMAGE_MAX_BYTES + 1),
      },
    });
    await expect(gateway.getSourceImage(request, "request-image-declared-oversized"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 未登记的键、别的租户的键、已删除的对象都由服务端 404 收口，这里如实透传。
    imageResponse = () => new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    await expect(gateway.getSourceImage(request, "request-image-missing"))
      .rejects.toMatchObject({ code: "not_found", retry: "never", httpStatus: 404 });
  });

  it("reads only the strict V2 Note projection and rejects a legacy response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith(`/v2/notes/${NOTE_DETAIL.noteId}`)) {
        return new Response(JSON.stringify(NOTE_DETAIL), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.getNote(NOTE_DETAIL.noteId)).resolves.toEqual(NOTE_DETAIL);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ note: NOTE_DETAIL }), { status: 200 });
    });
    const legacyGateway = new DesktopGateway(environment());
    await legacyGateway.connect();
    await expect(legacyGateway.getNote(NOTE_DETAIL.noteId)).rejects.toMatchObject({ code: "unsupported_contract" });
  });

  it("maps Note PATCH response loss to result_unknown and never retries the write", async () => {
    let patchCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith(`/v2/notes/${NOTE_DETAIL.noteId}`)) {
        patchCalls += 1;
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          version: 1,
          title: "已保存标题",
          baseVersionId: NOTE_DETAIL.currentVersionId,
        });
        if (patchCalls === 1) throw new TypeError("socket closed after commit");
        return new Response(JSON.stringify(NOTE_SAVE_RECEIPT), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const request = {
      version: 1 as const,
      title: "已保存标题",
      baseVersionId: NOTE_DETAIL.currentVersionId,
    };
    await expect(gateway.saveNote(NOTE_DETAIL.noteId, request, "command-note-save")).rejects.toMatchObject({
      code: "result_unknown",
      retry: "resync_first",
    });
    await expect(gateway.saveNote(NOTE_DETAIL.noteId, request, "command-note-save")).resolves.toEqual(NOTE_SAVE_RECEIPT);
    expect(patchCalls).toBe(2);
  });

  it("consumes only SSE sequence ids and never exposes the event payload", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/learning-runs/00000000-0000-4000-8000-000000000001/v2")) {
        return new Response(JSON.stringify(V2_SNAPSHOT), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/learning-runs/00000000-0000-4000-8000-000000000001/events?snapshotId=00000000-0000-4000-8000-000000000002")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("id: 4\nevent: learning_assessment.queued\ndata: {\"answer\":\"must-not-cross-ipc\"}\n\n"));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    let stop: (() => void) | undefined;
    let resolveReceived!: (sequence: number) => void;
    const received = new Promise<number>((resolve) => { resolveReceived = resolve; });
    stop = await gateway.watchLearningRunEvents(V2_SNAPSHOT.runId, (sequence) => {
      resolveReceived(sequence);
      stop?.();
    });
    await expect(received).resolves.toBe(4);
    stop?.();
  });

  it("watches Card Generation SSE through the main-only stream endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/v2/card-generation-runs/00000000-0000-4000-8000-000000000001/events/stream")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("id: 9\nevent: generation.progress\ndata: {\"candidate\":\"must-not-cross-ipc\"}\n\n"));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    let stop: (() => void) | undefined;
    let resolveReceived!: (sequence: number) => void;
    const received = new Promise<number>((resolve) => { resolveReceived = resolve; });
    stop = await gateway.watchCardGenerationEvents(V2_SNAPSHOT.runId, (sequence) => {
      resolveReceived(sequence);
      stop?.();
    });
    await expect(received).resolves.toBe(9);
    stop?.();
  });

  describe("source capture", () => {
    const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000a1";
    const USER_ID = "00000000-0000-4000-8000-0000000000a2";
    const SOURCE_ID = "00000000-0000-4000-8000-0000000000a3";
    const CAPTURED_AT = "2026-09-16T08:00:00.000Z";

    const capturedDetail = (overrides: Record<string, unknown> = {}) => ({
      source: {
        id: SOURCE_ID,
        workspaceId: WORKSPACE_ID,
        type: "markdown",
        title: "间隔效应",
        origin: null,
        status: "draft",
        createdBy: USER_ID,
        createdAt: CAPTURED_AT,
        updatedAt: CAPTURED_AT,
        noteCount: 0,
        metadata: {},
        ...overrides,
      },
      segments: [],
      // 服务端的真实回执从 F33 起带这个字段：null = 这次真的新建了一份；
      // 非空时返回的是既有那份的详情（界面据此提示"已经采过"）。
      duplicateOf: null,
    });

    function routeCapture(record: { body?: string; method?: string }) {
      return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (url.endsWith("/sources")) {
          record.body = String(init?.body);
          record.method = init?.method;
          return new Response(JSON.stringify(capturedDetail()), { status: 200 });
        }
        throw new Error(`unexpected URL ${url}`);
      };
    }

    it("posts the capture payload and returns the parsed detail", async () => {
      const record: { body?: string; method?: string } = {};
      vi.spyOn(globalThis, "fetch").mockImplementation(routeCapture(record));

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      const detail = await gateway.createSource({ content: "# 间隔效应\n\n正文", title: "间隔效应" });

      expect(record.method).toBe("POST");
      expect(JSON.parse(String(record.body))).toEqual({ content: "# 间隔效应\n\n正文", title: "间隔效应" });
      expect(detail.source.id).toBe(SOURCE_ID);
      expect(detail.source.status).toBe("draft");
      expect(detail.segments).toEqual([]);
    });

    it("rejects a response that is not a source detail", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      await expect(gateway.createSource({ url: "https://example.com/article" }))
        .rejects.toMatchObject({ code: "unsupported_contract" } satisfies Partial<DesktopGatewayFailure>);
    });

    it("maps a member's 403 onto forbidden so the strip can lock itself", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
      });

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      await expect(gateway.createSource({ content: "材料" }))
        .rejects.toMatchObject({ code: "forbidden" } satisfies Partial<DesktopGatewayFailure>);
    });

    /**
     * doc 34 L13 的下游那一半：`/voice/tts` 走的是取字节那条路，它过去**完全不读**
     * 失败响应的 body，所以服务端在 403 上回的 `ai_consent_required` 到不了界面，
     * "没签 AI 使用同意"被说成"这个账号没权限"。
     */
    it("语音那条路也认 error token：没签同意说的是没签同意，不是没权限", async () => {
      const ttsStatus = { value: 403 };
      const ttsBody = { value: JSON.stringify({ error: "ai_consent_required", message: "服务端那句原文" }) };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(ttsBody.value, {
          status: ttsStatus.value,
          headers: { "Content-Type": "application/json" },
        });
      });

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      const request = { version: 1 as const, text: "今天还有一张复习卡。" };
      const failure = await gateway.speakCompanionVoice(request, "request-consent-403").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DesktopGatewayFailure);
      expect(failure).toMatchObject({
        code: "ai_consent_required",
        retry: "never",
      } satisfies Partial<DesktopGatewayFailure>);
      // 失败体的 message 就是那个码（`DesktopGatewayFailure` 用 `super(code)`），
      // 所以这一条断的就是"服务端那句原文没有越界"。
      expect((failure as Error).message).toBe("ai_consent_required");

      // 对照 1：403 上没在名单里的 token 仍然只是 `forbidden`——专用码是白名单，不是"读到了就信"。
      ttsBody.value = JSON.stringify({ error: "TTS_FAILED" });
      await expect(gateway.speakCompanionVoice(request, "request-unknown-token"))
        .rejects.toMatchObject({ code: "forbidden" });

      // 对照 2：登录/邀请那一族的 token 在 403 上**也不算数**。它们的意思是路由内的
      // （`not_found` 在邀请路上是"邀请码无效"），要是 403 也照表翻，一次取图失败
      // 就会被说成邀请码问题——这条不是假想，是这次改动被既有用例当场抓到的形状。
      ttsBody.value = JSON.stringify({ error: "not_found" });
      await expect(gateway.speakCompanionVoice(request, "request-auth-token-on-403"))
        .rejects.toMatchObject({ code: "forbidden" });

      // 对照 3：403 空 body（旧行为的那条路）不受这次改动影响。
      ttsBody.value = "";
      await expect(gateway.speakCompanionVoice(request, "request-empty-body"))
        .rejects.toMatchObject({ code: "forbidden" });
    });
  });

  describe("companion learning-run context bridge", () => {
    const runId = "00000000-0000-4000-8000-000000000301";
    const snapshotId = "00000000-0000-4000-8000-000000000302";
    const taskId = "00000000-0000-4000-8000-000000000303";
    const pageInstanceId = "00000000-0000-4000-8000-000000000304";
    const contextRevision = "a".repeat(64);
    const context = {
      version: 1,
      pageKind: "learning_run",
      sharing: "page_registered",
      runId,
      snapshotId,
      taskId,
      requestedCapability: "none",
      contextRevision,
      groundedTutorGrant: null,
    } as const;
    const grant = {
      version: 1,
      grantId: "00000000-0000-4000-8000-000000000305",
      userId: "00000000-0000-4000-8000-000000000306",
      workspaceId: "00000000-0000-4000-8000-000000000307",
      pageInstanceId,
      pageKind: "learning_run",
      capability: "grounded_tutor",
      runId,
      snapshotId,
      taskId,
      contextRevision,
      permissionSnapshotHash: "b".repeat(64),
      issuedAt: "2026-09-18T08:00:00.000Z",
      expiresAt: "2026-09-18T08:05:00.000Z",
      signature: "c".repeat(64),
    } as const;

    it("reuses the existing context and single-use grant HTTP routes without changing their bodies", async () => {
      const calls: Array<{ url: string; method: string; body?: unknown }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (url.endsWith(`/learning-runs/${runId}/companion-context`)) {
          calls.push({ url, method: init?.method ?? "GET" });
          return new Response(JSON.stringify(context), { status: 200 });
        }
        if (url.endsWith(`/learning-runs/${runId}/companion-context-grants`)) {
          calls.push({ url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify(grant), { status: 200 });
        }
        throw new Error(`unexpected URL ${url}`);
      });

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      await expect(gateway.getCompanionLearningRunContext(runId)).resolves.toEqual(context);
      await expect(gateway.createCompanionLearningRunContextGrant(runId, {
        version: 1,
        pageInstanceId,
        taskId,
        contextRevision,
      })).resolves.toEqual(grant);
      expect(calls).toEqual([
        { url: `http://127.0.0.1:4000/learning-runs/${runId}/companion-context`, method: "GET" },
        {
          url: `http://127.0.0.1:4000/learning-runs/${runId}/companion-context-grants`,
          method: "POST",
          body: { version: 1, pageInstanceId, taskId, contextRevision },
        },
      ]);
    });

    it("fails closed when a context response does not match the shared schema", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(JSON.stringify({ ...context, requestedCapability: "grounded_tutor" }), { status: 200 });
      });

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      await expect(gateway.getCompanionLearningRunContext(runId))
        .rejects.toMatchObject({ code: "unsupported_contract" } satisfies Partial<DesktopGatewayFailure>);
    });
  });
});

/**
 * The settings page's AI consent block is only honest if its reads and writes
 * go through the server. These tests pin the wire contract: the read parses the
 * server's shape, each write is a real request followed by a re-read (so the UI
 * never shows an optimistic guess), and the native capability values come from
 * the desktop shell rather than from whatever the server guessed.
 */
describe("account AI settings", () => {
  const AI_SETTINGS = {
    version: 1,
    requiresConsent: true,
    consentVersion: null,
    consentAt: null,
    dataPolicy: { sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: false },
  };

  function mockApi(handler: (url: string, init?: RequestInit) => Response | null) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      const handled = handler(url, init);
      if (handled) return handled;
      throw new Error(`unexpected URL ${url}`);
    });
  }

  it("reads the signed-in account's consent state from the server", async () => {
    mockApi((url) => (url.includes("/me/ai-settings")
      ? new Response(JSON.stringify(AI_SETTINGS), { status: 200 })
      : null));

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.getWorkspaceAiSettings()).resolves.toEqual(AI_SETTINGS);
  });

  it("signs consent with the shared version and then re-reads the state", async () => {
    const sent: unknown[] = [];
    let signed = false;
    mockApi((url, init) => {
      if (url.includes("/me/ai-consent")) {
        sent.push(JSON.parse(String(init?.body)));
        signed = true;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes("/me/ai-settings")) {
        return new Response(JSON.stringify({
          ...AI_SETTINGS,
          consentVersion: signed ? "ai-consent-v1" : null,
          consentAt: signed ? "2026-09-17T00:00:00.000Z" : null,
        }), { status: 200 });
      }
      return null;
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const answer = await gateway.updateAiConsent("ai-consent-v1");

    expect(sent).toEqual([{ consentVersion: "ai-consent-v1" }]);
    // The answer is the server's re-read, not the request echoed back.
    expect(answer.consentVersion).toBe("ai-consent-v1");
  });

  it("sends the whole policy object and refuses an unknown contract shape", async () => {
    const sent: unknown[] = [];
    mockApi((url, init) => {
      if (url.includes("/me/ai-data-policy")) {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/me/ai-settings")) {
        return new Response(JSON.stringify({ ...AI_SETTINGS, canManage: "yes" }), { status: 200 });
      }
      return null;
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.updateAiDataPolicy({
      sendToExternal: true,
      sendImageContent: false,
      piiDetection: true,
      auditLogging: true,
    })).rejects.toMatchObject({ code: "unsupported_contract" } satisfies Partial<DesktopGatewayFailure>);
    expect(sent).toEqual([{ sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true }]);
  });

  it("reports native capabilities from the desktop shell, not from the server's placeholder", async () => {
    mockApi((url) => {
      if (url.includes("/auth/capabilities/v1")) {
        // The server cannot know this machine; it answers with a fail-closed
        // placeholder that the main process has to replace.
        return new Response(JSON.stringify({
          version: 1,
          revision: "server",
          workspaceEpoch: 1,
          actionCapabilities: Object.fromEntries(actionCapabilityValues.map((key) => [key, "denied"])),
          featureAvailability: Object.fromEntries(featureNameValues.map((key) => [key, { state: "disabled" }])),
          nativeCapabilities: {
            filePicker: "available",
            clipboard: "available",
            notifications: "available",
            asr: "available",
            updates: "available",
            live2d: "available",
          },
        }), { status: 200 });
      }
      return null;
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const projection = await gateway.getCapabilities();

    // 剪贴板与 ASR 通道已经实现（clipboardReadLinks / companionVoiceTranscribe，
    // 后者 2026-09-18 接线：本地 SenseVoice 优先、云 `/voice/transcribe` 兜底），
    // 其余仍没有对应通道——答案来自通道注册表，而不是服务端。
    expect(projection.nativeCapabilities).toEqual({
      filePicker: "unavailable",
      clipboard: "available",
      notifications: "unavailable",
      asr: "available",
      updates: "unavailable",
      live2d: "unavailable",
    });
    expect(capabilityProjectionSchema.safeParse(projection).success).toBe(true);
  });
});

/**
 * Workspace export is two halves: the server produces the data, the desktop
 * shell writes the file. The gateway owns only the first half, so these tests
 * pin that it fetches the real endpoint and never invents a payload.
 */
describe("workspace export", () => {
  it("reads the workspace export payload from the server's owner-only route", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.includes("/export/workspace")) {
        requested.push(url);
        return new Response(JSON.stringify({ workspace: { name: "Studio" }, notes: [{ id: "n-1" }] }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.fetchWorkspaceExport()).resolves.toEqual({
      workspace: { name: "Studio" },
      notes: [{ id: "n-1" }],
    });
    expect(requested).toHaveLength(1);
  });

  it("surfaces a member's 403 instead of writing an empty file", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.fetchWorkspaceExport())
      .rejects.toMatchObject({ code: "forbidden" } satisfies Partial<DesktopGatewayFailure>);
  });
});

describe("DesktopGateway · 笔记正文的离线提交（批次 4.4）", () => {
  const NOTE_ID = "77777777-7777-4777-8777-777777777777";
  const docStateUrl = `/v2/notes/${NOTE_ID}/doc-state`;
  const docUpdateUrl = `/v2/notes/${NOTE_ID}/doc-update`;

  function baseUpdate(): string {
    const doc = emptyNoteDoc();
    syncNoteBlocksForEditor(doc, [
      { type: "heading", content: "标题" },
      { type: "paragraph", content: "第一段" },
    ]);
    setNoteTitle(doc, "标题", "auto");
    return Buffer.from(snapshotOf(doc)).toString("base64");
  }

  /**
   * 把上送的那条增量应用到**同一份**起点上，读出正文——断言的是内容，不是字节。
   *
   * 起点必须逐字节复用：`baseUpdate()` 每调一次就是一份新文档，块条目的 struct id
   * 完全不同，把增量应用到"另一份同样的正文"上会因为找不到被改的那些条目而静默无操作
   * ——症状看着像"增量丢了"，其实是断言自己造了两个事实源。
   */
  function contentsAfter(base: string, updateBase64: string): string[] {
    const doc = emptyNoteDoc();
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(base, "base64")));
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(updateBase64, "base64")));
    const contents = projectNoteBlocks(doc).map((block) => block.content);
    doc.destroy();
    return contents;
  }

  function harness(options: {
    offline?: boolean;
    failStatus?: number;
    shareScope?: "private" | "shared";
    /**
     * 复用同一份服务端起点。跨重启的两个网关必须对着**同一份**编码差分：
     * 各造一份的话两份文档没有共同祖先，合并出来的就是两篇拼在一起，
     * 那测的是"两个事实源"而不是"重启"。
     */
    base?: string;
  } = {}) {
    const base = options.base ?? baseUpdate();
    const uploaded: string[] = [];
    let docStateReads = 0;
    let offline = options.offline ?? false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (offline) throw new TypeError("network down");
      if (url.endsWith(docStateUrl)) {
        docStateReads += 1;
        return new Response(JSON.stringify({
          update: base,
          revision: 3,
          backfilled: false,
          savedAt: "2026-09-21T00:00:00.000Z",
          // 起点带归属：客户端"要不要为这篇建长连接"以服务端为准，不看界面的说法。
          shareScope: options.shareScope ?? ("shared" as const),
        }), { status: 200 });
      }
      if (url.endsWith(docUpdateUrl)) {
        if (options.failStatus) {
          return new Response(JSON.stringify({ error: "forbidden" }), { status: options.failStatus });
        }
        uploaded.push(JSON.parse(String(init?.body)).update as string);
        return new Response(JSON.stringify({
          revision: 4 + uploaded.length,
          savedAt: "2026-09-21T00:00:09.000Z",
        }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const gateway = new DesktopGateway(environment());
    return { base, gateway, uploaded, docStateReads: () => docStateReads, goOffline: () => { offline = true; }, goOnline: () => { offline = false; } };
  }

/**
 * 本机改了正文：从起点开一份文档、整篇换成"标题 + 这一句"，交回**这一次产生的增量**。
 *
 * 界面交上来的从来不是整篇 blocks 了（那是 C2 之前那条路：主进程替界面差分，界面持有
 * 一份落后就可能覆盖对端的字），所以这批用例都得自己造出真实的本机增量。
 */
  /**
   * 本机连着改正文：每次都从**当前那份状态**出发产下一条增量，而不是每次都从起点出发。
   *
   * 这件事不是实现细节。三条"各自从同一起点整篇重写"的增量合起来是三段文字接在一起
   * （CRDT 不认识"整篇替换"，它只合并操作），而真实编辑器不会那样干——界面上第二次
   * 打字时文档里已经并进了第一次的结果。所以这里按运行状态链下去，与渲染层做的事一致。
   * 按起点字符串分组就够：每次 `harness()` 产出的起点都带着自己的 client id，互不相同。
   */
  const liveDocs = new Map<string, ReturnType<typeof emptyNoteDoc>>();
  const editTo = (base: string, second: string): string => {
    let doc = liveDocs.get(base);
    if (!doc) {
      doc = emptyNoteDoc();
      Y.applyUpdate(doc, Buffer.from(base, "base64"));
      liveDocs.set(base, doc);
    }
    const before = Y.encodeStateVector(doc);
    writeNoteBlocks(doc, [
      { type: "heading", content: "标题" },
      { type: "paragraph", content: second },
    ]);
    return Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64");
  };

  it("没网时如实报 queued：不假装服务端收到了", async () => {
    const { base, gateway, uploaded, goOffline } = harness();
    await gateway.connect();
    // 打开这篇时取过起点（离线编辑的前提），之后断网才只是"送不出去"。
    await gateway.getNoteDocState(NOTE_ID);
    goOffline();

    await expect(gateway.syncNoteDocUpdate(NOTE_ID, editTo(base, "第一段（离线改的）"))).resolves.toMatchObject({
      via: "queued",
    });
    expect(uploaded).toEqual([]);
  });

  it("恢复后一次把攒下的都交掉，两条改动服务端都看得到", async () => {
    const { base, gateway, uploaded, goOffline, goOnline } = harness();
    await gateway.connect();
    await gateway.getNoteDocState(NOTE_ID);
    goOffline();
    await gateway.syncNoteDocUpdate(NOTE_ID, editTo(base, "甲加的这句"));
    await gateway.syncNoteDocUpdate(NOTE_ID, editTo(base, "甲加的这句，还有乙补的半句"));
    expect(uploaded).toEqual([]);

    goOnline();
    const receipt = await gateway.syncNoteDocUpdate(NOTE_ID, editTo(base, "甲加的这句，还有乙补的半句，加上丙的"));
    expect(receipt.via).toBe("uploaded");
    expect(uploaded).toHaveLength(1);
    expect(contentsAfter(base, uploaded[0]!)).toEqual(["标题", "甲加的这句，还有乙补的半句，加上丙的"]);
  });

  it("非网络类失败不进队列——重发一百次也是同一个 403", async () => {
    const { base, gateway, uploaded, docStateReads } = harness({ failStatus: 403 });
    await gateway.connect();
    await expect(gateway.syncNoteDocUpdate(NOTE_ID, editTo(base, "不该被攒起来的一句")))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(uploaded).toEqual([]);

    // 队列是空的：下一次提交只带这一次的增量，不会把上次被拒的那条偷偷再塞进去。
    const fresh = harness();
    await fresh.gateway.connect();
    await fresh.gateway.syncNoteDocUpdate(NOTE_ID, editTo(fresh.base, "换一篇的增量"));
    expect(fresh.uploaded).toHaveLength(1);
    expect(docStateReads()).toBe(1);
  });

  it("切空间作废本机文档与队列：另一个空间的正文不能差分到这篇上", async () => {
    const { base, gateway, uploaded, goOffline } = harness();
    await gateway.connect();
    await gateway.getNoteDocState(NOTE_ID);
    goOffline();
    await gateway.syncNoteDocUpdate(NOTE_ID, editTo(base, "上一个空间的这句"));
    expect(uploaded).toEqual([]);

    gateway.dropNoteDocLocalSessions();

    // 换到另一个空间（这里是新建的会话）：上一空间攒下的那句绝不能跟着过来。
    const next = harness();
    await next.gateway.connect();
    await next.gateway.getNoteDocState(NOTE_ID);
    const receipt = await next.gateway.syncNoteDocUpdate(NOTE_ID, editTo(next.base, "这个空间的这句"));
    expect(receipt.via).toBe("uploaded");
    expect(next.uploaded).toHaveLength(1);
    expect(contentsAfter(next.base, next.uploaded[0]!)).toEqual(["标题", "这个空间的这句"]);
    // 旧的那台机器上：一次都没交出去，也没有在丢弃后被重新拾起。
    expect(uploaded).toEqual([]);
  });

  /** watchNoteDocument 要一个已鉴权的会话：给它一个内存里的凭据存储。 */
  function signedInStore() {
    return {
      available: true,
      hasStored: () => true,
      load: async () => "stored-token",
      save: async () => undefined,
      clear: async () => undefined,
    };
  };

  function watchProbe() {
    let transportCalls = 0;
    const gateway = new DesktopGateway(environment(), {
      credentials: signedInStore() as never,
      noteDocTransport: () => {
        transportCalls += 1;
        return {
          applyLocal: () => null,
          applyTitle: () => null,
          seed: () => undefined,
          setPresence: () => undefined,
          close: () => undefined,
        };
      },
    });
    return { gateway, transportCalls: () => transportCalls };
  }

  it("「仅自己可见」的那篇不建实时连接，但写入照旧", async () => {
    // 决定 7b 改到按篇判之后，门控关的是**传输**不是写入：私有笔记一样要能编辑，
    // 只是不广播。两个半边各钉一条，少任何一条都会留下一个"看起来对"的半成品。
    harness({ shareScope: "private" }); // 装 fetch 假实现：这篇是「仅自己可见」
    const { gateway, transportCalls } = watchProbe();
    await expect(gateway.watchNoteDocument(NOTE_ID, async () => undefined)).resolves.toBeNull();
    expect(transportCalls()).toBe(0);
  });

  it("已共享的那篇照常建连（上一条不是因为坏掉才返回 null）", async () => {
    harness(); // 这篇的 doc-state 报 shared
    const { gateway, transportCalls } = watchProbe();
    await gateway.connect();
    const handle = await gateway.watchNoteDocument(NOTE_ID, async () => undefined);
    expect(handle).not.toBeNull();
    expect(transportCalls()).toBe(1);
    handle?.stop();
  });

  it("只改标题不动正文：标题写进文档的 meta，正文一个字不变", async () => {
    const { base, gateway, uploaded } = harness();
    await gateway.connect();
    await gateway.getNoteDocState(NOTE_ID);
    const receipt = await gateway.syncNoteDocTitle(NOTE_ID, "改了名", "manual");
    expect(receipt.via).toBe("uploaded");
    expect(contentsAfter(base, uploaded[0]!)).toEqual(["标题", "第一段"]);
  });

  // ─── 本机那一份能跨过重启（决定 7）────────────────────────────────

  it("落盘的那一份接回来后，改出来的增量并回服务端起点上仍是同一篇", async () => {
    // 这是"重启 = 换一台空机器"的模拟：第二个网关没有任何起点，只拿到盘上那份。
    // 断言的不是"调用了 seed"，而是**增量并到服务端那份起点上之后不复制块**——
    // 4.0 实测过的失败模式就是两个没有共同祖先的副本一改就变四块。
    const first = harness();
    await first.gateway.connect();
    await first.gateway.getNoteDocState(NOTE_ID);
    const saved = first.gateway.noteDocLocalSnapshot(NOTE_ID);
    expect(saved).not.toBeNull();

    const reopened = harness({ base: first.base });
    await reopened.gateway.connect();
    reopened.gateway.restoreNoteDocLocal(NOTE_ID, saved!);
    await reopened.gateway.syncNoteDocUpdate(NOTE_ID, editTo(first.base, "第一段，重启后又改了"));

    expect(reopened.uploaded).toHaveLength(1);
    expect(contentsAfter(reopened.base, reopened.uploaded[0]!)).toEqual([
      "标题",
      "第一段，重启后又改了",
    ]);
  });

  it("没拿到起点之前没有可落盘的一份：不凭空造一个祖先", async () => {
    const { gateway } = harness();
    await gateway.connect();
    expect(gateway.noteDocLocalSnapshot(NOTE_ID)).toBeNull();
  });

  it("盘上那份不覆盖已经取到的服务端起点", async () => {
    const { base, gateway, uploaded } = harness();
    await gateway.connect();
    await gateway.getNoteDocState(NOTE_ID);
    // 一份来自上一次运行的状态：正文是"旧的那一句"。已经拿到过服务端起点时，
    // 接回来那一步必须被跳过，否则本机旧副本会盖掉服务端的现状——正是这一轮要
    // 消灭的那类覆盖。
    const staleDoc = emptyNoteDoc();
    syncNoteBlocksForEditor(staleDoc, [{ type: "paragraph", content: "旧的那一句" }]);
    gateway.restoreNoteDocLocal(NOTE_ID, {
      docState: Buffer.from(snapshotOf(staleDoc)).toString("base64"),
      pending: [],
      revision: 1,
      savedAt: "2026-09-19T00:00:00.000Z",
      shareScope: "shared",
    });
    staleDoc.destroy();

    // 旧副本没进来时，这一次写的增量并回服务端起点上仍是"标题 + 这一句"；
    // 进了的话会多出一段旧正文，或被差分掉一段——两种都不是这个结果。
    await gateway.syncNoteDocUpdate(NOTE_ID, editTo(base, "第一段，之后改的"));
    expect(contentsAfter(base, uploaded[0]!)).toEqual(["标题", "第一段，之后改的"]);
  });

  it("重启前欠的那几条，接回来之后一次交清", async () => {
    const { base, gateway, uploaded, goOffline } = harness();
    await gateway.connect();
    await gateway.getNoteDocState(NOTE_ID);
    goOffline();
    await gateway.syncNoteDocUpdate(NOTE_ID, editTo(base, "断网期间改的那一段"));
    const saved = gateway.noteDocLocalSnapshot(NOTE_ID)!;
    expect(saved.pending).toHaveLength(1);

    const reopened = harness({ base });
    await reopened.gateway.connect();
    reopened.gateway.restoreNoteDocLocal(NOTE_ID, saved);
    await reopened.gateway.flushNoteDocPending(NOTE_ID);

    expect(reopened.uploaded).toHaveLength(1);
    expect(contentsAfter(base, reopened.uploaded[0]!)).toEqual(["标题", "断网期间改的那一段"]);
    // 交清之后不该再有欠的：否则下一次重启还会把同一批重新发一遍。
    expect(reopened.gateway.noteDocLocalSnapshot(NOTE_ID)?.pending).toEqual([]);
  });
});

describe("DesktopGateway · 重认证那道门不该把空间换掉", () => {
  const USER_ID = "11111111-1111-4111-8111-111111111111";
  const PERSONAL = "22222222-2222-4222-8222-222222222222";
  const COLLAB = "33333333-3333-4333-8333-333333333333";
  const EMAIL = "member@example.test";

  const meBody = (workspaceId: string) => ({
    userId: USER_ID,
    workspaceId,
    email: EMAIL,
    role: workspaceId === COLLAB ? "member" : "owner",
    displayName: null,
    avatarUrl: null,
    workspaceName: workspaceId === COLLAB ? "验收空间" : "我的个人空间",
    workspaceType: workspaceId === COLLAB ? "collaborative" : "personal",
    isPersonal: workspaceId === PERSONAL,
    personalWorkspaceId: PERSONAL,
    workspaceEpoch: 1,
  });

  const listBody = () => ({
    workspaces: [
      { workspaceId: PERSONAL, workspaceName: "我的个人空间", role: "owner", workspaceType: "personal", isPersonal: true, leftAt: null },
      { workspaceId: COLLAB, workspaceName: "验收空间", role: "member", workspaceType: "collaborative", isPersonal: false, leftAt: null },
    ],
  });

  function reauthHarness() {
    // 服务端这一侧的事实：登录恒常落在账号的默认（个人）空间，切空间才会把人挪走。
    let active = PERSONAL;
    let switchCalls = 0;
    // 默认允许切；用例里 `blockSwitch()` 之后才扮演"那个人已经被移出去了"。
    let switchAllowed = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/auth/login")) {
        // 登录建的是**新会话**，落在这个账号的默认空间；上一个会话在哪一个空间与它无关。
        active = PERSONAL;
        return new Response(JSON.stringify({ token: "tok-1", ctx: { userId: USER_ID, workspaceId: PERSONAL, membershipRole: "owner" }, ...listBody() }), { status: 200 });
      }
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify(meBody(active)), { status: 200 });
      }
      if (url.endsWith("/auth/switch-workspace")) {
        switchCalls += 1;
        const wanted = JSON.parse(String(init?.body)).workspaceId as string;
        if (!switchAllowed) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
        active = wanted;
        // 服务端这个端点真实的形状：只有 token + ctx（+ csrfToken），**没有** workspaces 名册。
        return new Response(JSON.stringify({ token: "tok-2", ctx: { userId: USER_ID, workspaceId: wanted, membershipRole: wanted === COLLAB ? "member" : "owner" } }), { status: 200 });
      }
      if (url.endsWith("/auth/workspaces")) return new Response(JSON.stringify(listBody()), { status: 200 });
      if (url.endsWith("/auth/logout")) return new Response(JSON.stringify({ loggedOut: true }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });
    const gateway = new DesktopGateway(environment());
    return {
      gateway,
      active: () => active,
      switchCalls: () => switchCalls,
      blockSwitch: () => { switchAllowed = false; },
    };
  }

  it("在协作空间里过的重认证门，开完还在同一个空间", async () => {
    const { gateway, active } = reauthHarness();
    await gateway.connect();
    await gateway.login(EMAIL, "pw");
    await gateway.switchWorkspace(COLLAB);
    expect(active()).toBe(COLLAB);

    const session = await gateway.reauthenticate("pw");
    expect(session.workspace?.workspaceId).toBe(COLLAB);
    expect(active()).toBe(COLLAB);
    // 顶栏胶囊读的就是这份会话：它不能再报成个人空间。
    expect(session.workspace?.workspaceType).toBe("collaborative");
    expect(session.workspace?.role).toBe("member");
  });

  it("本来就在默认空间时不多发一次切换", async () => {
    const { gateway, switchCalls } = reauthHarness();
    await gateway.connect();
    await gateway.login(EMAIL, "pw");
    const before = switchCalls();
    const session = await gateway.reauthenticate("pw");
    expect(session.workspace?.workspaceId).toBe(PERSONAL);
    expect(switchCalls()).toBe(before);
  });

  it("那个空间已经回不去了（被移出）：门照样开，落回默认空间而不是卡住", async () => {
    const { gateway, blockSwitch } = reauthHarness();
    await gateway.connect();
    await gateway.login(EMAIL, "pw");
    await gateway.switchWorkspace(COLLAB);
    // -setup 之后才断：模拟"人在这个空间里待过，回来时已经被移出去了"。
    blockSwitch();
    const session = await gateway.reauthenticate("pw");
    // 抛错的话人连登录都完不成——回不去是"落在能落的那个空间"，不是一次失败。
    expect(session.workspace?.workspaceId).toBe(PERSONAL);
    expect(session.status).toBe("authenticated");
  });

  it("退登之后再登录，不会被拖回上一个空间", async () => {
    const { gateway, active } = reauthHarness();
    await gateway.connect();
    await gateway.login(EMAIL, "pw");
    await gateway.switchWorkspace(COLLAB);
    await gateway.logout();
    await gateway.login(EMAIL, "pw");
    expect(active()).toBe(PERSONAL);
    expect((await gateway.getSession()).workspace?.workspaceId).toBe(PERSONAL);
  });
});

describe("DesktopGateway · 伴星「这一页」的租约每 10 秒要真续上", () => {
  const USER_ID = "11111111-1111-4111-8111-111111111111";
  const PERSONAL = "22222222-2222-4222-8222-222222222222";
  const EMAIL = "member@example.test";
  const CONTEXT_ID = "55555555-5555-4555-8555-555555555555";
  const PAGE = {
    routeRef: { kind: "home" },
    pageKind: "today",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  };
  const ISSUED_AT = new Date(0).toISOString();

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  /** publish 回的是整份快照（服务端 `buildContextSnapshot`），renew 只回两个字段。 */
  const snapshotBody = (expiresAt: string) => ({
    version: 2,
    contextId: CONTEXT_ID,
    accountSessionId: "acct-1",
    deviceSessionId: "dev-1",
    workspaceId: PERSONAL,
    userId: USER_ID,
    pageInstanceId: "page-instance-1",
    revision: "rev-1",
    issuedAt: ISSUED_AT,
    expiresAt,
    ...PAGE,
  });

  function bridgeHarness(renewReply: (tick: number) => { status: number; body: unknown }) {
    const requests: string[] = [];
    let renewTick = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      requests.push(`${method} ${url}`);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.endsWith("/auth/login")) {
        return json({
          token: "tok-1",
          ctx: { userId: USER_ID, workspaceId: PERSONAL, membershipRole: "owner" },
          workspaces: [{
            workspaceId: PERSONAL, workspaceName: "我的个人空间", role: "owner",
            workspaceType: "personal", isPersonal: true, leftAt: null,
          }],
        });
      }
      if (url.endsWith("/auth/me")) {
        return json({
          userId: USER_ID,
          workspaceId: PERSONAL,
          email: EMAIL,
          role: "owner",
          displayName: null,
          avatarUrl: null,
          workspaceName: "我的个人空间",
          workspaceType: "personal",
          isPersonal: true,
          personalWorkspaceId: PERSONAL,
          workspaceEpoch: 1,
        });
      }
      if (url.endsWith("/renew")) {
        renewTick += 1;
        const reply = renewReply(renewTick);
        return json(reply.body, reply.status);
      }
      if (url.includes("/companion/bridge/contexts")) {
        if (method === "DELETE") return json({});
        return json(snapshotBody(new Date(30_000).toISOString()), 201);
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const count = (verb: string, suffix: string) =>
      requests.filter((entry) => entry.startsWith(`${verb} `) && entry.endsWith(suffix)).length;
    return { count, requests };
  }

  async function bridgeReady(gateway: DesktopGateway) {
    await gateway.connect();
    await gateway.login(EMAIL, "pw");
  }

  it("续租响应只有 revision/expiresAt 时：租约照续，不多发一次 publish", async () => {
    // 服务端 renewContext 的返回形状（context-service.ts:182）——拿整份快照的
    // schema 去解它必然失败，失败的那条 catch 会把上下文清掉、停掉定时器，
    // 而渲染层按内容去重发布：屏上没变就不会再推，于是她从此读不到这一页。
    // 本仓实测过这条链的产物：assistant_page_contexts 里 expires_at-issued_at
    // 恒为 30＋10 秒（只续上一拍），48 小时里 335 次 renew 200 对 427 次 publish。
    const { count } = bridgeHarness((tick) => ({
      status: 200,
      body: { revision: "rev-1", expiresAt: new Date((30 + tick * 10) * 1000).toISOString() },
    }));
    const gateway = new DesktopGateway(environment());
    await bridgeReady(gateway);
    vi.useFakeTimers();
    try {
      const published = await gateway.setCompanionBridgeContext(PAGE as never, "req-1");
      expect(published.active).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(count("POST", "/renew")).toBe(2);
      expect(count("POST", "/companion/bridge/contexts")).toBe(1);
      // 内容没变时再登记一次：走的是本地去重，报回来的必须是**续租后**那份到期时间。
      const again = await gateway.setCompanionBridgeContext(PAGE as never, "req-2");
      expect(again).toMatchObject({ active: true, revision: "rev-1", expiresAt: new Date(50_000).toISOString() });
    } finally {
      vi.useRealTimers();
    }
  });

  it("续租被服务端拒了（行没了）：拿手里这份 page 重新 publish，而不是永久变暗", async () => {
    const { count } = bridgeHarness(() => ({
      status: 404,
      body: { error: "context_not_found", message: "页面上下文不存在或已撤销" },
    }));
    const gateway = new DesktopGateway(environment());
    await bridgeReady(gateway);
    vi.useFakeTimers();
    try {
      await gateway.setCompanionBridgeContext(PAGE as never, "req-1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(count("POST", "/renew")).toBe(1);
      expect(count("POST", "/companion/bridge/contexts")).toBe(2);
      const state = await gateway.setCompanionBridgeContext(PAGE as never, "req-2");
      expect(state.active).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
