/**
 * 2026-08-25（AI 设计审计修复）回归：runPedagogyCritic 的 verdict↔hardIssues
 * fail-closed 归一化。
 *
 * 背景（审计发现）：Pedagogy Critic 的冻结 issue code 原先只做 zod 校验即
 * 丢弃——门禁只看模型自选的 verdict 字符串，弱基座模型返回自相矛盾的
 * {verdict:"keep", hardIssues:["front_leaks_answer"]} 时候选照常进入 deck
 * gate 并 review_ready。归一化后 hard 结论不可被 soft verdict 覆盖
 * （方案 20 §12.3），keep+hardIssues 强制降为 drop；setIssues 非空把整体
 * pass 压为 fail。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  runGroundingCritic,
  runPedagogyCritic,
  type GroundingCriticProvider,
  type PedagogyCriticInput,
} from "./critic-service.ts";
import type { GroundingCriticReportV2, PedagogyCriticReportV2 } from "../card-quality-v2-contracts.ts";
import type { LearningCardCandidateRevisionV2 } from "../card-generation-v2-contracts.ts";

function makeCandidate(): LearningCardCandidateRevisionV2 {
  return {
    version: 2,
    candidateRevisionId: randomUUID(),
    candidateId: randomUUID(),
    revision: 1,
    runId: randomUUID(),
    planRevisionId: randomUUID(),
    planVersion: 1,
    planHash: "b".repeat(64),
    cardContentEpoch: 1,
    planObjectiveLocalId: "obj-1",
    recommendation: { recommended: true, reasonCodes: [] },
    derivedFromCandidateRevisions: [],
    objective: {
      objectiveStatement: "定义：分布式共识。",
      publicSummary: "分布式共识",
      conceptLabel: "分布式共识",
      knowledgeForm: "definition",
      preferredTaskIntents: ["recall"],
      canonicalAnswer: { kind: "text", unit: { unitId: "ans-1", text: "多个节点达成一致的协议。" } },
      learningSupport: { explanation: "解释。" },
      rubric: {
        version: 2,
        units: [{
          rubricUnitId: "rubric-1",
          facet: "recall",
          criterion: "能复述定义",
          required: true,
          answerUnitIds: ["ans-1"],
          evidenceRefIds: [],
        }],
        passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
        rubricHash: "c".repeat(64),
      },
      relations: [],
      difficulty: "introductory",
      evidenceRefIds: [],
    },
    presentation: {
      strategy: "recall",
      transformationKind: "retrieval_definition",
      front: { cue: "共识", prompt: "什么是共识？" },
      estimatedReviewSeconds: 45,
    },
    evidenceSetHash: "d".repeat(64),
    candidateRevisionHash: "e".repeat(64),
  };
}

function makeReport(
  perCandidate: PedagogyCriticReportV2["perCandidate"],
  overrides: Partial<PedagogyCriticReportV2> = {},
): PedagogyCriticReportV2 {
  return {
    version: 2,
    runId: "r-1",
    candidateRevisionHashes: [makeCandidate().candidateRevisionHash],
    candidateEvidenceBindingPlanHashes: ["h"],
    planRevisionId: "p-1",
    planVersion: 1,
    planHash: "f".repeat(64),
    inputHash: "0".repeat(64),
    verdict: "pass",
    perCandidate,
    setIssues: [],
    recommendedFinalCount: perCandidate.length,
    criticVersion: "card-pedagogy-critic/v1",
    reportHash: "a".repeat(64),
    ...overrides,
  };
}

function makeInput(): PedagogyCriticInput {
  const c = makeCandidate();
  return {
    candidate: c,
    candidates: [c],
    candidateEvidenceBindingPlanHashes: ["h"],
    existingObjectives: [],
    inputHash: "0".repeat(64),
    runId: "r-1",
  };
}

describe("runPedagogyCritic fail-closed normalization (2026-08-25)", () => {
  test("keep + non-empty hardIssues is demoted to drop", async () => {
    const provider = {
      evaluate: async () =>
        makeReport([
          { candidateId: "c-1", verdict: "keep", hardIssues: ["front_leaks_answer"] },
        ]),
    };
    const report = await runPedagogyCritic(makeInput(), provider);
    assert.equal(report.perCandidate[0].verdict, "drop");
    assert.deepEqual(report.perCandidate[0].hardIssues, ["front_leaks_answer"]);
  });

  test("clean keep passes through untouched", async () => {
    const raw = makeReport([{ candidateId: "c-1", verdict: "keep", hardIssues: [] }]);
    const report = await runPedagogyCritic(makeInput(), { evaluate: async () => raw });
    assert.equal(report, raw, "no normalization → identical object returned");
  });

  test("rewrite with hard issues keeps rewrite verdict (already non-keep)", async () => {
    const provider = {
      evaluate: async () =>
        makeReport([{ candidateId: "c-1", verdict: "rewrite", hardIssues: ["front_leaks_answer"] }]),
    };
    const report = await runPedagogyCritic(makeInput(), provider);
    assert.equal(report.perCandidate[0].verdict, "rewrite");
  });

  test("non-empty setIssues demotes overall pass to fail", async () => {
    const provider = {
      evaluate: async () =>
        makeReport([{ candidateId: "c-1", verdict: "keep", hardIssues: [] }], {
          setIssues: ["too_fragmented"],
        }),
    };
    const report = await runPedagogyCritic(makeInput(), provider);
    assert.equal(report.verdict, "fail");
  });

  test("fail/no_cards verdicts are never upgraded by the normalizer", async () => {
    for (const verdict of ["fail", "no_cards"] as const) {
      const provider = {
        evaluate: async () =>
          makeReport([{ candidateId: "c-1", verdict: "keep", hardIssues: [] }], { verdict }),
      };
      const report = await runPedagogyCritic(makeInput(), provider);
      assert.equal(report.verdict, verdict);
    }
  });
});

// ─── 2026-09-15（管线评审 H2）：runGroundingCritic 结构化交叉校验 ──────────
//
// 背景：此前 runGroundingCritic 只检查顶层 verdict 与 hardIssues，模型返回
// 自相矛盾的 {verdict:"pass", answerUnits:[contradicted]} 会被原样放行，
// 被矛盾证据否决的候选照常进入 binding plan。现在 answer/relation/rubric 逐项
// verdict 与 explanation 支撑失败一律压为 fail（可选支撑字段的 insufficient
// 按 §12.2 不阻断）。

function makeGroundingReport(overrides: Partial<GroundingCriticReportV2>): GroundingCriticReportV2 {
  const candidateRevisionId = randomUUID();
  return {
    version: 2,
    reportId: randomUUID(),
    candidateRevisionId,
    candidateRevisionHash: "b".repeat(64),
    evidenceSetHash: "c".repeat(64),
    evidenceEligibilityVectorHash: "d".repeat(64),
    inputHash: "d".repeat(64),
    verdict: "pass",
    answerUnits: [{ answerUnitId: "ans-1", verdict: "entailed", evidenceSnapshotIds: [] }],
    learningSupport: [],
    relationSupport: [],
    rubricSupport: [{ rubricUnitId: "rubric-1", verdict: "supported", evidenceSnapshotIds: [] }],
    hardIssues: [],
    criticVersion: "card-grounding-critic/v1",
    reportHash: "a".repeat(64),
    ...overrides,
  } as GroundingCriticReportV2;
}

function groundingProvider(report: GroundingCriticReportV2): GroundingCriticProvider {
  return { evaluate: async () => report };
}

describe("runGroundingCritic：verdict↔结构化明细 fail-closed 归一化", () => {
  test("pass + answerUnit contradicted → fail", async () => {
    const report = await runGroundingCritic(
      { candidate: makeCandidate() },
      groundingProvider(makeGroundingReport({
        answerUnits: [{ answerUnitId: "ans-1", verdict: "contradicted", evidenceSnapshotIds: [] }],
      })),
    );
    assert.equal(report.verdict, "fail");
  });

  test("pass + rubric unsupported → fail", async () => {
    const report = await runGroundingCritic(
      { candidate: makeCandidate() },
      groundingProvider(makeGroundingReport({
        rubricSupport: [{ rubricUnitId: "rubric-1", verdict: "unsupported", evidenceSnapshotIds: [] }],
      })),
    );
    assert.equal(report.verdict, "fail");
  });

  test("pass + explanation 证据不足 → fail", async () => {
    const report = await runGroundingCritic(
      { candidate: makeCandidate() },
      groundingProvider(makeGroundingReport({
        learningSupport: [{ field: "explanation", verdict: "insufficient", evidenceSnapshotIds: [] }],
      })),
    );
    assert.equal(report.verdict, "fail");
  });

  test("pass + 可选支撑字段仅 insufficient → 保持 pass（§12.2 不阻断）", async () => {
    const report = await runGroundingCritic(
      { candidate: makeCandidate() },
      groundingProvider(makeGroundingReport({
        learningSupport: [{ field: "boundary", verdict: "insufficient", evidenceSnapshotIds: [] }],
      })),
    );
    assert.equal(report.verdict, "pass");
  });

  test("pass + 可选支撑字段被矛盾 → fail", async () => {
    const report = await runGroundingCritic(
      { candidate: makeCandidate() },
      groundingProvider(makeGroundingReport({
        learningSupport: [{ field: "workedExample", verdict: "contradicted", evidenceSnapshotIds: [] }],
      })),
    );
    assert.equal(report.verdict, "fail");
  });
});
