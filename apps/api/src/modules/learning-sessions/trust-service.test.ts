/**
 * 任务 04-3：Artifact Trust、EpisodeTrustDecision 与 reducer 单测。
 *
 * 覆盖（验收，04-w3 任务 04-3）：
 * - computeEffectiveTrustClass：多条件取最保守（assistance/attempts/stale/
 *   integrity/disclosure/ceiling/planKind），客户端无法提交 effective；
 * - issueEpisodeTrustDecision：decisionHash 确定性（排序幂等、同输入恒等、
 *   任一字段变更 hash 变化、verify 重建一致）；
 * - runRubricSessionReducer：pass|partial|fail|not_assessable 四态 + 输入校验
 *   fail closed；
 * - applyFacetToMasteryPolicy：facet-to-mastery-policy-v1 七条固定规则各一例；
 * - artifactEligibilityFilter：practice 不参与、只收 assistance 前 trusted
 *   locked 的 bindings；
 * - 验收：assisted/stale 结果 0 升级、0 延长 interval；同 artifact 重放 hash 一致。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RubricVerdict, TrustClass } from "@ailearn/shared";
import {
  applyFacetToMasteryPolicy,
  artifactEligibilityFilter,
  computeEffectiveTrustClass,
  issueEpisodeTrustDecision,
  mostConservativeTrustClass,
  ReducerError,
  RubricSessionResult,
  runRubricSessionReducer,
  verifyEpisodeTrustDecision,
  type EffectiveTrustInput,
  type FacetToMasteryPolicyInput,
  type ReducerResult,
  type RubricSessionItemInput,
  type TrustArtifactBindingInput,
} from "./trust-service.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

function effectiveInput(overrides?: Partial<EffectiveTrustInput>): EffectiveTrustInput {
  return {
    requestedTrustClass: TrustClass.MASTERY_ELIGIBLE,
    templateTrustCeiling: TrustClass.MASTERY_ELIGIBLE,
    disclosureMaxProvable: TrustClass.MASTERY_ELIGIBLE,
    planKindCeiling: TrustClass.MASTERY_ELIGIBLE,
    assistanceActivated: false,
    attemptsExceeded: false,
    inputUnreliable: false,
    integrityFailure: false,
    stale: false,
    ...overrides,
  };
}

function passResult(): ReducerResult {
  return {
    result: RubricSessionResult.PASS,
    weightedCoverage: 1,
    hasContradiction: false,
    allRequiredCovered: true,
    missingRequired: false,
    notAssessableRequired: false,
    reducerVersion: "rubric-session-reducer-v2",
    invariantViolation: false,
    reasonCodes: ["all_required_covered"],
  };
}

function partialResult(): ReducerResult {
  return {
    result: RubricSessionResult.PARTIAL,
    weightedCoverage: 0.5,
    hasContradiction: false,
    allRequiredCovered: false,
    missingRequired: false,
    notAssessableRequired: false,
    reducerVersion: "rubric-session-reducer-v2",
    invariantViolation: false,
    reasonCodes: ["partial_assessed"],
  };
}

function policyInput(overrides?: Partial<FacetToMasteryPolicyInput>): FacetToMasteryPolicyInput {
  return {
    planKind: "structured_mastery_bundle",
    authorizedAction: "consume_pending",
    reducerResult: passResult(),
    effectiveClass: TrustClass.MASTERY_ELIGIBLE,
    episodeComplete: true,
    completedRequiredSceneCount: 3,
    requiredSceneCount: 3,
    structuredProofEligible: true,
    equivalenceGatePassed: true,
    anyRequiredSceneBlocked: false,
    ...overrides,
  };
}

function rubricItem(
  rubricItemId: string,
  verdict: RubricVerdict,
  weight = 1,
  required = true,
): RubricSessionItemInput {
  return { rubricItemId, verdict, weight, required };
}

function binding(
  artifactId: string,
  overrides?: Partial<TrustArtifactBindingInput>,
): TrustArtifactBindingInput {
  return {
    artifactId,
    status: "locked",
    effectiveTrustClass: TrustClass.MASTERY_ELIGIBLE,
    assistanceSnapshot: {
      assistanceLevel: "none",
      contentAssisted: false,
      capturedBy: "lock",
    },
    planKind: "voice_mastery",
    fingerprintMatch: true,
    ...overrides,
  };
}

// ─── 1. computeEffectiveTrustClass：最保守 ────────────────────────────────

describe("computeEffectiveTrustClass", () => {
  it("无降级条件 → requested=mastery 取 ceiling 内的 mastery", () => {
    assert.equal(computeEffectiveTrustClass(effectiveInput()), TrustClass.MASTERY_ELIGIBLE);
  });

  it("requested 超过 templateTrustCeiling → 取 ceiling（facet_eligible）", () => {
    const input = effectiveInput({
      requestedTrustClass: TrustClass.MASTERY_ELIGIBLE,
      templateTrustCeiling: TrustClass.FACET_ELIGIBLE,
    });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.FACET_ELIGIBLE);
  });

  it("disclosure 限制可证明上限 → facet_eligible", () => {
    const input = effectiveInput({ disclosureMaxProvable: TrustClass.FACET_ELIGIBLE });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.FACET_ELIGIBLE);
  });

  it("planKind=facet_only → 上限 facet_eligible", () => {
    const input = effectiveInput({ planKindCeiling: TrustClass.FACET_ELIGIBLE });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.FACET_ELIGIBLE);
  });

  it("普通单选/判断 → planKindCeiling=diagnostic_only", () => {
    const input = effectiveInput({ planKindCeiling: TrustClass.DIAGNOSTIC_ONLY });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.DIAGNOSTIC_ONLY);
  });

  it("assistance 激活 → practice_only（0 升级）", () => {
    const input = effectiveInput({ assistanceActivated: true });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.PRACTICE_ONLY);
  });

  it("attempts 超限 → practice_only", () => {
    const input = effectiveInput({ attemptsExceeded: true });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.PRACTICE_ONLY);
  });

  it("assisted 时即使 requested=facet 仍取 practice_only（assistance 更保守）", () => {
    const input = effectiveInput({
      requestedTrustClass: TrustClass.FACET_ELIGIBLE,
      assistanceActivated: true,
    });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.PRACTICE_ONLY);
  });

  it("stale（fingerprint 失配）→ not_assessable，无正式副作用", () => {
    const input = effectiveInput({ stale: true });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.NOT_ASSESSABLE);
  });

  it("integrity 失败（hash 失配/非 locked）→ not_assessable", () => {
    const input = effectiveInput({ integrityFailure: true });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.NOT_ASSESSABLE);
  });

  it("关键输入不可靠（ASR 低置信）→ not_assessable", () => {
    const input = effectiveInput({ inputUnreliable: true });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.NOT_ASSESSABLE);
  });

  it("多条件取最保守：disclosure=diagnostic_only 时即使其余全 mastery", () => {
    const input = effectiveInput({ disclosureMaxProvable: TrustClass.DIAGNOSTIC_ONLY });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.DIAGNOSTIC_ONLY);
  });

  it("stale 优先于 assistance：stale + assisted → not_assessable", () => {
    const input = effectiveInput({ stale: true, assistanceActivated: true });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.NOT_ASSESSABLE);
  });
});

describe("mostConservativeTrustClass", () => {
  it("取最低等级", () => {
    assert.equal(
      mostConservativeTrustClass([
        TrustClass.MASTERY_ELIGIBLE,
        TrustClass.DIAGNOSTIC_ONLY,
        TrustClass.FACET_ELIGIBLE,
      ]),
      TrustClass.DIAGNOSTIC_ONLY,
    );
  });
  it("空输入 fail closed 为 not_assessable", () => {
    assert.equal(mostConservativeTrustClass([]), TrustClass.NOT_ASSESSABLE);
  });
});

// ─── 2. issueEpisodeTrustDecision：decisionHash 确定性 ────────────────────

describe("issueEpisodeTrustDecision", () => {
  const base = {
    episodeId: "ep-1",
    effectiveClass: TrustClass.MASTERY_ELIGIBLE,
    sourceArtifactIds: ["art-b", "art-a"],
    frozenProbeSetHash: "fp-hash-1",
    requiredRubricCoverageHash: "rc-hash-1",
    bundlePolicyVersion: "structured-mastery-bundle-v1",
    assistanceSnapshotHash: "assist-hash-1",
    reasonCodes: ["z-reason", "a-reason"],
  };

  it("相同冻结输入 → 相同 decisionHash（同 artifact 重放 hash 一致）", () => {
    const d1 = issueEpisodeTrustDecision(base);
    const d2 = issueEpisodeTrustDecision(base);
    assert.equal(d1.decisionHash, d2.decisionHash);
    assert.match(d1.decisionHash, /^[0-9a-f]{64}$/);
  });

  it("sourceArtifactIds / reasonCodes 顺序不影响 hash（排序幂等）", () => {
    const shuffled = issueEpisodeTrustDecision({
      ...base,
      sourceArtifactIds: ["art-a", "art-b"],
      reasonCodes: ["a-reason", "z-reason"],
    });
    const d = issueEpisodeTrustDecision(base);
    assert.deepEqual(shuffled.sourceArtifactIds, ["art-a", "art-b"]);
    assert.equal(shuffled.decisionHash, d.decisionHash);
  });

  it("任一语义字段变更 → hash 变化", () => {
    const d = issueEpisodeTrustDecision(base);
    assert.notEqual(
      issueEpisodeTrustDecision({ ...base, effectiveClass: TrustClass.FACET_ELIGIBLE })
        .decisionHash,
      d.decisionHash,
    );
    assert.notEqual(
      issueEpisodeTrustDecision({ ...base, assistanceSnapshotHash: "assist-hash-2" })
        .decisionHash,
      d.decisionHash,
    );
    assert.notEqual(
      issueEpisodeTrustDecision({ ...base, sourceArtifactIds: ["art-a", "art-c"] })
        .decisionHash,
      d.decisionHash,
    );
  });

  it("bundlePolicyVersion 存在与否影响 hash", () => {
    const d = issueEpisodeTrustDecision(base);
    const noVersion = issueEpisodeTrustDecision({
      episodeId: base.episodeId,
      effectiveClass: base.effectiveClass,
      sourceArtifactIds: base.sourceArtifactIds,
      frozenProbeSetHash: base.frozenProbeSetHash,
      requiredRubricCoverageHash: base.requiredRubricCoverageHash,
      assistanceSnapshotHash: base.assistanceSnapshotHash,
      reasonCodes: base.reasonCodes,
    });
    assert.notEqual(noVersion.decisionHash, d.decisionHash);
  });

  it("verifyEpisodeTrustDecision：重建一致；篡改后不通过", () => {
    const d = issueEpisodeTrustDecision(base);
    assert.equal(verifyEpisodeTrustDecision(d), true);
    const tampered = { ...d, effectiveClass: TrustClass.PRACTICE_ONLY };
    assert.equal(verifyEpisodeTrustDecision(tampered), false);
    const hashTampered = { ...d, decisionHash: "f".repeat(64) };
    assert.equal(verifyEpisodeTrustDecision(hashTampered), false);
  });
});

// ─── 3. runRubricSessionReducer：四态 ─────────────────────────────────────

describe("runRubricSessionReducer", () => {
  it("全部 required covered 且加权 ≥ 0.70 → pass", () => {
    const out = runRubricSessionReducer([
      rubricItem("r1", RubricVerdict.COVERED, 1),
      rubricItem("r2", RubricVerdict.COVERED, 2),
      rubricItem("o1", RubricVerdict.PARTIAL, 1, false),
    ]);
    assert.equal(out.result, RubricSessionResult.PASS);
    assert.equal(out.allRequiredCovered, true);
    assert.equal(out.weightedCoverage, (3 + 0.5) / 4);
  });

  it("required 全 covered 但加权 < 0.70 → partial", () => {
    const out = runRubricSessionReducer([
      rubricItem("r1", RubricVerdict.COVERED, 1),
      rubricItem("r2", RubricVerdict.COVERED, 1),
      rubricItem("o1", RubricVerdict.PARTIAL, 3, false),
      rubricItem("o2", RubricVerdict.PARTIAL, 3, false),
    ]);
    assert.equal(out.result, RubricSessionResult.PARTIAL);
    assert.equal(out.weightedCoverage, (2 + 3) / 8);
    assert.equal(out.reasonCodes[0], "coverage_below_threshold");
  });

  it("required 存在 partial 未全 covered → partial", () => {
    const out = runRubricSessionReducer([
      rubricItem("r1", RubricVerdict.COVERED, 1),
      rubricItem("r2", RubricVerdict.PARTIAL, 1),
    ]);
    assert.equal(out.result, RubricSessionResult.PARTIAL);
    assert.equal(out.allRequiredCovered, false);
  });

  it("required missing → fail", () => {
    const out = runRubricSessionReducer([
      rubricItem("r1", RubricVerdict.COVERED, 1),
      rubricItem("r2", RubricVerdict.MISSING, 1),
    ]);
    assert.equal(out.result, RubricSessionResult.FAIL);
    assert.equal(out.missingRequired, true);
    assert.equal(out.reasonCodes[0], "required_missing");
  });

  it("任一 contradicted（即使 required 全 covered）→ fail", () => {
    const out = runRubricSessionReducer([
      rubricItem("r1", RubricVerdict.COVERED, 1),
      rubricItem("r2", RubricVerdict.CONTRADICTED, 1),
    ]);
    assert.equal(out.result, RubricSessionResult.FAIL);
    assert.equal(out.hasContradiction, true);
    assert.equal(out.reasonCodes[0], "contradicted_present");
  });

  it("optional contradicted 也 fail closed", () => {
    const out = runRubricSessionReducer([
      rubricItem("r1", RubricVerdict.COVERED, 1),
      rubricItem("o1", RubricVerdict.CONTRADICTED, 1, false),
    ]);
    assert.equal(out.result, RubricSessionResult.FAIL);
  });

  it("全部 item missing/not_assessable → not_assessable", () => {
    const out = runRubricSessionReducer([
      rubricItem("r1", RubricVerdict.MISSING, 1),
      rubricItem("r2", RubricVerdict.MISSING, 1),
    ]);
    assert.equal(out.result, RubricSessionResult.NOT_ASSESSABLE);
    assert.equal(out.reasonCodes[0], "all_items_unassessed");
  });

  it("任一 required not_assessable → not_assessable（fail closed）", () => {
    const out = runRubricSessionReducer([
      rubricItem("r1", RubricVerdict.COVERED, 1),
      rubricItem("r2", RubricVerdict.NOT_ASSESSABLE, 1),
    ]);
    assert.equal(out.result, RubricSessionResult.NOT_ASSESSABLE);
    assert.equal(out.reasonCodes[0], "required_not_assessable");
  });

  it("结构性非法输入 throw（empty / no required / invalid verdict / weight）", () => {
    assert.throws(() => runRubricSessionReducer([]), ReducerError);
    assert.throws(
      () => runRubricSessionReducer([rubricItem("o1", RubricVerdict.COVERED, 1, false)]),
      ReducerError,
    );
    assert.throws(
      () => runRubricSessionReducer([rubricItem("r1", "bogus" as RubricVerdict, 1)]),
      ReducerError,
    );
    assert.throws(
      () => runRubricSessionReducer([rubricItem("r1", RubricVerdict.COVERED, 0)]),
      ReducerError,
    );
  });
});

// ─── 4. facet-to-mastery-policy-v1 七条规则各一例 ─────────────────────────

describe("applyFacetToMasteryPolicy（facet-to-mastery-policy-v1）", () => {
  it("R1：单个 facet_eligible 不消费/不延长 schedule（authorizedAction 也不能例外）", () => {
    const verdict = applyFacetToMasteryPolicy(
      policyInput({
        planKind: "facet_only",
        authorizedAction: "consume_pending",
        effectiveClass: TrustClass.FACET_ELIGIBLE,
      }),
    );
    assert.ok(verdict.ruleHits.includes(1));
    assert.equal(verdict.scheduleSideEffect, "none");
    assert.equal(verdict.allowed, true);
  });

  it("R2：只有预声明 facet_only 的完整 Episode 才能 commit facet evidence", () => {
    const verdict = applyFacetToMasteryPolicy(
      policyInput({
        planKind: "voice_mastery",
        effectiveClass: TrustClass.FACET_ELIGIBLE,
      }),
    );
    assert.ok(verdict.ruleHits.includes(2));
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.scheduleSideEffect, "none");
  });

  it("R3：structured_mastery_bundle 未完成 → 已完成 Scene 仅 support artifact", () => {
    const verdict = applyFacetToMasteryPolicy(
      policyInput({ episodeComplete: false, completedRequiredSceneCount: 2, requiredSceneCount: 3 }),
    );
    assert.ok(verdict.ruleHits.includes(3));
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.scheduleSideEffect, "none");
  });

  it("R4：voice_mastery 未覆盖全部 required rubric → 不能签发 mastery_eligible", () => {
    const verdict = applyFacetToMasteryPolicy(
      policyInput({
        planKind: "voice_mastery",
        reducerResult: partialResult(),
        effectiveClass: TrustClass.MASTERY_ELIGIBLE,
      }),
    );
    assert.ok(verdict.ruleHits.includes(4));
    assert.equal(verdict.maxTrustClass, TrustClass.FACET_ELIGIBLE);
  });

  it("R5：structured-proof-v1 资格不足（无 Gold / 场景不足）→ 不能 mastery", () => {
    const verdict = applyFacetToMasteryPolicy(policyInput({ structuredProofEligible: false }));
    assert.ok(verdict.ruleHits.includes(5));
    assert.equal(verdict.maxTrustClass, TrustClass.FACET_ELIGIBLE);
  });

  it("R6：bundle 任一 required Scene 未完成/stale/assisted/not-assessable → 不能消费 input schedule", () => {
    const verdict = applyFacetToMasteryPolicy(policyInput({ anyRequiredSceneBlocked: true }));
    assert.ok(verdict.ruleHits.includes(6));
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.scheduleSideEffect, "none");
  });

  it("R7：等价 Gate 通过前结构 Scene 最高 facet_eligible", () => {
    const verdict = applyFacetToMasteryPolicy(policyInput({ equivalenceGatePassed: false }));
    assert.ok(verdict.ruleHits.includes(7));
    assert.equal(verdict.maxTrustClass, TrustClass.FACET_ELIGIBLE);
  });

  it("R7：record_only / no_effect 的 schedule 写入必须为 0", () => {
    const verdict = applyFacetToMasteryPolicy(
      policyInput({
        planKind: "facet_only",
        authorizedAction: "record_only",
        effectiveClass: TrustClass.FACET_ELIGIBLE,
      }),
    );
    assert.ok(verdict.ruleHits.includes(7));
    assert.equal(verdict.scheduleSideEffect, "none");
  });

  it("mastery 完整路径：全部规则通过 → 允许恰一 schedule（consume_pending）", () => {
    const verdict = applyFacetToMasteryPolicy(
      policyInput({
        planKind: "voice_mastery",
        authorizedAction: "consume_pending",
        effectiveClass: TrustClass.MASTERY_ELIGIBLE,
      }),
    );
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.maxTrustClass, TrustClass.MASTERY_ELIGIBLE);
    assert.equal(verdict.scheduleSideEffect, "consume_pending");
  });

  it("practice plan：一律无正式归约与副作用（0 升级 0 延长）", () => {
    const verdict = applyFacetToMasteryPolicy(
      policyInput({
        planKind: "practice",
        authorizedAction: "no_effect",
        effectiveClass: TrustClass.PRACTICE_ONLY,
        reducerResult: partialResult(),
      }),
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.scheduleSideEffect, "none");
  });
});

// ─── 5. artifactEligibilityFilter：practice 不参与、只收 assistance 前 trusted locked ──

describe("artifactEligibilityFilter", () => {
  it("locked + trusted + 未辅助 + fingerprint 匹配 → 合格", () => {
    const out = artifactEligibilityFilter([binding("a1")]);
    assert.deepEqual(out.eligible, [
      { artifactId: "a1", effectiveTrustClass: TrustClass.MASTERY_ELIGIBLE },
    ]);
    assert.equal(out.rejected.length, 0);
  });

  it("facet_eligible 也合格", () => {
    const out = artifactEligibilityFilter([
      binding("a1", { effectiveTrustClass: TrustClass.FACET_ELIGIBLE }),
    ]);
    assert.equal(out.eligible.length, 1);
  });

  it("practice artifact 不参与正式归约", () => {
    const out = artifactEligibilityFilter([
      binding("a1", {
        planKind: "practice",
        effectiveTrustClass: TrustClass.PRACTICE_ONLY,
        assistanceSnapshot: {
          assistanceLevel: "content_assisted",
          contentAssisted: true,
          capturedBy: "assistance",
        },
      }),
    ]);
    assert.equal(out.eligible.length, 0);
    assert.equal(out.rejected[0].reasonCode, "practice_plan_excluded");
  });

  it("非 locked 拒绝", () => {
    const out = artifactEligibilityFilter([binding("a1", { status: "draft" })]);
    assert.equal(out.rejected[0].reasonCode, "not_locked");
  });

  it("stale（fingerprint 失配）拒绝，无副作用", () => {
    const out = artifactEligibilityFilter([binding("a1", { fingerprintMatch: false })]);
    assert.equal(out.rejected[0].reasonCode, "stale_fingerprint");
  });

  it("assistance 先赢（snapshot capturedBy=assistance）→ 拒绝", () => {
    const out = artifactEligibilityFilter([
      binding("a1", {
        assistanceSnapshot: {
          assistanceLevel: "practice_only",
          contentAssisted: true,
          capturedBy: "assistance",
        },
      }),
    ]);
    assert.equal(out.rejected[0].reasonCode, "assisted");
  });

  it("lock 先赢冻结 pre-exposure snapshot 后 reveal 不追溯污染已锁 artifact", () => {
    // snapshot capturedBy="lock" && contentAssisted=false → 仍合格
    const out = artifactEligibilityFilter([
      binding("a1", {
        assistanceSnapshot: {
          assistanceLevel: "none",
          contentAssisted: false,
          capturedBy: "lock",
        },
      }),
    ]);
    assert.equal(out.eligible.length, 1);
  });

  it("非 trusted（diagnostic_only/practice_only）拒绝", () => {
    const out = artifactEligibilityFilter([
      binding("a1", { effectiveTrustClass: TrustClass.DIAGNOSTIC_ONLY }),
    ]);
    assert.equal(out.rejected[0].reasonCode, "not_trusted");
  });

  it("混合输入：只收合格者，其余逐条给拒绝原因", () => {
    const out = artifactEligibilityFilter([
      binding("a1"),
      binding("a2", { status: "superseded" }),
      binding("a3", { planKind: "practice" }),
      binding("a4", { fingerprintMatch: false }),
    ]);
    assert.deepEqual(
      out.eligible.map((e) => e.artifactId),
      ["a1"],
    );
    assert.deepEqual(
      out.rejected.map((r) => r.artifactId).sort(),
      ["a2", "a3", "a4"],
    );
  });
});

// ─── 6. 验收：assisted/stale 结果 0 升级、0 延长 interval ─────────────────

describe("assisted/stale 0 升级 0 延长（验收）", () => {
  it("assisted → effectiveTrustClass=practice_only（0 升级）", () => {
    const input = effectiveInput({
      requestedTrustClass: TrustClass.MASTERY_ELIGIBLE,
      templateTrustCeiling: TrustClass.MASTERY_ELIGIBLE,
      assistanceActivated: true,
    });
    assert.equal(computeEffectiveTrustClass(input), TrustClass.PRACTICE_ONLY);
  });

  it("assisted bundle → policy 判定无 schedule 副作用（0 延长 interval）", () => {
    const verdict = applyFacetToMasteryPolicy(
      policyInput({ anyRequiredSceneBlocked: true, effectiveClass: TrustClass.MASTERY_ELIGIBLE }),
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.scheduleSideEffect, "none");
  });

  it("stale → not_assessable，且过滤排除（无副作用）", () => {
    assert.equal(
      computeEffectiveTrustClass(effectiveInput({ stale: true })),
      TrustClass.NOT_ASSESSABLE,
    );
    const out = artifactEligibilityFilter([binding("a1", { fingerprintMatch: false })]);
    assert.equal(out.eligible.length, 0);
    assert.equal(out.rejected[0].reasonCode, "stale_fingerprint");
  });
});
