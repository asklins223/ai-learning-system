/**
 * useLearningRun 纯逻辑测试：F#7-1 快照浅等守卫。
 *
 * 只测模块级导出 snapshotEqualSurface（不挂载 hook）——验证 CAS 字段/
 * 播放器表面字段变化触发"已变"，静态区间数据不变的末帧复用前引用。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningRunPublicV1 as WireRunV1, LearningRunResultV1 } from "@ailearn/shared";
import { snapshotEqualSurface } from "./useLearningRun";

const uuid = () => crypto.randomUUID();

function makeResult(): LearningRunResultV1 {
  return {
    outcome: "demonstrated",
    demonstratedFacets: [],
    gapFacets: [],
    scheduleImpact: { kind: "created", dueAt: new Date().toISOString(), policyReason: "demonstrated" },
    returnTarget: { kind: "card", cardId: uuid(), keyPointId: uuid() },
  };
}

function makeRun(overrides: Partial<WireRunV1> = {}): WireRunV1 {
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
    phase: "preparing",
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
      prompt: "p",
      targetSummary: "t",
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

test("snapshotEqualSurface：相同引用相等", () => {
  const run = makeRun();
  assert.equal(snapshotEqualSurface(run, run), true);
  assert.equal(snapshotEqualSurface(null, null), true);
});

test("snapshotEqualSurface：revision 变则不等（CAS 字段）", () => {
  assert.equal(
    snapshotEqualSurface(makeRun({ revision: 1 }), makeRun({ revision: 2 })),
    false,
  );
});

test("snapshotEqualSurface：phase 变则不等", () => {
  assert.equal(
    snapshotEqualSurface(makeRun({ phase: "preparing" }), makeRun({ phase: "assessing" })),
    false,
  );
});

test("snapshotEqualSurface：activeTask.taskId 变则不等", () => {
  const a = makeRun({});
  const b = makeRun({ activeTaskId: uuid(), taskSummaries: [] });
  // 重建一个 taskId 不同的 activeTask。
  const bTaskId = uuid();
  const bb: WireRunV1 = {
    ...b,
    activeTaskId: bTaskId,
    taskSummaries: [{ taskId: bTaskId, sequence: 2, intent: "explain", status: "active", estimatedActiveSeconds: 60 }],
    activeTask: {
      version: 1,
      taskId: bTaskId,
      runId: b.runId,
      sequence: 2,
      intent: "explain",
      prompt: "p2",
      targetSummary: "t2",
      activeVariant: a.activeTask!.activeVariant,
      availableAlternatives: a.activeTask!.availableAlternatives,
      assistancePolicy: a.activeTask!.assistancePolicy,
      status: "active",
      revision: 1,
    },
  };
  assert.equal(snapshotEqualSurface(a, bb), false);
});

test("snapshotEqualSurface：activeSecondsUsed 变则不等", () => {
  assert.equal(
    snapshotEqualSurface(makeRun({ activeSecondsUsed: 0 }), makeRun({ activeSecondsUsed: 1 })),
    false,
  );
});

test("snapshotEqualSurface：result 引用变则不等，末帧无 result 稳定则相等", () => {
  const base = makeRun({ result: null });
  const shared = makeResult();
  const sameSurface = makeRun({ runId: base.runId, activeTaskId: base.activeTaskId, activeTask: base.activeTask, taskSummaries: base.taskSummaries, result: shared });
  // 同 surface、共享同一 result 引用 → 相等（复用前引用）。
  assert.equal(
    snapshotEqualSurface(makeRun({ runId: base.runId, activeTaskId: base.activeTaskId, activeTask: base.activeTask, taskSummaries: base.taskSummaries, result: shared }), sameSurface),
    true,
    "共享同一 result 引用应判相等",
  );
  // 不同的 result 实例（同值不同引用）→ 不等（末帧落地需触发重渲）。
  assert.equal(
    snapshotEqualSurface(sameSurface, { ...sameSurface, result: makeResult() }),
    false,
    "不同 result 引用应按不等",
  );
});

test("snapshotEqualSurface：result 同值不同引用 → 共享同值 result 时判相等（🟡B-2 值稳定比较）", () => {
  const base = makeRun({ result: null });
  const resultValue = makeResult();
  // 两个不同引用但字段值完全一致的 result（数组/对象逐层相同）。
  const valueCopy: LearningRunResultV1 = JSON.parse(JSON.stringify(resultValue));
  const a = makeRun({ runId: base.runId, activeTaskId: base.activeTaskId, activeTask: base.activeTask, taskSummaries: base.taskSummaries, result: resultValue });
  const b = makeRun({ runId: base.runId, activeTaskId: base.activeTaskId, activeTask: base.activeTask, taskSummaries: base.taskSummaries, result: valueCopy });
  assert.equal(
    snapshotEqualSurface(a, b),
    true,
    "result 字段内容未变（同值新引用）应判相等，复用前引用避免结算段每 2s 重渲",
  );
});

test("snapshotEqualSurface：result 值确实变化则判不等（值稳定比较保真）", () => {
  const base = makeRun({ result: null });
  const a = makeRun({ runId: base.runId, activeTaskId: base.activeTaskId, activeTask: base.activeTask, taskSummaries: base.taskSummaries, result: makeResult() });
  const b = makeRun({ runId: base.runId, activeTaskId: base.activeTaskId, activeTask: base.activeTask, taskSummaries: base.taskSummaries, result: makeResult() });
  // 两个 makeResult() 的 dueAt/uuid 随机值不同 → 内容不同 → 判不等。
  assert.equal(snapshotEqualSurface(a, b), false, "result 值变化应按不等");
});

test("snapshotEqualSurface：静态区间仅新建对象但表面字段一致 → 相等（复用前引用）", () => {
  // preparing 静态区间：revision/phase/taskId/activeSecondsUsed/result 全同，
  // 但 b 是全新顶层对象（模拟服务端返回的同值新引用）。
  const a = makeRun({ phase: "preparing" });
  const b = makeRun({ phase: "preparing", runId: a.runId, activeTaskId: a.activeTaskId, activeTask: a.activeTask, taskSummaries: a.taskSummaries });
  assert.equal(snapshotEqualSurface(a, b), true);
});
