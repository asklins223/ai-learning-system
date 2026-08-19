/**
 * scene-safety.ts（阶段 05 / W4，任务 05-2）
 *
 * scene-safety-v1：动态 formal Scene 激活前的确定性安全检查（01-2 §3.3 +
 * 05-w4 任务 05-2）。全部为纯函数：不读时钟、不改状态、不写掌握/schedule 真值；
 * 外部依赖（事实源、独立 Critic、静态模板注册表、修复函数）通过端口注入。
 *
 * 检查项（01-2 §3.3）：
 * 1. schema：字段类型/枚举/必需/未知键（本地实现，收口后改用 shared zod schema）；
 * 2. public/secret 分离：public 对象零 private 字段、public/secret 独立 hash；
 * 3. allowlisted IDs：全部 token/node/edge/option 引用 ⊆ allowed 集合；
 * 4. 答案泄漏：public token 文本不覆盖正确答案/expected target；
 * 5. 可评估性：secret 解非空、formal 无即时泄题；
 * 6. 唯一解或有效多解：多解必须显式声明，否则唯一解；
 * 7. distractor 区分度：distractor 有效、与答案互异、互不重复；
 * 8. 事实支撑：每 rubric evidence binding 引用的证据 semanticSupport=supported；
 * 9. prompt injection：HTML/JS 脚本形态与路径穿越 ID 全部拒绝；
 * 10. 语言与 A11y：题面语言一致、等价操作不降低语义要求、无计时/速度评分。
 *
 * 修复一次语义（01-2 §3.3）：失败最多修复一次，仍失败 → question_retryable
 * （可重试内容问题）或 blocked（结构性问题，fail closed）。
 * 静态模板复用（01-2 §3.3）：只有完全静态且带不可变 certification hash、内容
 * 槽位仍通过 deterministic allowlist 的模板可复用历史 approval（跳过 Critic）。
 *
 * 收口迁移说明：Scene 契约的单一来源位于
 * packages/shared/src/scene-contracts.ts（含 zod strict schema）；当前
 * @ailearn/shared 的 index.ts 尚未 re-export（由主代理统一收口追加），且 api 的
 * tsconfig rootDir 不允许跨包相对导入，故按 silent-profile-registry 同款先例
 * 本地声明同型接口（structural 兼容）。主代理收口后应改为
 * `import { LearningScene, SceneSafetyVerdict, ... } from "@ailearn/shared"`，
 * schema 校验改用 shared zod schema 的 safeParse。
 */

import { sha256Hex } from "@ailearn/shared/content-hash";
import { normalizeText as fingerprintNormalize } from "@ailearn/shared/fingerprint";
import { CapabilityFacet, TrustClass } from "@ailearn/shared";

// ─── 本地契约类型（与 packages/shared/src/scene-contracts.ts 同型）────────

export const SceneMode = {
  FORMAL: "formal",
  PRACTICE: "practice",
} as const;
export type SceneMode = (typeof SceneMode)[keyof typeof SceneMode];

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

export const SceneSafetyVerdict = {
  APPROVED: "approved",
  REPAIR_REQUIRED: "repair_required",
  QUESTION_RETRYABLE: "question_retryable",
  BLOCKED: "blocked",
} as const;
export type SceneSafetyVerdict =
  (typeof SceneSafetyVerdict)[keyof typeof SceneSafetyVerdict];

export const FeedbackTiming = {
  NONE: "none",
  AFTER_ALL_PROBES: "after_all_probes",
  IMMEDIATE: "immediate",
} as const;
export type FeedbackTiming = (typeof FeedbackTiming)[keyof typeof FeedbackTiming];

export const A11yEquivalenceKind = {
  TAP_SELECT_PLACE: "tap_select_place",
  KEYBOARD: "keyboard",
  SCREEN_READER: "screen_reader",
  REDUCED_MOTION: "reduced_motion",
} as const;
export type A11yEquivalenceKind =
  (typeof A11yEquivalenceKind)[keyof typeof A11yEquivalenceKind];

export type LocalTrustClass = TrustClass;
export type LocalCapabilityFacet = CapabilityFacet;

export interface LocalTarget {
  keyPointId: string;
  targetIds: string[];
}

export interface LocalDisclosureProfile {
  maxProvableTrustClass: LocalTrustClass;
  exposesTokenText: boolean;
  provableRecall: boolean;
  feedbackTiming: FeedbackTiming;
}

export interface LocalRubricEvidenceBinding {
  rubricItemId: string;
  criterion: string;
  evidenceRefIds: string[];
  evidenceKind: string;
  expectedTargetHash: string;
}

export interface LocalAssistancePolicy {
  contentHelpAllowed: boolean;
  maxContentHelpCount: number;
  revealsAnswerOnAttempt: boolean;
  neutralAssistanceOnly: boolean;
}

export interface LocalA11yPath {
  kind: A11yEquivalenceKind;
  description: string;
  semanticRequirementUnchanged: boolean;
}

interface LocalSceneHeader {
  sceneId: string;
  template: string;
  version: string;
  target: LocalTarget;
  sourceFingerprint: string;
  capabilityFacet: LocalCapabilityFacet;
  mode: SceneMode;
  publicPayloadHash: string;
  publicPayloadVersion: string;
  secretSolutionHash: string;
  secretSolutionVersion: string;
  disclosureProfile: LocalDisclosureProfile;
  rubricEvidenceBindings: LocalRubricEvidenceBinding[];
  assistancePolicy: LocalAssistancePolicy;
  templateTrustCeiling: LocalTrustClass;
  feedbackTiming: FeedbackTiming;
  distractorIds: string[];
  branchIds: string[];
  maxOperations?: number;
  maxAttempts?: number;
  a11yEquivalentPaths: LocalA11yPath[];
}

export interface LocalOrderingItem {
  id: string;
  text: string;
}
export interface LocalNode {
  id: string;
  text: string;
}
export interface LocalEdge {
  sourceId: string;
  targetId: string;
  edgeType: string;
}
export interface LocalScenarioStep {
  stepId: string;
  optionIds: string[];
  optionTexts: string[];
}
export interface LocalCandidate {
  id: string;
  text: string;
}

export interface VoiceTeachbackScene extends LocalSceneHeader {
  sceneType: "voice_teachback";
  public: {
    prompt: string;
    allowedTokenIds: string[];
    visibleTokenText: Record<string, string>;
    recordingProtocol: string;
    maxRecordingSeconds: number;
  };
  secret: {
    expectedRubricTargets: string[];
    keyFactRefs: string[];
    disallowedClaims: string[];
  };
}

export interface OrderingScene extends LocalSceneHeader {
  sceneType: "ordering";
  public: {
    items: LocalOrderingItem[];
    shuffleStrategy: string;
    initialOrderHint?: string;
    emptySlots: number;
    dragProtocol: string;
  };
  secret: {
    correctOrderIds: string[];
    distractorItemIds: string[];
    acceptPermutedGroups: string[][];
    rationaleRefs: string[];
  };
}

export interface RelationCanvasScene extends LocalSceneHeader {
  sceneType: "relation_canvas";
  public: {
    nodes: LocalNode[];
    edgeTypes: string[];
    canvasProtocol: string;
    maxEdges: number;
  };
  secret: {
    correctEdges: LocalEdge[];
    distractorEdgeIds: string[];
    rationaleRefs: string[];
  };
}

export interface RepairScene extends LocalSceneHeader {
  sceneType: "repair";
  public: {
    brokenTokens: LocalOrderingItem[];
    operationProtocol: string;
    allowedOperations: string[];
  };
  secret: {
    intendedFlowIds: string[];
    errorLocations: string[];
    errorTypes: string[];
    acceptedRepairs: string[][];
    rationaleRefs: string[];
  };
}

export interface MultiStepScenarioScene extends LocalSceneHeader {
  sceneType: "multi_step_scenario";
  public: {
    scenarioText: string;
    steps: LocalScenarioStep[];
    branchProtocol: string;
    maxBranches: number;
  };
  secret: {
    correctOptions: Record<string, string>;
    branchOutcomes: Record<string, string>;
    correctBranchPath: string[];
    rationaleRefs: string[];
  };
}

export interface CounterexampleScene extends LocalSceneHeader {
  sceneType: "counterexample";
  public: {
    claimText: string;
    candidates: LocalCandidate[];
    constructionProtocol: string;
    maxConstructedExamples: number;
  };
  secret: {
    validCounterexamples: string[];
    invalidCandidateIds: string[];
    expectedJustificationRefs: string[];
    rationaleRefs: string[];
  };
}

export interface OptionalTextScene extends LocalSceneHeader {
  sceneType: "optional_text";
  public: {
    prompt: string;
    inputSchemaRef: string;
    characterLimit: number;
    submitProtocol: string;
  };
  secret: {
    expectedAnswerRef: string;
    keywordHints: string[];
    rationaleRefs: string[];
  };
}

/** 7 种 Scene 联合（与 shared learningSceneSchema 同构）。 */
export type LearningScene =
  | VoiceTeachbackScene
  | OrderingScene
  | RelationCanvasScene
  | RepairScene
  | MultiStepScenarioScene
  | CounterexampleScene
  | OptionalTextScene;

/** 私有 Episode Contract（仅服务端；activation 校验 planHash/epoch/budget 所需）。 */
export interface PrivateEpisodeContractLite {
  episodeId: string;
  keyPointId: string;
  formalEligibilityKind:
    | "initial_validation"
    | "scheduled_review"
    | "repair_revalidation"
    | "ad_hoc_transfer"
    | "practice";
  formalPlan: {
    kind: "voice_mastery" | "structured_mastery_bundle" | "facet_only" | "practice";
    requiredProbeIds: string[];
    silentProofProfileId?: string;
    structuredProofEligibilityReportHash?: string;
  };
  schedulingDecision: {
    authorizedAction: "create_initial" | "consume_pending" | "record_only" | "no_effect";
  };
  frozenProbes: Array<{
    probeId: string;
    publicSceneContractId: string;
    publicPayloadHash: string;
    privateSolutionId: string;
    privateSolutionHash: string;
    sceneSafetyReportId: string;
    sceneSafetyReportHash: string;
    templateTrustCeiling: LocalTrustClass;
    disclosureProfileHash: string;
  }>;
  episodeTargetFingerprint: string;
  contentExposureKey: string;
  rubricTargets: Array<{ id: string; capabilityFacet: LocalCapabilityFacet }>;
  allowedModalities: string[];
  runtimeEpochSnapshot: number;
  episodeEpoch: number;
  budgetEnvelopeRef: string;
  budgetEnvelopeHash: string;
  planHash: string;
}

// ─── 确定性哈希原语（trust-service 同款，SEC-01 静态扫描兼容）─────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const pairs: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    pairs.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${pairs.join(",")}}`;
}

/** 计算 public payload 的确定性 hash（仅覆盖 public 字段）。 */
export function computePublicPayloadHash(scene: LearningScene): string {
  return sha256Hex("scene-public-v1:" + stableStringify(scene.public));
}

/** 计算 secret solution 的确定性 hash（仅覆盖 secret 字段）。 */
export function computeSecretSolutionHash(scene: LearningScene): string {
  return sha256Hex(
    "scene-secret-v1:" + stableStringify({
      secret: scene.secret,
      rubricEvidenceBindings: scene.rubricEvidenceBindings,
    }),
  );
}

/** 计算 disclosure profile 的确定性 hash。 */
export function computeDisclosureProfileHash(scene: LearningScene): string {
  return sha256Hex("scene-disclosure-v1:" + stableStringify(scene.disclosureProfile));
}

// ─── Scene 语义访问器（per-type 解耦，保证检查函数与具体类型无关）────────

/** 公开 token 文本（完成操作所必需的展示文本）。 */
function publicTokenTexts(scene: LearningScene): string[] {
  const out: string[] = [];
  const push = (text: string | undefined) => {
    if (typeof text === "string" && text.length > 0) out.push(text);
  };
  switch (scene.sceneType) {
    case "voice_teachback":
      push(scene.public.prompt);
      for (const text of Object.values(scene.public.visibleTokenText)) push(text);
      break;
    case "ordering":
      for (const item of scene.public.items) push(item.text);
      push(scene.public.initialOrderHint);
      break;
    case "relation_canvas":
      for (const node of scene.public.nodes) push(node.text);
      for (const edgeType of scene.public.edgeTypes) push(edgeType);
      break;
    case "repair":
      for (const token of scene.public.brokenTokens) push(token.text);
      break;
    case "multi_step_scenario":
      push(scene.public.scenarioText);
      for (const step of scene.public.steps) {
        for (const text of step.optionTexts) push(text);
      }
      break;
    case "counterexample":
      push(scene.public.claimText);
      for (const candidate of scene.public.candidates) push(candidate.text);
      break;
    case "optional_text":
      push(scene.public.prompt);
      break;
  }
  return out;
}

/** secret 答案文本（正确答案/expected target/反例等，绝不返回客户端）。 */
function secretAnswerTexts(scene: LearningScene): string[] {
  const out: string[] = [];
  switch (scene.sceneType) {
    case "voice_teachback":
      out.push(...scene.secret.disallowedClaims);
      break;
    case "ordering":
      for (const group of scene.secret.acceptPermutedGroups) out.push(...group);
      break;
    case "relation_canvas":
      for (const edge of scene.secret.correctEdges) {
        out.push(edge.sourceId, edge.targetId, edge.edgeType);
      }
      break;
    case "repair":
      for (const repair of scene.secret.acceptedRepairs) out.push(...repair);
      break;
    case "multi_step_scenario":
      out.push(...scene.secret.correctBranchPath);
      out.push(...Object.values(scene.secret.branchOutcomes));
      break;
    case "counterexample":
      out.push(...scene.secret.validCounterexamples);
      break;
    case "optional_text":
      out.push(scene.secret.expectedAnswerRef);
      out.push(...scene.secret.keywordHints);
      break;
  }
  return out.filter((s) => s.length > 0);
}

/** secret 答案文本 ID（correctOrderIds / correctEdges / correctOptions 等）。 */
function secretSolutionRefIds(scene: LearningScene): string[] {
  const out: string[] = [];
  switch (scene.sceneType) {
    case "ordering":
      out.push(...scene.secret.correctOrderIds);
      out.push(...scene.secret.distractorItemIds);
      for (const group of scene.secret.acceptPermutedGroups) out.push(...group);
      break;
    case "relation_canvas":
      for (const edge of scene.secret.correctEdges) {
        out.push(edge.sourceId, edge.targetId);
      }
      out.push(...scene.secret.distractorEdgeIds);
      break;
    case "repair":
      out.push(...scene.secret.intendedFlowIds);
      out.push(...scene.secret.errorLocations);
      for (const repair of scene.secret.acceptedRepairs) out.push(...repair);
      break;
    case "multi_step_scenario":
      out.push(...Object.values(scene.secret.correctOptions));
      out.push(...scene.secret.correctBranchPath);
      break;
    case "counterexample":
      out.push(...scene.secret.invalidCandidateIds);
      out.push(...scene.secret.expectedJustificationRefs);
      break;
    case "voice_teachback":
      out.push(...scene.secret.expectedRubricTargets);
      out.push(...scene.secret.keyFactRefs);
      break;
    case "optional_text":
      break;
  }
  return out;
}

/** 公开题面引用的允许 ID 集合（token/node/edge/option IDs）。 */
function publicAllowedRefIds(scene: LearningScene): Set<string> {
  const ids = new Set<string>(scene.distractorIds);
  switch (scene.sceneType) {
    case "voice_teachback":
      for (const id of scene.public.allowedTokenIds) ids.add(id);
      break;
    case "ordering":
      for (const item of scene.public.items) ids.add(item.id);
      break;
    case "relation_canvas":
      for (const node of scene.public.nodes) ids.add(node.id);
      for (const edgeType of scene.public.edgeTypes) ids.add(edgeType);
      break;
    case "repair":
      for (const token of scene.public.brokenTokens) ids.add(token.id);
      for (const op of scene.public.allowedOperations) ids.add(op);
      break;
    case "multi_step_scenario":
      for (const step of scene.public.steps) {
        ids.add(step.stepId);
        for (const id of step.optionIds) ids.add(id);
      }
      break;
    case "counterexample":
      for (const candidate of scene.public.candidates) ids.add(candidate.id);
      break;
    case "optional_text":
      break;
  }
  return ids;
}

/** distractor 文本（identity 判定）。 */
function distractorTexts(scene: LearningScene): string[] {
  const out: string[] = [];
  switch (scene.sceneType) {
    case "ordering":
      for (const id of scene.secret.distractorItemIds) {
        const item = scene.public.items.find((i) => i.id === id);
        if (item) out.push(item.text);
      }
      break;
    case "counterexample":
      for (const id of scene.secret.invalidCandidateIds) {
        const candidate = scene.public.candidates.find((c) => c.id === id);
        if (candidate) out.push(candidate.text);
      }
      break;
    case "multi_step_scenario":
      for (const step of scene.public.steps) {
        for (const id of step.optionIds) {
          const idx = step.optionIds.indexOf(id);
          if (idx >= 0 && idx < step.optionTexts.length) out.push(step.optionTexts[idx] ?? "");
        }
      }
      break;
    default:
      break;
  }
  return out.filter((s) => s.length > 0);
}

/** 结构交互 Scene（01-2 §6.4：排序/连线/修复/多步情境/反例）。 */
function isStructuralInteractive(scene: LearningScene): boolean {
  return (
    scene.sceneType === "ordering" ||
    scene.sceneType === "relation_canvas" ||
    scene.sceneType === "repair" ||
    scene.sceneType === "multi_step_scenario" ||
    scene.sceneType === "counterexample"
  );
}

/** 结构 Scene 的区分度支撑（无 distractor 时需其他 basis）。 */
function structuralDiscriminationBasis(scene: LearningScene): string[] {
  const basis: string[] = [];
  switch (scene.sceneType) {
    case "ordering":
      if (scene.secret.distractorItemIds.length > 0) basis.push("valid_distractors");
      if (scene.public.emptySlots === 0) basis.push("no_unique_slot_guess");
      break;
    case "relation_canvas":
      if (scene.secret.distractorEdgeIds.length > 0) basis.push("valid_distractors");
      if (scene.public.maxEdges >= 2) basis.push("multi_step_dependency");
      break;
    case "repair":
      if (scene.secret.acceptedRepairs.length > 0) basis.push("sufficient_operation_count");
      if (scene.secret.errorLocations.length >= 1) basis.push("multi_step_dependency");
      break;
    case "multi_step_scenario":
      if (scene.public.steps.length >= 2) basis.push("multi_step_dependency");
      if (scene.public.maxBranches >= 1) basis.push("multi_step_dependency");
      break;
    case "counterexample":
      if (scene.secret.invalidCandidateIds.length > 0) basis.push("valid_distractors");
      break;
    default:
      break;
  }
  return basis;
}

// ─── 1. schema 校验（本地实现；收口后改用 shared zod safeParse）───────────

const SCENE_TYPES = new Set<string>(Object.values(SceneType));
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,159}$/;

/** 校验 Scene 结构（字段类型/枚举/必需/未知键）。返回失败原因码，空 = 通过。 */
export function validateSceneShape(scene: unknown): string[] {
  if (scene === null || typeof scene !== "object") return ["scene_not_object"];
  const s = scene as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof s.sceneId !== "string" || s.sceneId.length === 0) errors.push("missing_scene_id");
  if (typeof s.sceneType !== "string" || !SCENE_TYPES.has(s.sceneType)) {
    errors.push("invalid_scene_type");
  }
  if (typeof s.template !== "string" || s.template.length === 0) errors.push("missing_template");
  if (typeof s.version !== "string" || s.version.length === 0) errors.push("missing_version");
  if (typeof s.sourceFingerprint !== "string" || s.sourceFingerprint.length === 0) {
    errors.push("missing_source_fingerprint");
  }
  if (typeof s.publicPayloadHash !== "string" || !HEX64.test(s.publicPayloadHash)) {
    errors.push("invalid_public_payload_hash");
  }
  if (typeof s.secretSolutionHash !== "string" || !HEX64.test(s.secretSolutionHash)) {
    errors.push("invalid_secret_solution_hash");
  }
  const target = s.target as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object" || typeof target.keyPointId !== "string") {
    errors.push("invalid_target");
  }
  if (!Array.isArray(s.rubricEvidenceBindings) || s.rubricEvidenceBindings.length === 0) {
    errors.push("missing_rubric_evidence_bindings");
  }
  const profile = s.disclosureProfile as Record<string, unknown> | undefined;
  if (!profile || typeof profile !== "object" || typeof profile.maxProvableTrustClass !== "string") {
    errors.push("invalid_disclosure_profile");
  }
  if (s.mode !== "formal" && s.mode !== "practice") errors.push("invalid_mode");
  if (s.feedbackTiming !== "none" && s.feedbackTiming !== "after_all_probes" && s.feedbackTiming !== "immediate") {
    errors.push("invalid_feedback_timing");
  }
  if (typeof s.templateTrustCeiling !== "string") errors.push("invalid_template_trust_ceiling");
  if (!Array.isArray(s.a11yEquivalentPaths) || s.a11yEquivalentPaths.length === 0) {
    errors.push("missing_a11y_paths");
  }
  return errors;
}

// ─── 2. public/secret 分离 ────────────────────────────────────────────────

/** 私有字段名集合（03-4 PUBLIC_DTO_FORBIDDEN_FIELDS 扩展 + secret 结构名）。 */
const SECRET_FIELD_NAMES = new Set<string>([
  "secret",
  "solution",
  "correctOrderIds",
  "correctEdges",
  "intendedFlowIds",
  "errorLocations",
  "acceptedRepairs",
  "correctOptions",
  "correctBranchPath",
  "branchOutcomes",
  "validCounterexamples",
  "invalidCandidateIds",
  "expectedRubricTargets",
  "expectedAnswerRef",
  "keywordHints",
  "distractorItemIds",
  "distractorEdgeIds",
  "disallowedClaims",
  "keyFactRefs",
  "rationaleRefs",
  "expectedTargetHash",
  "expectedTargetRef",
  "rubricTargets",
  "schedulingDecision",
  "assistanceSnapshot",
]);

function collectObjectKeys(value: unknown, out: string[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    out.push(key);
    collectObjectKeys(obj[key], out);
  }
}

/** 检查 public 对象零 private 字段、独立 hash 覆盖各自字段。 */
export function checkPublicSecretSeparation(scene: LearningScene): SafetyCheckResult {
  const reasons: string[] = [];
  const publicKeys: string[] = [];
  collectObjectKeys(scene.public, publicKeys);
  for (const key of publicKeys) {
    if (SECRET_FIELD_NAMES.has(key)) reasons.push(`private_field_in_public:${key}`);
  }
  const expectedPublicHash = computePublicPayloadHash(scene);
  if (expectedPublicHash !== scene.publicPayloadHash) {
    reasons.push("public_payload_hash_mismatch");
  }
  const expectedSecretHash = computeSecretSolutionHash(scene);
  if (expectedSecretHash !== scene.secretSolutionHash) {
    reasons.push("secret_solution_hash_mismatch");
  }
  return {
    checkId: "public_secret_separation",
    passed: reasons.length === 0,
    reasonCodes: reasons,
  };
}

// ─── 3. allowlisted IDs ───────────────────────────────────────────────────

export interface AllowlistScope {
  /** 该 Episode/Key Point 允许的 evidence refs（rubric 预绑定） */
  allowedEvidenceRefIds: readonly string[];
}

/** 全部 public 引用的 ID 与 secret 解引用 ID 都必须在 allowed 集合内。 */
export function checkAllowlistedIds(
  scene: LearningScene,
  scope: AllowlistScope,
): SafetyCheckResult {
  const reasons: string[] = [];
  const allowedIds = publicAllowedRefIds(scene);
  for (const id of secretSolutionRefIds(scene)) {
    if (!allowedIds.has(id)) reasons.push(`solution_ref_not_allowed:${id}`);
  }
  if (isStructuralInteractive(scene)) {
    for (const id of scene.distractorIds) {
      if (!allowedIds.has(id)) reasons.push(`distractor_id_not_allowed:${id}`);
    }
  }
  for (const binding of scene.rubricEvidenceBindings) {
    for (const ref of binding.evidenceRefIds) {
      if (!scope.allowedEvidenceRefIds.includes(ref)) {
        reasons.push(`evidence_ref_not_allowed:${ref}`);
      }
    }
  }
  for (const id of [...allowedIds]) {
    if (!SAFE_ID.test(id)) reasons.push(`unsafe_id:${id}`);
  }
  return {
    checkId: "allowlisted_ids",
    passed: reasons.length === 0,
    reasonCodes: reasons,
  };
}

// ─── 4. 答案泄漏检测 ──────────────────────────────────────────────────────

/** 安全归一化：先剥离零宽字符（防答案泄漏子串比对被绕过），再委托 fingerprint 的标准归一化。 */
function normalizeText(text: string): string {
  // 剥离零宽字符（ZERO WIDTH SPACE / JOINER / NON-JOINER / BOM 等），
  // 防答案泄漏子串比对被零宽字符绕过（security_review LOW #4 修复）。
  const stripped = text.replace(/[\u200b-\u200d\ufeff\u2060\u00ad]/g, "");
  return fingerprintNormalize(stripped);
}

/** public token 文本不得覆盖正确答案 / expected target 文本。 */
export function checkAnswerLeakage(scene: LearningScene): SafetyCheckResult {
  const reasons: string[] = [];
  const publicTexts = publicTokenTexts(scene).map(normalizeText).filter((t) => t.length > 0);
  const answerTexts = secretAnswerTexts(scene).map(normalizeText).filter((t) => t.length > 0);

  for (const pub of publicTexts) {
    for (const ans of answerTexts) {
      if (ans.length > 0 && pub.includes(ans)) {
        reasons.push(`answer_text_disclosed_in_public`);
        break;
      }
    }
  }

  // 结构题：公开 token 不得覆盖无提示 recall（01-2 §3.2）。
  if (isStructuralInteractive(scene) && scene.disclosureProfile.provableRecall) {
    reasons.push("structural_scene_claims_recall");
  }

  // voice teachback：prompt 不得包含 disallowed claims（泄漏 expected 表述）。
  if (scene.sceneType === "voice_teachback") {
    const promptNorm = normalizeText(scene.public.prompt);
    for (const claim of scene.secret.disallowedClaims) {
      if (promptNorm.includes(normalizeText(claim))) {
        reasons.push("disallowed_claim_in_prompt");
        break;
      }
    }
  }

  // rubric expected target hash 不得出现在 public（结构性保证 + 文本互斥）。
  if (JSON.stringify(scene.public).includes(scene.secretSolutionHash)) {
    reasons.push("secret_hash_in_public");
  }

  return {
    checkId: "answer_leakage",
    passed: reasons.length === 0,
    reasonCodes: reasons,
  };
}

// ─── 5. 可评估性 ──────────────────────────────────────────────────────────

/** secret 解非空、formal 无即时泄题（反馈时点不泄题）、多解显式声明。 */
export function checkAssessability(scene: LearningScene): SafetyCheckResult {
  const reasons: string[] = [];
  if (scene.mode === SceneMode.FORMAL && scene.feedbackTiming === FeedbackTiming.IMMEDIATE) {
    reasons.push("formal_immediate_feedback_disallowed");
  }
  if (scene.mode === SceneMode.FORMAL && scene.assistancePolicy.revealsAnswerOnAttempt) {
    reasons.push("formal_reveals_answer_on_attempt");
  }
  if (scene.rubricEvidenceBindings.length === 0) reasons.push("no_rubric_evidence_binding");

  switch (scene.sceneType) {
    case "voice_teachback":
      if (scene.secret.expectedRubricTargets.length === 0) reasons.push("no_expected_rubric_targets");
      if (scene.secret.keyFactRefs.length === 0) reasons.push("no_key_facts");
      break;
    case "ordering":
      if (scene.secret.correctOrderIds.length < 2) reasons.push("ordering_solution_too_short");
      break;
    case "relation_canvas":
      if (scene.secret.correctEdges.length === 0) reasons.push("no_correct_edges");
      break;
    case "repair":
      if (scene.secret.intendedFlowIds.length < 2) reasons.push("repair_solution_too_short");
      if (scene.secret.errorLocations.length === 0) reasons.push("no_error_locations");
      break;
    case "multi_step_scenario":
      for (const step of scene.public.steps) {
        const correct = scene.secret.correctOptions[step.stepId];
        if (correct === undefined) reasons.push(`step_without_correct_option:${step.stepId}`);
        else if (!step.optionIds.includes(correct)) reasons.push(`correct_option_not_in_step:${step.stepId}`);
      }
      break;
    case "counterexample":
      if (scene.secret.validCounterexamples.length === 0) reasons.push("no_valid_counterexamples");
      break;
    case "optional_text":
      if (scene.secret.expectedAnswerRef.length === 0) reasons.push("no_expected_answer_ref");
      break;
  }
  return {
    checkId: "assessability",
    passed: reasons.length === 0,
    reasonCodes: reasons,
  };
}

// ─── 6. 唯一解或有效多解 ──────────────────────────────────────────────────

/** 多解必须显式声明（acceptPermutedGroups / acceptedRepairs）；否则唯一解。 */
export function checkSolutionUniqueness(scene: LearningScene): SafetyCheckResult {
  const reasons: string[] = [];
  const allowedIds = publicAllowedRefIds(scene);

  switch (scene.sceneType) {
    case "ordering": {
      const nonDistractor = scene.public.items
        .map((i) => i.id)
        .filter((id) => !scene.secret.distractorItemIds.includes(id));
      const declaredMulti = scene.secret.acceptPermutedGroups.length > 0;
      if (declaredMulti) {
        for (const group of scene.secret.acceptPermutedGroups) {
          if (group.length < 1 || !group.every((id) => nonDistractor.includes(id))) {
            reasons.push("invalid_permuted_group");
          }
        }
      } else {
        // 唯一解：正确顺序必须恰好覆盖全部非 distractor item。
        const correctSorted = [...scene.secret.correctOrderIds].sort();
        const nonDistractorSorted = [...nonDistractor].sort();
        if (
          correctSorted.length !== nonDistractorSorted.length ||
          correctSorted.some((id, i) => id !== nonDistractorSorted[i])
        ) {
          reasons.push("ordering_solution_not_unique_or_incomplete");
        }
      }
      break;
    }
    case "repair": {
      if (scene.secret.acceptedRepairs.length > 0) {
        for (const repair of scene.secret.acceptedRepairs) {
          if (repair.length === 0 || !repair.every((id) => allowedIds.has(id))) {
            reasons.push("invalid_accepted_repair");
          }
        }
      } else {
        // 唯一修复方案：intendedFlow 覆盖全部 broken token。
        const broken = scene.public.brokenTokens.map((t) => t.id).sort();
        const intended = [...scene.secret.intendedFlowIds].sort();
        if (broken.some((id, i) => id !== intended[i])) {
          reasons.push("repair_solution_not_unique_or_incomplete");
        }
      }
      break;
    }
    case "multi_step_scenario":
      // 每步唯一正确 option：多解路径必须显式由 branchOutcomes 声明。
      for (const step of scene.public.steps) {
        const correct = scene.secret.correctOptions[step.stepId];
        if (correct !== undefined) {
          const dup = step.optionIds.filter((id) => id === correct).length;
          if (dup !== 1) reasons.push(`step_option_ambiguous:${step.stepId}`);
        }
      }
      break;
    default:
      break;
  }
  return {
    checkId: "solution_uniqueness",
    passed: reasons.length === 0,
    reasonCodes: reasons,
  };
}

// ─── 7. distractor 区分度 ────────────────────────────────────────────────

/** 正确答案项文本（非 distractor 的选项/节点文本，供区分度比对）。 */
function correctAnswerItemTexts(scene: LearningScene): string[] {
  const out: string[] = [];
  switch (scene.sceneType) {
    case "ordering":
      for (const item of scene.public.items) {
        if (!scene.secret.distractorItemIds.includes(item.id)) out.push(item.text);
      }
      break;
    case "counterexample":
      for (const candidate of scene.public.candidates) {
        if (!scene.secret.invalidCandidateIds.includes(candidate.id)) out.push(candidate.text);
      }
      break;
    case "multi_step_scenario":
      for (const step of scene.public.steps) {
        const correct = scene.secret.correctOptions[step.stepId];
        const idx = correct !== undefined ? step.optionIds.indexOf(correct) : -1;
        if (idx >= 0 && idx < step.optionTexts.length) out.push(step.optionTexts[idx] ?? "");
      }
      break;
    default:
      break;
  }
  return out.filter((s) => s.length > 0);
}

/** distractor 有效、与答案文本互异、互不重复；无 distractor 需区分度 basis。 */
export function checkDistractorDiscrimination(scene: LearningScene): SafetyCheckResult {
  const reasons: string[] = [];
  if (!isStructuralInteractive(scene)) {
    return { checkId: "distractor_discrimination", passed: true, reasonCodes: [] };
  }
  const distractors = distractorTexts(scene).map(normalizeText).filter((t) => t.length > 0);
  const answerTexts = secretAnswerTexts(scene).map(normalizeText).filter((t) => t.length > 0);
  const correctTexts = correctAnswerItemTexts(scene).map(normalizeText).filter((t) => t.length > 0);
  const unique = new Set<string>(distractors);

  for (const d of distractors) {
    if (answerTexts.includes(d) || correctTexts.includes(d)) reasons.push("distractor_equals_answer");
  }
  if (unique.size !== distractors.length) reasons.push("duplicate_distractor");

  const basis = structuralDiscriminationBasis(scene);
  if (scene.distractorIds.length === 0 && basis.length === 0) {
    reasons.push("no_discrimination_basis");
  }
  return {
    checkId: "distractor_discrimination",
    passed: reasons.length === 0,
    reasonCodes: reasons,
  };
}

// ─── 8. 事实支撑 ──────────────────────────────────────────────────────────

export interface FactSourceEntry {
  evidenceRefId: string;
  semanticSupport: "supported" | "unsupported" | "unknown";
  contentHash: string;
}

export interface FactSupportScope {
  /** 该 Episode/Key Point 的已发布事实源（deterministic registry 注入） */
  sourceFacts: readonly FactSourceEntry[];
  /** 期望匹配的 source fingerprint（01-2 §11 内容指纹） */
  expectedSourceFingerprint: string;
  /** 期望匹配的 Key Point */
  expectedKeyPointId: string;
}

/** 每个 rubric evidence binding 引用的证据必须存在且 semanticSupport=supported。 */
export function checkFactualSupport(
  scene: LearningScene,
  scope: FactSupportScope,
): SafetyCheckResult {
  const reasons: string[] = [];
  if (scene.sourceFingerprint !== scope.expectedSourceFingerprint) {
    reasons.push("source_fingerprint_mismatch");
  }
  if (scene.target.keyPointId !== scope.expectedKeyPointId) {
    reasons.push("target_key_point_mismatch");
  }
  const factByRef = new Map(scope.sourceFacts.map((f) => [f.evidenceRefId, f]));
  for (const binding of scene.rubricEvidenceBindings) {
    for (const ref of binding.evidenceRefIds) {
      const fact = factByRef.get(ref);
      if (!fact) {
        reasons.push(`evidence_ref_missing_fact:${ref}`);
      } else if (fact.semanticSupport !== "supported") {
        reasons.push(`evidence_semantic_support_unsupported:${ref}`);
      }
    }
  }
  return {
    checkId: "factual_support",
    passed: reasons.length === 0,
    reasonCodes: reasons,
  };
}

// ─── 9. prompt injection 对抗 ─────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /data:text\/html/i,
  /data:image\/svg\+xml/i,
  /<svg/i,
  /onerror=/i,
  /onload=/i,
  /srcdoc/i,
  /<iframe/i,
  /<object/i,
  /<embed/i,
  /<math/i,
  /<link/i,
  /&#x?[0-9a-f]{2,}/i, // 实体/十六进制编码绕过
  /\\u00[0-9a-f]{2}/i, // unicode 转义绕过（\u 字面量文本）
];

/** 递归扫描全部字符串字段：HTML/JS 脚本形态拒绝；ID 必须安全形态。 */
export function checkPromptInjection(scene: unknown): SafetyCheckResult {
  const reasons: string[] = [];
  const scan = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      if (INJECTION_PATTERNS.some((re) => re.test(value))) {
        reasons.push(`script_marker_in:${path}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => scan(item, `${path}[${i}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        scan(v, `${path}.${k}`);
      }
    }
  };
  scan(scene, "scene");
  return {
    checkId: "prompt_injection",
    passed: reasons.length === 0,
    reasonCodes: reasons,
  };
}

// ─── 10. 语言与 A11y 检查 ────────────────────────────────────────────────

const REPLACEMENT_CHAR = /\uFFFD/;

/** 题面语言一致（无替换字符/混合脚本乱码）、A11y 等价操作不降低语义要求。 */
export function checkLanguageAndA11y(scene: LearningScene): SafetyCheckResult {
  const reasons: string[] = [];
  const texts = [
    ...publicTokenTexts(scene),
    scene.publicPayloadVersion,
    scene.secretSolutionVersion,
    scene.version,
  ];
  for (const text of texts) {
    if (typeof text === "string" && REPLACEMENT_CHAR.test(text)) {
      reasons.push("replacement_character_in_text");
    }
  }
  if (scene.a11yEquivalentPaths.length === 0) reasons.push("no_a11y_paths");
  for (const path of scene.a11yEquivalentPaths) {
    if (!path.semanticRequirementUnchanged) reasons.push(`a11y_semantics_reduced:${path.kind}`);
  }
  if (isStructuralInteractive(scene)) {
    const kinds = new Set(scene.a11yEquivalentPaths.map((p) => p.kind));
    if (!kinds.has(A11yEquivalenceKind.TAP_SELECT_PLACE)) reasons.push("missing_tap_select_place");
    if (!kinds.has(A11yEquivalenceKind.KEYBOARD)) reasons.push("missing_keyboard_path");
    if (!kinds.has(A11yEquivalenceKind.SCREEN_READER)) reasons.push("missing_screen_reader");
    if (!kinds.has(A11yEquivalenceKind.REDUCED_MOTION)) reasons.push("missing_reduced_motion");
  }
  // 无计时评分：feedback 时点与操作次数不得依赖精确速度/计时（01-2 §3.1/§6.6）。
  if (scene.maxOperations !== undefined && scene.maxOperations < 1) {
    reasons.push("max_operations_nonpositive");
  }
  if (scene.maxAttempts !== undefined && scene.maxAttempts < 1) {
    reasons.push("max_attempts_nonpositive");
  }
  return {
    checkId: "language_a11y",
    passed: reasons.length === 0,
    reasonCodes: reasons,
  };
}

// ─── 独立 Rubric/Scene Critic（mandatory，可注入）─────────────────────────

export interface SceneCriticVerdict {
  verdict: "approved" | "repair_required";
  reasonCodes: string[];
}

/** 独立 Critic 端口（01-2 §3.3 mandatory 调用；实现可注入，骨架供单测替换）。 */
export interface SceneCriticPort {
  readonly id: string;
  review(scene: LearningScene): SceneCriticVerdict;
}

// ─── 静态模板复用历史 approval（01-2 §3.3）───────────────────────────────

export interface StaticSceneTemplate {
  template: string;
  version: string;
  /** 不可变 certification hash（复用历史 approval 的依据） */
  certificationHash: string;
  /** 内容槽位来源（deterministic allowlist 标识，如 "gold-rubric-v1-<id>"） */
  contentSlotSources: string[];
  /** deterministic allowlist：内容槽位值必须 ∈ allowlist */
  allowlist: readonly string[];
}

export interface StaticCertificationResult {
  valid: boolean;
  certificationHash: string | null;
  reasonCodes: string[];
}

/**
 * 只有完全静态且带不可变 certification hash、内容槽位仍通过 deterministic
 * allowlist 的模板可复用历史 approval（01-2 §3.3）。判定纯函数：
 * - 模板未注册 / 缺 certificationHash → invalid；
 * - 全部公开 token 文本槽位 ∈ allowlist → valid（可跳过动态 Critic）。
 */
export function verifyStaticTemplateCertification(
  scene: LearningScene,
  templates: readonly StaticSceneTemplate[],
): StaticCertificationResult {
  const template = templates.find(
    (t) => t.template === scene.template && t.version === scene.version,
  );
  if (!template) return { valid: false, certificationHash: null, reasonCodes: ["static_template_not_registered"] };
  if (template.certificationHash.length !== 64) {
    return { valid: false, certificationHash: null, reasonCodes: ["static_certification_hash_invalid"] };
  }
  const allowlist = new Set(template.allowlist);
  for (const text of publicTokenTexts(scene)) {
    if (!allowlist.has(text)) {
      return { valid: false, certificationHash: null, reasonCodes: ["content_slot_not_in_deterministic_allowlist"] };
    }
  }
  return { valid: true, certificationHash: template.certificationHash, reasonCodes: [] };
}

// ─── scene-safety-v1 判定汇总 ─────────────────────────────────────────────

export interface SafetyCheckResult {
  checkId: string;
  passed: boolean;
  reasonCodes: string[];
}

export interface SceneSafetyReport {
  reportId: string;
  sceneId: string;
  mode: SceneMode;
  verdict: SceneSafetyVerdict;
  checks: SafetyCheckResult[];
  criticApproved: boolean;
  staticCertificationUsed: boolean;
  repairAttempts: 0 | 1;
  reasonCodes: string[];
  reportHash: string;
}

export interface SceneSafetyOptions {
  allowlist?: AllowlistScope;
  factScope?: FactSupportScope;
  critic: SceneCriticPort;
  /** 静态模板注册表（无匹配则复用不可用） */
  staticTemplates?: readonly StaticSceneTemplate[];
}

/** 结构性（不可重试）检查 ID：修复一次后仍失败 → blocked（fail closed）。 */
const BLOCKING_CHECK_IDS = new Set<string>([
  "public_secret_separation",
  "allowlisted_ids",
  "assessability",
  "solution_uniqueness",
  "distractor_discrimination",
  "factual_support",
]);

/** 计算报告 hash（对 verdict + checks + critic 判定确定性哈希）。 */
export function computeSceneSafetyReportHash(
  report: Omit<SceneSafetyReport, "reportId" | "reportHash">,
): string {
  return sha256Hex(
    "scene-safety-v1:" + stableStringify({
      sceneId: report.sceneId,
      mode: report.mode,
      verdict: report.verdict,
      checks: report.checks,
      criticApproved: report.criticApproved,
      staticCertificationUsed: report.staticCertificationUsed,
    }),
  );
}

/** 汇总 checks：全部通过 → approved；否则 repair_required（可修复一次）。 */
function aggregateChecks(checks: readonly SafetyCheckResult[]): {
  verdict: SceneSafetyVerdict;
  reasonCodes: string[];
} {
  const failed = checks.filter((c) => !c.passed);
  if (failed.length === 0) return { verdict: SceneSafetyVerdict.APPROVED, reasonCodes: [] };
  return {
    verdict: SceneSafetyVerdict.REPAIR_REQUIRED,
    reasonCodes: failed.flatMap((c) => c.reasonCodes),
  };
}

/**
 * 判定最终 verdict（修复一次后仍失败）：
 * 含任一结构性失败 → blocked（fail closed）；否则（仅 Critic 拒绝或可重试的
 * 内容问题）→ question_retryable。结构性失败优先于 Critic 状态。
 */
export function decideFinalVerdict(
  report: SceneSafetyReport,
): Exclude<SceneSafetyVerdict, "approved" | "repair_required"> {
  const failed = report.checks.filter((c) => !c.passed);
  const hasBlocking = failed.some((c) => BLOCKING_CHECK_IDS.has(c.checkId));
  if (hasBlocking) return SceneSafetyVerdict.BLOCKED;
  return SceneSafetyVerdict.QUESTION_RETRYABLE;
}

/** 单轮 scene-safety-v1（不修复）。确定性：同输入同报告。 */
export function runSceneSafety(
  scene: LearningScene,
  options: SceneSafetyOptions,
): SceneSafetyReport {
  const checks: SafetyCheckResult[] = [];
  const push = (result: SafetyCheckResult) => checks.push(result);

  const schemaErrors = validateSceneShape(scene);
  push({ checkId: "schema", passed: schemaErrors.length === 0, reasonCodes: schemaErrors });
  push(checkPublicSecretSeparation(scene));
  push(checkAllowlistedIds(scene, options.allowlist ?? { allowedEvidenceRefIds: [] }));
  push(checkAnswerLeakage(scene));
  push(checkAssessability(scene));
  push(checkSolutionUniqueness(scene));
  push(checkDistractorDiscrimination(scene));
  if (options.factScope) {
    push(checkFactualSupport(scene, options.factScope));
  } else {
    push({ checkId: "factual_support", passed: true, reasonCodes: ["fact_scope_not_provided"] });
  }
  push(checkPromptInjection(scene));
  push(checkLanguageAndA11y(scene));

  // 静态模板复用历史 approval（01-2 §3.3）：全部 deterministic 检查通过且
  // 模板静态认证有效 → 复用历史 Critic approval（criticApproved=true）。
  let staticCertificationUsed = false;
  let criticApproved = false;
  const staticCert = options.staticTemplates
    ? verifyStaticTemplateCertification(scene, options.staticTemplates)
    : { valid: false, certificationHash: null, reasonCodes: ["no_static_template_registry"] };

  const deterministicPassed = checks.every((c) => c.passed);
  if (staticCert.valid) {
    staticCertificationUsed = true;
    criticApproved = true;
    if (!deterministicPassed) {
      staticCertificationUsed = false;
      criticApproved = false;
    }
  } else if (deterministicPassed) {
    const criticVerdict = options.critic.review(scene);
    criticApproved = criticVerdict.verdict === "approved";
  }

  const aggregate = aggregateChecks(checks);
  let verdict: SceneSafetyVerdict;
  if (aggregate.verdict === SceneSafetyVerdict.APPROVED && criticApproved) {
    verdict = SceneSafetyVerdict.APPROVED;
  } else if (aggregate.verdict === SceneSafetyVerdict.APPROVED) {
    // deterministic 通过但 Critic 拒绝 → repair_required（可修复一次）。
    verdict = SceneSafetyVerdict.REPAIR_REQUIRED;
  } else {
    verdict = aggregate.verdict;
  }

  const reasonCodes = [
    ...aggregate.reasonCodes,
    ...(criticApproved ? [] : ["critic_not_approved"]),
    ...(staticCert.valid ? [] : staticCert.reasonCodes),
  ];
  const base = {
    sceneId: scene.sceneId,
    mode: scene.mode,
    verdict,
    checks,
    criticApproved,
    staticCertificationUsed,
    repairAttempts: 0 as const,
    reasonCodes,
  };
  return { reportId: `safety:${scene.sceneId}`, ...base, reportHash: computeSceneSafetyReportHash(base) };
}

export interface SceneSafetyWithRepairResult {
  report: SceneSafetyReport;
  /** 修复后的 Scene（有修复发生时非空） */
  repairedScene: LearningScene | null;
}

/**
 * 修复一次语义（01-2 §3.3）：失败最多修复一次，仍失败 → question_retryable
 * / blocked。repair 端口由调用方提供（修复后必须重跑全部 deterministic 检查）。
 */
export function runSceneSafetyWithRepair(
  scene: LearningScene,
  options: SceneSafetyOptions & {
    repair?: (first: LearningScene, firstReport: SceneSafetyReport) => LearningScene;
  },
): SceneSafetyWithRepairResult {
  const first = runSceneSafety(scene, options);
  if (first.verdict === SceneSafetyVerdict.APPROVED) {
    return { report: first, repairedScene: null };
  }
  if (!options.repair) {
    return { report: first, repairedScene: null };
  }
  const repairedScene = options.repair(scene, first);
  const second = runSceneSafety(repairedScene, options);
  if (second.verdict === SceneSafetyVerdict.APPROVED) {
    return { report: second, repairedScene };
  }
  const finalVerdict = decideFinalVerdict(second);
  const base = {
    sceneId: repairedScene.sceneId,
    mode: repairedScene.mode,
    verdict: finalVerdict,
    checks: second.checks,
    criticApproved: second.criticApproved,
    staticCertificationUsed: second.staticCertificationUsed,
    repairAttempts: 1 as const,
    reasonCodes: [...second.reasonCodes, "repair_exhausted"],
  };
  return {
    report: { reportId: `safety:${repairedScene.sceneId}`, ...base, reportHash: computeSceneSafetyReportHash(base) },
    repairedScene,
  };
}
