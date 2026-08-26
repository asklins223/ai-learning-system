import { createHmac } from "node:crypto";
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
import { DesktopGateway, DesktopGatewayFailure } from "./desktop-gateway";

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
  permissions: { canRead: true, canEdit: false, canSave: false },
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
  isAutosave: false,
  revision: "00000000-0000-4000-8000-000000000013",
  savedAt: "2026-08-23T00:00:03.000Z",
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("uses only strict V2 paths and keeps main-owned idempotency stable per command", async () => {
    const requestedIdempotencyKeys: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.includes("/reviews/v2/queue")) {
        return new Response(JSON.stringify({ version: 2, items: [], nextCursor: null }), { status: 200 });
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
    await expect(gateway.getReviewQueue()).resolves.toEqual({ version: 2, items: [], nextCursor: null });
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
    expect(first.captureCapability).toMatchObject({ state: "disabled", reason: "capability_denied" });
    expect(secondRequestIfNoneMatch).toBe('"dashboard-rev-1"');
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
    expect(first.activeGenerationSummary).toEqual({ state: "data", data: ACTIVE_GENERATION_SUMMARIES.items[0] });
    expect(second.activeGenerationSummary).toEqual(first.activeGenerationSummary);
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
          isAutosave: false,
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
      isAutosave: false,
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
});
