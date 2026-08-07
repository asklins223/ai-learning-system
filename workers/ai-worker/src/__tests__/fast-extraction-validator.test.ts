/**
 * P2-2：FAST_EXTRACT 确定性校验器单元测试。
 *
 * 覆盖 §3.1 中间校验清单：
 * - Schema 合法 / Local ID 唯一
 * - Evidence ID ∈ Allowlist
 * - Required Bundle 均有决策
 * - 代码/公式 Evidence 类型一致
 * - 输出未截断
 * - 失败分类(retryable vs escalate)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateFastExtractionArtifact,
  type FastExtractionEvidenceInfo,
  type FastExtractionValidationContext,
} from "../agent/fast-extraction-validator.ts";
import { fastExtractionArtifactSchema, type FastExtractionArtifact } from "@ailearn/shared";

function ctx(overrides: Partial<FastExtractionValidationContext> = {}): FastExtractionValidationContext {
  const allowlist = new Map<string, FastExtractionEvidenceInfo>([
    ["ev-1", { refId: "ev-1", blockType: "paragraph", isImage: false, containsFormulaMarker: false }],
    ["ev-code", { refId: "ev-code", blockType: "code", isImage: false, containsFormulaMarker: false }],
    ["ev-formula", { refId: "ev-formula", blockType: "paragraph", isImage: false, containsFormulaMarker: true }],
    ["ev-img", { refId: "ev-img", blockType: "image", isImage: true, containsFormulaMarker: false }],
  ]);
  return {
    evidenceAllowlist: allowlist,
    evidenceBundleByRef: new Map([
      ["ev-1", "bundle-1"],
      ["ev-code", "bundle-2"],
      ["ev-formula", "bundle-3"],
      ["ev-img", "bundle-4"],
    ]),
    requiredBundleIds: ["bundle-1", "bundle-2", "bundle-3", "bundle-4"],
    finishReason: "stop",
    ...overrides,
  };
}

function validArtifact(): FastExtractionArtifact {
  return {
    documentIntent: "介绍分布式一致性",
    learningFocus: ["一致性协议"],
    candidates: [
      {
        localId: "c1",
        claim: "两阶段提交协议通过准备和提交两个阶段保证原子性",
        topic: "两阶段提交",
        sectionKey: "3.1",
        cognitiveType: "concept",
        importance: "core",
        difficulty: "intermediate",
        evidenceRefIds: ["ev-1"],
      },
      {
        localId: "c2",
        claim: "函数定义使用 def 关键字",
        topic: "函数",
        sectionKey: "5",
        cognitiveType: "code",
        importance: "core",
        difficulty: "basic",
        evidenceRefIds: ["ev-code"],
      },
      {
        localId: "c3",
        claim: "质能方程 E=mc2",
        topic: "相对论",
        sectionKey: "7",
        cognitiveType: "formula",
        importance: "core",
        difficulty: "basic",
        evidenceRefIds: ["ev-formula"],
      },
      {
        localId: "c4",
        claim: "图中展示了系统架构",
        topic: "架构图",
        sectionKey: "2",
        cognitiveType: "concept",
        importance: "supporting",
        difficulty: "basic",
        evidenceRefIds: ["ev-img"],
      },
    ],
    noCandidateDecisions: [],
  };
}

test("有效 artifact 通过全部校验", () => {
  const result = validateFastExtractionArtifact(validArtifact(), ctx());
  assert.equal(result.passed, true);
  assert.deepEqual(result.issues, []);
});

test("Schema 非法 → schema_invalid(retryable)", () => {
  const bad = { ...validArtifact(), candidates: "not-an-array" };
  const result = validateFastExtractionArtifact(bad, ctx());
  assert.equal(result.passed, false);
  assert.equal(result.issues[0]?.code, "schema_invalid");
  assert.equal(result.issues[0]?.severity, "retryable");
});

test("Local ID 重复 → duplicate_local_id(retryable)", () => {
  const artifact = validArtifact();
  artifact.candidates[1] = { ...artifact.candidates[0]!, localId: "c1" };
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.code === "duplicate_local_id"));
});

test("Evidence 不在 Allowlist → evidence_not_in_allowlist(retryable)", () => {
  const artifact = validArtifact();
  artifact.candidates[0] = { ...artifact.candidates[0]!, evidenceRefIds: ["ev-999"] };
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.code === "evidence_not_in_allowlist"));
});

test("Required Bundle 无决策 → bundle_without_decision(retryable)", () => {
  const artifact = validArtifact();
  artifact.candidates = artifact.candidates.filter((c) => c.evidenceRefIds[0] !== "ev-img");
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.code === "bundle_without_decision" && i.details.includes("bundle-4")));
});

test("noCandidateDecisions 可覆盖 Required Bundle", () => {
  const artifact = validArtifact();
  artifact.candidates = artifact.candidates.filter((c) => c.evidenceRefIds[0] !== "ev-img");
  artifact.noCandidateDecisions = [{ bundleId: "bundle-4", reason: "decorative" }];
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, true);
});

test("代码候选无代码 Evidence → code_evidence_type_mismatch(escalate)", () => {
  const artifact = validArtifact();
  artifact.candidates[1] = { ...artifact.candidates[1]!, evidenceRefIds: ["ev-1"] };
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, false);
  const issue = result.issues.find((i) => i.code === "code_evidence_type_mismatch");
  assert.ok(issue);
  assert.equal(issue!.severity, "escalate");
});

test("公式候选无公式 Evidence → formula_evidence_type_mismatch(escalate)", () => {
  const artifact = validArtifact();
  artifact.candidates[2] = { ...artifact.candidates[2]!, evidenceRefIds: ["ev-1"] };
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, false);
  const issue = result.issues.find((i) => i.code === "formula_evidence_type_mismatch");
  assert.ok(issue);
  assert.equal(issue!.severity, "escalate");
});

test("noCandidateDecisions 引用非 Required Bundle → no_candidate_bundle_not_required", () => {
  const artifact = validArtifact();
  artifact.noCandidateDecisions = [{ bundleId: "bundle-ghost", reason: "decorative" }];
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.code === "no_candidate_bundle_not_required" && i.severity === "retryable"));
});

test("relationHints 悬空引用 → dangling_relation_target(retryable)", () => {
  const artifact = validArtifact();
  artifact.candidates[0] = {
    ...artifact.candidates[0]!,
    relationHints: [{ type: "supports", localTargetId: "ghost-id" }],
  };
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.code === "dangling_relation_target" && i.severity === "retryable"));
});

test("relationHints 自引用 → self_referencing_relation(retryable)", () => {
  const artifact = validArtifact();
  artifact.candidates[0] = {
    ...artifact.candidates[0]!,
    relationHints: [{ type: "supports", localTargetId: "c1" }],
  };
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.code === "self_referencing_relation" && i.severity === "retryable"));
});

test("relationHints 合法引用 → 通过", () => {
  const artifact = validArtifact();
  artifact.candidates[0] = {
    ...artifact.candidates[0]!,
    relationHints: [{ type: "supports", localTargetId: "c2" }],
  };
  const result = validateFastExtractionArtifact(artifact, ctx());
  assert.equal(result.passed, true);
});

test("输出截断 → output_truncated(retryable)", () => {
  const result = validateFastExtractionArtifact(validArtifact(), ctx({ finishReason: "length" }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.code === "output_truncated" && i.severity === "retryable"));
});

test("清洗后 artifact 不含未知键/__proto__(security 回归)", () => {
  // JSON.parse 构造 __proto__ 自有键(对象字面量会触发原型 setter,不算自有键)
  const withProto = JSON.parse(JSON.stringify({
    ...validArtifact(),
    extraKey: "x",
    __proto__: { polluted: true },
  }));
  const result = validateFastExtractionArtifact(withProto, ctx());
  assert.equal(result.passed, false, "未知键应被 .strict() 拒绝");
  assert.ok(result.issues.some((i) => i.code === "schema_invalid"));
  assert.equal(result.artifact, undefined, "失败不返回 artifact");

  // 通过时 artifact 为全新对象,不含未知键
  const ok = validateFastExtractionArtifact(validArtifact(), ctx());
  assert.equal(ok.passed, true);
  assert.deepEqual(Object.keys(ok.artifact ?? {}).sort(),
    ["candidates", "documentIntent", "learningFocus", "noCandidateDecisions"]);
});

test("schema 拒绝空 claim / 超长 claim / 非法枚举", () => {  // 空 claim
  assert.equal(fastExtractionArtifactSchema.safeParse({
    ...validArtifact(),
    candidates: [{ ...validArtifact().candidates[0]!, claim: "" }],
  }).success, false);
  // 超长 claim(>500)
  assert.equal(fastExtractionArtifactSchema.safeParse({
    ...validArtifact(),
    candidates: [{ ...validArtifact().candidates[0]!, claim: "x".repeat(501) }],
  }).success, false);
  // 非法 cognitiveType
  assert.equal(fastExtractionArtifactSchema.safeParse({
    ...validArtifact(),
    candidates: [{ ...validArtifact().candidates[0]!, cognitiveType: "nonsense" }],
  }).success, false);
});
