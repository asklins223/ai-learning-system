/**
 * Tests for Card Quality V2 contracts (方案 20 §12-14).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseGroundingCriticReportV2,
  parsePedagogyCriticReportV2,
  parseCandidateEvidenceBindingPlanV2,
  parseEvidenceEligibilityStateV2,
  parseEvidenceBindingV2,
  type GroundingCriticReportV2,
  type PedagogyCriticReportV2,
  type CandidateEvidenceBindingPlanV2,
  type EvidenceEligibilityStateV2,
  type EvidenceBindingV2,
} from "../src/card-quality-v2-contracts.ts";

const FAKE_HASH = "0".repeat(64);
const FAKE_UUID = "00000000-0000-4000-8000-000000000001";

function baseGroundingReport(): GroundingCriticReportV2 {
  return {
    version: 2,
    reportId: FAKE_UUID,
    candidateRevisionId: FAKE_UUID,
    candidateRevisionHash: FAKE_HASH,
    evidenceSetHash: FAKE_HASH,
    evidenceEligibilityVectorHash: FAKE_HASH,
    inputHash: FAKE_HASH,
    verdict: "pass",
    answerUnits: [
      {
        answerUnitId: "unit-1",
        verdict: "entailed",
        evidenceSnapshotIds: [FAKE_UUID],
      },
    ],
    learningSupport: [
      {
        field: "explanation",
        verdict: "entailed",
        evidenceSnapshotIds: [FAKE_UUID],
      },
    ],
    relationSupport: [],
    rubricSupport: [
      {
        rubricUnitId: "rubric-1",
        verdict: "supported",
        evidenceSnapshotIds: [FAKE_UUID],
      },
    ],
    hardIssues: [],
    criticVersion: "grounding-critic-v1",
    reportHash: FAKE_HASH,
  };
}

function basePedagogyReport(): PedagogyCriticReportV2 {
  return {
    version: 2,
    runId: FAKE_UUID,
    candidateRevisionHashes: [FAKE_HASH],
    candidateEvidenceBindingPlanHashes: [FAKE_HASH],
    planRevisionId: FAKE_UUID,
    planVersion: 1,
    planHash: FAKE_HASH,
    inputHash: FAKE_HASH,
    verdict: "pass",
    perCandidate: [
      {
        candidateId: FAKE_UUID,
        verdict: "keep",
        hardIssues: [],
      },
    ],
    setIssues: [],
    recommendedFinalCount: 1,
    criticVersion: "pedagogy-critic-v1",
    reportHash: FAKE_HASH,
  };
}

function baseBindingPlan(): CandidateEvidenceBindingPlanV2 {
  return {
    version: 2,
    bindingPlanId: FAKE_UUID,
    candidateRevisionId: FAKE_UUID,
    candidateRevisionHash: FAKE_HASH,
    evidenceSetHash: FAKE_HASH,
    evidenceEligibilityVectorHash: FAKE_HASH,
    bindings: [
      {
        targetUnit: { kind: "answer", answerUnitId: "unit-1" },
        evidenceSnapshotId: FAKE_UUID,
        evidenceSnapshotHash: FAKE_HASH,
        relation: "entails",
        supportStrength: "direct",
        semanticSupportReportId: FAKE_UUID,
        semanticSupportReportHash: FAKE_HASH,
      },
    ],
    bindingPlanHash: FAKE_HASH,
  };
}

function baseEligibilityState(): EvidenceEligibilityStateV2 {
  return {
    evidenceSnapshotId: FAKE_UUID,
    workspaceId: FAKE_UUID,
    eligibilityEpoch: 1,
    status: "usable",
    reasonCode: null,
    stateHash: FAKE_HASH,
    changedAt: "2026-08-14T00:00:00Z",
  };
}

function baseEvidenceBinding(): EvidenceBindingV2 {
  return {
    bindingId: FAKE_UUID,
    objectiveRevisionId: FAKE_UUID,
    targetUnit: { kind: "rubric", rubricUnitId: "rubric-1" },
    evidenceSnapshotId: FAKE_UUID,
    relation: "entails",
    supportStrength: "direct",
    semanticSupportReportId: FAKE_UUID,
    semanticSupportReportHash: FAKE_HASH,
    bindingHash: FAKE_HASH,
  };
}

describe("groundingCriticReportV2Schema", () => {
  it("parses a valid report", () => {
    const report = baseGroundingReport();
    const result = parseGroundingCriticReportV2(report);
    assert.equal(result.version, 2);
    assert.equal(result.verdict, "pass");
    assert.equal(result.answerUnits[0].verdict, "entailed");
  });

  it("accepts abstain verdict (fail closed at runtime, schema allows)", () => {
    const report = baseGroundingReport();
    report.verdict = "abstain";
    const result = parseGroundingCriticReportV2(report);
    assert.equal(result.verdict, "abstain");
  });

  it("rejects invalid unit verdict", () => {
    const report = baseGroundingReport();
    report.answerUnits[0].verdict = "invalid" as never;
    assert.throws(() => parseGroundingCriticReportV2(report));
  });

  it("rejects empty answerUnits array", () => {
    const report = baseGroundingReport();
    report.answerUnits = [];
    assert.throws(() => parseGroundingCriticReportV2(report));
  });

  it("rejects invalid overall verdict", () => {
    const report = baseGroundingReport();
    report.verdict = "invalid" as never;
    assert.throws(() => parseGroundingCriticReportV2(report));
  });

  it("rejects missing evidenceEligibilityVectorHash", () => {
    const report = baseGroundingReport() as unknown as Record<string, unknown>;
    delete report.evidenceEligibilityVectorHash;
    assert.throws(() => parseGroundingCriticReportV2(report));
  });

  it("rejects unknown extra fields (strict)", () => {
    const report = baseGroundingReport() as unknown as Record<string, unknown>;
    report.extraField = "not allowed";
    assert.throws(() => parseGroundingCriticReportV2(report));
  });
});

describe("pedagogyCriticReportV2Schema", () => {
  it("parses a valid report", () => {
    const report = basePedagogyReport();
    const result = parsePedagogyCriticReportV2(report);
    assert.equal(result.verdict, "pass");
  });

  it("accepts no_cards verdict", () => {
    const report = basePedagogyReport();
    report.verdict = "no_cards";
    const result = parsePedagogyCriticReportV2(report);
    assert.equal(result.verdict, "no_cards");
  });

  it("rejects invalid perCandidate verdict", () => {
    const report = basePedagogyReport();
    report.perCandidate[0].verdict = "invalid" as never;
    assert.throws(() => parsePedagogyCriticReportV2(report));
  });
});

describe("candidateEvidenceBindingPlanV2Schema", () => {
  it("parses a valid plan", () => {
    const plan = baseBindingPlan();
    const result = parseCandidateEvidenceBindingPlanV2(plan);
    assert.equal(result.version, 2);
    assert.equal(result.bindings.length, 1);
    assert.equal(result.bindings[0].supportStrength, "direct");
  });

  it("rejects empty bindings", () => {
    const plan = baseBindingPlan();
    plan.bindings = [];
    assert.throws(() => parseCandidateEvidenceBindingPlanV2(plan));
  });

  it("rejects invalid targetUnit kind", () => {
    const plan = baseBindingPlan();
    plan.bindings[0].targetUnit = { kind: "invalid" } as never;
    assert.throws(() => parseCandidateEvidenceBindingPlanV2(plan));
  });

  it("rejects missing evidenceSetHash", () => {
    const plan = baseBindingPlan() as unknown as Record<string, unknown>;
    delete plan.evidenceSetHash;
    assert.throws(() => parseCandidateEvidenceBindingPlanV2(plan));
  });
});

describe("evidenceEligibilityStateV2Schema", () => {
  it("parses a valid usable state", () => {
    const state = baseEligibilityState();
    const result = parseEvidenceEligibilityStateV2(state);
    assert.equal(result.status, "usable");
    assert.equal(result.eligibilityEpoch, 1);
  });

  it("parses a valid restricted state with reason", () => {
    const state = baseEligibilityState();
    state.status = "restricted";
    state.reasonCode = "evidence revoked by source change";
    const result = parseEvidenceEligibilityStateV2(state);
    assert.equal(result.status, "restricted");
    assert.equal(result.reasonCode, "evidence revoked by source change");
  });

  it("rejects invalid status", () => {
    const state = baseEligibilityState();
    state.status = "invalid" as never;
    assert.throws(() => parseEvidenceEligibilityStateV2(state));
  });

  it("rejects eligibilityEpoch < 1", () => {
    const state = baseEligibilityState();
    state.eligibilityEpoch = 0;
    assert.throws(() => parseEvidenceEligibilityStateV2(state));
  });
});

describe("evidenceBindingV2Schema", () => {
  it("parses a valid binding", () => {
    const binding = baseEvidenceBinding();
    const result = parseEvidenceBindingV2(binding);
    assert.equal(result.relation, "entails");
    assert.equal(result.targetUnit.kind, "rubric");
  });

  it("accepts derived binding with derivation report", () => {
    const binding = baseEvidenceBinding();
    binding.supportStrength = "derived";
    binding.derivationReportId = FAKE_UUID;
    binding.derivationReportHash = FAKE_HASH;
    const result = parseEvidenceBindingV2(binding);
    assert.equal(result.supportStrength, "derived");
  });

  it("rejects invalid relation", () => {
    const binding = baseEvidenceBinding();
    binding.relation = "invalid" as never;
    assert.throws(() => parseEvidenceBindingV2(binding));
  });

  it("rejects unknown extra fields (strict)", () => {
    const binding = baseEvidenceBinding() as unknown as Record<string, unknown>;
    binding.extra = "not allowed";
    assert.throws(() => parseEvidenceBindingV2(binding));
  });
});
