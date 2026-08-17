export * from "./enums.ts";
export * from "./types.ts";
export * from "./schemas.ts";
export * from "./constants.ts";
export * from "./review-attempt.ts";
export * from "./rubric-reducer.ts";
export * from "./scheduling-policy-v2.ts";
export * from "./scheduling-unified.ts";
// 2026-08-13：fingerprint/content-hash/published-learning-asset-contract 为
// 服务端专用（node: 依赖），改从子路径 import，不再经 index 全量导出
//（客户端 bundle 加载会触发 node: 缺失崩溃）。
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
// 2026-08-13（web 客户端打包修复）：task-router 依赖 platform-config-node
// （node:fs）——服务端专用，改从 @ailearn/shared/task-router 子路径 import，
// 不再经 index 全量导出（客户端加载会触发 node:fs 缺失崩溃）。
export * from "./platform-config.ts";
export * from "./companion-shell-contracts.ts";
export * from "./auth-surface-manifest.ts";
export * from "./learning-session-contracts.ts";
// 2026-08-13：LearningRun V1 统一合同（文档 16 §12 冻结）——四对象 wire
// contract 唯一来源。旧 learning-session-contracts.ts 仍作为内部演进细节保留。
export * from "./learning-run-contracts.ts";
// 消歧：TrustClass 在旧/新两模块同名导出（旧文件已 re-export 自新文件，
// 值域一致）。显式导出以消除 export * 歧义。
export { TrustClass } from "./learning-run-contracts.ts";
// 2026-08-13：Main ↔ Pet Bridge V2 合同（文档 16 §14 冻结）。
export * from "./companion-bridge-contracts.ts";
// 2026-08-13：Journey V2 合同（文档 16 §10.1 冻结）。
export * from "./companion-journey-contracts.ts";
// 2026-08-14：方案 20（learning-card-v2）Generation 域合同——纯 zod schema
// + 类型（无 node: 依赖，客户端安全）。hash 计算函数走
// @ailearn/shared/card-generation-v2-hashing 子路径（服务端专用）。
export * from "./card-generation-v2-contracts.ts";
// 2026-08-14：方案 20 LearningCard V2 公共合同（Public Card/Reveal/Publication）。
export * from "./learning-card-v2-contracts.ts";
// 2026-08-14：方案 20 LearningTargetSnapshotV2 合同（§16 Target Rebase）。
export * from "./learning-target-v2-contracts.ts";
export * from "./voice-artifact-contracts.ts";
export * from "./learning-trust-contracts.ts";
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
export * from "./card-quality-v2-contracts.ts";
export * from "./voice-expression-tags.ts";
export * from "./learning-objective-surface-contracts.ts";
export * from "./understanding-topology-v3-contracts.ts";

export type * from "./published-learning-asset-contract.ts";
export type * from "./fingerprint.ts";
export type * from "./content-hash.ts";
export type * from "./learning-assessment.ts";
