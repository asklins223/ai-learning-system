export * from "./enums.ts";
export * from "./types.ts";
export * from "./schemas.ts";
export * from "./constants.ts";
export * from "./review-attempt.ts";
export * from "./rubric-reducer.ts";
export * from "./scheduling-policy-v2.ts";
export * from "./scheduling-unified.ts";
export * from "./fingerprint.ts";
export * from "./question-safety.ts";
export * from "./deterministic-question.ts";
export * from "./fsrs-shadow.ts";
export * from "./fsrs-compare-report.ts";
export * from "./feature-flags.ts";
export * from "./effective-evidence.ts";
export * from "./safe-error.ts";
export * from "./output-sanitizer.ts";
export * from "./card-agent-contracts.ts";
export * from "./provider-capabilities.ts";
export * from "./provider-registry.ts";
export * from "./task-router.ts";
export * from "./platform-config.ts";
export * from "./companion-shell-contracts.ts";
export * from "./auth-surface-manifest.ts";
export * from "./published-learning-asset-contract.ts";
export * from "./learning-session-contracts.ts";
export * from "./voice-artifact-contracts.ts";
export * from "./learning-trust-contracts.ts";
export * from "./learning-assessment.ts";
export * from "./content-hash.ts";
export * from "./scene-contracts.ts";
// 2026-08-12（契约收口）：完整导出 silent-proof-profile-contracts（此前仅
// 4 个类型别名显式导出，ProfileStatus/EligibilityStatus 等契约符号 api 侧
// 拿不到，只能自造双份实现——silent-profile-registry.ts 已改为引用本模块）。
// 消歧（14 方案实施核验发现）：A11yEquivalenceKind 与 scene-contracts.ts 的
// 同名导出冲突（值域同为 tap_select_place/keyboard/screen_reader/reduced_motion），
// export * 会触发 TS2308；此处改为显式导出并给 silent 侧类型加
// SilentProof 前缀别名（scene-contracts 的同名导出保留原语义）。
export {
  ProfileFamily,
  ProfileStatus,
  EligibilityStatus,
  capabilityFacetEnum,
  silentProofProfileSchema,
  type SilentProofProfile,
  structuralEvidenceKindSchema,
  type StructuralEvidenceKind,
  facetCoverageEvidenceSchema,
  type FacetCoverageEvidence,
  coverageProofSchema,
  type CoverageProof,
  recallNonDisclosureSchema,
  type RecallNonDisclosure,
  discriminationBasisSchema,
  type DiscriminationBasis,
  discriminationProofSchema,
  type DiscriminationProof,
  a11yEquivalenceKindSchema,
  a11yEquivalenceProofSchema,
  type A11yEquivalenceProof,
  goldPassedProofSchema,
  type GoldPassedProof,
  structuredProofEligibilityReportSchema,
  type StructuredProofEligibilityReport,
} from "./silent-proof-profile-contracts.ts";
export type {
  A11yEquivalenceKind as SilentProofA11yEquivalenceKind,
} from "./silent-proof-profile-contracts.ts";
export * from "./capability-bundle.ts";
export * from "./desktop-pet-contracts.ts";
export * from "./companion-asr-contracts.ts";
export * from "./companion-character-contracts.ts";
export * from "./companion-emotion-classifier.ts";
export * from "./companion-conversation-contracts.ts";
export * from "./companion-learning-session-contracts.ts";
export * from "./companion-persona.ts";
