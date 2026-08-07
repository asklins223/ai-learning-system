import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerationPlan } from "@ailearn/shared";
import { detectGaps, affectedBundleIds, hasEscalateGaps, type GapDetectionContext } from "../agent/gap-detection.ts";

function plan(bundles: Array<{ id: string; specialist: "text_extractor" | "code_extractor" | "vision_specialist"; focus: string }>): GenerationPlan {
  return {
    schemaVersion: "1",
    documentIntent: "test",
    learningFocus: ["x"],
    bundleTasks: bundles.map((b) => ({
      bundleId: b.id,
      specialist: b.specialist,
      extractionFocus: b.focus,
      relatedBundleIds: [],
      expectedDecisionKinds: ["candidate", "no_candidate"],
    })),
    compositionStrategy: { density: "standard", cardBudget: 3 },
  };
}

function ctx(overrides: Partial<GapDetectionContext> & { plan: GenerationPlan }): GapDetectionContext {
  return {
    outcomes: {},
    evidenceAllowlist: new Set(),
    coverageLedgerComplete: true,
    survivingCoverage: 1,
    ...overrides,
  };
}

test("no gaps when all bundles decided and coverage healthy", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "机器学习" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: {
      b1: { hasDecision: true, decisionKind: "candidate", candidateCount: 3, protocolErrors: [], evidenceRefIds: ["e1"] },
    },
    evidenceAllowlist: new Set(["e1"]),
  }));
  assert.equal(gaps.length, 0);
});

test("bundle_no_decision when required bundle lacks decision", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: { b1: { hasDecision: false, candidateCount: 0, protocolErrors: [], evidenceRefIds: [] } },
  }));
  assert.ok(gaps.some((g) => g.code === "bundle_no_decision"));
  assert.equal(hasEscalateGaps(gaps), false);
});

test("bundle_no_outcome when specialist produced nothing", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }]);
  const gaps = detectGaps(ctx({ plan: p, outcomes: {} }));
  assert.ok(gaps.some((g) => g.code === "bundle_no_outcome"));
});

test("candidate_zero and candidate_explosion", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }]);
  const zero = detectGaps(ctx({
    plan: p,
    outcomes: { b1: { hasDecision: true, decisionKind: "candidate", candidateCount: 0, protocolErrors: [], evidenceRefIds: [] } },
  }));
  assert.ok(zero.some((g) => g.code === "candidate_zero"));

  const boom = detectGaps(ctx({
    plan: p,
    outcomes: { b1: { hasDecision: true, decisionKind: "candidate", candidateCount: 501, protocolErrors: [], evidenceRefIds: [] } },
    candidateExplosionThreshold: 500,
  }));
  assert.ok(boom.some((g) => g.code === "candidate_explosion"));
  assert.equal(hasEscalateGaps(boom), true);
});

test("evidence_ref_unassigned when ref not in allowlist", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: { b1: { hasDecision: true, decisionKind: "candidate", candidateCount: 1, protocolErrors: [], evidenceRefIds: ["ghost"] } },
    evidenceAllowlist: new Set(["e1"]),
  }));
  assert.ok(gaps.some((g) => g.code === "evidence_ref_unassigned"));
});

test("specialist_protocol_error escalates", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: { b1: { hasDecision: true, decisionKind: "candidate", candidateCount: 1, protocolErrors: ["类型不匹配"], evidenceRefIds: [] } },
  }));
  assert.ok(gaps.some((g) => g.code === "specialist_protocol_error"));
});

test("code_bundle_no_code_candidate", () => {
  const p = plan([{ id: "c1", specialist: "code_extractor", focus: "代码" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: { c1: { hasDecision: true, decisionKind: "candidate", candidateCount: 1, protocolErrors: [], evidenceRefIds: [], codeCandidateCount: 0 } },
  }));
  assert.ok(gaps.some((g) => g.code === "code_bundle_no_code_candidate"));
});

test("image_bundle_missing_image_evidence", () => {
  const p = plan([{ id: "v1", specialist: "vision_specialist", focus: "图表" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: { v1: { hasDecision: true, decisionKind: "candidate", candidateCount: 1, protocolErrors: [], evidenceRefIds: [], imageEvidenceCount: 0 } },
  }));
  assert.ok(gaps.some((g) => g.code === "image_bundle_missing_image_evidence"));
});

test("section_duplicate_candidates and finish_reason_truncated", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: {
      b1: {
        hasDecision: true, decisionKind: "candidate", candidateCount: 6, protocolErrors: [], evidenceRefIds: [],
        candidatesBySection: { "1.1 概念": 5 },
        finishReason: "truncated",
      },
    },
  }));
  assert.ok(gaps.some((g) => g.code === "section_duplicate_candidates"));
  assert.ok(gaps.some((g) => g.code === "finish_reason_truncated"));
});

test("specialist_self_reported_mismatch is add-on only, not success", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }]);
  // 自报 mismatch 存在 → 有 gap(但只是 replannable)
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: {
      b1: { hasDecision: true, decisionKind: "candidate", candidateCount: 1, protocolErrors: [], evidenceRefIds: [], planMismatchSignal: "focus 偏差" },
    },
  }));
  assert.ok(gaps.some((g) => g.code === "specialist_self_reported_mismatch"));
  assert.equal(hasEscalateGaps(gaps), false);
});

test("coverage_ledger_incomplete and surviving_coverage_below_threshold escalate", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: { b1: { hasDecision: true, decisionKind: "candidate", candidateCount: 1, protocolErrors: [], evidenceRefIds: [] } },
    coverageLedgerComplete: false,
    survivingCoverage: 0.5,
  }));
  assert.ok(gaps.some((g) => g.code === "coverage_ledger_incomplete"));
  assert.ok(gaps.some((g) => g.code === "surviving_coverage_below_threshold"));
  assert.equal(hasEscalateGaps(gaps), true);
});

test("plan_bundle_duplicate escalates", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }, { id: "b1", specialist: "text_extractor", focus: "y" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: {
      b1: { hasDecision: true, decisionKind: "candidate", candidateCount: 1, protocolErrors: [], evidenceRefIds: [] },
    },
  }));
  assert.ok(gaps.some((g) => g.code === "plan_bundle_duplicate"));
});

test("affectedBundleIds covers per-bundle and global gaps", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "x" }, { id: "b2", specialist: "text_extractor", focus: "y" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: {
      b1: { hasDecision: false, candidateCount: 0, protocolErrors: [], evidenceRefIds: [] },
      b2: { hasDecision: true, decisionKind: "candidate", candidateCount: 1, protocolErrors: [], evidenceRefIds: [] },
    },
    survivingCoverage: 0.4, // 全局 gap
  }));
  const affected = affectedBundleIds(gaps, p);
  assert.ok(affected.has("b1"));
  assert.ok(affected.has("b2"), "全局 gap 影响全部 bundle");
});

test("no_candidate 明确决策不触发 bundle_no_decision(遗留项①语义)", () => {
  const p = plan([{ id: "b1", specialist: "text_extractor", focus: "机器学习" }]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: {
      b1: { hasDecision: true, decisionKind: "no_candidate", candidateCount: 0, protocolErrors: [], evidenceRefIds: [] },
    },
  }));
  assert.equal(gaps.length, 0, "明确 no_candidate 决策 = 已覆盖,不 replan");
});

test("no_candidate 与 candidate 混合:未覆盖 bundle 仍触发", () => {
  const p = plan([
    { id: "b1", specialist: "text_extractor", focus: "A" },
    { id: "b2", specialist: "text_extractor", focus: "B" },
  ]);
  const gaps = detectGaps(ctx({
    plan: p,
    outcomes: {
      b1: { hasDecision: true, decisionKind: "no_candidate", candidateCount: 0, protocolErrors: [], evidenceRefIds: [] },
      b2: { hasDecision: false, protocolErrors: [], evidenceRefIds: [], candidateCount: 0 },
    },
  }));
  assert.ok(gaps.some((g) => g.code === "bundle_no_decision" && g.bundleId === "b2"), "b2 无决策仍触发");
  assert.ok(!gaps.some((g) => g.bundleId === "b1"), "b1 no_candidate 不触发");
});
