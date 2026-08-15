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
// §10.1/§11.4（2026-08-15 接线修复）：journey/bridge 合同此前**从未从 index
// 导出**——API 侧 journey-service/delivery-routes/context 全部 TS2305，
// 前端契约 import 亦只能走深路径。补齐后全链类型一致。
export * from "./companion-journey-contracts.ts";
export * from "./companion-bridge-contracts.ts";
// §11.4（2026-08-15 接线修复）：understanding 投影合同此前**不存在**——
// projection-routes 的 understandingRoutePlanRequestV1Schema 值导入缺失，
// API 加载即崩。新建后随 index 导出。
export * from "./understanding-projection-contracts.ts";
export * from "./companion-learning-session-contracts.ts";
export * from "./companion-persona.ts";

// ─── 方案 20 V2 导出（R35 恢复：并行会话 19:59 恢复工作区时冲掉） ─────────
export * from "./learning-target-v2-contracts.ts";
export * from "./learning-run-contracts.ts";
export * from "./learning-card-v2-contracts.ts";
export * from "./learning-assessment.ts";
// learning-session-contracts 的 TrustClass 与 learning-run-contracts 冲突：
// 显式导出（TrustClass 以别名提供，值/类型均由 learning-run-contracts 提供权威名）。
// learning-session-contracts：TrustClass 与 learning-run-contracts 同名冲突，
// 手动 re-export（值/类型分开声明，避免 export * 歧义）。
import { CapabilityFacet as LSCapabilityFacet, TrustClass as LSTrustClass } from "./learning-session-contracts.ts";
export const CapabilityFacet = LSCapabilityFacet;
export type CapabilityFacet = (typeof LSCapabilityFacet)[keyof typeof LSCapabilityFacet];
export const LearningSessionTrustClass = LSTrustClass;
export type LearningSessionTrustClass = (typeof LSTrustClass)[keyof typeof LSTrustClass];
export type { RubricTarget, FrozenProbeRef } from "./learning-session-contracts.ts";
export * from "./learning-trust-contracts.ts";
export * from "./card-generation-v2-contracts.ts";
export * from "./card-generation-v2-hashing.ts";
export * from "./card-quality-v2-contracts.ts";
export * from "./published-learning-asset-contract.ts";
