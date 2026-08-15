/**
 * run-planner / run-view 纯函数测试（P2 纵切：不依赖 DB）。
 *
 * 覆盖：预算 clamp、goal→intent 映射、text/voice 双 Variant 闭包、hash 确定性、
 * 公开题面不泄露 evidence 内容、runPlanHash/contractHash 可重放、公开视图
 * 不包含 private solution/rubric 字段、schedulePolicySummary 投影。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDeterministicHint,
  buildTaskPrompt,
  clampTimeBudget,
  computeRunContractHash,
  planRun,
  sha256Hex,
  type RunPlannerTargetInput,
} from "./run-planner.ts";
import {
  buildRunPublicView,
  buildSchedulePolicySummary,
  type RunViewInput,
} from "./run-view.ts";
import { learningRunPublicSchema } from "@ailearn/shared";

const target: RunPlannerTargetInput = {
  keyPointId: "11111111-1111-4111-8111-111111111111",
  claim: "艾宾浩斯遗忘曲线表明复习间隔决定长期记忆",
  sourceFingerprint: "fp-1",
  evidenceContentHashes: [sha256Hex("evidence-quote")],
};

function baseOptions() {
  return {
    runId: "22222222-2222-4222-8222-222222222222",
    goal: "stabilize" as const,
    responsePreference: "text" as const,
    timeBudgetSeconds: 180,
  };
}

test("clampTimeBudget：undefined→180，越界夹紧 30..180", () => {
  assert.equal(clampTimeBudget(undefined), 180);
  assert.equal(clampTimeBudget(10), 30);
  assert.equal(clampTimeBudget(500), 180);
  assert.equal(clampTimeBudget(90), 90);
});

test("planRun：恰好一个 Task，text 主 Variant + voice 备选，闭包完整", () => {
  const plan = planRun(target, baseOptions());
  assert.equal(plan.tasks.length, 1);
  const task = plan.tasks[0];
  assert.equal(task.intent, "explain");
  assert.equal(task.purpose, "formal");
  assert.equal(task.templateTrustCeiling, "mastery_eligible");
  assert.equal(plan.primaryVariant.interaction.kind, "text_response");
  assert.equal(plan.alternativeVariant.interaction.kind, "voice_teachback");
  // 两个 variant 都有独立 private/safety/disclosure 闭包
  for (const variant of [plan.primaryVariant, plan.alternativeVariant]) {
    const closure = plan.closures[variant.variantId];
    assert.ok(closure, `closure for ${variant.variantId}`);
    assert.equal(closure.solution.kind, "open_response");
    assert.equal(closure.safetyReport.activationDecision, "allowed");
    assert.ok(closure.reportHash.length > 0);
  }
  assert.ok(plan.runPlanHash.length > 0);
  assert.ok(plan.plannedActiveSeconds <= 180);
});

test("planRun：公开题面只含 claim，不泄露 evidence 内容与 solution", () => {
  const plan = planRun(target, baseOptions());
  const serialized = JSON.stringify({
    prompt: plan.tasks[0].prompt,
    interaction: plan.primaryVariant.interaction,
    alternatives: [],
  });
  assert.ok(serialized.includes(target.claim));
  assert.ok(!serialized.includes("evidence-quote"));
  assert.ok(!serialized.includes("rubric"));
  assert.ok(!serialized.includes("expectedTarget"));
});

test("buildTaskPrompt：recall intent 题面不得内嵌 claim 原文（§7.3 泄题防护）", () => {
  const claim = "珠穆朗玛峰海拔 8848 米";
  assert.ok(!buildTaskPrompt("recall", "先回想", claim).includes(claim));
  assert.ok(!buildTaskPrompt("recall", "先回想", claim).includes("8848"));
  // 解释/举例题给出观点是合理题面。
  assert.ok(buildTaskPrompt("explain", "解释为什么成立", claim).includes(claim));
});

test("planRun：goal 映射 intent（clarify→paraphrase、transfer→apply、explore→example）", () => {
  assert.equal(planRun(target, { ...baseOptions(), goal: "clarify" }).tasks[0].intent, "paraphrase");
  assert.equal(planRun(target, { ...baseOptions(), goal: "transfer" }).tasks[0].intent, "apply");
  assert.equal(planRun(target, { ...baseOptions(), goal: "explore" }).tasks[0].intent, "example");
  assert.equal(planRun(target, { ...baseOptions(), goal: "repair" }).tasks[0].intent, "explain");
});

test("planRun：responsePreference=voice 时主 Variant 为 voice", () => {
  const plan = planRun(target, { ...baseOptions(), responsePreference: "voice" });
  assert.equal(plan.primaryVariant.interaction.kind, "voice_teachback");
  assert.equal(plan.alternativeVariant.interaction.kind, "text_response");
});

test("planRun：确定性可重放（同输入同 runId 时 hash 一致）", () => {
  const a = planRun(target, baseOptions());
  const b = planRun(target, baseOptions());
  // taskId 随机（幂等由 idempotency 表保证），但 runPlanHash 结构确定性。
  assert.equal(a.primaryVariant.publicPayloadHash, b.primaryVariant.publicPayloadHash);
  assert.equal(a.primaryVariant.inputSchemaHash, b.primaryVariant.inputSchemaHash);
});

test("computeRunContractHash：字段参与哈希且确定性", () => {
  const base = {
    runId: "r1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    keyPointId: "33333333-3333-4333-8333-333333333333",
    targetFingerprint: "fp",
    runtimeEpoch: 0,
    timeBudgetSeconds: 180,
    planningClosesAtActiveSecond: 150,
    schedulingAuthorization: { kind: "create_initial", keyPointId: "k", targetFingerprint: "fp", schedulerPolicyId: "p" },
    taskPlanHash: "plan",
    projectionBaselineCheckpointToken: null,
  };
  assert.equal(computeRunContractHash(base), computeRunContractHash(base));
  assert.notEqual(
    computeRunContractHash(base),
    computeRunContractHash({ ...base, schedulingAuthorization: { kind: "no_effect", reasonCode: "practice" } }),
  );
});

test("buildDeterministicHint：按 intent/level 给出结构引导，不包含 claim 正文", () => {
  const hint = buildDeterministicHint({ intent: "explain" }, 1);
  assert.ok(hint.length > 0);
  assert.ok(!hint.includes("遗忘曲线"));
  const hint3 = buildDeterministicHint({ intent: "explain" }, 3);
  assert.ok(hint3.length > 0);
  assert.notEqual(hint, hint3);
});

test("buildSchedulePolicySummary：授权投影为公开摘要", () => {
  assert.deepEqual(
    buildSchedulePolicySummary({ kind: "create_initial", keyPointId: "k", targetFingerprint: "fp", schedulerPolicyId: "p" }),
    { kind: "create_on_canonical_outcome", eligibleOutcomes: ["demonstrated", "declared_unable"] },
  );
  assert.deepEqual(
    buildSchedulePolicySummary({ kind: "consume_pending", scheduleId: "s", scheduleGeneration: 2, keyPointId: "k", targetFingerprint: "fp", dueAt: "x", schedulerPolicyId: "p" }),
    {
      kind: "consume_on_canonical_outcome",
      scheduleId: "s",
      scheduleGeneration: 2,
      eligibleOutcomes: ["demonstrated", "declared_unable"],
    },
  );
  assert.deepEqual(
    buildSchedulePolicySummary({ kind: "no_effect", reasonCode: "sandbox" }),
    { kind: "no_schedule_effect", reasonCode: "sandbox" },
  );
});

function makeViewInput(): RunViewInput {
  const plan = planRun(target, baseOptions());
  const task = plan.tasks[0];
  return {
    run: {
      id: "22222222-2222-4222-8222-222222222222",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      userId: "55555555-5555-4555-8555-555555555555",
      assistantSessionId: null,
      origin: { kind: "card", cardId: "66666666-6666-4666-8666-666666666666", keyPointId: target.keyPointId },
      returnTarget: { kind: "card", cardId: "66666666-6666-4666-8666-666666666666", keyPointId: target.keyPointId },
      keyPointId: target.keyPointId,
      targetFingerprint: "fp-1",
      goal: "stabilize",
      phase: "active",
      timeBudgetSeconds: 180,
      plannedActiveSeconds: plan.plannedActiveSeconds,
      activeSecondsUsed: 0,
      activeTaskId: task.taskId,
      checkpoint: null,
      failure: null,
      projectionStatus: "not_requested",
      projectionBaselineCheckpointToken: null,
      revision: 1,
      runtimeEpoch: 0,
      eventCursor: 4,
      result: null,
    },
    tasks: [{
      id: task.taskId,
      runId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
      intent: task.intent,
      prompt: task.prompt,
      targetSummary: task.targetSummary,
      hintLevels: task.hintLevels,
      status: "active",
      revision: 1,
      activeVariantId: plan.primaryVariant.variantId,
    }],
    variants: [
      {
        id: plan.primaryVariant.variantId,
        taskId: task.taskId,
        purpose: "formal",
        templateTrustCeiling: "mastery_eligible",
        estimatedActiveSeconds: task.estimatedActiveSeconds,
        interaction: plan.primaryVariant.interaction,
        publicPayloadHash: plan.primaryVariant.publicPayloadHash,
        inputSchemaHash: plan.primaryVariant.inputSchemaHash,
        disclosureProfileHash: plan.primaryVariant.disclosureProfileHash,
        revision: 1,
        status: "active",
        alternativeFamily: null,
      },
      {
        id: plan.alternativeVariant.variantId,
        taskId: task.taskId,
        purpose: "formal",
        templateTrustCeiling: "mastery_eligible",
        estimatedActiveSeconds: task.estimatedActiveSeconds,
        interaction: plan.alternativeVariant.interaction,
        publicPayloadHash: plan.alternativeVariant.publicPayloadHash,
        inputSchemaHash: plan.alternativeVariant.inputSchemaHash,
        disclosureProfileHash: plan.alternativeVariant.disclosureProfileHash,
        revision: 1,
        status: "standby",
        alternativeFamily: null,
      },
    ],
    assessment: null,
    baselineCheckpoint: null,
    schedulingAuthorization: { kind: "create_initial", keyPointId: target.keyPointId, targetFingerprint: "fp-1", schedulerPolicyId: "p" },
  };
}

test("buildRunPublicView：输出通过 strict public schema 校验", () => {
  const view = buildRunPublicView(makeViewInput());
  const parsed = learningRunPublicSchema.safeParse(view);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? [] : parsed.error.issues));
});

test("buildRunPublicView：activeTask 完整合同 + 备选 descriptors", () => {
  const view = buildRunPublicView(makeViewInput());
  assert.ok(view.activeTask);
  assert.equal(view.activeTask.activeVariant.interaction.kind, "text_response");
  assert.equal(view.activeTask.availableAlternatives.length, 1);
  assert.equal(view.activeTask.availableAlternatives[0].family, "voice");
  assert.equal(view.activeTask.assistancePolicy.exposureLowersTrust, true);
});

test("buildRunPublicView：无 activeTaskId 时 activeTask 为 null（未激活不预取 payload）", () => {
  const input = makeViewInput();
  input.run.activeTaskId = null;
  const view = buildRunPublicView(input);
  assert.equal(view.activeTask, null);
  assert.equal(view.taskSummaries.length, 1);
  assert.equal(view.taskSummaries[0].status, "active");
});

test("buildRunPublicView：serialized 输出不包含 private solution/rubric/evidence hash", () => {
  const view = buildRunPublicView(makeViewInput());
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes("rubric"));
  assert.ok(!serialized.includes("expectedTarget"));
  assert.ok(!serialized.includes("privateSolution"));
  assert.ok(!serialized.includes("evidenceContentHash"));
});

test("§7.8 题面轮换：hash 纳入题面 prompt，不同角度 → 不同 publicPayloadHash", () => {
  const planA = planRun(target, baseOptions());
  const planB = planRun(target, baseOptions());
  // 无 avoid 集：两次都用第一个角度 → hash 相同（确定性）。
  assert.equal(planA.primaryVariant.publicPayloadHash, planB.primaryVariant.publicPayloadHash);
  // 同角度下 text/voice 备选 hash 不同（interaction 不同）。
  assert.notEqual(planA.primaryVariant.publicPayloadHash, planA.alternativeVariant.publicPayloadHash);
});

test("§7.8 题面轮换：avoid 集包含当前角度时选未呈现角度", () => {
  const first = planRun(target, baseOptions());
  const avoid = new Set([
    first.primaryVariant.publicPayloadHash,
    first.alternativeVariant.publicPayloadHash,
  ]);
  const rotated = planRun(target, { ...baseOptions(), recentPublicPayloadHashes: avoid });
  assert.notEqual(
    rotated.primaryVariant.publicPayloadHash,
    first.primaryVariant.publicPayloadHash,
    "rotate 后主 Variant hash 必须变化",
  );
  assert.notEqual(
    rotated.alternativeVariant.publicPayloadHash,
    first.alternativeVariant.publicPayloadHash,
  );
  // 新角度生成的不同 prompt（不可能是同义词替换的相同 hash）。
  assert.notEqual(rotated.tasks[0].prompt, first.tasks[0].prompt);
});

test("§7.8 题面轮换：角度池耗尽时复用第一个（候选耗尽语义）", () => {
  // 模拟三个角度全部呈现过：逐一收集 hash 后全量 avoid。
  const collected: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const plan = planRun(target, { ...baseOptions(), recentPublicPayloadHashes: new Set(collected) });
    collected.push(plan.primaryVariant.publicPayloadHash, plan.alternativeVariant.publicPayloadHash);
  }
  const exhausted = planRun(target, { ...baseOptions(), recentPublicPayloadHashes: new Set(collected) });
  assert.equal(
    exhausted.primaryVariant.publicPayloadHash,
    planRun(target, baseOptions()).primaryVariant.publicPayloadHash,
    "全部呈现过 → 复用第一个角度",
  );
});

test("§7.7 qualification：无记录 → practice；facet 审批记录 → facet_eligible", () => {
  const noQual = planRun(target, { ...baseOptions(), responsePreference: "structured" });
  assert.equal(noQual.tasks[0].purpose, "practice");
  assert.equal(noQual.tasks[0].templateTrustCeiling, "practice_only");

  const qualified = planRun(target, {
    ...baseOptions(),
    responsePreference: "structured",
    interactionQualifications: new Map([[
      "structured_bundle",
      { approvedCeiling: "facet_eligible", expiresAt: null },
    ]]),
  });
  assert.equal(qualified.tasks[0].purpose, "facet");
  assert.equal(qualified.tasks[0].templateTrustCeiling, "facet_eligible");
});
