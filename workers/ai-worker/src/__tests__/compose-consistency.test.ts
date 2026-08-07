import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerationPlan } from "@ailearn/shared";
import {
  validateComposeConsistency,
  type ComposeConsistencyInput,
} from "../agent/compose-consistency.ts";

function plan(): GenerationPlan {
  return {
    schemaVersion: "1",
    documentIntent: "test",
    learningFocus: ["x"],
    bundleTasks: [{ bundleId: "b1", specialist: "text_extractor", extractionFocus: "机器学习", relatedBundleIds: [], expectedDecisionKinds: ["candidate"] }],
    compositionStrategy: { density: "standard", cardBudget: 2 },
  };
}

function input(overrides: Partial<ComposeConsistencyInput> & { cards: ComposeConsistencyInput["cards"] }): ComposeConsistencyInput {
  return {
    plan: plan(),
    bundleCandidates: { b1: new Set(["c1", "c2"]) },
    claimByCandidateId: new Map([["c1", "监督学习需要标签"]]),
    evidenceAllowlist: new Set(["e1"]),
    ...overrides,
  };
}

test("consistent compose passes", () => {
  const issues = validateComposeConsistency(input({
    cards: [{ cardId: "k1", candidateIds: ["c1"], claimsByCandidate: { c1: "监督学习需要标签" }, evidenceRefIds: [] }],
  }));
  assert.deepEqual(issues, []);
});

test("card_refs_unknown_candidate", () => {
  const issues = validateComposeConsistency(input({
    cards: [{ cardId: "k1", candidateIds: ["ghost"], claimsByCandidate: {}, evidenceRefIds: [] }],
  }));
  assert.ok(issues.some((i) => i.code === "card_refs_unknown_candidate"));
});

test("card_duplicate_candidate_ref", () => {
  const issues = validateComposeConsistency(input({
    cards: [{ cardId: "k1", candidateIds: ["c1", "c1"], claimsByCandidate: {}, evidenceRefIds: [] }],
  }));
  assert.ok(issues.some((i) => i.code === "card_duplicate_candidate_ref"));
});

test("card_claim_mismatch when claim deviates from authoritative", () => {
  const issues = validateComposeConsistency(input({
    cards: [{ cardId: "k1", candidateIds: ["c1"], claimsByCandidate: { c1: "改写后的文本" }, evidenceRefIds: [] }],
  }));
  assert.ok(issues.some((i) => i.code === "card_claim_mismatch"));
});

test("card_refs_unassigned_evidence when card cites out-of-allowlist evidence", () => {
  const issues = validateComposeConsistency(input({
    cards: [{ cardId: "k1", candidateIds: ["c1"], claimsByCandidate: {}, evidenceRefIds: ["e1", "ghost"] }],
  }));
  assert.ok(issues.some((i) => i.code === "card_refs_unassigned_evidence" && i.candidateId === "ghost"));
  assert.equal(issues.filter((i) => i.code === "card_refs_unassigned_evidence").length, 1);
});

test("evidenceRefIds 全在 allowlist 时不产生 unassigned 问题", () => {
  const issues = validateComposeConsistency(input({
    cards: [{ cardId: "k1", candidateIds: ["c1"], claimsByCandidate: {}, evidenceRefIds: ["e1"] }],
  }));
  assert.deepEqual(issues, []);
});
