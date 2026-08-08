/**
 * 任务 05-1：最小 SilentProofProfile registry 与 eligibility matrix 单测。
 *
 * 覆盖（验收，05-w4 任务 05-1 / 01-2 §7.4/§8.2/§8.3）：
 * - family 注册：3 family（procedure / causal-boundary / concept-application）
 *   各含最小 profile，id 唯一、status=active、gold 认证存在、validateRegistry 通过；
 * - 互补 Scene 约束：每个合格 bundle 至少两个互补 Scene（§8.2 初始 family 组合）；
 * - structuredProofEligibilityReport 五项证明：coverage（无泄漏覆盖）、
 *   recall 不覆盖、区分度、A11y 等价、独立 Gold；任一失败 → ineligible（fail closed）；
 * - Key Point 级激活：100% 被路由到 structured proof 的目标必须 eligible；
 *   无 eligible profile 的目标不展示 silent mastery 路线；
 * - Relation Canvas 只操作当前 Key Point 冻结 Scene 结构，不创建共享 semantic relation。
 *
 * 验收断言：无 eligible profile 的目标 silentMasteryRouteOffered=false；
 * 报告五项中任一不满足 → eligibility=ineligible。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CapabilityFacet } from "@ailearn/shared";
import {
  assertKeyPointEligibility,
  buildEligibilityReport,
  EligibilityReportError,
  EligibilityStatus,
  getAllSilentProofProfiles,
  getProfilesForFamily,
  getSilentProofProfile,
  INITIAL_SILENT_PROOF_PROFILES,
  ProfileFamily,
  ProfileStatus,
  PROFILE_REGISTRY_VERSION,
  proveA11yEquivalence,
  proveCoverage,
  proveDiscrimination,
  proveGoldPassed,
  proveRecallNonDisclosure,
  relationCanvasScopedToFrozenScene,
  validateRegistry,
  type BuildEligibilityReportInput,
  type FacetCoverageEvidence,
} from "./silent-profile-registry.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

const PROCEDURE_PROFILE_ID = "silent-proof-procedure-v1";

function procedureProfile() {
  const profile = getSilentProofProfile(PROCEDURE_PROFILE_ID);
  assert.ok(profile, "procedure profile must be registered");
  return profile;
}

/** 通过全部五项证明的最小报告输入（procedure profile）。 */
function reportInput(overrides?: Partial<BuildEligibilityReportInput>): BuildEligibilityReportInput {
  const profile = procedureProfile();
  return {
    profileId: profile.id,
    keyPointId: "kp-procedure-1",
    requiredFacets: [CapabilityFacet.PROCEDURE, CapabilityFacet.BOUNDARY],
    facetCoverageEvidence: [
      {
        facet: CapabilityFacet.PROCEDURE,
        sceneId: "ordering-scene-v1",
        evidenceKind: "ordering_reconstruction",
        answerNotLeaked: true,
      },
      {
        facet: CapabilityFacet.BOUNDARY,
        sceneId: "repair-scene-v1",
        evidenceKind: "repair_with_justification",
        answerNotLeaked: true,
      },
    ],
    claimedRecallFacets: [],
    discriminationBasis: ["valid_distractors", "no_unique_slot_guess"],
    a11yEquivalentOperations: ["tap_select_place", "keyboard", "screen_reader", "reduced_motion"],
    goldCertificationHash: profile.goldCertificationHash ?? "",
    ...overrides,
  };
}

const MISMATCH_GOLD_HASH = "f".repeat(64);

// ─── 1. family 注册 ───────────────────────────────────────────────────────

describe("silent-proof-profile-registry: family 注册", () => {
  it("注册 3 个初始 family，且每个 family 至少一个 profile", () => {
    const profiles = getAllSilentProofProfiles();
    const families = new Set(profiles.map((p) => p.family));
    assert.deepEqual(
      [...families].sort(),
      [
        ProfileFamily.CONCEPT_APPLICATION,
        ProfileFamily.CAUSAL_BOUNDARY,
        ProfileFamily.PROCEDURE,
      ].sort(),
    );
    for (const family of [
      ProfileFamily.PROCEDURE,
      ProfileFamily.CAUSAL_BOUNDARY,
      ProfileFamily.CONCEPT_APPLICATION,
    ]) {
      assert.ok(
        profiles.some((p) => p.family === family),
        `family ${family} 必须注册至少一个 profile`,
      );
    }
  });

  it("profile id 全局唯一，version=registry-v1，status=active", () => {
    const ids = INITIAL_SILENT_PROOF_PROFILES.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of INITIAL_SILENT_PROOF_PROFILES) {
      assert.equal(p.version, "v1");
      assert.equal(p.status, ProfileStatus.ACTIVE);
      assert.match(p.id, /^silent-proof-/);
    }
  });

  it("registry 版本与一致性校验通过", () => {
    assert.equal(PROFILE_REGISTRY_VERSION, "silent-proof-profile-registry-v1");
    const verdict = validateRegistry();
    assert.deepEqual(verdict, { valid: true, reasonCodes: [] });
  });

  it("getSilentProofProfile 查找命中与未命中", () => {
    assert.equal(getSilentProofProfile(PROCEDURE_PROFILE_ID)?.id, PROCEDURE_PROFILE_ID);
    assert.equal(getSilentProofProfile("silent-proof-unknown"), null);
  });

  it("getProfilesForFamily 按 family 过滤", () => {
    const causal = getProfilesForFamily(ProfileFamily.CAUSAL_BOUNDARY);
    assert.equal(causal.length, 1);
    assert.equal(causal[0]?.family, ProfileFamily.CAUSAL_BOUNDARY);
    assert.equal(getProfilesForFamily(ProfileFamily.PROCEDURE).length, 1);
  });
});

// ─── 2. 互补 Scene 约束（§8.2 初始 family）────────────────────────────────

describe("silent-proof-profile-registry: 互补 Scene 约束", () => {
  it("每个合格 bundle 至少两个互补 Scene", () => {
    for (const p of INITIAL_SILENT_PROOF_PROFILES) {
      assert.ok(
        p.complementarySceneIds.length >= 2,
        `${p.id} 必须至少两个互补 Scene`,
      );
    }
  });

  it("procedure family = 排序 + 修复", () => {
    const p = procedureProfile();
    assert.deepEqual(
      [...p.complementarySceneIds].sort(),
      ["ordering-scene-v1", "repair-scene-v1"],
    );
    assert.deepEqual([...p.facets].sort(), [CapabilityFacet.BOUNDARY, CapabilityFacet.PROCEDURE]);
  });

  it("causal-boundary family = 关系重建 + 条件变式", () => {
    const p = getProfilesForFamily(ProfileFamily.CAUSAL_BOUNDARY)[0];
    assert.ok(p);
    assert.deepEqual(
      [...p.complementarySceneIds].sort(),
      ["conditional-variant-scene-v1", "relation-canvas-scene-v1"],
    );
    assert.deepEqual(
      [...p.facets].sort(),
      [CapabilityFacet.APPLY, CapabilityFacet.BOUNDARY, CapabilityFacet.RELATE],
    );
  });

  it("concept-application family = 开放构建 + 情境应用", () => {
    const p = getProfilesForFamily(ProfileFamily.CONCEPT_APPLICATION)[0];
    assert.ok(p);
    assert.deepEqual(
      [...p.complementarySceneIds].sort(),
      ["open-construction-scene-v1", "situated-application-scene-v1"],
    );
    assert.deepEqual(
      [...p.facets].sort(),
      [CapabilityFacet.APPLY, CapabilityFacet.EXPLAIN],
    );
  });

  it("profile 内互补 Scene 无重复，active profile 均持有 Gold 认证 hash", () => {
    const hex64 = /^[0-9a-f]{64}$/;
    for (const p of INITIAL_SILENT_PROOF_PROFILES) {
      assert.equal(new Set(p.complementarySceneIds).size, p.complementarySceneIds.length);
      assert.ok(p.goldCertificationHash, `${p.id} active 必须通过独立 Gold`);
      assert.match(p.goldCertificationHash ?? "", hex64);
    }
  });

  it("任何 profile 都不声明 recall（结构题公开 token 不覆盖无提示 recall）", () => {
    for (const p of INITIAL_SILENT_PROOF_PROFILES) {
      assert.ok(!p.facets.includes(CapabilityFacet.RECALL), `${p.id} 不得声称 recall`);
    }
  });
});

// ─── 3. structuredProofEligibilityReport 五项证明 ─────────────────────────

describe("buildEligibilityReport: 五项证明与 fail closed 综合", () => {
  it("全部证明通过 → eligibility=eligible", () => {
    const report = buildEligibilityReport(reportInput());
    assert.equal(report.eligibility, EligibilityStatus.ELIGIBLE);
    assert.equal(report.profileId, PROCEDURE_PROFILE_ID);
    assert.equal(report.keyPointId, "kp-procedure-1");
    assert.deepEqual([...report.requiredFacets].sort(), [
      CapabilityFacet.BOUNDARY,
      CapabilityFacet.PROCEDURE,
    ]);
    assert.ok(report.coverageProof.requiredFacetsCovered);
    assert.ok(report.coverageProof.disclosureBoundaryRespected);
    assert.ok(!report.recallNonDisclosure.publicTokensDiscloseAnswer);
    assert.ok(report.discrimination.sufficient);
    assert.ok(report.a11yEquivalence.semanticRequirementUnchanged);
    assert.ok(report.goldPassed.independentGoldPassed);
  });

  it("证明 1：required facet 无结构证据覆盖 → ineligible", () => {
    const report = buildEligibilityReport(
      reportInput({
        facetCoverageEvidence: [
          {
            facet: CapabilityFacet.PROCEDURE,
            sceneId: "ordering-scene-v1",
            evidenceKind: "ordering_reconstruction",
            answerNotLeaked: true,
          },
          // BOUNDARY 缺失覆盖
        ],
      }),
    );
    assert.equal(report.eligibility, EligibilityStatus.INELIGIBLE);
    assert.equal(report.coverageProof.requiredFacetsCovered, false);
    assert.ok(report.coverageProof.reasonCodes.some((r) => r.startsWith("missing_facet_coverage:")));
  });

  it("证明 1：结构证据泄漏答案 → ineligible", () => {
    const report = buildEligibilityReport(
      reportInput({
        facetCoverageEvidence: [
          {
            facet: CapabilityFacet.PROCEDURE,
            sceneId: "ordering-scene-v1",
            evidenceKind: "ordering_reconstruction",
            answerNotLeaked: false, // 泄漏
          },
          {
            facet: CapabilityFacet.BOUNDARY,
            sceneId: "repair-scene-v1",
            evidenceKind: "repair_with_justification",
            answerNotLeaked: true,
          },
        ],
      }),
    );
    assert.equal(report.eligibility, EligibilityStatus.INELIGIBLE);
    assert.equal(report.coverageProof.disclosureBoundaryRespected, false);
    assert.ok(report.coverageProof.reasonCodes.includes("answer_leaked_by_structural_evidence"));
  });

  it("证明 1：证据场景不在 profile 互补 Scene 结构 → ineligible", () => {
    const report = buildEligibilityReport(
      reportInput({
        facetCoverageEvidence: [
          {
            facet: CapabilityFacet.PROCEDURE,
            sceneId: "unrelated-scene-v1", // 越界
            evidenceKind: "ordering_reconstruction",
            answerNotLeaked: true,
          },
          {
            facet: CapabilityFacet.BOUNDARY,
            sceneId: "repair-scene-v1",
            evidenceKind: "repair_with_justification",
            answerNotLeaked: true,
          },
        ],
      }),
    );
    assert.equal(report.eligibility, EligibilityStatus.INELIGIBLE);
    assert.ok(
      report.coverageProof.reasonCodes.includes(
        "evidence_scene_outside_profile_complementary_set",
      ),
    );
  });

  it("证明 2：声称 recall → ineligible（公开 token 不覆盖无提示 recall）", () => {
    const report = buildEligibilityReport(
      reportInput({
        requiredFacets: [CapabilityFacet.PROCEDURE, CapabilityFacet.BOUNDARY, CapabilityFacet.RECALL],
        claimedRecallFacets: [CapabilityFacet.RECALL],
      }),
    );
    assert.equal(report.eligibility, EligibilityStatus.INELIGIBLE);
    assert.equal(report.recallNonDisclosure.publicTokensDiscloseAnswer, true);
    assert.ok(
      report.recallNonDisclosure.reasonCodes.includes(
        "recall_not_provable_by_structured_scene_public_tokens",
      ),
    );
  });

  it("证明 3：任务无区分度 basis → ineligible", () => {
    const report = buildEligibilityReport(reportInput({ discriminationBasis: [] }));
    assert.equal(report.eligibility, EligibilityStatus.INELIGIBLE);
    assert.equal(report.discrimination.sufficient, false);
    assert.ok(report.discrimination.reasonCodes.includes("no_discrimination_basis"));
  });

  it("证明 4：缺少 A11y 等价操作 → ineligible", () => {
    const report = buildEligibilityReport(reportInput({ a11yEquivalentOperations: [] }));
    assert.equal(report.eligibility, EligibilityStatus.INELIGIBLE);
    assert.equal(report.a11yEquivalence.semanticRequirementUnchanged, false);
    assert.ok(report.a11yEquivalence.reasonCodes.includes("missing_a11y_equivalent_operations"));
  });

  it("证明 5：独立 Gold 认证不匹配 → ineligible", () => {
    const report = buildEligibilityReport(reportInput({ goldCertificationHash: MISMATCH_GOLD_HASH }));
    assert.equal(report.eligibility, EligibilityStatus.INELIGIBLE);
    assert.equal(report.goldPassed.independentGoldPassed, false);
    assert.ok(report.goldPassed.reasonCodes.includes("independent_gold_not_passed_or_mismatch"));
  });

  it("profile 未注册 → EligibilityReportError(profile_not_found)", () => {
    assert.throws(
      () =>
        buildEligibilityReport(
          reportInput({ profileId: "silent-proof-does-not-exist" }),
        ),
      (err: unknown) =>
        err instanceof EligibilityReportError && err.code === "profile_not_found",
    );
  });

  it("五项证明可独立调用（纯函数，各自判定）", () => {
    const profile = procedureProfile();
    const evidence: FacetCoverageEvidence[] = [
      {
        facet: CapabilityFacet.PROCEDURE,
        sceneId: "ordering-scene-v1",
        evidenceKind: "ordering_reconstruction",
        answerNotLeaked: true,
      },
    ];
    assert.equal(proveCoverage(profile, [CapabilityFacet.PROCEDURE], evidence).requiredFacetsCovered, true);
    assert.equal(
      proveRecallNonDisclosure(profile, [CapabilityFacet.PROCEDURE], []).publicTokensDiscloseAnswer,
      false,
    );
    assert.equal(proveDiscrimination(["valid_distractors"]).sufficient, true);
    assert.equal(proveDiscrimination([]).sufficient, false);
    assert.equal(
      proveA11yEquivalence(["keyboard", "screen_reader"]).semanticRequirementUnchanged,
      true,
    );
    assert.equal(
      proveA11yEquivalence([]).semanticRequirementUnchanged,
      false,
    );
    assert.equal(
      proveGoldPassed(profile, profile.goldCertificationHash ?? "").independentGoldPassed,
      true,
    );
  });
});

// ─── 4. Key Point 级激活（无 eligible profile 不展示 silent mastery 路线）──

describe("assertKeyPointEligibility: Key Point 级激活", () => {
  it("未路由到 structured proof → 允许且不展示 silent route", () => {
    const verdict = assertKeyPointEligibility({
      keyPointId: "kp-a",
      routedToStructuredProof: false,
      eligibilityReport: null,
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.silentMasteryRouteOffered, false);
  });

  it("路由到 structured proof 但无 eligible profile → 拒绝且不展示 silent mastery 路线", () => {
    const verdict = assertKeyPointEligibility({
      keyPointId: "kp-a",
      routedToStructuredProof: true,
      eligibilityReport: null,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.silentMasteryRouteOffered, false);
    assert.equal(verdict.reasonCode, "no_eligible_profile_for_key_point");
  });

  it("路由但报告 ineligible → 拒绝且不展示 silent mastery 路线", () => {
    const ineligible = buildEligibilityReport(reportInput({ discriminationBasis: [] }));
    const verdict = assertKeyPointEligibility({
      keyPointId: "kp-procedure-1",
      routedToStructuredProof: true,
      eligibilityReport: ineligible,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.silentMasteryRouteOffered, false);
    assert.equal(verdict.reasonCode, "key_point_not_eligible");
  });

  it("路由但报告 keyPointId 不匹配 → 拒绝", () => {
    const eligible = buildEligibilityReport(reportInput());
    const verdict = assertKeyPointEligibility({
      keyPointId: "kp-other",
      routedToStructuredProof: true,
      eligibilityReport: eligible,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reasonCode, "eligibility_report_key_point_mismatch");
  });

  it("路由且 eligibility=eligible → 允许并展示 silent mastery 路线", () => {
    const eligible = buildEligibilityReport(reportInput());
    const verdict = assertKeyPointEligibility({
      keyPointId: "kp-procedure-1",
      routedToStructuredProof: true,
      eligibilityReport: eligible,
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.silentMasteryRouteOffered, true);
    assert.equal(verdict.reasonCode, "eligible_silent_mastery_route");
  });
});

// ─── 5. Relation Canvas 作用域守卫 ────────────────────────────────────────

describe("relationCanvasScopedToFrozenScene: Relation Canvas 作用域", () => {
  const frozenScenes = ["relation-canvas-scene-v1", "conditional-variant-scene-v1"];

  it("创建共享 semantic relation → 拒绝", () => {
    const verdict = relationCanvasScopedToFrozenScene({
      keyPointId: "kp-causal-1",
      sceneId: "relation-canvas-scene-v1",
      targetsSharedSemanticRelation: true,
      frozenSceneIds: frozenScenes,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reasonCode, "shared_semantic_relation_not_allowed");
  });

  it("操作目标不在当前 Key Point 冻结 Scene 结构 → 拒绝", () => {
    const verdict = relationCanvasScopedToFrozenScene({
      keyPointId: "kp-causal-1",
      sceneId: "ordering-scene-v1",
      targetsSharedSemanticRelation: false,
      frozenSceneIds: frozenScenes,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reasonCode, "scene_outside_frozen_structure");
  });

  it("冻结 Scene 结构内且不建共享关系 → 允许", () => {
    const verdict = relationCanvasScopedToFrozenScene({
      keyPointId: "kp-causal-1",
      sceneId: "relation-canvas-scene-v1",
      targetsSharedSemanticRelation: false,
      frozenSceneIds: frozenScenes,
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reasonCode, "relation_canvas_scoped_to_frozen_scene");
  });
});
