/**
 * Plan 23 W1-17/W1-18：Objective Surface V3 合同测试。
 * - 公共泄漏：递归拒绝 canonicalAnswer/rubric/fullQuote/privateReport；
 * - action union 穷尽；
 * - origin discriminated union 条件字段；
 * - Dashboard mode 与 counts 一致性；
 * - 版本字面量冻结（V3 只通过新合同暴露）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  learningObjectiveSurfaceV3Schema,
  learningDashboardV2Schema,
  learningObjectivePrimaryActionV3Schema,
  objectiveOriginV3Schema,
  learningObjectiveTopologyEventV2Schema,
  findPrivatePayloadLeaks,
} from "./learning-objective-surface-contracts.ts";
import { publicLearningCardV2Schema } from "./learning-card-v2-contracts.ts";

const OBJ = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";
const NOTE_VERSION = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";

function surfaceFixture(): Record<string, unknown> {
  return {
    version: 3,
    objectiveId: OBJ,
    surfaceRevision: 7,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "受激辐射与增益介质",
      publicSummary: "理解受激辐射如何产生光放大。",
      knowledgeForm: "causal_model",
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: CARD, cardRevision: 2, publicationRevision: 2 },
      sourceLabel: "光学笔记",
    },
    sources: {
      origins: [
        {
          originId: "66666666-6666-4666-8666-666666666666",
          kind: "note",
          noteId: NOTE,
          noteVersionId: NOTE_VERSION,
          sourceSnapshotId: null,
          evidenceSnapshotIds: [],
          integrity: "verified",
        },
      ],
      primaryNote: { noteId: NOTE, noteVersionId: NOTE_VERSION, title: "光学原理笔记" },
      missingOrigin: false,
    },
    personal: {
      initialValidation: null,
      activeRun: { runId: RUN, phase: "active" },
      review: null,
      practiceTrailCount: 2,
      lastCanonicalAt: "2026-08-16T10:00:00.000Z",
    },
    lifecycle: { status: "active", successorObjectiveId: null },
    personalState: { state: "learning", activeRunId: RUN },
    primaryAction: { kind: "resume_run", runId: RUN, objectiveId: OBJ },
    createdAt: "2026-08-16T09:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
  };
}

test("W1-17: valid Surface V3 parses and leaks NOTHING", () => {
  const parsed = learningObjectiveSurfaceV3Schema.parse(surfaceFixture());
  const leaks = findPrivatePayloadLeaks(parsed);
  assert.deepEqual(leaks, []);
  assert.equal(parsed.version, 3);
});

test("recent completed run is a navigable reference, not an exposed answer", () => {
  const fixture = surfaceFixture();
  (fixture.personal as Record<string, unknown>).latestResult = {
    runId: RUN,
    completedAt: "2026-08-16T11:00:00.000Z",
    outcome: "practice_completed",
  };
  const parsed = learningObjectiveSurfaceV3Schema.parse(fixture);
  assert.equal(parsed.personal.latestResult?.runId, RUN);
  assert.deepEqual(findPrivatePayloadLeaks(parsed), []);
});

test("W1-17: injecting private payload keys at any depth is rejected by strict schema", () => {
  const inject = (key: string) => {
    const fixture = surfaceFixture();
    (fixture as Record<string, unknown>)[key] = "SECRET";
    return learningObjectiveSurfaceV3Schema.safeParse(fixture);
  };
  for (const key of [
    "canonicalAnswer",
    "scoringRubric",
    "fullQuote",
    "protectedQuote",
    "privateReport",
  ]) {
    const result = inject(key);
    assert.equal(result.success, false, "should reject root key " + key);
  }
  // 深注入（content 下）
  const deep = surfaceFixture();
  (deep.content as Record<string, unknown>).canonicalAnswer = "SECRET";
  assert.equal(learningObjectiveSurfaceV3Schema.safeParse(deep).success, false);
});

test("W1-17: findPrivatePayloadLeaks reports deep forbidden keys", () => {
  const obj = surfaceFixture() as unknown;
  // 深扫描
  const staged = JSON.parse(JSON.stringify(obj, (k, v) => k === "content" ? { ...v, scoringRubric: "x" } : v));
  const leaks = findPrivatePayloadLeaks(staged);
  assert.deepEqual(leaks, ["root.content.scoringRubric"]);
});

test("W1-10: action union is exhaustive over all kinds", () => {
  const cardStart = { version: 2, originV2: { kind: "card", cardId: CARD, objectiveId: OBJ }, goal: "stabilize", requestedTimeBudgetSeconds: 180, responsePreference: "adaptive" };
  const actions: Array<Record<string, unknown>> = [
    { kind: "create_run", objectiveId: OBJ, label: "首次验证", start: cardStart },
    { kind: "resume_run", runId: RUN, objectiveId: OBJ },
    { kind: "create_review_run", objectiveId: OBJ, label: "开始复习", start: { ...cardStart, originV2: { kind: "review", scheduleId: RUN, objectiveId: OBJ, scheduleGeneration: 2 } } },
    { kind: "practice_only", objectiveId: OBJ, label: "带着参考答案练一下", start: cardStart, reasonCodes: ["exposed"], formalValidationNotBefore: "2026-08-18T00:00:00.000Z" },
    { kind: "practice_only", objectiveId: OBJ, label: "带着参考答案练一下", start: cardStart, reasonCodes: ["exposed"], formalValidationNotBefore: null },
    { kind: "wait_for_initial_validation", reminderId: RUN, qualificationNotBefore: "2026-08-18T00:00:00.000Z" },
    { kind: "view_successor", successorObjectiveId: OBJ, successorCardId: CARD },
    { kind: "refresh" },
    { kind: "none" },
  ];
  for (const action of actions) {
    assert.equal(learningObjectivePrimaryActionV3Schema.safeParse(action).success, true, JSON.stringify(action));
  }
  assert.equal(
    learningObjectivePrimaryActionV3Schema.safeParse({ kind: "guess", objectiveId: OBJ }).success,
    false,
  );
  // 练习动作必须自带「什么时候能正式算」；漏掉要在这里挡下，而不是让
  // 客户端各自决定怎么解释一个没有终点的等待（复盘 #9）。
  assert.equal(
    learningObjectivePrimaryActionV3Schema.safeParse({
      kind: "practice_only", objectiveId: OBJ, label: "练习", start: cardStart, reasonCodes: ["exposed"],
    }).success,
    false,
  );
});

test("W1-09: origin discriminated union enforces conditional fields", () => {
  const goodNote = objectiveOriginV3Schema.parse({
    originId: "66666666-6666-4666-8666-666666666666",
    kind: "note",
    noteId: NOTE,
    noteVersionId: NOTE_VERSION,
    sourceSnapshotId: null,
    evidenceSnapshotIds: [],
    integrity: "verified",
  });
  assert.equal(goodNote.kind, "note");
  // note 缺 noteVersionId → 失败
  assert.equal(
    objectiveOriginV3Schema.safeParse({ originId: "99", kind: "note", noteId: NOTE }).success,
    false,
  );
  // manual 带 note → 失败（严格对象 + 联合不匹配）
  assert.equal(
    objectiveOriginV3Schema.safeParse({ originId: "99", kind: "manual", noteId: NOTE }).success,
    false,
  );
  // imported 缺 importBatchRef → 失败
  assert.equal(
    objectiveOriginV3Schema.safeParse({ originId: "99", kind: "imported", evidenceSnapshotIds: [] }).success,
    false,
  );
});

test("W1-13: Dashboard parses with consistent shape and leaks nothing", () => {
  const dashboard = {
    version: 2,
    snapshotAt: "2026-08-16T10:00:00.000Z",
    dashboardRevision: "rev-1",
    counts: { notes: 6, activeObjectives: 3, activeRuns: 1, reviewsDue: 0, needsRepair: 0 },
    mode: "run_in_progress",
    primaryFocus: {
      objective: surfaceFixture(),
      reasonCodes: ["resume_active_run"],
      action: { kind: "resume_run", runId: RUN, objectiveId: OBJ },
    },
    queue: [],
    recentObjectives: [],
    suggestedNote: null,
    degradation: null,
  };
  const parsed = learningDashboardV2Schema.parse(dashboard);
  assert.equal(parsed.mode, "run_in_progress");
  assert.deepEqual(findPrivatePayloadLeaks(parsed), []);
  // mode/counts 一致性：run_in_progress 必须有 activeRuns>=1
  assert.ok(parsed.counts.activeRuns >= 1);
  assert.ok(parsed.counts.activeObjectives >= 1);
});

test("W1-13: Dashboard degraded mode must be explicit, not masked as empty", () => {
  const degraded = {
    version: 2,
    snapshotAt: "2026-08-16T10:00:00.000Z",
    dashboardRevision: "rev-2",
    counts: { notes: 6, activeObjectives: 3, activeRuns: 0, reviewsDue: 0, needsRepair: 0 },
    mode: "degraded",
    primaryFocus: null,
    queue: [],
    recentObjectives: [],
    suggestedNote: null,
    degradation: { unavailableSections: ["review"], retryable: true },
  };
  const parsed = learningDashboardV2Schema.parse(degraded);
  assert.equal(parsed.mode, "degraded");
  assert.ok(parsed.degradation !== null);
  assert.equal(parsed.degradation!.retryable, true);
});

test("W1-16: topology invalidation event union", () => {
  const evt = learningObjectiveTopologyEventV2Schema.parse({
    kind: "objective_revision_published",
    objectiveId: OBJ,
    objectiveRevisionId: "77777777-7777-4777-8777-777777777777",
    revisionClass: "target_equivalent",
    originIds: ["66666666-6666-4666-8666-666666666666"],
  });
  assert.equal(evt.kind, "objective_revision_published");
  // lifecycle 事件必须带 lifecycleEpoch
  assert.equal(
    learningObjectiveTopologyEventV2Schema.safeParse({ kind: "objective_lifecycle_changed", objectiveId: OBJ, lifecycle: "archived" }).success,
    false,
  );
});

test("W1-18: V1 PublicLearningCardV2 stays byte-frozen (version 2, no surface leaks)", () => {
  const card = {
    version: 2,
    cardId: CARD,
    publicationRevision: 2,
    cardRevision: 2,
    objectiveId: OBJ,
    objectiveRevision: 1,
    lifecycle: "active",
    front: { cue: "cue", prompt: "prompt" },
    publicSummary: "summary",
    knowledgeForm: "causal_model",
    strategy: "recall",
    sourceLabel: null,
    createdAt: "2026-08-16T09:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
    publicPayloadHash: "a".repeat(64),
  };
  const parsed = publicLearningCardV2Schema.parse(card);
  assert.equal(parsed.version, 2);
  assert.deepEqual(findPrivatePayloadLeaks(parsed), []);
  // version 必须保持字面量 2；不得悄悄升到 3
  assert.equal(
    publicLearningCardV2Schema.safeParse({ ...card, version: 3 }).success,
    false,
  );
});
