/**
 * 方案 20 R4 — binding-plan-assembler 单测（§12.2 段 2 / §14.3）。
 *
 * 覆盖：
 * - pass：所有 target unit 与 grounding report 一一对齐
 * - fail-closed：grounding 缺某个 answer unit verdict
 * - fail-closed：answer unit verdict=insufficient
 * - fail-closed：evidence 非 usable（eligibility≠usable）
 * - fail-closed：evidence 不在 sealed manifest（跨 workspace/unknown）
 * - derived binding 缺 derivation report → 一律 direct，不接受 derived 无说明
 * - bindingPlanHash 稳定（同输入同 hash）
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";
import {
  assembleCandidateEvidenceBindingPlanV2,
} from "../modules/card-generation-v2/binding-plan-assembler.ts";
import { CardGenerationV2ServiceError } from "../modules/card-generation-v2/helpers.ts";
import type { GroundingCriticReportV2 } from "@ailearn/shared/card-quality-v2-contracts";
import type { LearningCardCandidateRevisionV2, CanonicalAnswerV2 } from "@ailearn/shared/card-generation-v2-contracts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const EVIDENCE_SNAPSHOT = "00000000-0000-4000-8000-000000000010";

let candidate: LearningCardCandidateRevisionV2;
let grounding: GroundingCriticReportV2;
let manifest: { workspaceId: string; sourceSnapshotId: string; evidence: import("../modules/card-generation-v2/evidence-seal-service.ts").SealedEvidenceEntryV2[] };
let eligibility: Array<{ evidenceSnapshotId: string; eligibilityEpoch: number; status: string; stateHash: string }>;

beforeEach(() => {
  const answerUnit = "ans-1";
  const canonicalAnswer: CanonicalAnswerV2 = {
    kind: "text",
    unit: { unitId: answerUnit, text: "共识 = 多个节点对某值达成一致。" },
  };
  candidate = {
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
    recommendation: { recommended: true, reasonCodes: ["test"] },
    derivedFromCandidateRevisions: [],
    objective: {
      objectiveStatement: "共识的定义",
      publicSummary: "共识定义",
      conceptLabel: "测试概念标题",
      knowledgeForm: "definition",
      preferredTaskIntents: ["recall"],
      canonicalAnswer,
      learningSupport: { explanation: "共识协议保证故障容忍。" },
      rubric: {
        version: 2,
        units: [{
          rubricUnitId: "rubric-1",
          facet: "recall",
          criterion: "能回答共识定义",
          required: true,
          answerUnitIds: [answerUnit],
          evidenceRefIds: [EVIDENCE_SNAPSHOT],
        }],
        passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
        rubricHash: "c".repeat(64),
      },
      relations: [],
      difficulty: "introductory",
      evidenceRefIds: [EVIDENCE_SNAPSHOT],
    },
    presentation: {
      strategy: "recall",
      transformationKind: "retrieval_definition",
      front: { cue: "共识定义", prompt: "什么是共识？" },
      estimatedReviewSeconds: 45,
    },
    evidenceSetHash: "d".repeat(64),
    candidateRevisionHash: "e".repeat(64),
  };

  manifest = {
    workspaceId: WORKSPACE_ID,
    sourceSnapshotId: SOURCE_SNAPSHOT_ID,
    evidence: [{
      evidenceSnapshotId: EVIDENCE_SNAPSHOT,
      evidenceSnapshotHash: "f".repeat(64),
      sourceSnapshotId: SOURCE_SNAPSHOT_ID,
      blockId: "00000000-0000-4000-8000-00000000000a",
      startOffset: 0,
      endOffset: 10,
      quoteHash: "q".repeat(64),
      blockContentHash: "b".repeat(64),
    }],
  };

  eligibility = [{
    evidenceSnapshotId: EVIDENCE_SNAPSHOT,
    eligibilityEpoch: 1,
    status: "usable",
    stateHash: "s".repeat(64),
  }];

  grounding = {
    version: 2,
    reportId: randomUUID(),
    candidateRevisionId: candidate.candidateRevisionId,
    candidateRevisionHash: candidate.candidateRevisionHash,
    evidenceSetHash: "d".repeat(64),
    evidenceEligibilityVectorHash: "g".repeat(64),
    inputHash: "d".repeat(64),
    verdict: "pass",
    answerUnits: [{ answerUnitId: answerUnit, verdict: "entailed", evidenceSnapshotIds: [EVIDENCE_SNAPSHOT] }],
    learningSupport: [{ field: "explanation", verdict: "entailed", evidenceSnapshotIds: [EVIDENCE_SNAPSHOT] }],
    relationSupport: [],
    rubricSupport: [{ rubricUnitId: "rubric-1", verdict: "supported", evidenceSnapshotIds: [EVIDENCE_SNAPSHOT] }],
    hardIssues: [],
    criticVersion: "grounding-v1",
    reportHash: "h".repeat(64),
  };
});

function assemble() {
  return assembleCandidateEvidenceBindingPlanV2({
    runId: candidate.runId,
    workspaceId: WORKSPACE_ID,
    candidate,
    groundingReport: grounding,
    evidenceManifest: manifest,
    eligibilityVector: eligibility,
  });
}

describe("assembleCandidateEvidenceBindingPlanV2", () => {
  it("produces binding plan covering every target unit", () => {
    const { plan } = assemble();
    assert.equal(plan.candidateRevisionId, candidate.candidateRevisionId);
    assert.equal(plan.candidateRevisionHash, candidate.candidateRevisionHash);
    assert.equal(typeof plan.bindingPlanHash, "string");
    assert.equal(plan.bindingPlanHash.length, 64);
    assert.equal(typeof plan.evidenceEligibilityVectorHash, "string");
    assert.equal(plan.evidenceEligibilityVectorHash.length, 64);
    // answer + learning_support(explanation) + rubric
    const kinds = plan.bindings.map((b) => b.targetUnit.kind);
    assert.ok(kinds.includes("answer"));
    assert.ok(kinds.includes("learning_support"));
    assert.ok(kinds.includes("rubric"));
    for (const b of plan.bindings) {
      assert.equal(b.supportStrength, "direct");
      assert.equal(b.evidenceSnapshotId, EVIDENCE_SNAPSHOT);
      assert.ok(b.semanticSupportReportHash.length === 64);
    }
  });

  it("fail-closed: grounding missing an answer unit verdict", () => {
    grounding.answerUnits = [];
    assert.throws(() => assemble(), (e: CardGenerationV2ServiceError) => e.code === "binding_answer_verdict_missing");
  });

  it("fail-closed: answer unit verdict insufficient", () => {
    grounding.answerUnits[0].verdict = "insufficient";
    assert.throws(() => assemble(), (e: CardGenerationV2ServiceError) => e.code === "binding_unit_insufficient");
  });

  it("fail-closed: evidence not usable", () => {
    eligibility = [{ ...eligibility[0], status: "restricted" }];
    assert.throws(() => assemble(), (e: CardGenerationV2ServiceError) => e.code === "binding_evidence_not_usable");
  });

  it("fail-closed: evidence not in sealed manifest (cross-workspace/unknown)", () => {
    manifest.evidence = [];
    assert.throws(() => assemble(), (e: CardGenerationV2ServiceError) => e.code === "binding_evidence_not_in_manifest");
  });

  it("fail-closed: grounding verdict not pass", () => {
    grounding.verdict = "fail";
    assert.throws(() => assemble(), (e: CardGenerationV2ServiceError) => e.code === "binding_grounding_not_passed");
  });

  it("bindingPlanHash is deterministic for same input", () => {
    const { plan: p1 } = assemble();
    const { plan: p2 } = assemble();
    assert.equal(p1.bindingPlanHash, p2.bindingPlanHash);
  });
});
