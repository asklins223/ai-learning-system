import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_IPC_CONTRACT_VERSION,
  apiConnectionStateSchema,
  capabilityProjectionSchema,
  clipboardReadLinksResultSchema,
  commandReceiptSchema,
  deploymentConfigSchema,
  desktopContractSnapshotSchema,
  desktopCreateLearningRunV2RequestSchema,
  desktopNamespaceM2Values,
  desktopRecordLearningRunActivityLeaseRequestV2Schema,
  desktopRouteKindM2Values,
  desktopTrustChallengeRequestSchema,
  extractCandidateLinks,
  gatewayEventSchema,
  gatewayEventPayloadM2Schema,
  gatewayResultSchema,
  localApiTrustSchema,
  navigationEntrySchema,
  sessionContextSchema,
  staticAssetPathSchema,
  subscriptionTopicM2Schema,
  workspaceContextSchema,
} from "./desktop-ipc-contracts.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

test("M1 contract snapshot rejects duplicate and ungated routes", () => {
  const valid = {
    version: 1 as const,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    domainSchemaRevision: "domain-v2",
    deploymentConfigRevision: "deployment-v1",
    namespaces: ["runtime", "navigation", "auth", "workspace", "capabilities", "window", "subscriptions"] as const,
    enabledRoutes: ["auth.login", "auth.register"] as const,
  };
  assert.deepEqual(desktopContractSnapshotSchema.parse(valid).enabledRoutes, valid.enabledRoutes);
  assert.throws(() => desktopContractSnapshotSchema.parse({ ...valid, enabledRoutes: ["auth.login", "auth.login"] }));
  assert.throws(() => desktopContractSnapshotSchema.parse({ ...valid, enabledRoutes: ["room.home"] }));
});

test("authenticated session accepts the strict workspace context shape", () => {
  const workspace = {
    version: 1 as const,
    workspaceId: WORKSPACE_ID,
    name: "Owner workspace",
    role: "owner" as const,
    workspaceType: "personal" as const,
    isPersonal: true,
    workspaceEpoch: 7,
  };
  assert.deepEqual(workspaceContextSchema.parse(workspace), workspace);
  const session = sessionContextSchema.parse({
    version: 1,
    status: "authenticated",
    user: { userId: USER_ID, email: "owner@example.com" },
    workspace,
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch: 7,
    credentialPersistence: "memory",
  });
  assert.equal(session.status, "authenticated");
});

test("authenticated member accepts a collaborative projection of an owner personal workspace", () => {
  const workspace = {
    version: 1 as const,
    workspaceId: WORKSPACE_ID,
    name: "Shared workspace",
    role: "member" as const,
    workspaceType: "collaborative" as const,
    isPersonal: false,
    workspaceEpoch: 7,
  };
  const session = sessionContextSchema.parse({
    version: 1,
    status: "authenticated",
    user: { userId: USER_ID, email: "member@example.com" },
    workspace,
    membership: { role: "member" },
    capabilities: null,
    workspaceEpoch: 7,
    credentialPersistence: "memory",
  });
  assert.equal(session.workspace?.workspaceType, "collaborative");
  assert.equal(session.workspace?.isPersonal, false);
});

test("M2 roster is explicitly gated and renderer cannot inject replay/device secrets", () => {
  const contract = desktopContractSnapshotSchema.parse({
    version: 1 as const,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    domainSchemaRevision: "domain-v2",
    deploymentConfigRevision: "deployment-v1",
    namespaces: [...desktopNamespaceM2Values],
    enabledRoutes: [...desktopRouteKindM2Values],
  });
  assert.equal(contract.enabledRoutes.includes("review.queue"), true);
  assert.equal(contract.enabledRoutes.includes("learningRun.detail"), true);
  assert.equal(contract.enabledRoutes.includes("room.home"), true);
  assert.throws(() => desktopCreateLearningRunV2RequestSchema.parse({
    version: 2,
    originV2: { kind: "card", cardId: USER_ID, objectiveId: WORKSPACE_ID },
    goal: "clarify",
    idempotencyKey: "renderer-must-not-send",
  }));
  assert.throws(() => desktopRecordLearningRunActivityLeaseRequestV2Schema.parse({
    version: 2,
    snapshotId: WORKSPACE_ID,
    runRevision: 1,
    runtimeEpoch: 1,
    deviceSessionId: "renderer-must-not-send",
    startedAt: "2026-08-23T00:00:00.000Z",
    endedAt: "2026-08-23T00:00:01.000Z",
  }));
  assert.throws(() => desktopRecordLearningRunActivityLeaseRequestV2Schema.parse({
    version: 2,
    snapshotId: WORKSPACE_ID,
    runRevision: 1,
    runtimeEpoch: 1,
    startedAt: "2026-08-23T00:00:00.000Z",
    endedAt: "2026-08-23T00:00:01.000Z",
    idempotencyKey: "renderer-must-not-send",
  }));
});

test("M2 subscription wire only exposes safe learning-run and card-generation invalidations", () => {
  assert.deepEqual(subscriptionTopicM2Schema.parse({ kind: "learningRun", runId: WORKSPACE_ID, cursor: "cursor-1" }), {
    kind: "learningRun",
    runId: WORKSPACE_ID,
    cursor: "cursor-1",
  });
  assert.deepEqual(subscriptionTopicM2Schema.parse({ kind: "cardGeneration", runId: WORKSPACE_ID }), {
    kind: "cardGeneration",
    runId: WORKSPACE_ID,
  });
  assert.throws(() => subscriptionTopicM2Schema.parse({ kind: "cardGeneration" }));
  assert.deepEqual(gatewayEventPayloadM2Schema.parse({
    kind: "learning_run_changed",
    runId: WORKSPACE_ID,
    revision: 3,
  }), {
    kind: "learning_run_changed",
    runId: WORKSPACE_ID,
    revision: 3,
  });
  assert.deepEqual(gatewayEventPayloadM2Schema.parse({
    kind: "card_generation_changed",
    runId: WORKSPACE_ID,
    eventCursor: 7,
    revision: 4,
  }), {
    kind: "card_generation_changed",
    runId: WORKSPACE_ID,
    eventCursor: 7,
    revision: 4,
  });
  assert.throws(() => gatewayEventPayloadM2Schema.parse({
    kind: "learning_run_changed",
    runId: WORKSPACE_ID,
    revision: 3,
    snapshot: { secret: "must-not-cross-ipc" },
  }));
  assert.throws(() => gatewayEventPayloadM2Schema.parse({
    kind: "card_generation_changed",
    runId: WORKSPACE_ID,
    eventCursor: 7,
    revision: 4,
    candidate: { answer: "must-not-cross-ipc" },
  }));
  assert.throws(() => subscriptionTopicM2Schema.parse({
    kind: "cardGeneration",
    runId: WORKSPACE_ID,
    cursor: "cursor-1",
    answer: "must-not-cross-ipc",
  }));
});

test("navigation scope is fail-closed", () => {
  const gate = {
    version: 1 as const,
    scope: "gate" as const,
    historyKey: "h1",
    route: { kind: "auth.login" as const },
    entryKind: "startup" as const,
    correlationId: "corr-1",
  };
  assert.equal(navigationEntrySchema.parse(gate).scope, "gate");
  assert.throws(() => navigationEntrySchema.parse({ ...gate, workspaceId: WORKSPACE_ID }));
  assert.throws(() => navigationEntrySchema.parse({ ...gate, route: { kind: "room.home" } }));
});

test("deployment config keeps local trust and remote HTTPS mutually exclusive", () => {
  assert.equal(
    deploymentConfigSchema.parse({
      version: 1,
      mode: "local_loopback",
      apiOrigin: "http://127.0.0.1:4000",
      localServiceTrust: "hmac_pairing_v1",
      expectedServiceId: "ailearn-api",
      expectedDomainSchemaRevision: "domain-v2",
      pairingKeyId: "key-1",
      configRevision: "deployment-v1",
    }).mode,
    "local_loopback",
  );
  assert.throws(() => deploymentConfigSchema.parse({
    version: 1,
    mode: "local_loopback",
    apiOrigin: "http://localhost:4000",
    localServiceTrust: "hmac_pairing_v1",
    expectedServiceId: "ailearn-api",
    expectedDomainSchemaRevision: "domain-v2",
    pairingKeyId: "key-1",
    configRevision: "deployment-v1",
  }));
  assert.throws(() => deploymentConfigSchema.parse({
    version: 1,
    mode: "remote_https",
    apiOrigin: "https://example.com/path",
    expectedDomainSchemaRevision: "domain-v2",
    configRevision: "deployment-v1",
    localServiceTrust: "hmac_pairing_v1",
  }));
});

test("api_unavailable and api_untrusted remain distinct renderer states", () => {
  assert.equal(apiConnectionStateSchema.parse({ version: 1, kind: "api_unavailable" }).kind, "api_unavailable");
  assert.equal(apiConnectionStateSchema.parse({ version: 1, kind: "api_untrusted", reason: "wrong_service" }).kind, "api_untrusted");
  assert.throws(() => apiConnectionStateSchema.parse({ version: 1, kind: "anonymous" }));
});

test("gateway and command envelopes reject raw unknown fields and false commits", () => {
  const resultSchema = gatewayResultSchema(capabilityProjectionSchema);
  assert.equal(resultSchema.parse({
    version: 1,
    ok: false,
    error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" },
    requestId: "request-1",
    correlationId: "correlation-1",
    schemaRevision: "desktop-ipc-m1",
  }).ok, false);
  assert.throws(() => resultSchema.parse({
    version: 1,
    ok: false,
    error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action", raw: "secret" },
    requestId: "request-1",
    correlationId: "correlation-1",
    schemaRevision: "desktop-ipc-m1",
  }));

  const receiptSchema = commandReceiptSchema(capabilityProjectionSchema);
  assert.throws(() => receiptSchema.parse({
    version: 1,
    commandId: "command-1",
    state: "unknown",
    result: {},
    resyncHint: { kind: "entity", ref: "workspace" },
  }));
});

test("asset and trust challenge scalars fail closed", () => {
  assert.equal(staticAssetPathSchema.parse("posters/room-day.webp"), "posters/room-day.webp");
  assert.throws(() => staticAssetPathSchema.parse("../room-day.webp"));
  assert.throws(() => staticAssetPathSchema.parse("https://example.com/room.webp"));
  assert.throws(() => desktopTrustChallengeRequestSchema.parse({
    version: 1,
    nonce: "short",
    ipcContractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    pairingKeyId: "key-1",
  }));
  assert.equal(localApiTrustSchema.parse({
    version: 1,
    state: "untrusted",
    origin: "http://127.0.0.1:4000",
    serviceId: "ailearn-api",
    transportEpoch: 1,
  }).state, "untrusted");
  assert.equal(gatewayEventSchema.parse({
    version: 1,
    subscriptionId: "subscription-1",
    workspaceEpoch: 0,
    cursor: "cursor-1",
    eventRevision: 0,
    kind: "connection_changed",
    schemaRevision: "desktop-ipc-m1",
    data: { kind: "connection_changed", state: { version: 1, kind: "api_unavailable" } },
  }).workspaceEpoch, 0);
  assert.throws(() => gatewayEventSchema.parse({
    version: 1,
    subscriptionId: "subscription-1",
    workspaceEpoch: 0,
    cursor: "cursor-1",
    eventRevision: 0,
    kind: "snapshot_invalidated",
    schemaRevision: "desktop-ipc-m1",
    data: { kind: "snapshot_invalidated", scope: "workspace" },
  }));
  assert.notEqual(WORKSPACE_ID, USER_ID);
});

test("extractCandidateLinks 只收 http(s) 链接并归一化去重", () => {
  assert.deepEqual(
    extractCandidateLinks("看看这个 https://example.com/a?p=1，正文。"),
    ["https://example.com/a?p=1"],
  );
  // 尾巴标点与右括号剥掉，重复只留一个，数量封顶。
  assert.deepEqual(
    extractCandidateLinks("(https://a.test/1，https://a.test/1) https://b.test/2! https://c.test/3 https://d.test/4"),
    ["https://a.test/1", "https://b.test/2", "https://c.test/3"],
  );
  // 非目标协议与带账密的一律不要。
  assert.deepEqual(extractCandidateLinks("ftp://a.test/x file:///etc/passwd example.com"), []);
  assert.deepEqual(extractCandidateLinks("https://user:pass@a.test/x"), []);
  assert.deepEqual(extractCandidateLinks("只是普通密码 Abc123!@#"), []);
  assert.deepEqual(extractCandidateLinks(""), []);
});

test("clipboardReadLinksResultSchema 拒绝超长与超量", () => {
  assert.equal(clipboardReadLinksResultSchema.safeParse({ urls: [] }).success, true);
  assert.equal(
    clipboardReadLinksResultSchema.safeParse({ urls: ["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://d.test/4"] }).success,
    false,
  );
});
