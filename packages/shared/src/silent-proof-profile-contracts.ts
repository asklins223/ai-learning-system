/**
 * silent-proof-profile-contracts.ts（阶段 05 / W4，任务 05-1）
 *
 * 单一来源（01-2 §7.4/§8.2/§8.3 冻结语义 + 05-w4 任务 05-1）：
 * - SilentProofProfile 是 versioned 资格模板，不是对所有知识通吃的小游戏；
 *   初始 family：procedure（排序 + 修复）、causal-boundary（关系重建 + 条件变式）、
 *   concept-application（开放构建 + 情境应用）；
 * - 每个合格 bundle 至少两个互补 Scene；structured-proof-v1 至少两个预冻结、
 *   互补、无中途反馈且高区分度的结构 Scene，联合覆盖全部 required rubric；
 * - 每个 structuredProofEligibilityReport 必须证明五项：全部 required facets 可由
 *   未泄漏答案的结构证据覆盖、公开 token 不覆盖所声称的 recall、任务具有足够
 *   区分度、A11y 等价操作不降低语义要求、该 profile 已通过独立 Gold；
 * - 公测 silent route 采用 Key Point 级激活：100% 被路由到 structured proof
 *   的目标必须 eligibility=`eligible`；无 eligible profile 的目标不展示
 *   silent mastery 路线；
 * - Relation Canvas 只操作当前 Key Point 的冻结 Scene 结构，不创建共享
 *   semantic relation（relate facet 冻结边界，01-2 §8.1）。
 *
 * zod schema 风格与 packages/shared/src/schemas.ts /
 * learning-trust-contracts.ts 保持一致（z.object + .strict + z.infer）。
 *
 * 收口：由主代理统一在 packages/shared/src/index.ts 追加
 *   export * from "./silent-proof-profile-contracts.ts";
 */

import { z } from "zod";
import { CapabilityFacet } from "./learning-session-contracts.ts";

// ─── 基础枚举（§7.4）──────────────────────────────────────────────────────

/** 初始 ProfileFamily（01-2 §8.2）。实际启用 family 由 W0 corpus audit 与 Gold 决定。 */
export const ProfileFamily = {
  PROCEDURE: "procedure",
  CAUSAL_BOUNDARY: "causal-boundary",
  CONCEPT_APPLICATION: "concept-application",
} as const;
export type ProfileFamily = (typeof ProfileFamily)[keyof typeof ProfileFamily];

/** profile 生命周期状态；只有 active 的 profile 可被 Key Point 级激活使用。 */
export const ProfileStatus = {
  DRAFT: "draft",
  ACTIVE: "active",
  RETIRED: "retired",
} as const;
export type ProfileStatus = (typeof ProfileStatus)[keyof typeof ProfileStatus];

/** structuredProofEligibilityReport 综合判定（fail closed：全证明通过才 eligible）。 */
export const EligibilityStatus = {
  ELIGIBLE: "eligible",
  INELIGIBLE: "ineligible",
} as const;
export type EligibilityStatus = (typeof EligibilityStatus)[keyof typeof EligibilityStatus];

// ─── 复用 CapabilityFacet（learning-session-contracts 单一来源）─────────────

export const capabilityFacetEnum = z.enum([
  CapabilityFacet.RECALL,
  CapabilityFacet.EXPLAIN,
  CapabilityFacet.APPLY,
  CapabilityFacet.BOUNDARY,
  CapabilityFacet.PROCEDURE,
  CapabilityFacet.RELATE,
]);

// ─── SilentProofProfile（01-2 §8.2 冻结）──────────────────────────────────

export const silentProofProfileSchema = z.object({
  /** 稳定 profile id（registry 唯一） */
  id: z.string().min(1).max(160),
  /** versioned 资格模板版本，如 "v1" */
  version: z.string().min(1).max(40),
  /** 所属 family */
  family: z.enum([
    ProfileFamily.PROCEDURE,
    ProfileFamily.CAUSAL_BOUNDARY,
    ProfileFamily.CONCEPT_APPLICATION,
  ]),
  /** 该 profile 可证明的 capability facet（recall 除外：结构题公开 token 不覆盖 recall） */
  facets: z.array(capabilityFacetEnum).min(1).max(6),
  /** 互补 Scene 模板集合：每个合格 bundle 至少两个互补 Scene（01-2 §8.3 R5） */
  complementarySceneIds: z.array(z.string().min(1).max(160)).min(2).max(8),
  status: z.enum([ProfileStatus.DRAFT, ProfileStatus.ACTIVE, ProfileStatus.RETIRED]),
  /** 独立 Gold 认证 hash；active profile 必须持有，缺失则未通过独立 Gold，不得 eligible */
  goldCertificationHash: z.string().length(64).optional(),
}).strict();
export type SilentProofProfile = z.infer<typeof silentProofProfileSchema>;

// ─── structuredProofEligibilityReport（01-2 §8.2 五项证明）────────────────

/** 结构证据种类：只包含结构性（未泄漏答案）证据来源。 */
export const structuralEvidenceKindSchema = z.enum([
  "ordering_reconstruction", // 排：重建步骤/顺序（无提示排序）
  "repair_with_justification", // 修：定位并修复错误流程/论证，附用户依据
  "relation_reconstruction", // 连：在冻结结构内重建因果/组成/前置关系
  "conditional_variant", // 演：条件变式/后果预测
  "open_construction", // 开放构建：主动构建理由/条件 artifact
  "situated_application", // 情境应用：迁移到新情境
]);
export type StructuralEvidenceKind = z.infer<typeof structuralEvidenceKindSchema>;

/** 逐 facet 结构证据覆盖绑定。 */
export const facetCoverageEvidenceSchema = z.object({
  facet: capabilityFacetEnum,
  /** 证据来源 Scene 模板（必须属于 profile.complementarySceneIds） */
  sceneId: z.string().min(1).max(160),
  evidenceKind: structuralEvidenceKindSchema,
  /** 该证据在展示题面（public token）时不泄漏正确答案 */
  answerNotLeaked: z.boolean(),
}).strict();
export type FacetCoverageEvidence = z.infer<typeof facetCoverageEvidenceSchema>;

/** 证明 1：全部 required facets 可由未泄漏答案的结构证据覆盖。 */
export const coverageProofSchema = z.object({
  /** 每个 required facet 至少一条 answerNotLeaked=true 的结构证据 */
  requiredFacetsCovered: z.boolean(),
  /** 逐 facet 覆盖证据（保留输入序） */
  facetCoverage: z.array(facetCoverageEvidenceSchema).max(64),
  /** 任何证据泄漏答案 / 证据场景不在 profile 互补 Scene 结构内 → false（fail closed） */
  disclosureBoundaryRespected: z.boolean(),
  reasonCodes: z.array(z.string().min(1)).max(50),
}).strict();
export type CoverageProof = z.infer<typeof coverageProofSchema>;

/** 证明 2：公开 token 不覆盖所声称的 recall。 */
export const recallNonDisclosureSchema = z.object({
  /** 声称的无提示 recall facet（结构题不得声称 → 必须为空数组） */
  claimedRecallFacets: z.array(capabilityFacetEnum).max(6),
  /** 公开 token 是否泄漏/声称了 recall（true → 不达标） */
  publicTokensDiscloseAnswer: z.boolean(),
  /** recall 只能由未泄漏的结构证据覆盖；不声称 recall 时视为满足 */
  recallCoveredByStructuralEvidenceOnly: z.boolean(),
  reasonCodes: z.array(z.string().min(1)).max(50),
}).strict();
export type RecallNonDisclosure = z.infer<typeof recallNonDisclosureSchema>;

/** 任务区分度 basis（§6.4 降级因素的正面镜像）。 */
export const discriminationBasisSchema = z.enum([
  "valid_distractors", // 存在有效 distractor/错误项
  "no_unique_slot_guess", // 非"只剩唯一槽位"推理
  "multi_step_dependency", // 多步依赖，不能单步猜中
  "no_snapping_assist", // 无吸附正确位辅助
  "sufficient_operation_count", // 操作次数满足最大上限约束且可区分
]);
export type DiscriminationBasis = z.infer<typeof discriminationBasisSchema>;

/** 证明 3：任务具有足够区分度。 */
export const discriminationProofSchema = z.object({
  /** basis 非空 → sufficient；空 → 不足（fail closed） */
  sufficient: z.boolean(),
  basis: z.array(discriminationBasisSchema).max(16),
  reasonCodes: z.array(z.string().min(1)).max(50),
}).strict();
export type DiscriminationProof = z.infer<typeof discriminationProofSchema>;

/** A11y 等价操作（01-2 §3.1 每个 Scene 冻结的等价路径）。 */
export const a11yEquivalenceKindSchema = z.enum([
  "tap_select_place", // 点选对象 → 选择动作 → 点选目标
  "keyboard", // 键盘移动/连接/撤销/锁定
  "screen_reader", // 读屏可理解的节点/关系/顺序描述
  "reduced_motion", // reduced-motion 静态变化等价路径
]);
export type A11yEquivalenceKind = z.infer<typeof a11yEquivalenceKindSchema>;

/** 证明 4：A11y 等价操作不降低语义要求。 */
export const a11yEquivalenceProofSchema = z.object({
  /** 等价操作存在且语义要求未降低（空 → false，fail closed） */
  semanticRequirementUnchanged: z.boolean(),
  equivalentOperations: z.array(a11yEquivalenceKindSchema).max(8),
  reasonCodes: z.array(z.string().min(1)).max(50),
}).strict();
export type A11yEquivalenceProof = z.infer<typeof a11yEquivalenceProofSchema>;

/** 证明 5：该 profile 已通过独立 Gold（false-upgrade/false-downgrade Gate，§16.2）。 */
export const goldPassedProofSchema = z.object({
  independentGoldPassed: z.boolean(),
  /** 匹配 profile.goldCertificationHash 的独立 Gold 认证引用 */
  goldCertificationHash: z.string().length(64),
  reasonCodes: z.array(z.string().min(1)).max(50),
}).strict();
export type GoldPassedProof = z.infer<typeof goldPassedProofSchema>;

/** structuredProofEligibilityReport（01-2 §8.2）：Key Point 级资格报告。 */
export const structuredProofEligibilityReportSchema = z.object({
  profileId: z.string().min(1).max(160),
  keyPointId: z.string().min(1).max(160),
  /** 该 Key Point 的 required rubric facets（联合覆盖目标） */
  requiredFacets: z.array(capabilityFacetEnum).min(1).max(6),
  coverageProof: coverageProofSchema,
  recallNonDisclosure: recallNonDisclosureSchema,
  discrimination: discriminationProofSchema,
  a11yEquivalence: a11yEquivalenceProofSchema,
  goldPassed: goldPassedProofSchema,
  /** 综合判定：五项全部通过才 eligible，否则 ineligible（fail closed） */
  eligibility: z.enum([EligibilityStatus.ELIGIBLE, EligibilityStatus.INELIGIBLE]),
}).strict();
export type StructuredProofEligibilityReport = z.infer<
  typeof structuredProofEligibilityReportSchema
>;
