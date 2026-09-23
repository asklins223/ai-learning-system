import assert from "node:assert/strict";
import test from "node:test";
import {
  createLearningRunV2RequestSchema,
  getLearningRunResultResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  learningRunReturnContractV2Schema,
  pendingReturnMarkerV2Schema,
} from "./index.ts";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const CARD_ID = "00000000-0000-4000-8000-000000000003";
const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000004";
const SCHEDULE_ID = "00000000-0000-4000-8000-000000000005";
const TASK_ID = "00000000-0000-4000-8000-000000000006";
const HASH = "a".repeat(64);

const originV2 = {
  kind: "card" as const,
  cardId: CARD_ID,
  objectiveId: OBJECTIVE_ID,
};

const target = {
  objectiveId: OBJECTIVE_ID,
  objectiveRevision: 1,
  cardId: CARD_ID,
  publicationRevision: 1,
  cardRevision: 1,
  publicPayloadHash: HASH,
  publicSummary: "A public learning target",
  semanticTargetFingerprint: HASH,
  targetRevisionHash: HASH,
};

const activeTask = {
  version: 1 as const,
  taskId: TASK_ID,
  runId: RUN_ID,
  sequence: 1,
  intent: "explain" as const,
  prompt: "Explain the target in your own words.",
  targetSummary: "A short public summary",
  activeVariant: {
    variantId: "variant-1",
    purpose: "formal" as const,
    interaction: { kind: "text_response" as const, maxChars: 2000 },
    templateTrustCeiling: "mastery_eligible" as const,
    estimatedActiveSeconds: 60,
    publicPayloadHash: HASH,
    inputSchemaHash: HASH,
    disclosureProfileHash: HASH,
    revision: 1,
  },
  availableAlternatives: [],
  assistancePolicy: { hintLevels: 1 as const, exposureLowersTrust: true as const },
  status: "active" as const,
  revision: 1,
};

const snapshot = {
  version: 2 as const,
  runId: RUN_ID,
  snapshotId: SNAPSHOT_ID,
  originV2,
  target,
  returnTargetV2: { kind: "card" as const, cardId: CARD_ID, objectiveId: OBJECTIVE_ID },
  phase: "active" as const,
  runRevision: 1,
  runtimeEpoch: 1,
  activeSecondsUsed: 12,
  timeBudgetSeconds: 120,
  activeTask,
  allowedActions: [
    { version: 2 as const, kind: "pause" as const },
    { version: 2 as const, kind: "request_hint" as const, level: 1 as const },
  ],
  publishedTargetEligibility: "eligible" as const,
  // 审计 F28：checkpoint 之外一律 null。夹具按解析后的完整形状写，
  // 这条用例才是"往返相等"而不是"少一个字段也能过"。
  checkpointReason: null,
};

const resultBase = {
  version: 2 as const,
  runId: RUN_ID,
  snapshotId: SNAPSHOT_ID,
  originV2,
  returnTargetV2: { kind: "card" as const, cardId: CARD_ID, objectiveId: OBJECTIVE_ID },
};

test("V2 create request is versioned and never falls back to V1 origin", () => {
  const parsed = createLearningRunV2RequestSchema.parse({
    originV2,
    goal: "clarify",
    idempotencyKey: "command-1",
  });
  assert.equal(parsed.version, 2);
  assert.throws(() => createLearningRunV2RequestSchema.parse({
    version: 1,
    origin: { kind: "card", cardId: CARD_ID, keyPointId: OBJECTIVE_ID },
    goal: "clarify",
    idempotencyKey: "command-1",
  }));
});

test("public snapshot accepts the frozen V2 binding and rejects V1/unknown/mismatched payloads", () => {
  assert.deepEqual(learningRunPublicSnapshotV2Schema.parse(snapshot), snapshot);
  // `.default(null)` 是读侧的容忍：服务端还没带这个字段时也解析得出来，且解析结果是
  // null 而不是 undefined——网关按解析后形状推断返回类型，两者差一个 `undefined`
  // 就会让调用方的类型变成"字段可有可无"（desktop-gateway.ts 的 getLearningRunV2）。
  const { checkpointReason: _omitted, ...snapshotWithoutReason } = snapshot;
  assert.equal(learningRunPublicSnapshotV2Schema.parse(snapshotWithoutReason).checkpointReason, null);
  assert.throws(() => learningRunPublicSnapshotV2Schema.parse({ ...snapshot, extra: true }));
  assert.throws(() => learningRunPublicSnapshotV2Schema.parse({
    ...snapshot,
    version: 1,
    origin: { kind: "card", cardId: CARD_ID, keyPointId: OBJECTIVE_ID },
    originV2: undefined,
  }));
  assert.throws(() => learningRunPublicSnapshotV2Schema.parse({
    ...snapshot,
    activeTask: { ...activeTask, runId: "00000000-0000-4000-8000-000000000099" },
  }));
  assert.throws(() => learningRunPublicSnapshotV2Schema.parse({ ...snapshot, activeSecondsUsed: -1 }));
  assert.throws(() => learningRunPublicSnapshotV2Schema.parse({ ...snapshot, activeSecondsUsed: 181 }));
});

test("V2 result response has explicit pending, learning and terminal states", () => {
  assert.equal(getLearningRunResultResponseV2Schema.parse({
    ...resultBase,
    status: "pending",
    httpStatus: 202,
    phase: "assessing",
    runRevision: 2,
  }).status, "pending");

  assert.equal(getLearningRunResultResponseV2Schema.parse({
    ...resultBase,
    status: "learning_result",
    httpStatus: 200,
    result: {
      ...resultBase,
      outcome: "partial",
      demonstratedFacets: ["explain"],
      gapFacets: ["boundary"],
      scheduleImpact: { kind: "none", reasonCode: "facet_only" },
    },
  }).status, "learning_result");

  assert.equal(getLearningRunResultResponseV2Schema.parse({
    ...resultBase,
    status: "terminal_without_result",
    httpStatus: 200,
    phase: "ended",
    reasonCode: "user_ended",
  }).status, "terminal_without_result");
});

test("V2 result and return contracts keep the V2 return target bound", () => {
  const wrongTarget = { kind: "review" as const, scheduleId: SCHEDULE_ID, objectiveId: OBJECTIVE_ID };
  assert.throws(() => getLearningRunResultResponseV2Schema.parse({
    ...resultBase,
    status: "learning_result",
    httpStatus: 200,
    result: {
      ...resultBase,
      returnTargetV2: wrongTarget,
      outcome: "partial",
      demonstratedFacets: [],
      gapFacets: [],
      scheduleImpact: { kind: "none", reasonCode: "facet_only" },
    },
  }));

  const common = { ...resultBase };
  const contracts = [
    { ...common, status: "run_active" as const, runPhase: "active" as const },
    { ...common, status: "no_projection_change" as const, sourceChange: { kind: "none" as const } },
    {
      ...common,
      status: "projection_pending" as const,
      sourceChange: { kind: "canonical" as const, canonicalEventId: "event-1" },
      currentCheckpoint: { version: 1 as const, workspaceId: OBJECTIVE_ID, userId: OBJECTIVE_ID, token: "cp", capturedAt: "now" },
      retryAfterMs: 500,
    },
    {
      ...common,
      status: "ready" as const,
      sourceChange: { kind: "practice_only" as const, practiceEventId: "practice-1" },
      targetCheckpoint: { version: 1 as const, workspaceId: OBJECTIVE_ID, userId: OBJECTIVE_ID, token: "cp", capturedAt: "now" },
      changeSetId: "change-1",
    },
    { ...common, status: "unavailable" as const, reason: "permission_revoked" as const, fallbackTargetV2: null },
  ];
  assert.equal(contracts.filter((value) => learningRunReturnContractV2Schema.safeParse(value).success).length, 5);
  assert.equal(learningRunReturnContractV2Schema.safeParse({
    ...common,
    status: "ready",
    sourceChange: { kind: "canonical", canonicalEventId: "event-1" },
    targetCheckpoint: { version: 1, workspaceId: OBJECTIVE_ID, userId: OBJECTIVE_ID, token: "cp", capturedAt: "now" },
    changeSetId: "change-1",
    returnTargetV2: { kind: "review", objectiveId: OBJECTIVE_ID },
  }).success, false);
});

test("pending return marker cannot smuggle result/checkpoint/fallback data", () => {
  const marker = pendingReturnMarkerV2Schema.parse({
    version: 2,
    runId: RUN_ID,
    originV2,
    checkedAt: "2026-08-23T00:00:00.000Z",
  });
  assert.equal(marker.runId, RUN_ID);
  assert.throws(() => pendingReturnMarkerV2Schema.parse({ ...marker, result: {} }));
  assert.throws(() => pendingReturnMarkerV2Schema.parse({ ...marker, fallbackTargetV2: null }));
});
