/**
 * ui-adapter 纯函数测试（wire ↔ UI 映射，P3 生产接线）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningRunPublicV1 as WireRunV1 } from "@ailearn/shared";
import { adaptRunToUi, planUiIntent } from "./ui-adapter";

const uuid = () => crypto.randomUUID();

function makeWireRun(overrides: Partial<WireRunV1> = {}): WireRunV1 {
  const runId = uuid();
  const taskId = uuid();
  return {
    version: 1,
    runId,
    workspaceId: uuid(),
    userId: uuid(),
    assistantSessionId: null,
    origin: { kind: "card", cardId: uuid(), keyPointId: uuid() },
    returnTarget: { kind: "card", cardId: uuid(), keyPointId: uuid() },
    target: { kind: "key_point", keyPointId: uuid(), fingerprint: "fp" },
    projectionBaselineCheckpoint: null,
    goal: "stabilize",
    schedulePolicySummary: { kind: "create_on_canonical_outcome", eligibleOutcomes: ["demonstrated", "declared_unable"] },
    phase: "active",
    timeBudgetSeconds: 180,
    plannedActiveSeconds: 60,
    activeSecondsUsed: 0,
    planningClosesAtActiveSecond: 150,
    activeTaskId: taskId,
    taskSummaries: [{ taskId, sequence: 1, intent: "explain", status: "active", estimatedActiveSeconds: 60 }],
    activeTask: {
      version: 1,
      taskId,
      runId,
      sequence: 1,
      intent: "explain",
      prompt: "请解释为什么成立：遗忘曲线",
      targetSummary: "遗忘曲线",
      activeVariant: {
        variantId: "v1",
        purpose: "formal",
        interaction: { kind: "text_response", maxChars: 2000 },
        templateTrustCeiling: "mastery_eligible",
        estimatedActiveSeconds: 60,
        publicPayloadHash: "ph",
        inputSchemaHash: "ih",
        disclosureProfileHash: "dh",
        revision: 1,
      },
      availableAlternatives: [{ alternativeId: "v2", family: "voice", estimatedActiveSeconds: 60, maximumPurpose: "formal" }],
      assistancePolicy: { hintLevels: 2, exposureLowersTrust: true },
      status: "active",
      revision: 1,
    },
    activeAssessment: null,
    checkpoint: null,
    failure: null,
    projectionStatus: "not_requested",
    revision: 1,
    runtimeEpoch: 0,
    eventCursor: 4,
    result: null,
    ...overrides,
  };
}

test("adaptRunToUi：label 映射与 phase 文案", () => {
  const ui = adaptRunToUi(makeWireRun());
  assert.equal(ui.originLabel, "学习卡");
  assert.equal(ui.returnLabel, "返回学习卡");
  assert.equal(ui.keyPointTitle, "遗忘曲线");
  assert.equal(ui.phase, "active");
  assert.equal(ui.activeTask?.intent, "explain");
  assert.equal(ui.activeTask?.alternatives.length, 1);
  assert.equal(ui.activeTask?.alternatives[0].label, "用说的方式");
});

test("adaptRunToUi：not_assessable checkpoint 映射 0 副作用文案", () => {
  const ui = adaptRunToUi(makeWireRun({
    phase: "checkpoint",
    checkpoint: { kind: "not_assessable", allowedFollowupIds: [] },
    activeTask: null,
    activeTaskId: null,
  }));
  assert.equal(ui.checkpoint?.kind, "not_assessable");
  assert.ok(ui.checkpoint?.detail.includes("0 学习副作用"));
});

test("adaptRunToUi：result 映射（declared_unable + created schedule）", () => {
  const ui = adaptRunToUi(makeWireRun({
    phase: "completed",
    activeTask: null,
    activeTaskId: null,
    result: {
      outcome: "declared_unable",
      demonstratedFacets: [],
      gapFacets: [],
      scheduleImpact: { kind: "created", dueAt: "2026-08-14T00:00:00Z", policyReason: "declared_unable" },
      returnTarget: { kind: "card", cardId: uuid(), keyPointId: uuid() },
    },
  }));
  assert.equal(ui.result?.outcome, "declared_unable");
  assert.equal(ui.result?.scheduleImpact.kind, "created");
});

test("planUiIntent：pause/end/skip/hint 映射为动作", () => {
  const run = makeWireRun();
  assert.deepEqual(planUiIntent(run, { kind: "pause" }), { kind: "action", action: { kind: "pause" } });
  assert.deepEqual(planUiIntent(run, { kind: "end" }), { kind: "action", action: { kind: "end", abandonLockedEvidence: false } });
  assert.deepEqual(planUiIntent(run, { kind: "skip_task" }), { kind: "action", action: { kind: "skip_task", taskId: run.activeTask!.taskId } });
  assert.deepEqual(planUiIntent(run, { kind: "request_hint", level: 1 }), { kind: "action", action: { kind: "request_hint", level: 1 } });
});

test("planUiIntent：assessing 阶段 end 必须携带 abandonLockedEvidence", () => {
  const run = makeWireRun({ phase: "assessing" });
  const plan = planUiIntent(run, { kind: "end" });
  assert.equal(plan.kind, "action");
  if (plan.kind === "action") {
    assert.deepEqual(plan.action, { kind: "end", abandonLockedEvidence: true });
  }
});

test("planUiIntent：提交映射 text/voice/declared_unable 携带 variant 合同字段", () => {
  const run = makeWireRun();
  const textPlan = planUiIntent(run, { kind: "submit_text", text: "回答" });
  assert.equal(textPlan.kind, "submit");
  if (textPlan.kind === "submit") {
    assert.equal(textPlan.request.variantId, "v1");
    assert.equal(textPlan.request.payload.kind, "text");
  }
  const unablePlan = planUiIntent(run, { kind: "declare_unable" });
  assert.equal(unablePlan.kind, "submit");
  if (unablePlan.kind === "submit") {
    assert.equal(unablePlan.request.payload.kind, "declared_unable");
  }
});

test("planUiIntent：checkpoint 映射（not_assessable→finish_without_commit，partial→finish_current_evidence）", () => {
  const notAssessable = makeWireRun({
    phase: "checkpoint",
    checkpoint: { kind: "not_assessable", allowedFollowupIds: [] },
    activeTask: null,
    activeTaskId: null,
  });
  assert.deepEqual(planUiIntent(notAssessable, { kind: "finish_checkpoint" }), {
    kind: "action",
    action: { kind: "finish_without_commit" },
  });
  const partial = makeWireRun({
    phase: "checkpoint",
    checkpoint: { kind: "partial", allowedFollowupIds: [] },
    activeTask: null,
    activeTaskId: null,
  });
  assert.deepEqual(planUiIntent(partial, { kind: "checkpoint_primary" }), {
    kind: "action",
    action: { kind: "finish_current_evidence" },
  });
});

test("planUiIntent：P4 结构化提交映射为 wire payload", () => {
  const run = makeWireRun();
  assert.deepEqual(planUiIntent(run, { kind: "submit_ordering", orderedTokenIds: ["a", "b"] }), {
    kind: "submit",
    request: {
      version: 1,
      variantId: run.activeTask?.activeVariant.variantId ?? "",
      variantRevision: run.activeTask?.activeVariant.revision ?? 1,
      inputSchemaHash: run.activeTask?.activeVariant.inputSchemaHash ?? "",
      payload: { kind: "ordering", orderedTokenIds: ["a", "b"], interactionRefs: [] },
    },
  });
  assert.deepEqual(planUiIntent(run, { kind: "submit_repair", elementId: "el", replacementOptionId: "opt" }), {
    kind: "submit",
    request: {
      version: 1,
      variantId: run.activeTask?.activeVariant.variantId ?? "",
      variantRevision: run.activeTask?.activeVariant.revision ?? 1,
      inputSchemaHash: run.activeTask?.activeVariant.inputSchemaHash ?? "",
      payload: {
        kind: "repair",
        operations: [{ op: "replace", elementId: "el", replacementOptionId: "opt" }],
        interactionRefs: [],
      },
    },
  });
  assert.deepEqual(planUiIntent(run, { kind: "submit_relation", fromNodeId: "a", toNodeId: "b", edgeKind: "supports" }), {
    kind: "submit",
    request: {
      version: 1,
      variantId: run.activeTask?.activeVariant.variantId ?? "",
      variantRevision: run.activeTask?.activeVariant.revision ?? 1,
      inputSchemaHash: run.activeTask?.activeVariant.inputSchemaHash ?? "",
      payload: {
        kind: "relation",
        edges: [{ fromNodeId: "a", toNodeId: "b", edgeKind: "supports" }],
        interactionRefs: [],
      },
    },
  });
  // choice/scenario 仍 fail closed（§7.7 上限外）。
  assert.deepEqual(planUiIntent(run, { kind: "submit_choice_with_rationale", choiceId: "c", rationaleIds: [] }), { kind: "none" });
  assert.deepEqual(planUiIntent(run, { kind: "submit_scenario", choiceId: "c", cueIds: [] }), { kind: "none" });
});

test("§12.3 bundle：submit_structured_bundle → wire 原子提交 payload", () => {
  const run = makeWireRun();
  const partAnswers: Array<
    | { kind: "ordering"; orderedTokenIds: string[] }
    | { kind: "relation"; edges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: string }> }
  > = [
    { kind: "ordering", orderedTokenIds: ["a", "b"] },
    { kind: "relation", edges: [{ fromNodeId: "n1", toNodeId: "n2", edgeKind: "supports" }] },
  ];
  assert.deepEqual(planUiIntent(run, { kind: "submit_structured_bundle", partAnswers }), {
    kind: "submit",
    request: {
      version: 1,
      variantId: run.activeTask?.activeVariant.variantId ?? "",
      variantRevision: run.activeTask?.activeVariant.revision ?? 1,
      inputSchemaHash: run.activeTask?.activeVariant.inputSchemaHash ?? "",
      payload: { kind: "structured_bundle", partAnswers, interactionRefs: [] },
    },
  });
});

test("§12.7 bundle draft：双向映射（部分完成只存 draft）", () => {
  const { adaptDraftToWire, adaptWireDraftToUi } = require("./ui-adapter") as typeof import("./ui-adapter");
  const partial: any = {
    kind: "structured_bundle",
    partAnswers: [{ kind: "ordering", orderedTokenIds: ["a"] }],
  };
  const wire = adaptDraftToWire(partial);
  assert.equal(wire?.kind, "structured_bundle");
  assert.deepEqual((wire.payload as { partAnswers: unknown }).partAnswers, [{ kind: "ordering", orderedTokenIds: ["a"] }]);
  const restored = adaptWireDraftToUi(wire?.payload);
  assert.equal(restored?.kind, "structured_bundle");
  if (restored?.kind === "structured_bundle") {
    assert.equal(restored.partAnswers.length, 1);
  }
});
