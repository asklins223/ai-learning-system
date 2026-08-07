import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastExtractionArtifact, GenerationPlan } from "@ailearn/shared";
import { attributeFastArtifactToBundles } from "../agent/fast-to-planned.ts";

function artifact(candidates: Array<{ localId: string; topic: string; claim: string; evidenceRefIds: string[] }>): FastExtractionArtifact {
  return {
    documentIntent: "test",
    learningFocus: ["x"],
    candidates: candidates.map((c) => ({
      localId: c.localId,
      kind: "claim",
      topic: c.topic,
      claim: c.claim,
      cognitiveType: "knowledge",
      importance: "medium",
      difficulty: "medium",
      evidenceRefIds: c.evidenceRefIds,
      sectionKey: "1",
    })),
    noCandidateDecisions: [],
  };
}

function plan(bundles: Array<{ id: string; focus: string }>): GenerationPlan {
  return {
    schemaVersion: "1",
    documentIntent: "test",
    learningFocus: ["x"],
    bundleTasks: bundles.map((b) => ({
      bundleId: b.id,
      specialist: "text_extractor",
      extractionFocus: b.focus,
      relatedBundleIds: [],
      expectedDecisionKinds: ["candidate", "no_candidate"],
    })),
    compositionStrategy: { density: "standard", cardBudget: 3 },
  };
}

test("candidates attributed to bundle by extractionFocus keywords", () => {
  const p = plan([{ id: "b-ml", focus: "机器学习" }, { id: "b-nn", focus: "神经网络" }]);
  const a = artifact([
    { localId: "c1", topic: "机器学习概述", claim: "数据驱动", evidenceRefIds: ["e1"] },
    { localId: "c2", topic: "神经网络层", claim: "多层神经元", evidenceRefIds: ["e2"] },
  ]);
  const r = attributeFastArtifactToBundles(p, a);
  assert.deepEqual(r.byBundle["b-ml"].candidateIds, ["c1"]);
  assert.deepEqual(r.byBundle["b-nn"].candidateIds, ["c2"]);
  assert.deepEqual(r.leftovers, []);
});

test("first-match-wins when multiple bundles hit same candidate", () => {
  const p = plan([{ id: "b1", focus: "神经网络 机器学习" }, { id: "b2", focus: "机器学习" }]);
  const a = artifact([{ localId: "c1", topic: "机器学习", claim: "神经网络", evidenceRefIds: ["e1"] }]);
  const r = attributeFastArtifactToBundles(p, a);
  assert.deepEqual(r.byBundle["b1"].candidateIds, ["c1"]);
  assert.deepEqual(r.byBundle["b2"].candidateIds, []);
});

test("leftovers: unmatched candidates surfaced for Gap Detection", () => {
  const p = plan([{ id: "b1", focus: "机器学习" }]);
  const a = artifact([
    { localId: "c1", topic: "机器学习", claim: "x", evidenceRefIds: ["e1"] },
    { localId: "c2", topic: "足球规则", claim: "y", evidenceRefIds: ["e2"] },
  ]);
  const r = attributeFastArtifactToBundles(p, a);
  assert.deepEqual(r.byBundle["b1"].candidateIds, ["c1"]);
  assert.deepEqual(r.leftovers, ["c2"]);
});

test("evidenceRefIds deduplicated per bundle", () => {
  const p = plan([{ id: "b1", focus: "机器学习" }]);
  const a = artifact([
    { localId: "c1", topic: "机器学习", claim: "x", evidenceRefIds: ["e1"] },
    { localId: "c2", topic: "机器学习应用", claim: "y", evidenceRefIds: ["e1", "e2"] },
  ]);
  const r = attributeFastArtifactToBundles(p, a);
  assert.deepEqual(r.byBundle["b1"].evidenceRefIds.sort(), ["e1", "e2"]);
});

test("empty focus matches all (fallback)", () => {
  const p = plan([{ id: "b1", focus: "" }]);
  const a = artifact([{ localId: "c1", topic: "任何内容", claim: "z", evidenceRefIds: [] }]);
  const r = attributeFastArtifactToBundles(p, a);
  assert.deepEqual(r.byBundle["b1"].candidateIds, ["c1"]);
});
