/**
 * scene-contracts.ts（阶段 05 / W4，任务 05-2）
 *
 * Structured Scene DSL 契约单一来源（01-2 §3~§5 + 05-w4 任务 05-2 冻结语义）。
 *
 * 冻结语义（01-2 §6.3/§6.4）：
 * - 7 种 Scene 类型：VoiceTeachbackScene / OrderingScene / RelationCanvasScene /
 *   RepairScene / MultiStepScenarioScene / CounterexampleScene / OptionalTextScene；
 *   公测首版不允许模型任意生成界面，Supervisor 只能选择并填充 versioned Scene schema；
 * - 每个 Scene 冻结：scene/template/version、target IDs、source fingerprint、
 *   capability facet、public/secret 独立 hash/version、allowed token/node/edge/
 *   option IDs、disclosureProfile、逐 rubric evidence binding、assistance policy、
 *   template trust ceiling、反馈时点、distractor/branch/最大操作次数、
 *   A11y 等价路径；
 * - 物理拆分三对象：PublicSceneContract（可返回客户端）/ PrivateSceneSolution
 *   （仅服务端）/ PrivateLearningEpisodeContract（仅服务端）；客户端只得到净化 view；
 * - scene-safety-v1 判定：approved / repair_required / question_retryable / blocked。
 *
 * zod schema 风格与 packages/shared/src/schemas.ts /
 * silent-proof-profile-contracts.ts / learning-trust-contracts.ts 保持一致
 * （z.object + .strict + z.infer）。
 *
 * 收口：由主代理统一在 packages/shared/src/index.ts 追加
 *   export * from "./scene-contracts.ts";
 */

import { z } from "zod";
import { CapabilityFacet, TrustClass } from "./learning-session-contracts.ts";

// ─── 基础枚举（01-2 §6.3/§6.4）───────────────────────────────────────────

/** 运行两态（05-w4 任务 05-2）：formal 无即时泄题 / practice 可即时反馈。 */
export const SceneMode = {
  FORMAL: "formal",
  PRACTICE: "practice",
} as const;
export type SceneMode = (typeof SceneMode)[keyof typeof SceneMode];

/** 7 种 Scene 类型（01-2 §3 冻结，05-w4 任务 05-2）。 */
export const SceneType = {
  VOICE_TEACHBACK: "voice_teachback",
  ORDERING: "ordering",
  RELATION_CANVAS: "relation_canvas",
  REPAIR: "repair",
  MULTI_STEP_SCENARIO: "multi_step_scenario",
  COUNTEREXAMPLE: "counterexample",
  OPTIONAL_TEXT: "optional_text",
} as const;
export type SceneType = (typeof SceneType)[keyof typeof SceneType];

/** scene-safety-v1 判定（01-2 §3.3）：approved 可激活；其余不可。 */
export const SceneSafetyVerdict = {
  APPROVED: "approved",
  REPAIR_REQUIRED: "repair_required",
  QUESTION_RETRYABLE: "question_retryable",
  BLOCKED: "blocked",
} as const;
export type SceneSafetyVerdict =
  (typeof SceneSafetyVerdict)[keyof typeof SceneSafetyVerdict];

/** 反馈时点（01-2 §3.1 冻结字段）。formal 不得为 immediate（无即时泄题）。 */
export const FeedbackTiming = {
  NONE: "none",
  AFTER_ALL_PROBES: "after_all_probes",
  IMMEDIATE: "immediate",
} as const;
export type FeedbackTiming = (typeof FeedbackTiming)[keyof typeof FeedbackTiming];

/** A11y 等价路径种类（01-2 §3.1 / §6.6，05-w4 任务 05-3）。 */
export const A11yEquivalenceKind = {
  TAP_SELECT_PLACE: "tap_select_place",
  KEYBOARD: "keyboard",
  SCREEN_READER: "screen_reader",
  REDUCED_MOTION: "reduced_motion",
} as const;
export type A11yEquivalenceKind =
  (typeof A11yEquivalenceKind)[keyof typeof A11yEquivalenceKind];

/** rubric evidence 结构证据种类（01-2 §6.1 统一交互语法 + §9）。 */
export const EvidenceKind = {
  ORDERING_RECONSTRUCTION: "ordering_reconstruction",
  REPAIR_WITH_JUSTIFICATION: "repair_with_justification",
  RELATION_RECONSTRUCTION: "relation_reconstruction",
  CONDITIONAL_VARIANT: "conditional_variant",
  OPEN_CONSTRUCTION: "open_construction",
  SITUATED_APPLICATION: "situated_application",
  VOICE_TEACHBACK: "voice_teachback",
} as const;
export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

const trustClassEnum = z.enum([
  TrustClass.MASTERY_ELIGIBLE,
  TrustClass.FACET_ELIGIBLE,
  TrustClass.DIAGNOSTIC_ONLY,
  TrustClass.PRACTICE_ONLY,
  TrustClass.NOT_ASSESSABLE,
]);

const capabilityFacetEnum = z.enum([
  CapabilityFacet.RECALL,
  CapabilityFacet.EXPLAIN,
  CapabilityFacet.APPLY,
  CapabilityFacet.BOUNDARY,
  CapabilityFacet.PROCEDURE,
  CapabilityFacet.RELATE,
]);

// ─── 共享子 schema（01-2 §3.1 每个 Scene 冻结字段）────────────────────────

export const feedbackTimingSchema = z.enum([
  FeedbackTiming.NONE,
  FeedbackTiming.AFTER_ALL_PROBES,
  FeedbackTiming.IMMEDIATE,
]);

export const disclosureProfileSchema = z.object({
  /** 本 Scene 的 disclosure 最多可证明的 trust class（01-2 §3.2） */
  maxProvableTrustClass: trustClassEnum,
  /** 是否展示完成操作所必需的 token 文本（结构题 true，01-2 §3.2） */
  exposesTokenText: z.boolean(),
  /** 是否可证明无提示 recall（结构题恒 false：公开 token 不覆盖 recall） */
  provableRecall: z.boolean(),
  /** disclosure 决定的反馈时点（formal 不得 immediate） */
  feedbackTiming: feedbackTimingSchema,
}).strict();
export type DisclosureProfile = z.infer<typeof disclosureProfileSchema>;

export const rubricEvidenceBindingSchema = z.object({
  /** 绑定到冻结 RubricTarget（01-2 §9 逐项 evidence refs ⊆ RubricTarget.evidenceRefIds） */
  rubricItemId: z.string().min(1).max(160),
  criterion: z.string().min(1).max(500),
  /** 逐 rubric evidence binding：预绑定证据 refs */
  evidenceRefIds: z.array(z.string().min(1).max(160)).min(1).max(32),
  evidenceKind: z.enum([
    EvidenceKind.ORDERING_RECONSTRUCTION,
    EvidenceKind.REPAIR_WITH_JUSTIFICATION,
    EvidenceKind.RELATION_RECONSTRUCTION,
    EvidenceKind.CONDITIONAL_VARIANT,
    EvidenceKind.OPEN_CONSTRUCTION,
    EvidenceKind.SITUATED_APPLICATION,
    EvidenceKind.VOICE_TEACHBACK,
  ]),
  /** server-only expected target hash（绝不返回客户端，01-2 §7.1） */
  expectedTargetHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type RubricEvidenceBinding = z.infer<typeof rubricEvidenceBindingSchema>;

export const assistancePolicySchema = z.object({
  /** 是否允许 content assistance（允许 → practice_only 天花板，01-2 §7.6/§10） */
  contentHelpAllowed: z.boolean(),
  /** 内容帮助计数上限（0 = 不允许任何内容帮助） */
  maxContentHelpCount: z.number().int().nonnegative().max(16),
  /** practice 态是否即时揭示答案（formal 恒 false） */
  revealsAnswerOnAttempt: z.boolean(),
  /** 是否只允许不降级的中性辅助（原样 TTS/操作说明/重录/撤销） */
  neutralAssistanceOnly: z.boolean(),
}).strict();
export type AssistancePolicy = z.infer<typeof assistancePolicySchema>;

export const a11yEquivalentPathSchema = z.object({
  kind: z.enum([
    A11yEquivalenceKind.TAP_SELECT_PLACE,
    A11yEquivalenceKind.KEYBOARD,
    A11yEquivalenceKind.SCREEN_READER,
    A11yEquivalenceKind.REDUCED_MOTION,
  ]),
  description: z.string().min(1).max(500),
  /** 等价操作不降低语义要求（01-2 §3.1/§6.6 冻结项） */
  semanticRequirementUnchanged: z.boolean(),
}).strict();
export type A11yEquivalentPath = z.infer<typeof a11yEquivalentPathSchema>;

/** 每个 Scene 共享的冻结 header 字段（01-2 §3.1）。 */
const sceneHeaderFields = {
  template: z.string().min(1).max(160),
  version: z.string().min(1).max(40),
  target: z.object({
    keyPointId: z.string().min(1).max(160),
    targetIds: z.array(z.string().min(1).max(160)).min(1).max(16),
  }).strict(),
  /** source fingerprint：覆盖已发布 Card/Key Point revision 等（01-2 §11） */
  sourceFingerprint: z.string().min(1).max(200),
  capabilityFacet: capabilityFacetEnum,
  /** 运行两态：formal（无即时泄题）/ practice（可即时反馈） */
  mode: z.enum([SceneMode.FORMAL, SceneMode.PRACTICE]),
  /** public payload 与 secret solution 独立 hash/version（01-2 §3.1） */
  publicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  publicPayloadVersion: z.string().min(1).max(40),
  secretSolutionHash: z.string().regex(/^[0-9a-f]{64}$/),
  secretSolutionVersion: z.string().min(1).max(40),
  disclosureProfile: disclosureProfileSchema,
  /** 逐 rubric evidence binding（01-2 §3.1） */
  rubricEvidenceBindings: z.array(rubricEvidenceBindingSchema).min(1).max(32),
  assistancePolicy: assistancePolicySchema,
  /** template trust ceiling（01-2 §6.3：Scene policy 冻结最高等级） */
  templateTrustCeiling: trustClassEnum,
  feedbackTiming: feedbackTimingSchema,
  /** distractor / branch / 最大操作次数（01-2 §3.1） */
  distractorIds: z.array(z.string().min(1).max(160)).max(64),
  branchIds: z.array(z.string().min(1).max(160)).max(16),
  maxOperations: z.number().int().nonnegative().optional(),
  maxAttempts: z.number().int().nonnegative().optional(),
  /** keyboard / tap-select-place / screen-reader / reduced-motion 等价路径 */
  a11yEquivalentPaths: z.array(a11yEquivalentPathSchema).min(1).max(16),
} as const;

// ─── 7 种 Scene schema（public / secret 物理分字段）────────────────────────

// 1. VoiceTeachbackScene（语音讲解 → 最高 mastery_eligible，01-2 §6.4）
export const voiceTeachbackPublicSchema = z.object({
  prompt: z.string().min(1).max(2000),
  /** opaque token IDs（01-2 §3.2 净化题面） */
  allowedTokenIds: z.array(z.string().min(1).max(160)).min(1).max(64),
  /** 可见 token 文本（完成操作所必需的展示文本） */
  visibleTokenText: z.record(z.string().min(1).max(200)),
  recordingProtocol: z.string().min(1).max(500),
  maxRecordingSeconds: z.number().int().positive().max(300),
}).strict();
export type VoiceTeachbackPublic = z.infer<typeof voiceTeachbackPublicSchema>;

export const voiceTeachbackSecretSchema = z.object({
  /** server-only expected rubric targets（不返回客户端） */
  expectedRubricTargets: z.array(z.string().min(1).max(160)).min(1).max(16),
  /** canonical 证据 refs（事实支撑检查来源） */
  keyFactRefs: z.array(z.string().min(1).max(160)).min(1).max(32),
  /** 明确禁止的表述/claim（答案泄漏对抗） */
  disallowedClaims: z.array(z.string().min(1).max(500)).max(32),
}).strict();
export type VoiceTeachbackSecret = z.infer<typeof voiceTeachbackSecretSchema>;

export const voiceTeachbackSceneSchema = z.object({
  sceneId: z.string().min(1).max(160),
  sceneType: z.literal(SceneType.VOICE_TEACHBACK),
  ...sceneHeaderFields,
  public: voiceTeachbackPublicSchema,
  secret: voiceTeachbackSecretSchema,
}).strict();
export type VoiceTeachbackScene = z.infer<typeof voiceTeachbackSceneSchema>;

// 2. OrderingScene（无提示排序 → 最高 facet_eligible，01-2 §6.4）
export const orderingPublicSchema = z.object({
  /** token 文本（完成操作必需，01-2 §3.2） */
  items: z.array(z.object({ id: z.string().min(1).max(160), text: z.string().min(1).max(200) }).strict()).min(2).max(24),
  shuffleStrategy: z.string().min(1).max(200),
  initialOrderHint: z.string().max(500).optional(),
  emptySlots: z.number().int().nonnegative().max(24),
  dragProtocol: z.string().min(1).max(500),
}).strict();
export type OrderingPublic = z.infer<typeof orderingPublicSchema>;

export const orderingSecretSchema = z.object({
  /** 正确顺序（仅服务端） */
  correctOrderIds: z.array(z.string().min(1).max(160)).min(2).max(24),
  /** distractor 身份（01-2 §3.2 仅服务端） */
  distractorItemIds: z.array(z.string().min(1).max(160)).max(24),
  /** 有效多解：允许的置换组（空 = 唯一解） */
  acceptPermutedGroups: z.array(z.array(z.string().min(1).max(160)).min(1).max(24)).max(8),
  rationaleRefs: z.array(z.string().min(1).max(160)).max(32),
}).strict();
export type OrderingSecret = z.infer<typeof orderingSecretSchema>;

export const orderingSceneSchema = z.object({
  sceneId: z.string().min(1).max(160),
  sceneType: z.literal(SceneType.ORDERING),
  ...sceneHeaderFields,
  public: orderingPublicSchema,
  secret: orderingSecretSchema,
}).strict();
export type OrderingScene = z.infer<typeof orderingSceneSchema>;

// 3. RelationCanvasScene（无提示拖拽连线 → 最高 facet_eligible，01-2 §6.4）
export const relationCanvasPublicSchema = z.object({
  nodes: z.array(z.object({ id: z.string().min(1).max(160), text: z.string().min(1).max(200) }).strict()).min(2).max(16),
  edgeTypes: z.array(z.string().min(1).max(160)).min(1).max(8),
  canvasProtocol: z.string().min(1).max(500),
  maxEdges: z.number().int().positive().max(64),
}).strict();
export type RelationCanvasPublic = z.infer<typeof relationCanvasPublicSchema>;

export const relationCanvasSecretSchema = z.object({
  /** 正确关系（仅服务端） */
  correctEdges: z.array(z.object({
    sourceId: z.string().min(1).max(160),
    targetId: z.string().min(1).max(160),
    edgeType: z.string().min(1).max(160),
  }).strict()).min(1).max(64),
  /** 错误连线 distractor 身份 */
  distractorEdgeIds: z.array(z.string().min(1).max(160)).max(64),
  rationaleRefs: z.array(z.string().min(1).max(160)).max(32),
}).strict();
export type RelationCanvasSecret = z.infer<typeof relationCanvasSecretSchema>;

export const relationCanvasSceneSchema = z.object({
  sceneId: z.string().min(1).max(160),
  sceneType: z.literal(SceneType.RELATION_CANVAS),
  ...sceneHeaderFields,
  public: relationCanvasPublicSchema,
  secret: relationCanvasSecretSchema,
}).strict();
export type RelationCanvasScene = z.infer<typeof relationCanvasSceneSchema>;

// 4. RepairScene（故障修复 → 最高 facet_eligible，01-2 §6.4）
export const repairPublicSchema = z.object({
  /** 损坏流程 token 文本（完成修复操作必需） */
  brokenTokens: z.array(z.object({ id: z.string().min(1).max(160), text: z.string().min(1).max(200) }).strict()).min(2).max(24),
  operationProtocol: z.string().min(1).max(500),
  /** 允许的 typed operations：delete/replace/move/connect（01-2 §6.1 drag_graph/repair） */
  allowedOperations: z.array(z.enum(["delete", "replace", "move", "connect"])).min(1).max(4),
}).strict();
export type RepairPublic = z.infer<typeof repairPublicSchema>;

export const repairSecretSchema = z.object({
  /** 意图流程（仅服务端） */
  intendedFlowIds: z.array(z.string().min(1).max(160)).min(2).max(24),
  errorLocations: z.array(z.string().min(1).max(160)).min(1).max(24),
  errorTypes: z.array(z.string().min(1).max(160)).min(1).max(24),
  /** 有效修复方案集合（空 = 唯一解；非空 = 显式声明的有效多解） */
  acceptedRepairs: z.array(z.array(z.string().min(1).max(160)).min(1).max(24)).max(8),
  rationaleRefs: z.array(z.string().min(1).max(160)).max(32),
}).strict();
export type RepairSecret = z.infer<typeof repairSecretSchema>;

export const repairSceneSchema = z.object({
  sceneId: z.string().min(1).max(160),
  sceneType: z.literal(SceneType.REPAIR),
  ...sceneHeaderFields,
  public: repairPublicSchema,
  secret: repairSecretSchema,
}).strict();
export type RepairScene = z.infer<typeof repairSceneSchema>;

// 5. MultiStepScenarioScene（多步情境 → 单 Scene 最高 facet_eligible，01-2 §6.4）
export const multiStepScenarioPublicSchema = z.object({
  scenarioText: z.string().min(1).max(3000),
  steps: z.array(z.object({
    stepId: z.string().min(1).max(160),
    optionIds: z.array(z.string().min(1).max(160)).min(2).max(8),
    optionTexts: z.array(z.string().min(1).max(300)).min(2).max(8),
  }).strict()).min(1).max(8),
  branchProtocol: z.string().min(1).max(500),
  maxBranches: z.number().int().positive().max(8),
}).strict();
export type MultiStepScenarioPublic = z.infer<typeof multiStepScenarioPublicSchema>;

export const multiStepScenarioSecretSchema = z.object({
  /** 每步正确 option（仅服务端） */
  correctOptions: z.record(z.string().min(1).max(160)),
  /** branch 结果映射（distractor/branch 身份） */
  branchOutcomes: z.record(z.string().min(1).max(500)),
  correctBranchPath: z.array(z.string().min(1).max(160)).min(1).max(8),
  rationaleRefs: z.array(z.string().min(1).max(160)).max(32),
}).strict();
export type MultiStepScenarioSecret = z.infer<typeof multiStepScenarioSecretSchema>;

export const multiStepScenarioSceneSchema = z.object({
  sceneId: z.string().min(1).max(160),
  sceneType: z.literal(SceneType.MULTI_STEP_SCENARIO),
  ...sceneHeaderFields,
  public: multiStepScenarioPublicSchema,
  secret: multiStepScenarioSecretSchema,
}).strict();
export type MultiStepScenarioScene = z.infer<typeof multiStepScenarioSceneSchema>;

// 6. CounterexampleScene（反例构造 → 边界辨析，01-2 §6.2 备选）
export const counterexamplePublicSchema = z.object({
  claimText: z.string().min(1).max(1000),
  /** 候选例（含候选 distractor 文本） */
  candidates: z.array(z.object({ id: z.string().min(1).max(160), text: z.string().min(1).max(300) }).strict()).min(1).max(16),
  constructionProtocol: z.string().min(1).max(500),
  maxConstructedExamples: z.number().int().positive().max(8),
}).strict();
export type CounterexamplePublic = z.infer<typeof counterexamplePublicSchema>;

export const counterexampleSecretSchema = z.object({
  /** 有效反例（仅服务端） */
  validCounterexamples: z.array(z.string().min(1).max(300)).min(1).max(16),
  /** 无效候选身份 */
  invalidCandidateIds: z.array(z.string().min(1).max(160)).max(16),
  expectedJustificationRefs: z.array(z.string().min(1).max(160)).max(16),
  rationaleRefs: z.array(z.string().min(1).max(160)).max(32),
}).strict();
export type CounterexampleSecret = z.infer<typeof counterexampleSecretSchema>;

export const counterexampleSceneSchema = z.object({
  sceneId: z.string().min(1).max(160),
  sceneType: z.literal(SceneType.COUNTEREXAMPLE),
  ...sceneHeaderFields,
  public: counterexamplePublicSchema,
  secret: counterexampleSecretSchema,
}).strict();
export type CounterexampleScene = z.infer<typeof counterexampleSceneSchema>;

// 7. OptionalTextScene（文本兼容/偏好选项，01-2 §6.1）
export const optionalTextPublicSchema = z.object({
  prompt: z.string().min(1).max(2000),
  inputSchemaRef: z.string().min(1).max(200),
  characterLimit: z.number().int().positive().max(20000),
  submitProtocol: z.string().min(1).max(500),
}).strict();
export type OptionalTextPublic = z.infer<typeof optionalTextPublicSchema>;

export const optionalTextSecretSchema = z.object({
  /** server-only expected answer 引用 */
  expectedAnswerRef: z.string().min(1).max(200),
  keywordHints: z.array(z.string().min(1).max(200)).max(32),
  rationaleRefs: z.array(z.string().min(1).max(160)).max(32),
}).strict();
export type OptionalTextSecret = z.infer<typeof optionalTextSecretSchema>;

export const optionalTextSceneSchema = z.object({
  sceneId: z.string().min(1).max(160),
  sceneType: z.literal(SceneType.OPTIONAL_TEXT),
  ...sceneHeaderFields,
  public: optionalTextPublicSchema,
  secret: optionalTextSecretSchema,
}).strict();
export type OptionalTextScene = z.infer<typeof optionalTextSceneSchema>;

/** 全部 7 种 Scene 的 discriminated union（01-2 §3 冻结）。 */
export const learningSceneSchema = z.discriminatedUnion("sceneType", [
  voiceTeachbackSceneSchema,
  orderingSceneSchema,
  relationCanvasSceneSchema,
  repairSceneSchema,
  multiStepScenarioSceneSchema,
  counterexampleSceneSchema,
  optionalTextSceneSchema,
]);
export type LearningScene = z.infer<typeof learningSceneSchema>;

// ─── 三对象拆分（01-2 §3.2 物理分离）──────────────────────────────────────

/** PublicSceneContract（可返回客户端）：净化题面、opaque token IDs、可见 token
 *  文本、操作协议、A11y 与 publicPayloadHash。零 private 字段。 */
export const publicSceneContractSchema = z.object({
  contractVersion: z.literal("public-scene-contract-v1"),
  sceneId: z.string().min(1).max(160),
  probeId: z.string().min(1).max(160),
  sceneType: z.enum([
    SceneType.VOICE_TEACHBACK,
    SceneType.ORDERING,
    SceneType.RELATION_CANVAS,
    SceneType.REPAIR,
    SceneType.MULTI_STEP_SCENARIO,
    SceneType.COUNTEREXAMPLE,
    SceneType.OPTIONAL_TEXT,
  ]),
  template: z.string().min(1).max(160),
  version: z.string().min(1).max(40),
  mode: z.enum([SceneMode.FORMAL, SceneMode.PRACTICE]),
  targetKeyPointId: z.string().min(1).max(160),
  /** 净化题面（仅 public 字段，与 secret 物理分离） */
  publicPayload: z.unknown(),
  publicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  disclosureProfileHash: z.string().regex(/^[0-9a-f]{64}$/),
  templateTrustCeiling: trustClassEnum,
  a11yEquivalentPaths: z.array(a11yEquivalentPathSchema).min(1).max(16),
}).strict();
export type PublicSceneContract = z.infer<typeof publicSceneContractSchema>;

/** PrivateSceneSolution（仅服务端/评估器）：正确顺序/关系/branch、distractor
 *  身份、rubric target 与 evidence binding。绝不返回客户端。 */
export const privateSceneSolutionSchema = z.object({
  contractVersion: z.literal("private-scene-solution-v1"),
  privateSolutionId: z.string().min(1).max(160),
  sceneId: z.string().min(1).max(160),
  sceneType: z.enum([
    SceneType.VOICE_TEACHBACK,
    SceneType.ORDERING,
    SceneType.RELATION_CANVAS,
    SceneType.REPAIR,
    SceneType.MULTI_STEP_SCENARIO,
    SceneType.COUNTEREXAMPLE,
    SceneType.OPTIONAL_TEXT,
  ]),
  secretSolutionVersion: z.string().min(1).max(40),
  secretSolutionHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** 仅服务端 secret payload */
  solution: z.unknown(),
  rubricEvidenceBindings: z.array(rubricEvidenceBindingSchema).min(1).max(32),
  expectedTargetRefs: z.array(z.string().min(1).max(160)).min(1).max(16),
}).strict();
export type PrivateSceneSolution = z.infer<typeof privateSceneSolutionSchema>;

/** PrivateLearningEpisodeContract（仅服务端）：target/schedule/fingerprint、
 *  RubricTargets、policy/model refs、budget 与 plan hash。 */
export const privateLearningEpisodeContractSchema = z.object({
  contractVersion: z.literal("private-learning-episode-contract-v1"),
  sessionId: z.string().min(1).max(160),
  episodeId: z.string().min(1).max(160),
  keyPointId: z.string().min(1).max(160),
  origin: z.enum(["card", "review", "star_map", "now"]),
  originRef: z.object({
    type: z.enum(["card", "review_schedule", "key_point", "question_suggestion"]),
    id: z.string().min(1).max(160),
  }).strict(),
  intent: z.enum(["stabilize", "clarify", "transfer", "explore"]),
  formalEligibilityKind: z.enum([
    "initial_validation",
    "scheduled_review",
    "repair_revalidation",
    "ad_hoc_transfer",
    "practice",
  ]),
  formalPlan: z.object({
    kind: z.enum(["voice_mastery", "structured_mastery_bundle", "facet_only", "practice"]),
    requiredProbeIds: z.array(z.string().min(1).max(160)).min(0).max(64),
    bundlePolicyVersion: z.string().min(1).max(40).optional(),
    silentProofProfileId: z.string().min(1).max(160).optional(),
    structuredProofEligibilityReportHash: z.string().min(1).max(200).optional(),
  }).strict(),
  schedulingDecision: z.object({
    decisionRef: z.string().min(1).max(160),
    decisionHash: z.string().min(1).max(200),
    authorizedAction: z.enum(["create_initial", "consume_pending", "record_only", "no_effect"]),
    inputScheduleId: z.string().min(1).max(160).optional(),
    inputScheduleGeneration: z.number().int().nonnegative().optional(),
    prioritySource: z.enum(["official_due", "official_overdue", "canonical_gap", "user_selected"]),
    policyVersion: z.string().min(1).max(40),
    policyEpoch: z.number().int().nonnegative(),
    reasonCodes: z.array(z.string().min(1)).max(64),
  }).strict(),
  episodeTargetFingerprint: z.string().min(1).max(200),
  contentExposureKey: z.string().min(1).max(200),
  rubricTargets: z.array(z.object({
    id: z.string().min(1).max(160),
    criterion: z.string().min(1).max(500),
    expectedTargetRef: z.string().min(1).max(200),
    expectedTargetHash: z.string().regex(/^[0-9a-f]{64}$/),
    weight: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    required: z.boolean(),
    capabilityFacet: capabilityFacetEnum,
    targetKeyPointId: z.string().min(1).max(160),
    evidenceRefIds: z.array(z.string().min(1).max(160)).min(1).max(32),
    semanticSupportReportId: z.string().min(1).max(200),
    semanticSupportReportHash: z.string().min(1).max(200),
  }).strict()).min(1).max(32),
  allowedModalities: z.array(z.enum(["voice", "text_or_mixed", "drag_graph", "ordering", "repair", "scenario"])).min(1).max(6),
  frozenProbes: z.array(z.object({
    probeId: z.string().min(1).max(160),
    publicSceneContractId: z.string().min(1).max(160),
    publicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    privateSolutionId: z.string().min(1).max(160),
    privateSolutionHash: z.string().regex(/^[0-9a-f]{64}$/),
    sceneSafetyReportId: z.string().min(1).max(160),
    sceneSafetyReportHash: z.string().min(1).max(200),
    templateTrustCeiling: trustClassEnum,
    disclosureProfileHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()).min(1).max(64),
  maxTurns: z.number().int().positive().max(16),
  assistancePolicyVersion: z.string().min(1).max(40),
  rubricPolicyVersion: z.string().min(1).max(40),
  scenePolicyVersion: z.string().min(1).max(40),
  assessmentPolicyVersion: z.string().min(1).max(40),
  masteryPolicyVersion: z.string().min(1).max(40),
  schedulerPolicyVersion: z.string().min(1).max(40),
  commitPolicyVersion: z.string().min(1).max(40),
  providerPolicyVersion: z.string().min(1).max(40),
  providerConfigId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(160),
  requiredCapabilityIds: z.array(z.string().min(1).max(160)).min(0).max(64),
  capabilitySnapshotHash: z.string().min(1).max(200),
  runtimeEpochSnapshot: z.number().int().nonnegative(),
  episodeEpoch: z.number().int().nonnegative(),
  budgetEnvelopeRef: z.string().min(1).max(200),
  budgetEnvelopeHash: z.string().min(1).max(200),
  planHash: z.string().min(1).max(300),
}).strict();
export type PrivateLearningEpisodeContract = z.infer<
  typeof privateLearningEpisodeContractSchema
>;
