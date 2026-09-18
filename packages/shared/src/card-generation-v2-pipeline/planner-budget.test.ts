/**
 * §8.5 计划预算合同回归（2026-09-17 修复"内容全过 critic 却交付不了"）。
 *
 * 缺陷形态（dev 实测 run `4ffcbf37`，fixture `micro-bound-get-vs-post`：
 * 34 字 micro-note）：
 *   1. planner 从可学原子池直接生成 objectives，`recommendedCardCount = 池大小 (4)`，
 *      而 `activationHardMax = min(20, micro上限 3, 客户端上限, 池大小) = 3`；
 *   2. 于是产出的 plan **违反自身 schema**——`cardPlanV2Schema.superRefine`
 *      明确要求 `recommendedCardCount ≤ activationHardMax`，但 handler 持久化
 *      plan 时不再复校验，违约静默流入下游；
 *   3. author 按"整池"出 4 张卡（注释声称 budget = activationHardMax，实现没有），
 *      4 张全部通过 grounding + pedagogy；
 *   4. deck gate 判 `count_out_of_plan`（hard）→ **整条 run 进 needs_attention**。
 *
 * 本测试同时钉住三件事：预算内截断、plan 通过合同校验、author 不越预算。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executePlanner,
  budgetedPlanObjectives,
  DeterministicAuthoringProvider,
  MICRO_NOTE_MAX_CARDS,
  type SourceBlockInput,
} from "./index.ts";
import { cardPlanV2Schema } from "../card-generation-v2-contracts.ts";
import type { ExtractedKnowledgeAtom } from "./planner-service.ts";

function blocks(content: string): SourceBlockInput[] {
  return [{ blockId: "blk-1", type: "paragraph", content, ordinal: 0 }];
}

function inputSnapshot(runId: string) {
  return {
    version: 2 as const,
    generationRunId: runId,
    workspaceId: "ws-00000000-0000-4000-8000-000000000001",
    idempotencyKey: `key-${runId}`,
    rawRequest: {
      version: 2 as const,
      noteVersionId: "nv-00000000-0000-4000-8000-000000000001",
      sourceScope: { kind: "whole_note" as const },
      learningGoal: "understand" as const,
      detailThreshold: "balanced" as const,
      quantity: { kind: "adaptive" as const },
      clientRequestId: "req-001",
    },
    sourceSnapshot: {
      sourceSnapshotId: "ss-00000000-0000-4000-8000-000000000001",
      noteId: "n-00000000-0000-4000-8000-000000000001",
      noteVersionId: "nv-00000000-0000-4000-8000-000000000001",
      sourceSnapshotHash: "a".repeat(64),
      sourceContentHash: "b".repeat(64),
      blockManifestHash: "c".repeat(64),
      assetManifestHash: "d".repeat(64),
      scopeManifestHash: "e".repeat(64),
    },
    semanticSpecHash: "f".repeat(64),
    generationFingerprint: "1".repeat(64),
    cardContentEpoch: 1,
    inputSnapshotHash: "2".repeat(64),
  };
}

function semanticSpec() {
  return {
    version: 2 as const,
    semanticRequest: {
      sourceScope: { kind: "whole_note" as const },
      learningGoal: "understand" as const,
      detailThreshold: "balanced" as const,
      quantity: { kind: "adaptive" as const },
    },
    policies: {
      plannerPolicyVersion: "planner-v1",
      deterministicGateVersion: "gate-v1",
      evidencePolicyVersion: "evidence-v1",
      targetPolicyVersion: "target-v1",
      cardContractVersion: "learning-card-v2" as const,
      targetSnapshotVersion: "learning-target-snapshot-v2" as const,
      stageRuntimes: [{
        stage: "planner" as const,
        providerId: "system",
        modelSnapshot: "v1",
        deploymentId: "local",
        capabilityFingerprint: "basic",
        promptVersion: "v1",
        sampling: { temperature: 0 },
        outputSchemaVersion: "v2",
      }],
    },
    governancePolicyVersion: "gov-v1",
    semanticSpecHash: "f".repeat(64),
  };
}

/** 直接给定原子池的 provider——把测试聚焦在"预算"这一步，不掺入提取启发式。 */
function stubProvider(atoms: ExtractedKnowledgeAtom[]) {
  return { extractAtoms: async () => ({ atoms }) };
}

function atoms(count: number): ExtractedKnowledgeAtom[] {
  return Array.from({ length: count }, (_, i) => ({
    atomId: `atom-${i + 1}`,
    proposition: `第 ${i + 1} 个可独立判分的知识命题`,
    evidenceRefIds: [],
    sourceSectionKeys: [],
    importanceBps: 8_000,
    learnabilityBps: 8_000,
    confidenceBps: 8_000,
    knowledgeFormHint: "definition" as const,
  }));
}

async function planFor(atomCount: number, clientHardMaxCards?: number) {
  const runId = "11111111-1111-4111-8111-111111111111";
  return executePlanner({
    runId,
    workspaceId: "ws-00000000-0000-4000-8000-000000000001",
    inputSnapshot: inputSnapshot(runId) as never,
    semanticSpec: semanticSpec() as never,
    blocks: blocks("微笔记内容，用于触发 micro-note 上限。"),
    existingObjectives: [],
    clientHardMaxCards,
    extractionProvider: stubProvider(atoms(atomCount)) as never,
  });
}

test("§8.5：目标数超出预算时按预算截断，且计划满足自身 schema", async () => {
  // micro-note 上限（§8.6：1–2 张）：10 个可学原子 → 只允许 MICRO_NOTE_MAX_CARDS 个目标。
  // 这里显式钉住策略值本身，使"改上限"必须是一次有意识的改动。
  assert.equal(MICRO_NOTE_MAX_CARDS, 2, "§8.6：micro-note 上限应为 2（1–2 张）");
  const { plan } = await planFor(10);
  assert.equal(plan.result.kind, "author_candidates");
  if (plan.result.kind !== "author_candidates") return;

  assert.equal(plan.result.activationHardMax, MICRO_NOTE_MAX_CARDS);
  assert.equal(plan.result.objectives.length, MICRO_NOTE_MAX_CARDS, "目标数必须被截断到预算内");
  assert.equal(plan.result.recommendedCardCount, MICRO_NOTE_MAX_CARDS);
  assert.ok(
    plan.result.recommendedCardCount <= plan.result.activationHardMax,
    "recommendedCardCount 不得超过 activationHardMax（schema superRefine 的硬要求）",
  );

  // 最关键的一条：计划必须通过合同校验（修复前这里必然失败）。
  const parsed = cardPlanV2Schema.safeParse(plan);
  assert.equal(
    parsed.success,
    true,
    `plan 必须满足 cardPlanV2Schema：${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`,
  );

  // 被截断的原子要显式记账，审计上能回答"为什么没成卡"。
  const overBudget = plan.atomDecisions.filter((d) => d.decision === "omit_over_budget");
  assert.equal(overBudget.length, 10 - MICRO_NOTE_MAX_CARDS, "超预算的原子应记 omit_over_budget");
  assert.equal(
    plan.atomDecisions.filter((d) => d.decision === "create_objective").length,
    MICRO_NOTE_MAX_CARDS,
    "create_objective 的原子数必须与 objectives 一致（不得出现悬空决策）",
  );
});

test("§8.5：客户端 hardMaxCards 同样约束目标数", async () => {
  const { plan } = await planFor(10, 2);
  if (plan.result.kind !== "author_candidates") throw new Error("expected author_candidates");
  assert.equal(plan.result.activationHardMax, 2);
  assert.equal(plan.result.objectives.length, 2);
  assert.equal(cardPlanV2Schema.safeParse(plan).success, true);
});

test("§8.5：预算内的目标全部出卡，author 不得越预算", async () => {
  const { plan } = await planFor(10);
  const budgeted = budgetedPlanObjectives(plan);
  assert.equal(budgeted.length, MICRO_NOTE_MAX_CARDS);

  const { executeAuthor } = await import("./author-service.ts");
  const result = await executeAuthor({
    runId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "ws-00000000-0000-4000-8000-000000000001",
    plan,
    sourceContent: "微笔记内容",
    semanticSpecHash: "f".repeat(64),
    provider: new DeterministicAuthoringProvider(),
  });
  assert.equal(result.candidates.length, MICRO_NOTE_MAX_CARDS, "候选数不得超过 activationHardMax");
  assert.deepEqual(
    result.candidates.map((c) => c.planObjectiveLocalId),
    budgeted.map((o) => o.objectiveLocalId),
    "候选必须与预算内目标一一对应且保序",
  );
});

test("§8.5：不超预算时行为不变（截断不误伤）", async () => {
  const { plan } = await planFor(2);
  if (plan.result.kind !== "author_candidates") throw new Error("expected author_candidates");
  assert.equal(plan.result.objectives.length, 2);
  assert.equal(
    plan.atomDecisions.filter((d) => d.decision === "omit_over_budget").length,
    0,
    "未超预算时不应产生 omit_over_budget",
  );
});
