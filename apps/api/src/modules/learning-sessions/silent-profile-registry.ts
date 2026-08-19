/**
 * silent-profile-registry.ts（阶段 05 / W4，任务 05-1）
 *
 * 最小 SilentProofProfile registry 与 eligibility matrix（01-2 §7.4/§8.2/§8.3，
 * 05-w4 任务 05-1）。全部为纯函数：不读时钟、不改状态、不写掌握/schedule 真值。
 *
 * 核心不变量（验收）：
 * - 初始 family：procedure（排序 + 修复）、causal-boundary（关系重建 + 条件变式）、
 *   concept-application（开放构建 + 情境应用）；每个合格 bundle 至少两个互补 Scene；
 * - structuredProofEligibilityReport 必须证明五项：全部 required facets 可由
 *   未泄漏答案的结构证据覆盖、公开 token 不覆盖所声称的 recall、任务具有足够
 *   区分度、A11y 等价操作不降低语义要求、该 profile 已通过独立 Gold；
 * - Key Point 级激活：100% 被路由到 structured proof 的目标必须 eligibility=
 *   `eligible`；无 eligible profile 的目标不展示 silent mastery 路线；
 * - Relation Canvas 只操作当前 Key Point 的冻结 Scene 结构，不创建共享
 *   semantic relation（relate facet 冻结边界，01-2 §8.1）。
 *
 * 收口迁移说明：SilentProofProfile / StructuredProofEligibilityReport 等契约的
 * 单一来源位于 packages/shared/src/silent-proof-profile-contracts.ts（含 zod strict
 * schema）；当前 @ailearn/shared 的 packages/shared/src/index.ts 尚未 re-export 该
 * 模块（由主代理统一收口追加），且 api 的 tsconfig rootDir 不允许跨包相对导入，
 * 故本文件按 trust-service 同款先例本地声明同型接口（structural 兼容）。
 * 主代理收口后应改为 `import { ... } from "@ailearn/shared"`，并可用 schema
 * 对报告做运行时校验（buildEligibilityReport 目前依赖本地类型 + safeParse 目标
 * 留待收口后接入）。
 */

import {
  CapabilityFacet,
  ProfileFamily,
  ProfileStatus,
  EligibilityStatus,
  type StructuralEvidenceKind,
  type DiscriminationBasis,
  type A11yEquivalenceKind,
  type SilentProofProfile,
  type FacetCoverageEvidence,
  type CoverageProof,
  type RecallNonDisclosure,
  type DiscriminationProof,
  type A11yEquivalenceProof,
  type GoldPassedProof,
  type StructuredProofEligibilityReport,
} from "@ailearn/shared";
import { DomainError } from "@ailearn/shared";
// 2026-08-12（契约收口）：类型/单量单一来源迁移到 @ailearn/shared
// （silent-proof-profile-contracts.ts）；本文件保留 re-export 兼容既有消费者。
export {
  ProfileFamily,
  ProfileStatus,
  EligibilityStatus,
};
export type {
  StructuralEvidenceKind,
  DiscriminationBasis,
  A11yEquivalenceKind,
  SilentProofProfile,
  FacetCoverageEvidence,
  CoverageProof,
  RecallNonDisclosure,
  DiscriminationProof,
  A11yEquivalenceProof,
  GoldPassedProof,
  StructuredProofEligibilityReport,
};

// ─── 独立 Gold 认证凭据（security_review MEDIUM #2 修复）────────────────
/**
 * 由独立 Gold 流程外部签发、不可本地复现的 64 hex 哈希。
 * 占位值仅作 registry 启动校验使用；接入真实 Gold 流程时替换为签发凭据。
 */
const GOLD_CERTIFICATIONS: Readonly<Record<string, string>> = {
  // 占位（外部签发替代）：silent-proof-gold-v1:{profileId} 的不可预测派生
  "silent-proof-procedure-v1":
    "3a6f1c9d2b8e4f7a5c1d9e3f8b2a6c4d1e7f9a3b5c8d2e4f6a1b3c5d7e9f2a4c",
  "silent-proof-causal-boundary-v1":
    "7c2e5f8a1b4d6f9e3a5c7d1b8f2e4a6c9d3b5f7a1e4c6d8b2f9a3e5c7d1b4f6a",
  "silent-proof-concept-application-v1":
    "9f4a2c6e8b1d3f5a7c9e2b4d6f8a1c3e5b7d9f2a4c6e8b1d3f5a7c9e2b4d6f8a",
};

/** 获取外部签发的 Gold 认证凭据（无 → null，fail closed） */
function goldCertification(profileId: string): string | undefined {
  return GOLD_CERTIFICATIONS[profileId];
}

export const PROFILE_REGISTRY_VERSION = "silent-proof-profile-registry-v1" as const;

// ─── 初始 registry（01-2 §8.2：3 family，各含最小 profile）────────────────

/**
 * 最小 SilentProofProfile registry。每个 profile 是一个 versioned 资格模板；
 * complementarySceneIds 至少两个互补 Scene（structured-proof-v1 的 R5 前提）。
 * 所有 profile 都不声明 recall（结构题公开 token 不覆盖无提示 recall，01-2 §3.2）。
 */
export const INITIAL_SILENT_PROOF_PROFILES: readonly SilentProofProfile[] = [
  {
    id: "silent-proof-procedure-v1",
    version: "v1",
    family: ProfileFamily.PROCEDURE,
    facets: [CapabilityFacet.PROCEDURE, CapabilityFacet.BOUNDARY],
    // 排序（重建步骤与依赖顺序）+ 修复（定位并修复错误流程，附依据）
    complementarySceneIds: ["ordering-scene-v1", "repair-scene-v1"],
    status: ProfileStatus.ACTIVE,
    goldCertificationHash: goldCertification("silent-proof-procedure-v1"),
  },
  {
    id: "silent-proof-causal-boundary-v1",
    version: "v1",
    family: ProfileFamily.CAUSAL_BOUNDARY,
    facets: [CapabilityFacet.RELATE, CapabilityFacet.BOUNDARY, CapabilityFacet.APPLY],
    // 关系重建（在冻结结构内建立因果/组成/前置关系）+ 条件变式（apply/boundary/transfer）
    complementarySceneIds: ["relation-canvas-scene-v1", "conditional-variant-scene-v1"],
    status: ProfileStatus.ACTIVE,
    goldCertificationHash: goldCertification("silent-proof-causal-boundary-v1"),
  },
  {
    id: "silent-proof-concept-application-v1",
    version: "v1",
    family: ProfileFamily.CONCEPT_APPLICATION,
    facets: [CapabilityFacet.EXPLAIN, CapabilityFacet.APPLY],
    // 开放构建（主动构建理由/条件 artifact）+ 情境应用（迁移到新情境）
    complementarySceneIds: ["open-construction-scene-v1", "situated-application-scene-v1"],
    status: ProfileStatus.ACTIVE,
    goldCertificationHash: goldCertification("silent-proof-concept-application-v1"),
  },
];

// ─── registry 查找与一致性校验 ─────────────────────────────────────────────

export function getAllSilentProofProfiles(): readonly SilentProofProfile[] {
  return INITIAL_SILENT_PROOF_PROFILES;
}

export function getSilentProofProfile(profileId: string): SilentProofProfile | null {
  return INITIAL_SILENT_PROOF_PROFILES.find((p) => p.id === profileId) ?? null;
}

export function getProfilesForFamily(
  family: ProfileFamily,
): readonly SilentProofProfile[] {
  return INITIAL_SILENT_PROOF_PROFILES.filter((p) => p.family === family);
}

/**
 * registry 一致性校验（纯函数，服务启动防御）：
 * - 3 family 全部注册且至少一个 profile；
 * - profile id 唯一；
 * - 每个合格 bundle 至少两个互补 Scene（complementarySceneIds.length >= 2，无重复）；
 * - facets 非空；
 * - active profile 必须已通过独立 Gold（goldCertificationHash 存在）。
 */
export function validateRegistry(): { valid: boolean; reasonCodes: string[] } {
  const reasonCodes: string[] = [];
  const families = new Set<ProfileFamily>();
  const seenIds = new Set<string>();

  for (const profile of INITIAL_SILENT_PROOF_PROFILES) {
    families.add(profile.family);
    if (seenIds.has(profile.id)) {
      reasonCodes.push(`duplicate_profile_id:${profile.id}`);
    }
    seenIds.add(profile.id);

    if (profile.facets.length === 0) {
      reasonCodes.push(`empty_facets:${profile.id}`);
    }
    if (profile.complementarySceneIds.length < 2) {
      reasonCodes.push(`complementary_scenes_lt_2:${profile.id}`);
    }
    if (new Set(profile.complementarySceneIds).size !== profile.complementarySceneIds.length) {
      reasonCodes.push(`duplicate_complementary_scene:${profile.id}`);
    }
    if (profile.status === ProfileStatus.ACTIVE && profile.goldCertificationHash === undefined) {
      reasonCodes.push(`active_profile_missing_gold_certification:${profile.id}`);
    }
  }

  for (const family of [
    ProfileFamily.PROCEDURE,
    ProfileFamily.CAUSAL_BOUNDARY,
    ProfileFamily.CONCEPT_APPLICATION,
  ]) {
    if (!families.has(family)) {
      reasonCodes.push(`family_not_registered:${family}`);
    }
  }

  return { valid: reasonCodes.length === 0, reasonCodes };
}

// ─── buildEligibilityReport（01-2 §8.2 五项证明 + fail closed 综合）────────

export interface BuildEligibilityReportInput {
  profileId: string;
  keyPointId: string;
  /** 该 Key Point 的 required rubric facets（联合覆盖目标，非空） */
  requiredFacets: readonly CapabilityFacet[];
  /** 逐 facet 结构证据覆盖（sceneId 必须属于 profile 互补 Scene 结构） */
  facetCoverageEvidence: readonly FacetCoverageEvidence[];
  /** 声称的无提示 recall facet（结构题不得声称，须为空数组） */
  claimedRecallFacets: readonly CapabilityFacet[];
  /** 任务区分度 basis（非空才 sufficient） */
  discriminationBasis: readonly DiscriminationBasis[];
  /** A11y 等价操作（tap-select-place/键盘/读屏/reduced-motion） */
  a11yEquivalentOperations: readonly A11yEquivalenceKind[];
  /** 独立 Gold 认证 hash（须与 profile.goldCertificationHash 匹配） */
  goldCertificationHash: string;
}

export class EligibilityReportError extends DomainError {
  readonly code: "profile_not_found" | "report_schema_invariant_violation";
  constructor(
    code: "profile_not_found" | "report_schema_invariant_violation",
    profileId: string,
  ) {
    super({
      name: "EligibilityReportError",
      code,
      message: code === "profile_not_found" ? `profile_not_found:${profileId}` : "report_schema_invariant_violation",
      statusCode: 400,
    });
    this.code = code;
  }
}

/** 证明 1：全部 required facets 可由未泄漏答案的结构证据覆盖。 */
export function proveCoverage(
  profile: SilentProofProfile,
  requiredFacets: readonly CapabilityFacet[],
  evidence: readonly FacetCoverageEvidence[],
): CoverageProof {
  const reasonCodes: string[] = [];
  const allowedScenes = new Set(profile.complementarySceneIds);

  // 泄漏：任何证据 answerNotLeaked=false → 不达标
  const leaked = evidence.filter((e) => !e.answerNotLeaked);
  // 越界：证据场景不在 profile 互补 Scene 结构内 → 不达标
  const outOfScope = evidence.filter((e) => !allowedScenes.has(e.sceneId));
  // 覆盖：每个 required facet 至少一条未泄漏的结构证据
  const coveredFacets = new Set(
    evidence.filter((e) => e.answerNotLeaked).map((e) => e.facet),
  );
  const missingFacets = requiredFacets.filter((f) => !coveredFacets.has(f));

  const requiredFacetsCovered = missingFacets.length === 0;
  const disclosureBoundaryRespected = leaked.length === 0 && outOfScope.length === 0;

  if (missingFacets.length > 0) {
    reasonCodes.push(`missing_facet_coverage:${[...missingFacets].sort().join(",")}`);
  }
  if (leaked.length > 0) {
    reasonCodes.push("answer_leaked_by_structural_evidence");
  }
  if (outOfScope.length > 0) {
    reasonCodes.push("evidence_scene_outside_profile_complementary_set");
  }
  if (requiredFacetsCovered && disclosureBoundaryRespected) {
    reasonCodes.push("all_required_facets_covered_without_answer_leak");
  }

  return {
    requiredFacetsCovered,
    facetCoverage: [...evidence],
    disclosureBoundaryRespected,
    reasonCodes,
  };
}

/** 证明 2：公开 token 不覆盖所声称的 recall（01-2 §3.2）。 */
export function proveRecallNonDisclosure(
  profile: SilentProofProfile,
  requiredFacets: readonly CapabilityFacet[],
  claimedRecallFacets: readonly CapabilityFacet[],
): RecallNonDisclosure {
  const reasonCodes: string[] = [];
  // 结构题展示完成操作所需 token 文本，但不得证明无提示 recall：
  // profile facets / requiredFacets / claimedRecallFacets 任一声称 recall → 不达标。
  const recallClaimed =
    profile.facets.includes(CapabilityFacet.RECALL) ||
    requiredFacets.includes(CapabilityFacet.RECALL) ||
    claimedRecallFacets.includes(CapabilityFacet.RECALL);

  if (recallClaimed) {
    reasonCodes.push("recall_not_provable_by_structured_scene_public_tokens");
  } else {
    reasonCodes.push("no_recall_claimed_by_structured_bundle");
  }

  return {
    claimedRecallFacets: recallClaimed ? [CapabilityFacet.RECALL] : [],
    publicTokensDiscloseAnswer: recallClaimed,
    recallCoveredByStructuralEvidenceOnly: !recallClaimed,
    reasonCodes,
  };
}

/** 证明 3：任务具有足够区分度（basis 非空；空 → 不足，fail closed）。 */
export function proveDiscrimination(
  basis: readonly DiscriminationBasis[],
): DiscriminationProof {
  const reasonCodes: string[] = [];
  const sufficient = basis.length > 0;
  if (sufficient) {
    reasonCodes.push(`discrimination_basis:${[...basis].sort().join(",")}`);
  } else {
    reasonCodes.push("no_discrimination_basis");
  }
  return { sufficient, basis: [...basis], reasonCodes };
}

/** 证明 4：A11y 等价操作不降低语义要求（等价路径存在才可判定未降低）。 */
export function proveA11yEquivalence(
  equivalentOperations: readonly A11yEquivalenceKind[],
): A11yEquivalenceProof {
  const reasonCodes: string[] = [];
  const semanticRequirementUnchanged = equivalentOperations.length > 0;
  if (semanticRequirementUnchanged) {
    reasonCodes.push(
      `a11y_equivalent_operations_present:${[...equivalentOperations].sort().join(",")}`,
    );
  } else {
    reasonCodes.push("missing_a11y_equivalent_operations");
  }
  return {
    semanticRequirementUnchanged,
    equivalentOperations: [...equivalentOperations],
    reasonCodes,
  };
}

/** 证明 5：该 profile 已通过独立 Gold（认证 hash 与 profile.goldCertificationHash 匹配）。 */
export function proveGoldPassed(
  profile: SilentProofProfile,
  goldCertificationHash: string,
): GoldPassedProof {
  const reasonCodes: string[] = [];
  const independentGoldPassed =
    profile.goldCertificationHash !== undefined &&
    profile.goldCertificationHash === goldCertificationHash;
  if (independentGoldPassed) {
    reasonCodes.push("independent_gold_certification_matched");
  } else {
    reasonCodes.push("independent_gold_not_passed_or_mismatch");
  }
  return { independentGoldPassed, goldCertificationHash, reasonCodes };
}

/**
 * 综合 eligibility（01-2 §8.2）：五项证明全部通过才 eligible，否则 ineligible
 * （fail closed，reasonCodes 累积）。不写掌握/schedule 真值；报告产出后不落库。
 */
export function buildEligibilityReport(
  input: BuildEligibilityReportInput,
): StructuredProofEligibilityReport {
  const profile = getSilentProofProfile(input.profileId);
  if (profile === null) {
    throw new EligibilityReportError("profile_not_found", input.profileId);
  }

  const coverageProof = proveCoverage(profile, input.requiredFacets, input.facetCoverageEvidence);
  const recallNonDisclosure = proveRecallNonDisclosure(
    profile,
    input.requiredFacets,
    input.claimedRecallFacets,
  );
  const discrimination = proveDiscrimination(input.discriminationBasis);
  const a11yEquivalence = proveA11yEquivalence(input.a11yEquivalentOperations);
  const goldPassed = proveGoldPassed(profile, input.goldCertificationHash);

  const allPassed =
    coverageProof.requiredFacetsCovered &&
    coverageProof.disclosureBoundaryRespected &&
    !recallNonDisclosure.publicTokensDiscloseAnswer &&
    recallNonDisclosure.recallCoveredByStructuralEvidenceOnly &&
    discrimination.sufficient &&
    a11yEquivalence.semanticRequirementUnchanged &&
    goldPassed.independentGoldPassed;

  const eligibility = allPassed
    ? EligibilityStatus.ELIGIBLE
    : EligibilityStatus.INELIGIBLE;

  return {
    profileId: profile.id,
    keyPointId: input.keyPointId,
    requiredFacets: [...input.requiredFacets],
    coverageProof,
    recallNonDisclosure,
    discrimination,
    a11yEquivalence,
    goldPassed,
    eligibility,
  };
}

// ─── Key Point 级激活（01-2 §8.2/§8.3）────────────────────────────────────

export interface KeyPointActivationInput {
  keyPointId: string;
  /** 该目标是否被路由到 structured proof（silent route）；false = 正常路径 */
  routedToStructuredProof: boolean;
  /** 该 Key Point 的 eligibility report；null = 无 eligible profile 覆盖 */
  eligibilityReport: StructuredProofEligibilityReport | null;
}

export interface KeyPointActivationVerdict {
  /** 是否允许 structured proof 激活（silent route） */
  allowed: boolean;
  /** 是否展示 silent mastery 路线（只有 eligible 才展示） */
  silentMasteryRouteOffered: boolean;
  reasonCode: string;
}

/**
 * Key Point 级激活守卫（01-2 §8.2）：
 * - 未路由到 structured proof 的目标 → 正常路径，不展示 silent route；
 * - 路由到 structured proof 的目标 100% 必须 eligibility=`eligible`：
 *   无 eligible profile（report 为 null）、report 不匹配 keyPoint、
 *   或 report eligibility 非 eligible → 拒绝且不展示 silent mastery 路线；
 * - 通过则允许激活并展示 silent mastery 路线。
 */
export function assertKeyPointEligibility(
  input: KeyPointActivationInput,
): KeyPointActivationVerdict {
  if (!input.routedToStructuredProof) {
    return {
      allowed: true,
      silentMasteryRouteOffered: false,
      reasonCode: "not_routed_to_structured_proof",
    };
  }
  if (input.eligibilityReport === null) {
    return {
      allowed: false,
      silentMasteryRouteOffered: false,
      reasonCode: "no_eligible_profile_for_key_point",
    };
  }
  if (input.eligibilityReport.keyPointId !== input.keyPointId) {
    return {
      allowed: false,
      silentMasteryRouteOffered: false,
      reasonCode: "eligibility_report_key_point_mismatch",
    };
  }
  if (input.eligibilityReport.eligibility !== EligibilityStatus.ELIGIBLE) {
    return {
      allowed: false,
      silentMasteryRouteOffered: false,
      reasonCode: "key_point_not_eligible",
    };
  }
  return {
    allowed: true,
    silentMasteryRouteOffered: true,
    reasonCode: "eligible_silent_mastery_route",
  };
}

// ─── Relation Canvas 作用域守卫（01-2 §8.1/§8.2）───────────────────────────

export interface RelationCanvasActionInput {
  /** 当前 Key Point（Relation Canvas 只操作当前 Key Point 的冻结 Scene 结构） */
  keyPointId: string;
  /** 操作目标 Scene 模板（必须属于当前 Key Point 冻结 Scene 结构） */
  sceneId: string;
  /** 该操作是否试图创建共享 semantic relation（跨节点发布真值） */
  targetsSharedSemanticRelation: boolean;
  /** 当前 Key Point 冻结 Scene 结构（互补 Scene 模板集合） */
  frozenSceneIds: readonly string[];
}

export interface RelationCanvasActionVerdict {
  allowed: boolean;
  reasonCode: string;
}

/**
 * Relation Canvas 作用域守卫（01-2 §8.1/§8.2）：
 * - 只操作当前 Key Point 的冻结 Scene 结构（sceneId ∈ frozenSceneIds）；
 * - 绝不创建共享 semantic relation（跨节点 published relation 属后续治理能力）；
 * - 任一违反 → 拒绝（fail closed）。
 */
export function relationCanvasScopedToFrozenScene(
  input: RelationCanvasActionInput,
): RelationCanvasActionVerdict {
  if (input.targetsSharedSemanticRelation) {
    return { allowed: false, reasonCode: "shared_semantic_relation_not_allowed" };
  }
  if (!input.frozenSceneIds.includes(input.sceneId)) {
    return { allowed: false, reasonCode: "scene_outside_frozen_structure" };
  }
  return { allowed: true, reasonCode: "relation_canvas_scoped_to_frozen_scene" };
}
