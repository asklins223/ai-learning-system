/**
 * Grounded Answer Critic 单测（阶段 07 / W6 任务 07-7，§5.7）。
 *
 * 覆盖（验收，07-w6 任务 07-7）：
 * - 逐段 supported / partial / unsupported；
 * - `derived_from_current_target` 必须绑定 premise refs + 推导类型
 *   （缺失 → fail-closed 抛错）；
 * - 引用完整 ≠ 语义支撑通过：refs ⊆ allowlist 但 claimed=none → unsupported；
 * - forged premise ref（不在 allowlisted 集合）→ fail-closed 抛错；
 * - 只有 supported 可以用来源标签（sourceLabelAllowed）；partial/unsupported
 *   必须降为扩展说明（Should 开启）或 abstain（Should 未开启）；
 * - 仅 current_target / workspace_knowledge 段被检查；extended/unknown 段
 *   直接呈现（verdict=null）；
 * - Critic mandatory：需要检查的段缺少 claimed support → 抛错；
 * - 独立 system policy：禁止改写/越权输出；角色工厂工具与网关一致。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { LearningAgentRole, LearningToolId } from "../types.ts";
import {
  TutorDerivationType,
  TutorSupportMode,
  type TutorSegment,
} from "./grounded-tutor.ts";
import {
  ClaimedSemanticSupport,
  GroundedAnswerCriticError,
  SegmentDisposition,
  SupportVerdict,
  buildGroundedAnswerCriticSystemPolicy,
  createGroundedAnswerCriticRole,
  criticizeAnswer,
  criticizeSegment,
  type SegmentCritiqueInput,
} from "./grounded-answer-critic.ts";

// ─── fixtures ─────────────────────────────────────────────────────────────

const ALLOWLIST = ["ev-1", "ev-2", "ev-3"];

function currentTarget(overrides?: Partial<TutorSegment>): TutorSegment {
  return {
    segmentId: "seg-ct",
    text: "氧气是燃烧反应的氧化剂。",
    supportMode: TutorSupportMode.CURRENT_TARGET,
    evidenceRefs: ["ev-1"],
    ...overrides,
  };
}

function derivedTarget(overrides?: Partial<TutorSegment>): TutorSegment {
  return {
    segmentId: "seg-derived",
    text: "由上述证据可推得，燃烧反应依赖氧化剂参与。",
    supportMode: TutorSupportMode.CURRENT_TARGET,
    evidenceRefs: [],
    derivedFromCurrentTarget: {
      premiseRefs: ["ev-1", "ev-2"],
      derivationType: TutorDerivationType.BOUNDED_DERIVATION,
    },
    ...overrides,
  };
}

function workspaceSegment(overrides?: Partial<TutorSegment>): TutorSegment {
  return {
    segmentId: "seg-ws",
    text: "工作区另一 Key Point 的表述。",
    supportMode: TutorSupportMode.WORKSPACE_KNOWLEDGE,
    ...overrides,
  };
}

function critiqueInput(overrides?: Partial<SegmentCritiqueInput>): SegmentCritiqueInput {
  return {
    segment: currentTarget(),
    allowlistedEvidencePremises: ALLOWLIST,
    claimedSemanticSupport: ClaimedSemanticSupport.FULL,
    shouldFlag: false,
    ...overrides,
  };
}

// ─── 1. supported / partial / unsupported ─────────────────────────────────

test("supported：refs ⊆ allowlist + 语义支撑 full → present_as_is + 来源标签可用", () => {
  const c = criticizeSegment(critiqueInput());
  assert.equal(c.verdict, SupportVerdict.SUPPORTED);
  assert.equal(c.sourceLabelAllowed, true);
  assert.equal(c.disposition, SegmentDisposition.PRESENT_AS_IS);
});

test("引用完整 ≠ 语义支撑通过：refs ⊆ allowlist 但 claimed=none → unsupported", () => {
  const c = criticizeSegment(
    critiqueInput({ claimedSemanticSupport: ClaimedSemanticSupport.NONE }),
  );
  assert.equal(c.verdict, SupportVerdict.UNSUPPORTED);
  assert.equal(c.sourceLabelAllowed, false);
  assert.ok(c.reasons.includes("semantic_support_none"));
});

test("claimed=partial → partial verdict；来源标签不可用", () => {
  const c = criticizeSegment(
    critiqueInput({ claimedSemanticSupport: ClaimedSemanticSupport.PARTIAL }),
  );
  assert.equal(c.verdict, SupportVerdict.PARTIAL);
  assert.equal(c.sourceLabelAllowed, false);
});

// ─── 2. derived_from_current_target 绑定校验 ──────────────────────────────

test("derived_from_current_target：绑定 premiseRefs+derivationType 且 ⊆ allowlist → 可 supported", () => {
  const c = criticizeSegment(
    critiqueInput({
      segment: derivedTarget(),
      claimedSemanticSupport: ClaimedSemanticSupport.FULL,
    }),
  );
  assert.equal(c.verdict, SupportVerdict.SUPPORTED);
  assert.ok(c.reasons.includes("derived_from_current_target_bound"));
});

test("derived 段缺 premiseRefs → fail-closed 抛错", () => {
  assert.throws(
    () =>
      criticizeSegment(
        critiqueInput({
          segment: currentTarget({
            evidenceRefs: [],
            derivedFromCurrentTarget: {
              premiseRefs: [],
              derivationType: TutorDerivationType.BOUNDED_DERIVATION,
            },
          }),
        }),
      ),
    (err: unknown) =>
      err instanceof GroundedAnswerCriticError &&
      err.code === "invalid_derived_structure",
  );
});

test("derived 段缺 derivationType → fail-closed 抛错", () => {
  assert.throws(
    () =>
      criticizeSegment(
        critiqueInput({
          segment: currentTarget({
            evidenceRefs: [],
            derivedFromCurrentTarget: {
              premiseRefs: ["ev-1"],
              derivationType: "not_a_type" as never,
            },
          }),
        }),
      ),
    (err: unknown) =>
      err instanceof GroundedAnswerCriticError &&
      err.code === "invalid_derived_structure",
  );
});

test("derived 段 premise refs 不在 allowlist → forged_premise_ref 抛错", () => {
  assert.throws(
    () =>
      criticizeSegment(
        critiqueInput({
          segment: derivedTarget({
            derivedFromCurrentTarget: {
              premiseRefs: ["ev-1", "not-in-allowlist"],
              derivationType: TutorDerivationType.BOUNDED_DERIVATION,
            },
          }),
        }),
      ),
    (err: unknown) =>
      err instanceof GroundedAnswerCriticError && err.code === "forged_premise_ref",
  );
});

// ─── 3. forged refs 与缺引用 fail-closed ─────────────────────────────────

test("current_target 段引用不在 allowlist → forged_premise_ref 抛错", () => {
  assert.throws(
    () =>
      criticizeSegment(
        critiqueInput({ segment: currentTarget({ evidenceRefs: ["ev-9"] }) }),
      ),
    (err: unknown) =>
      err instanceof GroundedAnswerCriticError && err.code === "forged_premise_ref",
  );
});

test("current_target 段无任何引用 → missing_premise_refs 抛错", () => {
  assert.throws(
    () =>
      criticizeSegment(
        critiqueInput({
          segment: currentTarget({ evidenceRefs: [], derivedFromCurrentTarget: undefined }),
        }),
      ),
    (err: unknown) =>
      err instanceof GroundedAnswerCriticError && err.code === "missing_premise_refs",
  );
});

test("workspace_knowledge 段引用不在 allowlist → forged_premise_ref 抛错", () => {
  assert.throws(
    () =>
      criticizeSegment(
        critiqueInput({ segment: workspaceSegment({ evidenceRefs: ["ws-ev-1"] }) }),
      ),
    (err: unknown) =>
      err instanceof GroundedAnswerCriticError && err.code === "forged_premise_ref",
  );
});

test("workspace_knowledge 段无引用 + 语义支撑 full → supported", () => {
  const c = criticizeSegment(
    critiqueInput({ segment: workspaceSegment() }),
  );
  assert.equal(c.verdict, SupportVerdict.SUPPORTED);
  assert.equal(c.sourceLabelAllowed, true);
});

// ─── 4. partial/unsupported 处置：降级扩展说明 或 abstain ────────────────

test("unsupported + Should 未开 → abstain（不展示）；Should 开 → 降级扩展说明", () => {
  const off = criticizeSegment(
    critiqueInput({ claimedSemanticSupport: ClaimedSemanticSupport.NONE, shouldFlag: false }),
  );
  assert.equal(off.disposition, SegmentDisposition.ABSTAIN);

  const on = criticizeSegment(
    critiqueInput({ claimedSemanticSupport: ClaimedSemanticSupport.NONE, shouldFlag: true }),
  );
  assert.equal(on.disposition, SegmentDisposition.DOWNGRADE_TO_EXTENDED_EXPLANATION);
});

test("partial + Should 未开 → abstain；Should 开 → 降级扩展说明", () => {
  const off = criticizeSegment(
    critiqueInput({ claimedSemanticSupport: ClaimedSemanticSupport.PARTIAL, shouldFlag: false }),
  );
  assert.equal(off.disposition, SegmentDisposition.ABSTAIN);

  const on = criticizeSegment(
    critiqueInput({ claimedSemanticSupport: ClaimedSemanticSupport.PARTIAL, shouldFlag: true }),
  );
  assert.equal(on.disposition, SegmentDisposition.DOWNGRADE_TO_EXTENDED_EXPLANATION);
});

// ─── 5. 只检查 current_target / workspace_knowledge ───────────────────────

test("extended_explanation / unknown 段不检查：verdict=null 且直接呈现", () => {
  for (const segment of [
    {
      segmentId: "seg-ext",
      text: "扩展说明。",
      supportMode: TutorSupportMode.EXTENDED_EXPLANATION,
      extendedExplanation: true,
    },
    {
      segmentId: "seg-unk",
      text: "不知道。",
      supportMode: TutorSupportMode.UNKNOWN,
      unknownDeclaration: true,
    },
  ] as TutorSegment[]) {
    const c = criticizeSegment(critiqueInput({ segment }));
    assert.equal(c.verdict, null);
    assert.equal(c.disposition, SegmentDisposition.PRESENT_AS_IS);
    assert.equal(c.sourceLabelAllowed, false);
  }
});

// ─── 6. 聚合：Critic mandatory ───────────────────────────────────────────

test("criticizeAnswer：需要检查的段缺少 claimed support → 抛错（Critic mandatory）", () => {
  assert.throws(
    () =>
      criticizeAnswer({
        segments: [currentTarget(), workspaceSegment()],
        allowlistedEvidencePremises: ALLOWLIST,
        claimedSupportBySegment: {
          // seg-ct 有，seg-ws 缺失 → fail-closed
          "seg-ct": ClaimedSemanticSupport.FULL,
        },
        shouldFlag: false,
      }),
    (err: unknown) =>
      err instanceof GroundedAnswerCriticError &&
      err.code === "missing_claimed_support",
  );
});

test("criticizeAnswer：全 supported → allCheckedSegmentsSupported=true 无 abstain/downgrade", () => {
  const result = criticizeAnswer({
    segments: [
      currentTarget(),
      derivedTarget(),
      {
        segmentId: "seg-ext",
        text: "扩展说明。",
        supportMode: TutorSupportMode.EXTENDED_EXPLANATION,
        extendedExplanation: true,
      },
    ],
    allowlistedEvidencePremises: ALLOWLIST,
    claimedSupportBySegment: {
      "seg-ct": ClaimedSemanticSupport.FULL,
      "seg-derived": ClaimedSemanticSupport.FULL,
    },
    shouldFlag: false,
  });
  assert.equal(result.allCheckedSegmentsSupported, true);
  assert.equal(result.requiresAbstention, false);
  assert.equal(result.requiresDowngrade, false);
  assert.equal(result.critiques.length, 3);
});

test("criticizeAnswer：unsupported + Should 未开 → requiresAbstention=true", () => {
  const result = criticizeAnswer({
    segments: [currentTarget()],
    allowlistedEvidencePremises: ALLOWLIST,
    claimedSupportBySegment: { "seg-ct": ClaimedSemanticSupport.NONE },
    shouldFlag: false,
  });
  assert.equal(result.requiresAbstention, true);
  assert.equal(result.requiresDowngrade, false);
  assert.equal(result.allCheckedSegmentsSupported, false);
});

test("criticizeAnswer：partial + Should 开 → requiresDowngrade=true", () => {
  const result = criticizeAnswer({
    segments: [workspaceSegment()],
    allowlistedEvidencePremises: ALLOWLIST,
    claimedSupportBySegment: { "seg-ws": ClaimedSemanticSupport.PARTIAL },
    shouldFlag: true,
  });
  assert.equal(result.requiresDowngrade, true);
  assert.equal(result.requiresAbstention, false);
});

// ─── 7. 独立 system policy + 角色工厂 ────────────────────────────────────

test("buildGroundedAnswerCriticSystemPolicy：禁止改写/越权输出、工具与网关一致", () => {
  const policy = buildGroundedAnswerCriticSystemPolicy({
    provider: "mock",
    model: "critic-model",
    version: "v1",
    snapshotHash: "h".repeat(64),
  });
  assert.equal(policy.role, LearningAgentRole.GROUNDED_ANSWER_CRITIC);
  assert.equal(policy.policyId, "grounded-answer-critic-policy-v1");
  assert.ok(policy.forbiddenOutputs.includes("rewrite_answer"));
  assert.ok(policy.forbiddenOutputs.includes("mastery"));
  assert.ok(policy.forbiddenOutputs.includes("shared_graph_truth"));
  assert.ok(policy.forbiddenOutputs.includes("source_label_on_partial_unsupported"));
  assert.deepEqual([...policy.allowedToolIds].sort(), [
    LearningToolId.READ_ALLOWLISTED_EVIDENCE_PREMISES,
    LearningToolId.READ_SUPPORT_MODE,
    LearningToolId.READ_TUTOR_SEGMENT,
    LearningToolId.SUBMIT_SUPPORT_VERDICT,
  ]);
  assert.ok(policy.systemPrompt.includes("引用完整不等于语义支撑通过"));
});

test("createGroundedAnswerCriticRole：GROUNDED_ANSWER_CRITIC + 4 个允许工具", () => {
  const spec = createGroundedAnswerCriticRole();
  assert.equal(spec.role, LearningAgentRole.GROUNDED_ANSWER_CRITIC);
  assert.deepEqual([...spec.allowedToolIds].sort(), [
    LearningToolId.READ_ALLOWLISTED_EVIDENCE_PREMISES,
    LearningToolId.READ_SUPPORT_MODE,
    LearningToolId.READ_TUTOR_SEGMENT,
    LearningToolId.SUBMIT_SUPPORT_VERDICT,
  ]);
  for (const forbidden of ["enter-practice", "confirm-and-lock", "submit", "commit"]) {
    assert.ok(!(spec.allowedToolIds as readonly string[]).includes(forbidden), forbidden);
  }
});
