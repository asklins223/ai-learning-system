/**
 * Assessment Critic 单测（阶段 04 / W3 任务 04-4，INDEPENDENT_ASSESS 逐项 evidence binding §7.5）
 *
 * 覆盖（node:test + assert，验收）：
 * - 独立 system policy：绑定模型快照、显式禁止 mastery/interval/总体 outcome；
 * - deterministicScorer：ordering / 固定 graph / typed repair 的 covered/partial/contradicted/
 *   missing/not_assessable，evidence refs ⊆ 预绑定；
 * - assessRubricItem：每 verdict 绑定 artifact/excerpt/interaction refs/evidence refs；
 *   ASR 低置信 / transcript hash 失配 / 音频替换 / replay 攻击 → not_assessable；
 * - runFailClosedChecks：unknown / duplicate / missing / 伪造引用（evidence/excerpt/interaction）
 *   全部 fail closed；redacted artifact 不允许 semantic re-audit；
 * - assessRubricSet：每个冻结 rubric item 恰好一条最终 assessment；越权输出（mastery/interval）为 0。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { LearningAgentRole, LearningToolId } from "../types.ts";
import {
  assessReliability,
  assessRubricItem,
  assessRubricSet,
  AssessmentCriticError,
  buildAssessmentCriticSystemPolicy,
  canonicalAnswerText,
  deterministicScorer,
  excerptReconstructible,
  runFailClosedChecks,
  type ArtifactStatus,
  type AssessRubricItemInput,
  type FrozenRubricTarget,
  type LockedArtifactView,
  type ProposedAssessment,
} from "./assessment-critic.ts";
import { computeVoiceContentHash } from "@ailearn/shared/content-hash";

// ─── fixtures ─────────────────────────────────────────────────────────────

function artifact(overrides: Partial<LockedArtifactView> = {}): LockedArtifactView {
  return {
    artifactId: "artifact-1",
    status: "locked",
    modality: "voice",
    revision: 1,
    contentHash: "a".repeat(64),
    transcript: "氧气是燃烧反应的氧化剂。",
    transcriptHash: computeVoiceContentHash("氧气是燃烧反应的氧化剂。"),
    asrConfidence: 0.95,
    asrProvider: "mock-asr",
    asrModel: "mock-asr-v1",
    interactionRefs: ["inter-1", "inter-2"],
    ...overrides,
  };
}

function orderingTarget(overrides: Partial<FrozenRubricTarget> = {}): FrozenRubricTarget {
  return {
    rubricItemId: "rubric-order-1",
    facet: "procedure",
    scoringMode: "ordering",
    evidenceRefIds: ["ev-order-a", "ev-order-b", "ev-order-c"],
    expectedOrderIds: ["A", "B", "C"],
    ...overrides,
  };
}

function graphTarget(overrides: Partial<FrozenRubricTarget> = {}): FrozenRubricTarget {
  return {
    rubricItemId: "rubric-graph-1",
    facet: "relate",
    scoringMode: "graph",
    evidenceRefIds: ["ev-graph-e1", "ev-graph-e2"],
    expectedEdgeSet: ["A:prerequisite:B", "B:derives_from:C"],
    ...overrides,
  };
}

function repairTarget(overrides: Partial<FrozenRubricTarget> = {}): FrozenRubricTarget {
  return {
    rubricItemId: "rubric-repair-1",
    facet: "procedure",
    scoringMode: "typed_repair",
    evidenceRefIds: ["ev-repair-op1", "ev-repair-op2"],
    expectedRepairOps: ["remove:node-B", "link:A:prerequisite"],
    ...overrides,
  };
}

function voiceTarget(overrides: Partial<FrozenRubricTarget> = {}): FrozenRubricTarget {
  return {
    rubricItemId: "rubric-voice-1",
    facet: "explain",
    scoringMode: "voice",
    evidenceRefIds: ["ev-voice-1"],
    ...overrides,
  };
}

function semanticTarget(overrides: Partial<FrozenRubricTarget> = {}): FrozenRubricTarget {
  return {
    rubricItemId: "rubric-open-1",
    facet: "boundary",
    scoringMode: "open_semantic",
    evidenceRefIds: ["ev-open-1", "ev-open-2"],
    ...overrides,
  };
}

function preboundFor(target: FrozenRubricTarget): string[] {
  return [...target.evidenceRefIds];
}

// ─── 1. 独立 system policy：不返回 mastery/interval/总体 outcome ──────────

test("buildAssessmentCriticSystemPolicy：独立 policy 绑定模型快照并禁止越权输出", () => {
  const policy = buildAssessmentCriticSystemPolicy({
    provider: "mock",
    model: "critic-model",
    version: "v2",
    snapshotHash: "h".repeat(64),
  });
  assert.equal(policy.role, LearningAgentRole.ASSESSMENT_CRITIC);
  assert.equal(policy.policyId, "assessment-critic-policy-v1");
  assert.equal(policy.modelSnapshot.model, "critic-model");
  assert.ok(policy.systemPrompt.length > 80, "system prompt 应包含完整约束");
  // 越权输出（mastery/interval/overall）显式禁止，且不写入 policy 任何可返回字段
  assert.ok(policy.forbiddenOutputs.includes("mastery"));
  assert.ok(policy.forbiddenOutputs.includes("review_interval"));
  assert.ok(policy.forbiddenOutputs.includes("overall_outcome"));
  assert.ok(policy.forbiddenOutputs.includes("shared_graph_truth"));
  assert.ok(policy.forbiddenOutputs.includes("rc_gold_self_score"));
  // 工具 allowlist：只读 + 逐项提交
  assert.deepEqual([...policy.allowedToolIds].sort(), [
    LearningToolId.READ_EVIDENCE_REFS,
    LearningToolId.READ_LOCKED_ARTIFACT,
    LearningToolId.READ_RUBRIC_TARGET,
    LearningToolId.SUBMIT_ASSESSMENT_VERDICT,
  ].sort());
  // policy 结构本身不携带 mastery/interval/outcome 数值字段
  const keys = Object.keys(policy);
  assert.ok(!keys.some((k) => k === "mastery" || k === "interval" || k === "outcome"));
});

// ─── 2. canonical 文本重建与 excerpt 校验 ─────────────────────────────────

test("canonicalAnswerText / excerptReconstructible：excerpt 必须从锁定 transcript/text 重建", () => {
  const locked = artifact();
  assert.equal(canonicalAnswerText(locked), "氧气是燃烧反应的氧化剂。");
  assert.ok(excerptReconstructible(locked, "燃烧反应"));
  assert.ok(!excerptReconstructible(locked, "不存在的内容"));
  // segments 拼接重建（voice transcript 缺失时）
  const segmentsOnly = artifact({
    transcript: undefined,
    transcriptHash: undefined,
    segments: [
      { startMs: 0, endMs: 100, text: "氧气是" },
      { startMs: 100, endMs: 200, text: "燃烧反应的氧化剂。" },
    ],
  });
  assert.equal(canonicalAnswerText(segmentsOnly), "氧气是燃烧反应的氧化剂。");
  assert.ok(excerptReconstructible(segmentsOnly, "燃烧反应"));
  // 无 transcript 也无 segments → 任何 excerpt 都不可重建
  const empty = artifact({ transcript: undefined, segments: undefined });
  assert.ok(!excerptReconstructible(empty, "x"));
});

// ─── 3. deterministicScorer：ordering ─────────────────────────────────────

test("deterministicScorer ordering：完全一致 → covered，evidence refs 全部命中", () => {
  const a = artifact({ modality: "ordering", orderedIds: ["A", "B", "C"], allowlistedItemIds: ["A", "B", "C"] });
  const result = deterministicScorer({ artifact: a, rubricTarget: orderingTarget() });
  assert.ok(result);
  assert.equal(result!.verdict, "covered");
  assert.deepEqual(result!.evidenceRefIds, ["ev-order-a", "ev-order-b", "ev-order-c"]);
  assert.equal(result!.detail.matched, 3);
  assert.equal(result!.confidence, 1);
});

test("deterministicScorer ordering：顺序颠倒 → contradicted", () => {
  const a = artifact({ modality: "ordering", orderedIds: ["B", "A", "C"], allowlistedItemIds: ["A", "B", "C"] });
  const result = deterministicScorer({ artifact: a, rubricTarget: orderingTarget() });
  assert.ok(result);
  assert.equal(result!.verdict, "contradicted");
});

test("deterministicScorer ordering：缺项且保持相对顺序 → partial", () => {
  const a = artifact({ modality: "ordering", orderedIds: ["A", "C"], allowlistedItemIds: ["A", "B", "C"] });
  const result = deterministicScorer({ artifact: a, rubricTarget: orderingTarget() });
  assert.ok(result);
  assert.equal(result!.verdict, "partial");
  assert.deepEqual(result!.evidenceRefIds, ["ev-order-a", "ev-order-c"]);
});

test("deterministicScorer ordering：完全无交集 → missing", () => {
  const a = artifact({ modality: "ordering", orderedIds: ["X", "Y"], allowlistedItemIds: ["X", "Y"] });
  const result = deterministicScorer({ artifact: a, rubricTarget: orderingTarget() });
  assert.ok(result);
  assert.equal(result!.verdict, "missing");
});

test("deterministicScorer ordering：未知/重复 ID → not_assessable（fail closed）", () => {
  const unknown = artifact({ modality: "ordering", orderedIds: ["A", "FORGED"], allowlistedItemIds: ["A", "B", "C"] });
  const dup = artifact({ modality: "ordering", orderedIds: ["A", "A", "B"], allowlistedItemIds: ["A", "B", "C"] });
  assert.equal(
    deterministicScorer({ artifact: unknown, rubricTarget: orderingTarget() })!.verdict,
    "not_assessable",
  );
  assert.equal(
    deterministicScorer({ artifact: dup, rubricTarget: orderingTarget() })!.verdict,
    "not_assessable",
  );
});

// ─── 4. deterministicScorer：固定 graph 与 typed repair ───────────────────

test("deterministicScorer graph：完全一致 → covered；缺边 → partial；多选 → contradicted", () => {
  const target = graphTarget();
  const covered = artifact({ modality: "drag_graph", edges: ["A:prerequisite:B", "B:derives_from:C"] });
  assert.equal(deterministicScorer({ artifact: covered, rubricTarget: target })!.verdict, "covered");

  const partial = artifact({ modality: "drag_graph", edges: ["A:prerequisite:B"] });
  assert.equal(deterministicScorer({ artifact: partial, rubricTarget: target })!.verdict, "partial");

  const extra = artifact({ modality: "drag_graph", edges: ["A:prerequisite:B", "B:derives_from:C", "A:derives_from:C"] });
  assert.equal(deterministicScorer({ artifact: extra, rubricTarget: target })!.verdict, "contradicted");
});

test("deterministicScorer graph：冲突边（同节点对不同关系）→ contradicted", () => {
  const target = graphTarget();
  const conflict = artifact({ modality: "drag_graph", edges: ["A:derives_from:B", "B:derives_from:C"] });
  assert.equal(deterministicScorer({ artifact: conflict, rubricTarget: target })!.verdict, "contradicted");
});

test("deterministicScorer repair：完全一致 → covered；缺操作 → partial；相反操作 → contradicted", () => {
  const target = repairTarget();
  const covered = artifact({ modality: "repair", repairOps: ["remove:node-B", "link:A:prerequisite"] });
  assert.equal(deterministicScorer({ artifact: covered, rubricTarget: target })!.verdict, "covered");

  const partial = artifact({ modality: "repair", repairOps: ["remove:node-B"] });
  assert.equal(deterministicScorer({ artifact: partial, rubricTarget: target })!.verdict, "partial");

  const conflict = artifact({ modality: "repair", repairOps: ["add:node-B", "link:A:prerequisite"] });
  assert.equal(deterministicScorer({ artifact: conflict, rubricTarget: target })!.verdict, "contradicted");
});

test("deterministicScorer：非 deterministic 模式返回 null（交给 Critic）", () => {
  const a = artifact();
  assert.equal(deterministicScorer({ artifact: a, rubricTarget: voiceTarget() }), null);
  assert.equal(deterministicScorer({ artifact: a, rubricTarget: semanticTarget() }), null);
});

// ─── 5. 内容可靠性：ASR 失败 / 低置信 / 音频替换 / replay 攻击 fail closed ─

test("assessReliability：ASR 低置信 / transcript hash 失配 / 音频替换 → 不可靠", () => {
  const lowConfidence = artifact({ asrConfidence: 0.5 });
  assert.equal(assessReliability(lowConfidence, voiceTarget()).reliable, false);

  const hashMismatch = artifact({ transcriptHash: "f".repeat(64) }); // 音频替换/replay 攻击
  assert.equal(assessReliability(hashMismatch, voiceTarget()).reliable, false);
  assert.equal(assessReliability(hashMismatch, voiceTarget()).reasonCode, "transcript_hash_mismatch");

  const noTranscript = artifact({ transcript: undefined, segments: undefined });
  assert.equal(assessReliability(noTranscript, voiceTarget()).reliable, false);
});

test("assessReliability：健康 voice / 结构模态 → 可靠", () => {
  assert.equal(assessReliability(artifact(), voiceTarget()).reliable, true);
  assert.equal(
    assessReliability(
      artifact({ modality: "ordering", orderedIds: ["A", "B", "C"], allowlistedItemIds: ["A", "B", "C"] }),
      orderingTarget(),
    ).reliable,
    true,
  );
});

// ─── 6. runFailClosedChecks：unknown / duplicate / 伪造引用全部 fail closed ─

test("fail closed：伪造 evidence ref（不在预绑定）被拒", () => {
  const target = semanticTarget();
  const failures = runFailClosedChecks({
    artifact: artifact(),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
    verdict: "covered",
    evidenceRefIds: ["ev-open-1", "forged-ref"],
  });
  assert.ok(failures.some((f) => f.code === "forged_evidence_ref"));
});

test("fail closed：prebound 与 RubricTarget 预绑定不一致（契约破坏）被拒", () => {
  const target = semanticTarget();
  const failures = runFailClosedChecks({
    artifact: artifact(),
    rubricTarget: target,
    preboundEvidenceRefIds: ["different-ref"],
    verdict: "covered",
  });
  assert.ok(failures.some((f) => f.code === "contract_evidence_mismatch"));
});

test("fail closed：excerpt 无法从 transcript 重建 / interaction ref 不来自 artifact 被拒", () => {
  const target = semanticTarget();
  const badExcerpt = runFailClosedChecks({
    artifact: artifact(),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
    verdict: "covered",
    answerExcerpt: "不存在的内容",
  });
  assert.ok(badExcerpt.some((f) => f.code === "forged_excerpt"));

  const forgedInteraction = runFailClosedChecks({
    artifact: artifact(),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
    verdict: "covered",
    interactionRefs: ["inter-1", "forged-interaction"],
  });
  assert.ok(forgedInteraction.some((f) => f.code === "forged_interaction_ref"));
});

test("fail closed：redacted / 非 locked artifact 一律拒绝（redacted 不可 semantic re-audit）", () => {
  const target = semanticTarget();
  const redacted = runFailClosedChecks({
    artifact: artifact({ status: "redacted" }),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
  });
  assert.ok(redacted.some((f) => f.code === "artifact_redacted_semantic_audit"));

  const awaiting = runFailClosedChecks({
    artifact: artifact({ status: "awaiting_confirmation" }),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
  });
  assert.ok(awaiting.some((f) => f.code === "artifact_not_locked"));
});

test("fail closed：未知 verdict / 重复 ref / 非法 confidence 被拒", () => {
  const target = semanticTarget();
  const badVerdict = runFailClosedChecks({
    artifact: artifact(),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
    verdict: "unlocked" as never,
  });
  assert.ok(badVerdict.some((f) => f.code === "unknown_verdict"));

  const dupRef = runFailClosedChecks({
    artifact: artifact(),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
    verdict: "covered",
    evidenceRefIds: ["ev-open-1", "ev-open-1"],
  });
  assert.ok(dupRef.some((f) => f.code === "duplicate_ref"));

  const badConfidence = runFailClosedChecks({
    artifact: artifact(),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
    verdict: "covered",
    confidence: 1.5,
  });
  assert.ok(badConfidence.some((f) => f.code === "invalid_confidence"));
});

// ─── 7. assessRubricItem：逐项判定与绑定 ─────────────────────────────────

test("assessRubricItem：deterministic ordering 输出绑定 artifact / evidence refs，无越权字段", () => {
  const a = artifact({ modality: "ordering", orderedIds: ["A", "B", "C"], allowlistedItemIds: ["A", "B", "C"] });
  const target = orderingTarget();
  const assessment = assessRubricItem({
    artifact: a,
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
  });
  assert.equal(assessment.verdict, "covered");
  assert.equal(assessment.assessmentSource, "deterministic");
  assert.deepEqual(assessment.evidenceRefIds, ["ev-order-a", "ev-order-b", "ev-order-c"]);
  assert.equal(assessment.responseBindings.length, 1);
  assert.equal(assessment.responseBindings[0]!.responseArtifactId, "artifact-1");
  // 不返回 mastery/interval/总体 outcome
  assert.ok(!("mastery" in assessment));
  assert.ok(!("interval" in assessment));
  assert.ok(!("outcome" in assessment));
});

test("assessRubricItem：critic 开放语义模式使用 claimed verdict，excerpt/evidence 通过校验", () => {
  const target = semanticTarget();
  const assessment = assessRubricItem({
    artifact: artifact(),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
    claimedVerdict: "covered",
    claimedEvidenceRefIds: ["ev-open-1"],
    claimedAnswerExcerpt: "燃烧反应",
    claimedInteractionRefs: ["inter-1"],
    claimedConfidence: 0.92,
    claimedSource: "critic",
    claimedRationale: "covered:semantic_support",
  });
  assert.equal(assessment.verdict, "covered");
  assert.equal(assessment.assessmentSource, "critic");
  assert.deepEqual(assessment.evidenceRefIds, ["ev-open-1"]);
  assert.equal(assessment.responseBindings[0]!.answerExcerpt, "燃烧反应");
});

test("assessRubricItem：ASR 低置信 → 即使 critic 声称 covered 也降级 not_assessable（可无损重试）", () => {
  const target = voiceTarget();
  const a = artifact({ asrConfidence: 0.4 });
  const assessment = assessRubricItem({
    artifact: a,
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
    claimedVerdict: "covered",
    claimedEvidenceRefIds: [],
    claimedConfidence: 0.9,
    claimedSource: "critic",
  });
  assert.equal(assessment.verdict, "not_assessable");
  assert.equal(assessment.confidence, 0);
});

test("assessRubricItem：user_declared_unable 只允许 not_assessable", () => {
  const target = voiceTarget();
  const ok = assessRubricItem({
    artifact: artifact(),
    rubricTarget: target,
    preboundEvidenceRefIds: preboundFor(target),
    claimedVerdict: "not_assessable",
    claimedSource: "user_declared_unable",
    claimedEvidenceRefIds: [],
  });
  assert.equal(ok.verdict, "not_assessable");
  assert.equal(ok.assessmentSource, "user_declared_unable");

  assert.throws(
    () =>
      assessRubricItem({
        artifact: artifact(),
        rubricTarget: target,
        preboundEvidenceRefIds: preboundFor(target),
        claimedVerdict: "covered",
        claimedSource: "user_declared_unable",
      }),
    (err: unknown) => err instanceof AssessmentCriticError && err.code === "unknown_verdict",
  );
});

// ─── 8. assessRubricSet：每冻结 item 恰好一条；unknown/duplicate/missing 拒绝 ──

test("assessRubricSet：混合集每冻结 rubric item 恰好一条最终 assessment", () => {
  const ordering = orderingTarget();
  const open = semanticTarget();
  const a = artifact({ modality: "ordering", orderedIds: ["A", "B", "C"], allowlistedItemIds: ["A", "B", "C"] });
  const proposals: ProposedAssessment[] = [
    {
      rubricItemId: open.rubricItemId,
      verdict: "partial",
      evidenceRefIds: ["ev-open-1"],
      answerExcerpt: "燃烧反应",
      source: "critic",
    },
  ];
  const result = assessRubricSet({
    artifact: a,
    frozenRubricTargets: [ordering, open],
    preboundEvidenceByItem: {
      [ordering.rubricItemId]: preboundFor(ordering),
      [open.rubricItemId]: preboundFor(open),
    },
    proposals,
  });
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => r.rubricItemId),
    [ordering.rubricItemId, open.rubricItemId],
  );
  const orderAssessment = result.find((r) => r.rubricItemId === ordering.rubricItemId)!;
  assert.equal(orderAssessment.verdict, "covered");
  assert.equal(orderAssessment.assessmentSource, "deterministic");
  const openAssessment = result.find((r) => r.rubricItemId === open.rubricItemId)!;
  assert.equal(openAssessment.verdict, "partial");
});

test("assessRubricSet：unknown / duplicate / missing 全部 fail closed", () => {
  const open = semanticTarget();
  const a = artifact();

  assert.throws(
    () =>
      assessRubricSet({
        artifact: a,
        frozenRubricTargets: [open],
        preboundEvidenceByItem: { [open.rubricItemId]: preboundFor(open) },
        proposals: [
          { rubricItemId: "unknown-item", verdict: "covered" },
        ],
      }),
    (err: unknown) => err instanceof AssessmentCriticError && err.code === "unknown_rubric_item",
  );

  assert.throws(
    () =>
      assessRubricSet({
        artifact: a,
        frozenRubricTargets: [open],
        preboundEvidenceByItem: { [open.rubricItemId]: preboundFor(open) },
        proposals: [
          { rubricItemId: open.rubricItemId, verdict: "covered" },
          { rubricItemId: open.rubricItemId, verdict: "partial" },
        ],
      }),
    (err: unknown) => err instanceof AssessmentCriticError && err.code === "duplicate_rubric_item",
  );

  // critic 模式缺 proposal → missing
  assert.throws(
    () =>
      assessRubricSet({
        artifact: a,
        frozenRubricTargets: [open],
        preboundEvidenceByItem: { [open.rubricItemId]: preboundFor(open) },
        proposals: [],
      }),
    (err: unknown) => err instanceof AssessmentCriticError && err.code === "missing_rubric_item",
  );
});

// ─── 9. 状态机守卫：仅 locked 可评估（superseded/stale/redacted 不行） ────

test("artifact 状态守卫：superseded / stale / redacted 均不可进入逐项评估", () => {
  const target = semanticTarget();
  for (const status of ["superseded", "stale", "redacted"] as ArtifactStatus[]) {
    const input: AssessRubricItemInput = {
      artifact: artifact({ status }),
      rubricTarget: target,
      preboundEvidenceRefIds: preboundFor(target),
      claimedVerdict: "covered",
      claimedEvidenceRefIds: [],
    };
    assert.throws(
      () => assessRubricItem(input),
      (err: unknown) => err instanceof AssessmentCriticError,
      `status=${status} 应 fail closed`,
    );
  }
});
