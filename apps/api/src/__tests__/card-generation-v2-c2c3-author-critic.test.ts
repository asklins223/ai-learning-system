/**
 * 方案 20 C2/C3: Author + Critic 测试。
 *
 * 验证：
 * 1. DeterministicAuthoringProvider 正确生成 candidate；
 * 2. candidateRevisionHash 正确计算；
 * 3. deterministic grounding precheck 检测答案未 grounding；
 * 4. deterministic pedagogy precheck 检测 front 泄漏答案；
 * 5. final gates 阻断 hard issue；
 * 6. merge/dedup 正确合并。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  executeAuthor,
  DeterministicAuthoringProvider,
  extractAnswerText,
  frontLeaksAnswerVerbatimV2,
} from "@ailearn/shared/card-generation-v2-pipeline";
import {
  deterministicGroundingPrecheck,
  deterministicPedagogyPrecheck,
  runDeterministicFinalGates,
  mergeDuplicateCandidates,
} from "@ailearn/shared/card-generation-v2-pipeline";
import type {
  CardPlanV2,
  LearningCardCandidateRevisionV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import {
  computeCandidateRevisionHashV2,
  computeRubricHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";

// ─── Mock helpers ────────────────────────────────────────────────────────

function makeMockPlan(): CardPlanV2 {
  return {
    version: 2,
    planRevisionId: randomUUID(),
    runId: "r-00000000-0000-4000-8000-000000000001",
    inputSnapshotHash: "a".repeat(64),
    cardContentEpoch: 1,
    planVersion: 1,
    previousPlanRevisionId: null,
    result: {
      kind: "author_candidates",
      recommendedCardCount: 1,
      activationHardMax: 3,
      objectives: [{
        objectiveLocalId: "obj-1",
        objectiveStatement: "定义：分布式共识是指多个节点对某个值达成一致的协议。",
        priority: "critical",
        knowledgeForm: "definition",
        strategy: "recall",
        sourceAtomIds: ["atom-1"],
        reasonCodes: ["learnability-9000"],
        estimatedReviewCostSeconds: 60,
        changeContext: { kind: "create_new" },
      }],
      existingActions: [],
    },
    atomDecisions: [{
      atomId: "atom-1",
      decision: "create_objective",
      objectiveLocalId: "obj-1",
    }],
    planHash: "b".repeat(64),
  };
}

function makeMockCandidate(
  overrides: Partial<LearningCardCandidateRevisionV2> = {},
): LearningCardCandidateRevisionV2 {
  const base: Omit<LearningCardCandidateRevisionV2, "candidateRevisionHash"> = {
    version: 2,
    candidateRevisionId: randomUUID(),
    candidateId: randomUUID(),
    revision: 1,
    runId: "r-00000000-0000-4000-8000-000000000001",
    planRevisionId: randomUUID(),
    planVersion: 1,
    planHash: "b".repeat(64),
    cardContentEpoch: 1,
    planObjectiveLocalId: "obj-1",
    recommendation: { recommended: true, reasonCodes: ["test"] },
    derivedFromCandidateRevisions: [],
    objective: {
      objectiveStatement: "定义：分布式共识是指多个节点对某个值达成一致的协议。",
      publicSummary: "分布式共识定义",
      conceptLabel: "测试概念标题",
      knowledgeForm: "definition",
      preferredTaskIntents: ["recall"],
      canonicalAnswer: {
        kind: "text",
        unit: {
          unitId: "ans-1",
          text: "分布式共识是指多个节点对某个值达成一致的协议。",
        },
      },
      learningSupport: {
        explanation: "共识协议确保节点在分布式系统中达成一致。",
      },
      rubric: {
        version: 2,
        units: [{
          rubricUnitId: "rubric-1",
          facet: "recall",
          criterion: "能正确回答分布式共识的定义",
          required: true,
          answerUnitIds: ["ans-1"],
          evidenceRefIds: [],
        }],
        passingPolicy: {
          requireAllRequiredUnits: true,
          allowContradiction: false,
        },
        rubricHash: "c".repeat(64),
      },
      relations: [],
      difficulty: "introductory",
      evidenceRefIds: [],
    },
    presentation: {
      strategy: "recall",
      transformationKind: "retrieval_definition",
      front: {
        cue: "分布式共识",
        prompt: "请回答：什么是分布式共识？",
      },
      estimatedReviewSeconds: 60,
    },
    evidenceSetHash: "d".repeat(64),
  };
  const hash = computeCandidateRevisionHashV2(base);
  return { ...base, candidateRevisionHash: hash, ...overrides };
}

describe("C2: Author Service", () => {
  test("DeterministicAuthoringProvider generates valid candidate", async () => {
    const plan = makeMockPlan();
    const provider = new DeterministicAuthoringProvider();
    const result = await executeAuthor({
      runId: "r-00000000-0000-4000-8000-000000000001",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      plan,
      sourceContent: "分布式共识是指多个节点对某个值达成一致的协议。",
      semanticSpecHash: "f".repeat(64),
      provider,
    });
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    assert.ok(candidate.candidateRevisionHash.match(/^[0-9a-f]{64}$/));
    assert.equal(candidate.revision, 1);
    assert.equal(candidate.planObjectiveLocalId, "obj-1");
    assert.equal(candidate.objective.canonicalAnswer.kind, "text");
    assert.equal(candidate.presentation.strategy, "recall");
    // 2026-09-18：确定性 fallback 不再把目标陈述整句贴进正面/摘要（「题面即答案」
    // 的退化形态，库中 34 张已发布卡即此形态）。注意可达的不变量边界：当陈述本身
    // 就是答案时，从陈述派生的概念标题仍可能是答案的逐字片段 —— 「无模型就出不了
    // 正式卡」是本质，不是缺陷；发布侧 frontLeaksAnswerVerbatimV2 后闸兜底
    // （拦下即不出卡，不出假卡）。
    const statement = "定义：分布式共识是指多个节点对某个值达成一致的协议。";
    assert.equal(candidate.objective.objectiveStatement, statement);
    assert.notEqual(candidate.presentation.front.cue, statement.slice(0, 200));
    assert.notEqual(candidate.presentation.front.prompt, `请回答：${statement}`);
    assert.notEqual(candidate.objective.publicSummary, statement.slice(0, 200));
    // 兜底闸必须拦得住退化形态：正面整句照抄答案时判定为泄漏。
    const answerText = extractAnswerText(candidate.objective.canonicalAnswer);
    assert.equal(
      frontLeaksAnswerVerbatimV2(
        `请回答：${answerText}`, answerText, candidate.presentation.strategy,
      ),
      true,
    );
  });

  /**
   * 2026-09-20 实走复盘 #10：提示要**自带在卡片上**，且不得并进判分内容的审计链。
   * 前一条保证两张不同内容的卡拿到不同提示；后一条由 `hints` 不出现在候选对象上
   * 来保证——candidateRevisionHash 对整个候选对象取哈希。
   */
  test("每张卡带自己的提示，且提示不进入候选修订哈希的输入", async () => {
    async function authorFor(objectiveStatement: string, sourceContent: string) {
      const plan = makeMockPlan();
      if (plan.result.kind !== "author_candidates") throw new Error("plan must author candidates");
      plan.result.objectives[0].objectiveStatement = objectiveStatement;
      const result = await executeAuthor({
        runId: "r-00000000-0000-4000-8000-000000000001",
        workspaceId: "ws-00000000-0000-4000-8000-000000000001",
        plan,
        sourceContent,
        semanticSpecHash: "f".repeat(64),
        provider: new DeterministicAuthoringProvider(),
      });
      const candidate = result.candidates[0];
      return {
        candidate,
        hints: result.hintsByCandidateRevisionId.get(candidate.candidateRevisionId),
      };
    }

    const consensus = await authorFor(
      "定义：分布式共识是指多个节点对某个值达成一致的协议。",
      "分布式共识是指多个节点对某个值达成一致的协议。",
    );
    const backprop = await authorFor(
      "定义：反向传播是损失梯度从输出层逐层回传到各层参数的算法。",
      "反向传播是损失梯度从输出层逐层回传到各层参数的算法。",
    );

    assert.ok(consensus.hints, "作者必须同时交出提示，否则作答侧只能退回常量表");
    assert.ok(consensus.hints.level1.length > 0 && consensus.hints.level2.length > 0);
    assert.notEqual(consensus.hints.level2, backprop.hints?.level2,
      "两张不同内容的卡不应看到同一句提示");
    // 提示是候选行的兄弟列，不是候选对象的一部分。
    assert.equal("hints" in consensus.candidate, false,
      "hints 进了候选对象就会被算进 candidateRevisionHash");
  });

  test("returns empty for no_cards_recommended plan", async () => {
    const plan: CardPlanV2 = {
      ...makeMockPlan(),
      result: { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] },
    };
    const provider = new DeterministicAuthoringProvider();
    const result = await executeAuthor({
      runId: "r-00000000-0000-4000-8000-000000000001",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      plan,
      sourceContent: "",
      semanticSpecHash: "f".repeat(64),
      provider,
    });
    assert.equal(result.candidates.length, 0);
  });

  test("rubric hash is correctly computed", async () => {
    const plan = makeMockPlan();
    const provider = new DeterministicAuthoringProvider();
    const result = await executeAuthor({
      runId: "r-00000000-0000-4000-8000-000000000001",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      plan,
      sourceContent: "分布式共识是指多个节点对某个值达成一致的协议。",
      semanticSpecHash: "f".repeat(64),
      provider,
    });
    const candidate = result.candidates[0];
    const { rubricHash: _, ...rubricWithoutHash } = candidate.objective.rubric;
    const expectedHash = computeRubricHashV2(rubricWithoutHash);
    assert.equal(candidate.objective.rubric.rubricHash, expectedHash);
  });
});

describe("C3: Grounding Critic Precheck", () => {
  test("detects answer not grounded in source", () => {
    const candidate = makeMockCandidate({
      objective: {
        ...makeMockCandidate().objective,
        canonicalAnswer: {
          kind: "text",
          unit: {
            unitId: "ans-1",
            text: "量子力学是研究原子核内部结构的物理学分支。",
          },
        },
      },
    });
    const issues = deterministicGroundingPrecheck(candidate, "分布式共识是指多个节点对某个值达成一致的协议。");
    // 2026-08-16：按方案 20 §13.1「字符重合只能作为风险信号」，重叠检查降级
    // 为 soft——断言改为软信号而非 hard gate。
    const softIssues = issues.filter((i) => i.severity === "soft" && i.code === "answer_not_grounded");
    assert.ok(softIssues.length > 0, "should flag ungrounded answer as soft risk");
  });

  test("passes for grounded answer", () => {
    const candidate = makeMockCandidate();
    const issues = deterministicGroundingPrecheck(candidate, "分布式共识是指多个节点对某个值达成一致的协议。");
    const hardIssues = issues.filter((i) => i.severity === "hard");
    assert.equal(hardIssues.length, 0);
  });

  test("detects rubric referencing missing answer unit", () => {
    const candidate = makeMockCandidate({
      objective: {
        ...makeMockCandidate().objective,
        rubric: {
          ...makeMockCandidate().objective.rubric,
          units: [{
            ...makeMockCandidate().objective.rubric.units[0],
            answerUnitIds: ["nonexistent-unit"],
          }],
        },
      },
    });
    const issues = deterministicGroundingPrecheck(candidate, "some source");
    assert.ok(issues.some((i) => i.code === "rubric_references_missing_answer_unit"));
  });
});

describe("C3: Pedagogy Critic Precheck", () => {
  // 2026-08-24（AI 设计审查 §4.5 认识论分工）：改写式/照抄式泄题的子串匹配
  // 从 hard 降级为 soft 风险信号（surface_paraphrase_only）——语义裁决归
  // Pedagogy Critic 的冻结 code front_leaks_answer。
  test("flags front leaking answer as soft risk signal", () => {
    const candidate = makeMockCandidate({
      presentation: {
        ...makeMockCandidate().presentation,
        front: {
          cue: "test",
          prompt: "分布式共识是指多个节点对某个值达成一致的协议。",
        },
      },
    });
    const issues = deterministicPedagogyPrecheck(candidate, "source");
    assert.ok(issues.some((i) => i.code === "surface_paraphrase_only" && i.severity === "soft"));
  });

  test("detects cue identical to objective statement", () => {
    const candidate = makeMockCandidate({
      presentation: {
        ...makeMockCandidate().presentation,
        front: {
          cue: "定义：分布式共识是指多个节点对某个值达成一致的协议。",
          prompt: "请回答",
        },
      },
    });
    const issues = deterministicPedagogyPrecheck(candidate, "source");
    assert.ok(issues.some((i) => i.code === "cue_is_claim_copy"));
  });

  test("passes for good pedagogy", () => {
    const candidate = makeMockCandidate();
    const issues = deterministicPedagogyPrecheck(candidate, "source content here");
    const hardIssues = issues.filter((i) => i.severity === "hard");
    assert.equal(hardIssues.length, 0);
  });
});

describe("C3: Final Gates", () => {
  test("passes when all candidates pass critics", () => {
    const candidate = makeMockCandidate();
    const groundingReport = {
      reportId: "r1", reportType: "grounding" as const,
      candidateRevisionId: candidate.candidateRevisionId,
      candidateRevisionHash: candidate.candidateRevisionHash,
      inputHash: "d".repeat(64), version: 2, reportHash: "",
      issues: [], verdict: "passed" as const, gateVersion: "v1",
    };
    const pedagogyReport = { ...groundingReport, reportType: "pedagogy" as const, reportId: "r2" };
    const plan = makeMockPlan();
    const result = runDeterministicFinalGates(
      [candidate], [groundingReport], [pedagogyReport],
      { planRevisionId: plan.planRevisionId, planVersion: plan.planVersion, planHash: plan.planHash, runId: plan.runId },
      3,
    );
    assert.ok(result.passed);
    assert.equal(result.gateReport.finalCount, 1);
  });

  test("fails when candidate fails grounding", () => {
    const candidate = makeMockCandidate();
    const groundingReport = {
      reportId: "r1", reportType: "grounding" as const,
      candidateRevisionId: candidate.candidateRevisionId,
      candidateRevisionHash: candidate.candidateRevisionHash,
      inputHash: "d".repeat(64), version: 2, reportHash: "",
      issues: [{ code: "bad", severity: "hard" as const, detail: "test" }],
      verdict: "failed" as const, gateVersion: "v1",
    };
    const pedagogyReport = {
      reportId: "r2", reportType: "pedagogy" as const,
      candidateRevisionId: candidate.candidateRevisionId,
      candidateRevisionHash: candidate.candidateRevisionHash,
      inputHash: "d".repeat(64), version: 2, reportHash: "",
      issues: [], verdict: "passed" as const, gateVersion: "v1",
    };
    const plan = makeMockPlan();
    const result = runDeterministicFinalGates(
      [candidate], [groundingReport], [pedagogyReport],
      { planRevisionId: plan.planRevisionId, planVersion: plan.planVersion, planHash: plan.planHash, runId: plan.runId },
      3,
    );
    assert.ok(!result.passed);
    assert.ok(result.gateReport.issues.some((i) => i.code === "candidate_revision_mismatch"));
  });

  test("detects semantic duplicates", () => {
    const candidate1 = makeMockCandidate();
    const candidate2 = makeMockCandidate({
      candidateId: randomUUID(),
      candidateRevisionId: randomUUID(),
    });
    // Same objective statement
    const groundingReport = {
      reportId: "r1", reportType: "grounding" as const,
      candidateRevisionId: candidate1.candidateRevisionId,
      candidateRevisionHash: candidate1.candidateRevisionHash,
      inputHash: "d".repeat(64), version: 2, reportHash: "",
      issues: [], verdict: "passed" as const, gateVersion: "v1",
    };
    const pedagogyReport = {
      reportId: "r2", reportType: "pedagogy" as const,
      candidateRevisionId: candidate1.candidateRevisionId,
      candidateRevisionHash: candidate1.candidateRevisionHash,
      inputHash: "d".repeat(64), version: 2, reportHash: "",
      issues: [], verdict: "passed" as const, gateVersion: "v1",
    };
    const groundingReport2 = { ...groundingReport, candidateRevisionId: candidate2.candidateRevisionId, candidateRevisionHash: candidate2.candidateRevisionHash };
    const pedagogyReport2 = { ...pedagogyReport, candidateRevisionId: candidate2.candidateRevisionId, candidateRevisionHash: candidate2.candidateRevisionHash };
    const plan = makeMockPlan();
    const result = runDeterministicFinalGates(
      [candidate1, candidate2], [groundingReport, groundingReport2], [pedagogyReport, pedagogyReport2],
      { planRevisionId: plan.planRevisionId, planVersion: plan.planVersion, planHash: plan.planHash, runId: plan.runId },
      3,
    );
    assert.ok(!result.passed);
    assert.ok(result.gateReport.issues.some((i) => i.code === "semantic_duplicate"));
  });
});

describe("C3: Merge/Dedup", () => {
  test("merges candidates with same objective statement", () => {
    const c1 = makeMockCandidate();
    const c2 = makeMockCandidate({
      candidateId: randomUUID(),
      candidateRevisionId: randomUUID(),
    });
    const { merged, mergeMap } = mergeDuplicateCandidates([c1, c2]);
    assert.equal(merged.length, 1);
    assert.equal(mergeMap.size, 1);
    assert.equal(mergeMap.get(c2.candidateId), c1.candidateId);
  });

  test("does not merge candidates with different statements", () => {
    const c1 = makeMockCandidate();
    const c2 = makeMockCandidate({
      candidateId: randomUUID(),
      candidateRevisionId: randomUUID(),
      objective: {
        ...c1.objective,
        objectiveStatement: "不同的目标声明",
      },
    });
    const { merged, mergeMap } = mergeDuplicateCandidates([c1, c2]);
    assert.equal(merged.length, 2);
    assert.equal(mergeMap.size, 0);
  });
});
