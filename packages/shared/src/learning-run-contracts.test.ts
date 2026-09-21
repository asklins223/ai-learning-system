/**
 * LearningRun V1 合同 strict/negative 测试（文档 16 §22 P0 Gate：
 * "共享合同通过 strict schema/negative tests；没有第二套 API/写路径获准进入后续阶段"）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artifactPayloadSchema,
  assessmentPublicSchema,
  canonicalLearningEventEnvelopeSchema,
  createLearningRunRequestSchema,
  getLearningRunResultResponseSchema,
  learningRunActionRequestSchema,
  learningRunActionResponseSchema,
  learningRunOriginSchema,
  learningRunPublicSchema,
  learningRunResultSchema,
  learningRunReturnContractSchema,
  practiceTrailEventSchema,
  putLearningTaskDraftRequestSchema,
  submitTaskArtifactSchema,
  submitTaskArtifactReceiptSchema,
  learningTaskPublicSchema,
  taskInteractionSchema,
} from "./learning-run-contracts.ts";

const uuid = () => crypto.randomUUID();

// ─── happy path fixtures ─────────────────────────────────────────────────

function makeOrigin() {
  return { kind: "card", cardId: uuid(), keyPointId: uuid() };
}

function makeTask() {
  return {
    version: 1,
    taskId: uuid(),
    runId: uuid(),
    sequence: 1,
    intent: "explain",
    prompt: "用自己的话解释这个观点为什么成立。",
    targetSummary: "目标要点摘要",
    activeVariant: {
      variantId: "variant-1",
      purpose: "formal",
      interaction: { kind: "text_response", maxChars: 2000 },
      templateTrustCeiling: "mastery_eligible",
      estimatedActiveSeconds: 60,
      publicPayloadHash: "pub-hash-1",
      inputSchemaHash: "in-hash-1",
      disclosureProfileHash: "disc-hash-1",
      revision: 1,
    },
    availableAlternatives: [
      {
        alternativeId: "alt-voice",
        family: "voice",
        interactionKind: "voice_teachback",
        estimatedActiveSeconds: 50,
        maximumPurpose: "formal",
      },
    ],
    assistancePolicy: { hintLevels: 3, exposureLowersTrust: true },
    status: "active",
    revision: 1,
  };
}

function makeRunPublic(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId: uuid(),
    workspaceId: uuid(),
    userId: uuid(),
    assistantSessionId: null,
    origin: makeOrigin(),
    returnTarget: { kind: "card", cardId: uuid(), keyPointId: uuid() },
    target: { kind: "key_point", keyPointId: uuid(), fingerprint: "fp-1" },
    projectionBaselineCheckpoint: null,
    goal: "stabilize",
    schedulePolicySummary: {
      kind: "create_on_canonical_outcome",
      eligibleOutcomes: ["demonstrated", "declared_unable"],
    },
    phase: "active",
    timeBudgetSeconds: 180,
    plannedActiveSeconds: 60,
    activeSecondsUsed: 0,
    planningClosesAtActiveSecond: 150,
    activeTaskId: null,
    taskSummaries: [],
    activeTask: null,
    activeAssessment: null,
    checkpoint: null,
    failure: null,
    projectionStatus: "not_requested",
    revision: 1,
    runtimeEpoch: 1,
    eventCursor: 0,
    result: null,
    ...overrides,
  };
}

test("createLearningRunRequestSchema 接受合法 card origin", () => {
  const parsed = createLearningRunRequestSchema.parse({
    version: 1,
    origin: makeOrigin(),
    goal: "stabilize",
    requestedTimeBudgetSeconds: 120,
    responsePreference: "voice",
    clientRequestId: "client-1",
    idempotencyKey: "idem-1",
  });
  assert.equal(parsed.origin.kind, "card");
  assert.equal(parsed.requestedTimeBudgetSeconds, 120);
});

test("createLearningRunRequestSchema 拒绝未知字段（strict）", () => {
  const input = {
    version: 1,
    origin: makeOrigin(),
    goal: "stabilize",
    clientRequestId: "client-1",
    idempotencyKey: "idem-1",
    answerText: "泄题答案不应出现在请求",
  };
  const result = createLearningRunRequestSchema.safeParse(input);
  assert.equal(result.success, false);
});

test("createLearningRunRequestSchema 拒绝非法 goal / 越界预算", () => {
  assert.equal(
    createLearningRunRequestSchema.safeParse({
      version: 1,
      origin: makeOrigin(),
      goal: "memorize",
      clientRequestId: "c",
      idempotencyKey: "k",
    }).success,
    false,
  );
  assert.equal(
    createLearningRunRequestSchema.safeParse({
      version: 1,
      origin: makeOrigin(),
      goal: "repair",
      requestedTimeBudgetSeconds: 181,
      clientRequestId: "c",
      idempotencyKey: "k",
    }).success,
    false,
  );
});

test("learningRunOriginSchema 接受全部 5 种 origin 并拒绝非法", () => {
  assert.equal(learningRunOriginSchema.parse({ kind: "today", keyPointId: uuid() }).kind, "today");
  assert.equal(
    learningRunOriginSchema.safeParse({ kind: "today", keyPointId: uuid(), extra: 1 }).success,
    false,
  );
  assert.equal(
    learningRunOriginSchema.safeParse({ kind: "card", cardId: uuid(), keyPointId: "not-uuid" }).success,
    false,
  );
  // review 必须带 generation
  assert.equal(
    learningRunOriginSchema.safeParse({ kind: "review", scheduleId: uuid(), keyPointId: uuid() }).success,
    false,
  );
});

test("artifactPayloadSchema 接受 text/voice/declared_unable 并拒绝非结构化 stringify", () => {
  assert.equal(artifactPayloadSchema.parse({ kind: "text", text: "答案" }).kind, "text");
  assert.equal(
    artifactPayloadSchema.parse({
      kind: "voice",
      confirmedTranscript: "逐字转写",
      voiceArtifactRef: "voice-ref",
    }).kind,
    "voice",
  );
  assert.equal(
    artifactPayloadSchema.safeParse({ kind: "declared_unable", reasonCode: "cannot_recall" }).success,
    true,
  );
  // 结构化答案被 JSON.stringify 塞进 text 是合法的 text（无法在 wire 拒绝），
  // 但伪装成结构化的字段必须被拒——payload 必须判别式合法：
  assert.equal(
    artifactPayloadSchema.safeParse({ kind: "ordering", orderedTokenIds: [] }).success,
    false,
  );
  assert.equal(
    artifactPayloadSchema.safeParse({ kind: "ordering", orderedTokenIds: ["a"], interactionRefs: [], extra: true }).success,
    false,
  );
});

test("submitTaskArtifactSchema 校验 CAS 字段与 idempotencyKey", () => {
  const parsed = submitTaskArtifactSchema.parse({
    version: 1,
    variantId: "v1",
    variantRevision: 1,
    runRevision: 3,
    taskRevision: 2,
    inputSchemaHash: "in-hash",
    payload: { kind: "text", text: "回答" },
    baseArtifactId: uuid(),
    baseRevision: 1,
    idempotencyKey: "idem-sub",
  });
  assert.equal(parsed.runRevision, 3);
  assert.equal(
    submitTaskArtifactSchema.safeParse({
      version: 1,
      variantId: "v1",
      variantRevision: 1,
      runRevision: 3,
      taskRevision: 2,
      inputSchemaHash: "in-hash",
      payload: { kind: "text", text: "回答" },
      idempotencyKey: "idem-sub",
      // 客户端不得传入答案之外的调试字段
      privateSolution: "leak",
    }).success,
    false,
  );
});

test("submitTaskArtifactReceiptSchema 固定 locked+queued 形状", () => {
  const receipt = submitTaskArtifactReceiptSchema.parse({
    version: 1,
    runId: uuid(),
    taskId: uuid(),
    artifactId: uuid(),
    artifactRevision: 1,
    artifactStatus: "locked",
    assessment: { assessmentId: uuid(), status: "queued" },
    runRevision: 4,
    taskRevision: 2,
    eventCursor: 7,
  });
  assert.equal(receipt.artifactStatus, "locked");
  assert.equal(
    submitTaskArtifactReceiptSchema.safeParse({
      ...receipt,
      artifactStatus: "draft",
    }).success,
    false,
  );
});

test("assessmentPublicSchema：非终态不得携带 rubric/trust/report；终态必须带 reportHash", () => {
  const base = {
    version: 1,
    assessmentId: uuid(),
    runId: uuid(),
    taskId: uuid(),
    artifactId: uuid(),
    source: "assessment_critic",
    status: "queued",
    rubricResults: [],
    trustClass: null,
    reportHash: null,
  };
  assert.equal(assessmentPublicSchema.parse(base).status, "queued");
  assert.equal(
    assessmentPublicSchema.safeParse({
      ...base,
      rubricResults: [{ rubricItemId: "r1", facet: "explain", verdict: "covered", userFacingReason: "ok" }],
    }).success,
    false,
  );
  assert.equal(
    assessmentPublicSchema.safeParse({ ...base, status: "completed", reportHash: null }).success,
    false,
  );
  assert.equal(
    assessmentPublicSchema.parse({
      ...base,
      status: "completed",
      rubricResults: [],
      reportHash: "report-hash",
    }).status,
    "completed",
  );
});

test("learningRunPublicSchema：activeTask 与 activeTaskId 一致；预算约束；拒绝未知字段", () => {
  const run = makeRunPublic();
  assert.equal(learningRunPublicSchema.parse(run).phase, "active");

  const taskId = uuid();
  const withTask = makeRunPublic({
    activeTaskId: taskId,
    taskSummaries: [{ taskId, sequence: 1, intent: "explain", status: "active", estimatedActiveSeconds: 60 }],
    activeTask: { ...makeTask(), taskId, runId: run.runId },
  });
  assert.equal(learningRunPublicSchema.parse(withTask).activeTaskId, taskId);

  // activeTaskId 非空但 activeTask 为空 → 违反 §12.1
  assert.equal(
    learningRunPublicSchema.safeParse(makeRunPublic({ activeTaskId: uuid() })).success,
    false,
  );
  // plannedActiveSeconds 超过 timeBudgetSeconds
  assert.equal(
    learningRunPublicSchema.safeParse(
      makeRunPublic({ timeBudgetSeconds: 30, plannedActiveSeconds: 60 }),
    ).success,
    false,
  );
  // 未知字段
  assert.equal(
    learningRunPublicSchema.safeParse({ ...run, privateRubric: "leak" }).success,
    false,
  );
});

test("learningRunResultSchema：scheduleImpact 只有 created/rescheduled 是学习结算", () => {
  const result = {
    outcome: "demonstrated",
    demonstratedFacets: ["explain"],
    gapFacets: [],
    scheduleImpact: { kind: "created", dueAt: "2026-08-20T00:00:00Z", policyReason: "demonstrated" },
    returnTarget: { kind: "card", cardId: uuid(), keyPointId: uuid() },
  };
  assert.equal(learningRunResultSchema.parse(result).scheduleImpact.kind, "created");
  assert.equal(
    learningRunResultSchema.safeParse({
      ...result,
      scheduleImpact: { kind: "rescheduled", dueAt: "x", policyReason: "demonstrated" },
    }).success,
    false,
  );
  // none 分支必须有 reasonCode
  assert.equal(
    learningRunResultSchema.safeParse({
      ...result,
      scheduleImpact: { kind: "none" },
    }).success,
    false,
  );
});

test("learningRunActionRequestSchema：action union 严格、epoch/revision 必填", () => {
  const base = {
    version: 1,
    runRevision: 2,
    runtimeEpoch: 1,
    idempotencyKey: "k",
  };
  assert.equal(learningRunActionRequestSchema.parse({ ...base, action: { kind: "pause" } }).action.kind, "pause");
  // skip_task 已于 2026-09-20 删除（与 skip_run 产生逐字节相同的终态，用户面前
  // 摆了两个同义按钮）。这里断言它**被拒绝**而不是被忽略：陈旧客户端不能
  // 静默把"无痕跳过"当成合法动作送进来。
  assert.equal(
    learningRunActionRequestSchema.safeParse({
      ...base,
      taskRevision: 1,
      action: { kind: "skip_task", taskId: uuid() },
    }).success,
    false,
  );
  // end 必须显式 abandonLockedEvidence
  assert.equal(
    learningRunActionRequestSchema.safeParse({ ...base, action: { kind: "end" } }).success,
    false,
  );
  // declared_unable 不走 action（只走 submission）
  assert.equal(
    learningRunActionRequestSchema.safeParse({ ...base, action: { kind: "declared_unable" } }).success,
    false,
  );
  // 未知动作
  assert.equal(
    learningRunActionRequestSchema.safeParse({ ...base, action: { kind: "approve_mastery" } }).success,
    false,
  );
});

test("learningRunActionResponseSchema：hint_revealed 携带 exposure 与 practice_only ceiling", () => {
  const response = {
    version: 1,
    acceptedActionId: "action-1",
    actionResult: {
      kind: "hint_revealed",
      hintId: "h1",
      level: 1,
      text: "提示文本",
      exposureEventId: "exp-1",
      resultingTrustCeiling: "practice_only",
    },
    snapshot: makeRunPublic(),
  };
  assert.equal(learningRunActionResponseSchema.parse(response).actionResult.kind, "hint_revealed");
  assert.equal(
    learningRunActionResponseSchema.safeParse({
      ...response,
      actionResult: { ...response.actionResult, resultingTrustCeiling: "mastery_eligible" },
    }).success,
    false,
  );
});

test("getLearningRunResultResponseSchema 三分支判别", () => {
  assert.equal(
    getLearningRunResultResponseSchema.parse({ status: "pending", httpStatus: 202, phase: "assessing", revision: 3 }).status,
    "pending",
  );
  assert.equal(
    getLearningRunResultResponseSchema.safeParse({
      status: "pending",
      httpStatus: 200,
      phase: "assessing",
      revision: 3,
    }).success,
    false,
  );
});

test("putLearningTaskDraftRequestSchema：CAS expectedDraftRevision 可空、payload 可空", () => {
  assert.equal(
    putLearningTaskDraftRequestSchema.parse({
      version: 1,
      variantId: "v1",
      variantRevision: 1,
      taskRevision: 1,
      expectedDraftRevision: null,
      payload: null,
      rendererState: { kind: "text", selectionStart: 0, selectionEnd: 3 },
      idempotencyKey: "k",
    }).payload,
    null,
  );
  // draft 允许不完整 payload（§12.7），但 kind 必须合法
  assert.equal(
    putLearningTaskDraftRequestSchema.safeParse({
      version: 1,
      variantId: "v1",
      variantRevision: 1,
      taskRevision: 1,
      expectedDraftRevision: null,
      payload: { kind: "structured_bundle", partAnswers: [] },
      rendererState: { kind: "structured", activePartId: null, focusedElementId: null },
      idempotencyKey: "k",
    }).success,
    false,
  );
});

test("canonicalLearningEventEnvelopeSchema：等长、≤2、无重复、1..2 长度", () => {
  const base = {
    version: 1,
    canonicalEventId: "evt-1",
    eventHash: "h",
    commitId: uuid(),
    workspaceId: uuid(),
    userId: uuid(),
    runId: uuid(),
    taskIds: [uuid()],
    artifactIds: [uuid()],
    keyPointId: uuid(),
    targetFingerprint: "fp",
    fact: { kind: "initial_validation", factId: "f1", disposition: "mastery_evidence" },
    assessments: [{ source: "assessment_critic", assessmentId: uuid(), reportHash: "rh", trustClass: "mastery_eligible" }],
    occurredAt: new Date().toISOString(),
  };
  assert.equal(canonicalLearningEventEnvelopeSchema.parse(base).taskIds.length, 1);

  const two = {
    ...base,
    taskIds: [uuid(), uuid()],
    artifactIds: [uuid(), uuid()],
    assessments: [
      { source: "assessment_critic", assessmentId: uuid(), reportHash: "rh1", trustClass: "facet_eligible" },
      { source: "assessment_critic", assessmentId: uuid(), reportHash: "rh2", trustClass: "facet_eligible" },
    ],
  };
  assert.equal(canonicalLearningEventEnvelopeSchema.parse(two).taskIds.length, 2);

  // 3 个 task → V1 上限拒绝
  assert.equal(
    canonicalLearningEventEnvelopeSchema.safeParse({
      ...base,
      taskIds: [uuid(), uuid(), uuid()],
      artifactIds: [uuid(), uuid(), uuid()],
      assessments: [1, 2, 3].map(() => ({
        source: "assessment_critic",
        assessmentId: uuid(),
        reportHash: "rh",
        trustClass: "mastery_eligible",
      })),
    }).success,
    false,
  );
  // 等长破坏
  assert.equal(
    canonicalLearningEventEnvelopeSchema.safeParse({ ...base, artifactIds: [] }).success,
    false,
  );
  // 重复 taskId
  const dup = uuid();
  assert.equal(
    canonicalLearningEventEnvelopeSchema.safeParse({
      ...two,
      taskIds: [dup, dup],
    }).success,
    false,
  );
});

test("practiceTrailEventSchema：reasons 至少一个、scope 二元", () => {
  const ok = {
    version: 1,
    practiceEventId: "p-1",
    eventHash: "h",
    workspaceId: uuid(),
    userId: uuid(),
    runId: uuid(),
    taskIds: [uuid()],
    keyPointId: uuid(),
    targetFingerprint: "fp",
    artifactIds: [uuid()],
    scope: "official_user",
    reasons: ["hint_used"],
    occurredAt: new Date().toISOString(),
    expiresAt: null,
  };
  assert.equal(practiceTrailEventSchema.parse(ok).reasons[0], "hint_used");
  assert.equal(practiceTrailEventSchema.safeParse({ ...ok, scope: "official" }).success, false);
  assert.equal(practiceTrailEventSchema.safeParse({ ...ok, reasons: [] }).success, false);
});

test("learningRunReturnContractSchema：五种状态分支判别", () => {
  assert.equal(
    learningRunReturnContractSchema.parse({
      version: 1,
      status: "run_active",
      runPhase: "active",
      returnTarget: { kind: "today" },
    }).status,
    "run_active",
  );
  assert.equal(
    learningRunReturnContractSchema.parse({
      version: 1,
      status: "no_projection_change",
      sourceChange: { kind: "none" },
      returnTarget: { kind: "today" },
    }).status,
    "no_projection_change",
  );
  // ready 必须携带 changeSetId
  assert.equal(
    learningRunReturnContractSchema.safeParse({
      version: 1,
      status: "ready",
      sourceChange: { kind: "canonical", canonicalEventId: "e1" },
      targetCheckpoint: { version: 1, workspaceId: uuid(), userId: uuid(), token: "t", capturedAt: "2026-08-13T00:00:00Z" },
      returnTarget: { kind: "today" },
    }).success,
    false,
  );
});

test("taskInteractionSchema：structured_bundle 长度 1–2", () => {
  const part = {
    kind: "ordering",
    partId: "p1",
    publicTokenIds: ["a", "b"],
    publicTokenLabels: { a: "第一步", b: "第二步" },
    partTrustCeiling: "facet_eligible",
    qualificationProfileHash: null,
  };
  const one = taskInteractionSchema.parse({ kind: "structured_bundle", parts: [part] });
  assert.ok(one.kind === "structured_bundle");
  assert.equal(one.parts.length, 1);
  assert.equal(one.parts[0].kind, "ordering");
  assert.equal(one.parts[0].publicTokenLabels?.a, "第一步");
  const two = taskInteractionSchema.parse({
    kind: "structured_bundle",
    parts: [part, { ...part, partId: "p2" }],
  });
  assert.ok(two.kind === "structured_bundle");
  assert.equal(two.parts.length, 2);
  assert.equal(
    taskInteractionSchema.safeParse({ kind: "structured_bundle", parts: [part, { ...part, partId: "p2" }, { ...part, partId: "p3" }] }).success,
    false,
  );
  assert.equal(
    taskInteractionSchema.safeParse({ kind: "structured_bundle", parts: [] }).success,
    false,
  );
  assert.equal(
    taskInteractionSchema.safeParse({
      kind: "structured_bundle",
      parts: [{ ...part, labels: { a: "不属于公开合同" } }],
    }).success,
    false,
  );
});

test("learningTaskPublicSchema：assistancePolicy 固定 exposureLowersTrust=true", () => {
  const task = makeTask();
  assert.equal(learningTaskPublicSchema.parse(task).assistancePolicy.exposureLowersTrust, true);
  assert.equal(
    learningTaskPublicSchema.safeParse({
      ...task,
      assistancePolicy: { hintLevels: 3, exposureLowersTrust: false },
    }).success,
    false,
  );
});

test("artifactPayloadSchema：voice 支持 §7.5 correctionMethod（none/re_recorded/manual_text_edit）", () => {
  const base = { kind: "voice", confirmedTranscript: "间隔重复能降低遗忘率" };
  assert.equal(artifactPayloadSchema.safeParse(base).success, true);
  assert.equal(
    artifactPayloadSchema.safeParse({ ...base, correctionMethod: "manual_text_edit" }).success,
    true,
  );
  assert.equal(
    artifactPayloadSchema.safeParse({ ...base, correctionMethod: "re_recorded" }).success,
    true,
  );
  // 非法值拒绝
  assert.equal(artifactPayloadSchema.safeParse({ ...base, correctionMethod: "auto_edited" }).success, false);
});
