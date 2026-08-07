/**
 * P2-4/P2-5：按需读取 Evidence + DeterministicClaimRisk 单元测试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readEvidenceSubset,
  isUnboundedSelection,
  type FastEvidenceEntry,
} from "../agent/fast-evidence-reader.ts";
import {
  computeClaimRisk,
  riskToReviewLevel,
  ClaimRiskLevel,
  ReviewLevel,
} from "../agent/claim-risk-calculator.ts";
import type { FastExtractionCandidate } from "@ailearn/shared";

// ─── P2-4: 按需读取 ──────────────────────────────────────────────────────

function pool(): FastEvidenceEntry[] {
  return [
    { refId: "ev-1", text: "a", bundleId: "b1", sectionKey: "1", blockType: "paragraph" },
    { refId: "ev-2", text: "b", bundleId: "b1", sectionKey: "1", blockType: "paragraph" },
    { refId: "ev-code", text: "code", bundleId: "b2", sectionKey: "2", blockType: "code" },
    { refId: "ev-img", text: "img", bundleId: "b3", sectionKey: "3", blockType: "image" },
  ];
}

test("按 ID 读取只返回选中证据", () => {
  const r = readEvidenceSubset(pool(), { mode: "by_ids", evidenceRefIds: ["ev-1", "ev-code"] });
  assert.deepEqual(r.selected.map((e) => e.refId).sort(), ["ev-1", "ev-code"]);
  assert.deepEqual(r.coveredBundleIds.sort(), ["b1", "b2"]);
});

test("按 Bundle / Section 读取", () => {
  const byBundle = readEvidenceSubset(pool(), { mode: "by_bundles", bundleIds: ["b2"] });
  assert.deepEqual(byBundle.selected.map((e) => e.refId), ["ev-code"]);
  const bySection = readEvidenceSubset(pool(), { mode: "by_sections", sectionKeys: ["3"] });
  assert.deepEqual(bySection.selected.map((e) => e.refId), ["ev-img"]);
});

test("空选择器(未限定范围)→ 拒绝全文扫描,返回空", () => {
  assert.equal(isUnboundedSelection({ mode: "by_ids", evidenceRefIds: [] }), true);
  const r = readEvidenceSubset(pool(), { mode: "by_ids", evidenceRefIds: [] });
  assert.deepEqual(r.selected, []);
  assert.deepEqual(r.coveredBundleIds, []);
});

test("选择器不存在的 ID → 空结果(不报错)", () => {
  const r = readEvidenceSubset(pool(), { mode: "by_ids", evidenceRefIds: ["ev-999"] });
  assert.deepEqual(r.selected, []);
});

// ─── P2-5: DeterministicClaimRisk ────────────────────────────────────────

function candidate(overrides: Partial<FastExtractionCandidate> = {}): FastExtractionCandidate {
  return {
    localId: "c1",
    claim: "这是一个测试命题，用于验证风险计算器的确定性行为。",
    topic: "t",
    sectionKey: "1",
    cognitiveType: "concept",
    importance: "core",
    difficulty: "basic",
    evidenceRefIds: ["ev-1"],
    ...overrides,
  };
}

test("普通概念 claim + 多证据 → low(→ Light)", () => {
  const r = computeClaimRisk({
    candidate: candidate(),
    referencedBlockTypes: ["paragraph", "paragraph"],
    referencedFormulaMarkers: [false, false],
  });
  assert.equal(r.level, ClaimRiskLevel.LOW);
  assert.equal(riskToReviewLevel(r.level), ReviewLevel.LIGHT);
});

test("无证据 → high", () => {
  const r = computeClaimRisk({
    candidate: candidate(),
    referencedBlockTypes: [],
    referencedFormulaMarkers: [],
  });
  assert.equal(r.level, ClaimRiskLevel.HIGH);
  assert.ok(r.signals.includes("no_evidence"));
});

test("代码/公式/图片证据 → high(至少 Claim-Level 硬规则)", () => {
  const code = computeClaimRisk({
    candidate: candidate({ cognitiveType: "code" }),
    referencedBlockTypes: ["code"],
    referencedFormulaMarkers: [],
  });
  assert.equal(code.level, ClaimRiskLevel.HIGH);
  const formula = computeClaimRisk({
    candidate: candidate({ cognitiveType: "formula" }),
    referencedBlockTypes: ["paragraph"],
    referencedFormulaMarkers: [true],
  });
  assert.equal(formula.level, ClaimRiskLevel.HIGH);
  const image = computeClaimRisk({
    candidate: candidate(),
    referencedBlockTypes: ["image"],
    referencedFormulaMarkers: [],
  });
  assert.equal(image.level, ClaimRiskLevel.HIGH);
  assert.equal(riskToReviewLevel(image.level), ReviewLevel.CLAIM);
});

test("超长 claim → 高风险", () => {
  const r = computeClaimRisk({
    candidate: candidate({ claim: "x".repeat(301) }),
    referencedBlockTypes: ["paragraph", "paragraph"],
    referencedFormulaMarkers: [],
  });
  assert.equal(r.level, ClaimRiskLevel.HIGH);
});

test("模型标注只升不降(低→标注高=高;高→标注低=仍高)", () => {
  const up = computeClaimRisk({
    candidate: candidate(),
    referencedBlockTypes: ["paragraph", "paragraph"],
    referencedFormulaMarkers: [],
    modelAnnotation: { claimRisk: ClaimRiskLevel.HIGH },
  });
  assert.equal(up.level, ClaimRiskLevel.HIGH);
  const down = computeClaimRisk({
    candidate: candidate({ claim: "x".repeat(301) }),
    referencedBlockTypes: ["paragraph", "paragraph"],
    referencedFormulaMarkers: [],
    modelAnnotation: { claimRisk: ClaimRiskLevel.LOW },
  });
  assert.equal(down.level, ClaimRiskLevel.HIGH, "确定性 high 不因模型标 low 而降级");
});

test("medium → Claim-Level 映射", () => {
  const r = computeClaimRisk({
    candidate: candidate({ claim: "y".repeat(220) }),
    referencedBlockTypes: ["paragraph"],
    referencedFormulaMarkers: [],
  });
  assert.equal(r.level, ClaimRiskLevel.MEDIUM);
  assert.equal(riskToReviewLevel(r.level), ReviewLevel.CLAIM);
});
