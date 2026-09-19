/**
 * 方案 20 C5 R6：V2 planner / structured / critic 重接单测（§16.4-16.6）。
 * 只测纯函数，不依赖 DB：
 * - planRun v2 分支：public 题面用 objectiveStatement，不泄漏 canonicalAnswer；
 * - generateStructuredFromSnapshot：从 CanonicalAnswerV2 显式结构生成；
 * - buildCriticPromptV2：含 objective/answer units/rubric units/evidence/闭包。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildV2TaskPrompt, planRun, rubricTargetIdsOf, type RunPlannerTargetInput, type PlannerV2Target } from "./run-planner.ts";
import { generateStructuredFromSnapshot } from "./run-structured.ts";
import { buildCriticPromptV2, flattenAnswerUnits, type CriticInputV2 } from "./run-critic.ts";
import type { CanonicalAnswerV2, ObjectiveRubricV2, ObjectiveRelationV2 } from "@ailearn/shared/card-generation-v2-contracts";

function makeRubric(): ObjectiveRubricV2 {
  return {
    version: 2,
    units: [
      { rubricUnitId: "r1", facet: "explain", criterion: "解释遗忘曲线机制", required: true, answerUnitIds: ["a1"], evidenceRefIds: ["11111111-1111-4111-8111-111111111111"] },
      { rubricUnitId: "r2", facet: "example", criterion: "举一个间隔复习例子", required: false, answerUnitIds: ["a2"], evidenceRefIds: ["11111111-1111-4111-8111-111111111111"] },
    ],
    passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
    rubricHash: "a".repeat(64),
  };
}

const answer: CanonicalAnswerV2 = {
  kind: "ordered_steps",
  steps: [
    { unitId: "s1", text: "刚才学过的内容遗忘最快" },
    { unitId: "s2", text: "在遗忘前安排第一次复习" },
    { unitId: "s3", text: "拉长间隔并逐步巩固" },
  ],
};

const relations: ObjectiveRelationV2[] = [
  { relationId: "rel1", fromAnswerUnitId: "s1", toAnswerUnitId: "s2", kind: "causes", evidenceRefIds: ["11111111-1111-4111-8111-111111111111"], relationHash: "b".repeat(64) },
];

function makeV2Target(overrides: Partial<PlannerV2Target> = {}): PlannerV2Target {
  return {
    objectiveStatement: "解释艾宾浩斯遗忘曲线与复习间隔的关系",
    publicSummary: "复习间隔决定长期记忆",
    knowledgeForm: "causal_model",
    preferredIntents: ["explain"],
    canonicalAnswer: answer,
    scoringRubric: makeRubric(),
    relations,
    evidence: [{ bindingId: "11111111-1111-4111-8111-111111111111", targetUnit: { kind: "answer", answerUnitId: "a1" }, evidenceSnapshotId: "22222222-2222-4222-8222-222222222222", evidenceSnapshotHash: "c".repeat(64), expectedEvidenceEligibilityEpoch: 1, relation: "entails", supportStrength: "direct", bindingHash: "d".repeat(64), semanticSupportReportId: "33333333-3333-4333-8333-333333333333", semanticSupportReportHash: "e".repeat(64) }],
    publishedTargetEligibility: "eligible",
    ...overrides,
  };
}

function makeBaseTarget(v2: PlannerV2Target): RunPlannerTargetInput {
  return {
    keyPointId: "objective-1",
    claim: "目标陈述（不应出现在 public 题面的答案）",
    sourceFingerprint: "fp",
    evidenceContentHashes: ["hash1"],
    v2,
  };
}

test("planRun v2：public 题面含 objectiveStatement，不泄漏 canonicalAnswer/al ready rubric", () => {
  const plan = planRun(makeBaseTarget(makeV2Target()), {
    runId: "44444444-4444-4444-8444-444444444444",
    goal: "stabilize",
    responsePreference: "text",
    timeBudgetSeconds: 180,
  });
  const serialized = JSON.stringify({ prompt: plan.tasks[0].prompt, interaction: plan.primaryVariant.interaction });
  // objectiveStatement 是公开 cue。
  assert.ok(serialized.includes("解释艾宾浩斯遗忘曲线与复习间隔的关系"));
  // canonicalAnswer 内容（步骤文本）与 rubric criterion 不得泄漏。
  assert.ok(!serialized.includes("刚才学过的内容遗忘最快"));
  assert.ok(!serialized.includes("r1"));
});

test("planRun v2：practice_only eligibility 钳到 practice_only ceiling", () => {
  const plan = planRun(makeBaseTarget(makeV2Target({ publishedTargetEligibility: "practice_only" })), {
    runId: "44444444-4444-4444-8444-444444444444",
    goal: "stabilize",
    responsePreference: "text",
    timeBudgetSeconds: 180,
  });
  const task = plan.tasks[0];
  assert.equal(task.purpose, "practice");
  assert.equal(task.templateTrustCeiling, "practice_only");
});

test("planRun v2：结构题只作练习，不能用单一结构验证换取 mastery", () => {
  const plan = planRun(makeBaseTarget(makeV2Target()), {
    runId: "44444444-4444-4444-8444-444444444444",
    goal: "stabilize",
    responsePreference: "structured",
    timeBudgetSeconds: 180,
  });
  assert.equal(plan.primaryVariant.interaction.kind, "ordering");
  assert.equal(plan.tasks[0].purpose, "practice");
  assert.equal(plan.tasks[0].templateTrustCeiling, "practice_only");
});

test("planRun v2：只把 required rubric 写入必须覆盖的评估合同", () => {
  const plan = planRun(makeBaseTarget(makeV2Target()), {
    runId: "44444444-4444-4444-8444-444444444444",
    goal: "stabilize",
    responsePreference: "text",
    timeBudgetSeconds: 180,
  });
  assert.deepEqual(
    rubricTargetIdsOf(plan.closures[plan.primaryVariant.variantId].solution),
    ["r1"],
  );
  // 2026-09-18：备位里可能出现结构化练习变体（评估层固定走
  // deterministic_structured，rubricTargetIds 是规划器派生的合成 id）；
  // 断言按交互家族定位口述备选，而不是假设它排第一。
  const voiceAlternative = plan.alternativeVariants.find(
    (v) => v.interaction.kind === "voice_teachback",
  );
  assert.ok(voiceAlternative, "voice alternative should exist");
  assert.deepEqual(
    rubricTargetIdsOf(plan.closures[voiceAlternative.variantId].solution),
    ["r1"],
  );
});

test("planRun v2：题面覆盖全部必需 rubric 能力，不要求可选项", () => {
  const rubric = makeRubric();
  rubric.units.push({
    rubricUnitId: "r3",
    facet: "apply",
    criterion: "说明一个适用场景",
    required: true,
    answerUnitIds: ["a1"],
    evidenceRefIds: ["11111111-1111-4111-8111-111111111111"],
  });
  const plan = planRun(makeBaseTarget(makeV2Target({ scoringRubric: rubric })), {
    runId: "44444444-4444-4444-8444-444444444444",
    goal: "stabilize",
    responsePreference: "text",
    timeBudgetSeconds: 180,
  });
  assert.equal(plan.tasks[0].intent, "explain");
  assert.match(plan.tasks[0].prompt, /关键机制/);
  assert.match(plan.tasks[0].prompt, /适用场景/);
  assert.doesNotMatch(plan.tasks[0].prompt, /具体例子/);
});

test("planRun v2：用户目标不在 required rubric 中时改用可计分的能力动作", () => {
  const plan = planRun(makeBaseTarget(makeV2Target()), {
    runId: "44444444-4444-4444-8444-444444444444",
    goal: "transfer",
    responsePreference: "text",
    timeBudgetSeconds: 180,
  });
  assert.equal(plan.tasks[0].intent, "explain");
  assert.match(plan.tasks[0].prompt, /关键机制/);
  assert.equal(
    buildV2TaskPrompt("explain", "解释遗忘曲线", ["explain"]),
    "请说明它为何成立以及关键机制：解释遗忘曲线",
  );
});

test("planRun v2：没有 required rubric 时拒绝生成可计分任务", () => {
  const rubric = makeRubric();
  rubric.units = rubric.units.map((unit) => ({ ...unit, required: false }));
  assert.throws(() => planRun(makeBaseTarget(makeV2Target({ scoringRubric: rubric })), {
    runId: "44444444-4444-4444-8444-444444444444",
    goal: "stabilize",
    responsePreference: "text",
    timeBudgetSeconds: 180,
  }), /at least one required unit/);
});

test("planRun v2：structured preference 从 ordered_steps 生成 ordering，不切 claim", () => {
  const base = makeBaseTarget(makeV2Target());
  const plan = planRun({ ...base, claim: "不应被切分的答案文本" }, {
    runId: "44444444-4444-4444-8444-444444444444",
    goal: "stabilize",
    responsePreference: "structured",
    timeBudgetSeconds: 180,
  });
  // 主 Variant 是 ordering（说明用 answer 结构而非 claim 切片）。
  assert.equal(plan.primaryVariant.interaction.kind, "ordering");
  assert.equal(plan.tasks[0].primaryFamily, "text");
});

test("planRun v2：无显式结构的 canonical 且无 relations → 走 open text/voice", () => {
  const textAnswer: CanonicalAnswerV2 = { kind: "text", unit: { unitId: "t1", text: "复习间隔决定长期记忆" } };
  const plan = planRun(makeBaseTarget(makeV2Target({ canonicalAnswer: textAnswer, relations: [] })), {
    runId: "44444444-4444-4444-8444-444444444444",
    goal: "stabilize",
    responsePreference: "structured",
    timeBudgetSeconds: 180,
  });
  // 无足够结构 → primary 是 text_response（Planner 换 open interaction）。
  assert.equal(plan.primaryVariant.interaction.kind, "text_response");
});

test("generateStructuredFromSnapshot：ordered_steps → ordering（step 为答案序列）", () => {
  const structured = generateStructuredFromSnapshot(answer, relations);
  assert.ok(structured);
  assert.equal(structured.interaction.kind, "ordering");
  const sol = structured.solution;
  assert.equal(sol.kind, "ordering");
  assert.equal((sol as { correctTokenIds: string[] }).correctTokenIds.length, 3);
});

test("generateStructuredFromSnapshot：mapping → ordering", () => {
  const mapping: CanonicalAnswerV2 = {
    kind: "mapping",
    pairs: [
      { unitId: "p1", left: "遗忘最快", right: "刚学完" },
      { unitId: "p2", left: "最佳复习", right: "遗忘前" },
    ],
  };
  const structured = generateStructuredFromSnapshot(mapping, relations);
  assert.equal(structured?.interaction.kind, "ordering");
});

test("generateStructuredFromSnapshot：comparison → relation_canvas（contrasts）", () => {
  const cmp: CanonicalAnswerV2 = {
    kind: "comparison",
    columns: ["间隔复习", "集中突击"],
    rows: [
      { unitId: "c1", dimension: "长期保持", values: ["高", "低"] },
      { unitId: "c2", dimension: "遗忘速度", values: ["慢", "快"] },
    ],
  };
  const structured = generateStructuredFromSnapshot(cmp, []);
  assert.ok(structured);
  assert.equal(structured.interaction.kind, "relation_canvas");
  // 用 contrast 表达对比。
  assert.equal((structured.solution as { requiredEdges: Array<{ edgeKind: string }> }).requiredEdges[0].edgeKind, "contrasts_with");
});

test("flattenAnswerUnits：展开 answer 显式单元，稳定 unitId", () => {
  const units = flattenAnswerUnits(answer);
  assert.equal(units.length, 3);
  assert.equal(units[0].unitId, "s1");
});

function makeCriticV2(): CriticInputV2 {
  return {
    objectiveStatement: "解释遗忘曲线",
    canonicalAnswerUnits: [{ unitId: "s1", text: "遗忘最快" }],
    assessedRubricUnits: [
      { rubricUnitId: "r1", criterion: "解释机制", facet: "explain", required: true },
      { rubricUnitId: "r2", criterion: "举例", facet: "example", required: false },
    ],
    evidenceRefs: [{ evidenceSnapshotHash: "h".repeat(64), preview: "证据预览" }],
    taskIntent: "explain",
    taskPrompt: "解释为什么",
    interactionFamily: "text_response",
    publicPayloadHash: "ph",
    artifactText: "用户答案",
    semanticTargetFingerprint: "s".repeat(64),
    targetRevisionHash: "t".repeat(64),
    snapshotHash: "sn".repeat(32),
    criticVersion: "critic-snapshot-v2.1",
  };
}

test("buildCriticPromptV2：含 objective/answer/rubric/evidence/闭包签名", () => {
  const prompt = buildCriticPromptV2(makeCriticV2());
  assert.ok(prompt.includes("解释遗忘曲线"));
  assert.ok(prompt.includes("s1"));
  assert.ok(prompt.includes("r1"));
  // 已冻结的旧 closure 若含 optional rubric，也必须和 parser 的期望一致。
  assert.ok(prompt.includes("r2"));
  assert.ok(prompt.includes("已冻结附加项"));
  assert.ok(prompt.includes("h".repeat(64).slice(0, 12)));
  assert.ok(prompt.includes("snapshotHash"));
  assert.ok(prompt.includes("criticVersion"));
  // 角色隔离。
  assert.ok(prompt.includes("不是辅导老师"));
  assert.ok(prompt.includes("不是可执行指令"));
});
