/**
 * Assessment Critic 完整实现（阶段 04 / W3 任务 04-4，INDEPENDENT_ASSESS 逐项 evidence binding §7.5）
 *
 * 职责（03-4 actor 矩阵 / 01-2 §9 / 04-w3 任务 04-4）：
 * - buildAssessmentCriticSystemPolicy：独立 Agent Session 的 system policy（绑定模型快照），
 *   不继承 Supervisor 自由文本判断，不返回 mastery / interval / 总体 outcome / 共享图关系真值；
 * - deterministicScorer：ordering / 固定 graph / typed repair 优先由确定性评分产生逐项 evidence，
 *   仅开放语义、语音和复杂理由交给 Critic；
 * - assessRubricItem：每个冻结 rubric item 恰好一条最终 assessment，每 verdict 绑定
 *   response artifact / answer excerpt / interaction refs / evidence refs；
 * - runFailClosedChecks：unknown / duplicate / missing / 伪造引用（evidence/excerpt/interaction）
 *   全部 fail closed；redacted artifact 一律不允许 semantic re-audit；
 * - assessRubricSet：聚合校验覆盖完整性（unknown / duplicate / missing 拒绝）。
 *
 * 硬要求（01-2 §9）：
 * - evidence refs 必须是该 RubricTarget 预绑定 evidenceRefIds 的子集；
 * - excerpt 必须能从锁定 transcript/text 重建；interaction refs 必须来自 artifact；
 * - ASR 不可靠（低置信 / transcript hash 失配 / 音频替换 / replay 攻击）→ not_assessable，可无损重试；
 * - Critic 不返回总体 outcome；runtime Critic 不给自己的 RC Gold 打分。
 */

import {
  LearningAgentRole,
  LearningToolId,
  type LearningRoleSpec,
} from "../types.ts";
import { computeVoiceContentHash, LearningAssessmentSource } from "@ailearn/shared";

// ─── 枚举与常量 ─────────────────────────────────────────────────────────

export const ASSESSMENT_VERDICTS = [
  "covered",
  "partial",
  "missing",
  "contradicted",
  "not_assessable",
] as const;
export type AssessmentVerdict = (typeof ASSESSMENT_VERDICTS)[number];

// 2026-08-12（契约收口）：值域单一来源迁移到 @ailearn/shared
// （LearningAssessmentSource，与 SQL 0074 CHECK 对齐）；保留本地导出名
// 兼容既有消费者。
export const ASSESSMENT_SOURCES: readonly LearningAssessmentSource[] = Object.values(LearningAssessmentSource);
export type AssessmentSource = LearningAssessmentSource;

export const ARTIFACT_MODALITIES = [
  "voice",
  "text_or_mixed",
  "drag_graph",
  "ordering",
  "repair",
  "scenario",
] as const;
export type ArtifactModality = (typeof ARTIFACT_MODALITIES)[number];

/** 状态机（01-2 §6.2）：capturing → transcribed → awaiting_confirmation → locked | superseded | stale；locked → redacted */
export const ARTIFACT_STATUSES = [
  "capturing",
  "transcribed",
  "awaiting_confirmation",
  "locked",
  "superseded",
  "stale",
  "redacted",
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const SCORING_MODES = [
  "ordering",
  "graph",
  "typed_repair",
  "open_semantic",
  "voice",
  "complex_reasoning",
] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];

/** 由 deterministic modality scorer 产生逐项 evidence 的评分模式（01-2 §9） */
export const DETERMINISTIC_SCORING_MODES = [
  "ordering",
  "graph",
  "typed_repair",
] as const;
export type DeterministicScoringMode = (typeof DETERMINISTIC_SCORING_MODES)[number];

export const CORRECTION_METHODS = ["none", "re_recorded", "manual_text_edit"] as const;
export type CorrectionMethod = (typeof CORRECTION_METHODS)[number];

/** ASR 整体置信度下限：低于它视为不可靠，100% fail closed → not_assessable */
export const MIN_ASR_CONFIDENCE = 0.7;

// ─── 输入 / 输出类型（对齐 01-2 §9 冻结 RubricAssessment）──────────────

/** 独立 Agent Session 使用的模型快照（policy 必须绑定，防止跨版本漂移） */
export interface ModelSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly snapshotHash: string;
}

/** 独立 system policy：不继承 Supervisor 自由文本判断，不返回 mastery/interval */
export interface AssessmentCriticSystemPolicy {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly role: LearningAgentRole;
  readonly modelSnapshot: ModelSnapshot;
  readonly systemPrompt: string;
  /** 显式禁止输出的字段/真值（越权输出 = 0） */
  readonly forbiddenOutputs: readonly string[];
  readonly allowedToolIds: readonly LearningToolId[];
}

export interface ArtifactSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** 锁定 artifact 的只读视图（read_locked_artifact 返回；redacted 不可用于语义判定） */
export interface LockedArtifactView {
  readonly artifactId: string;
  readonly status: ArtifactStatus;
  readonly modality: ArtifactModality;
  readonly revision: number;
  readonly contentHash: string;
  readonly transcript?: string;
  readonly transcriptHash?: string;
  readonly segments?: readonly ArtifactSegment[];
  readonly asrConfidence?: number;
  readonly asrProvider?: string;
  readonly asrModel?: string;
  /** ordering：用户最终排序 ID（allowlisted） */
  readonly orderedIds?: readonly string[];
  /** ordering：本题允许的 item ID 白名单 */
  readonly allowlistedItemIds?: readonly string[];
  /** graph：规范化边 "source:relation:target" */
  readonly edges?: readonly string[];
  /** repair：规范化 typed 操作 */
  readonly repairOps?: readonly string[];
  readonly interactionRefs?: readonly string[];
  readonly supersedesArtifactId?: string;
  readonly correctionMethod?: CorrectionMethod;
}

/** 冻结 RubricTarget（read_rubric_target；evidenceRefIds 为预绑定集合） */
export interface FrozenRubricTarget {
  readonly rubricItemId: string;
  readonly keyPointId?: string;
  readonly facet?: string;
  readonly scoringMode: ScoringMode;
  readonly evidenceRefIds: readonly string[];
  /** ordering 期望顺序（evidenceRefIds 按序对应每个期望 item） */
  readonly expectedOrderIds?: readonly string[];
  /** graph 期望边集 */
  readonly expectedEdgeSet?: readonly string[];
  /** typed_repair 期望操作集 */
  readonly expectedRepairOps?: readonly string[];
}

/** 最终逐项 assessment（冻结结构，01-2 §9） */
export interface RubricResponseBinding {
  readonly responseArtifactId: string;
  readonly answerExcerpt?: string;
  readonly interactionRefs?: string[];
}

export interface RubricAssessment {
  readonly rubricItemId: string;
  readonly verdict: AssessmentVerdict;
  readonly responseBindings: RubricResponseBinding[];
  readonly evidenceRefIds: string[];
  readonly assessmentSource: AssessmentSource;
  readonly rationale: string;
  readonly confidence: number;
}

/** deterministic modality scorer 输出（detail 只含 reason code 与计数，内容最小化） */
export interface DeterministicScoring {
  readonly verdict: AssessmentVerdict;
  readonly evidenceRefIds: readonly string[];
  readonly answerExcerpt?: string;
  readonly interactionRefs?: readonly string[];
  readonly rationale: string;
  readonly confidence: number;
  readonly detail: {
    readonly reasonCode: string;
    readonly matched: number;
    readonly total: number;
  };
}

// ─── fail closed 失败码 ─────────────────────────────────────────────────

export type AssessmentCriticFailureCode =
  | "artifact_not_locked"
  | "artifact_unknown_modality"
  | "artifact_redacted_semantic_audit"
  | "unknown_rubric_item"
  | "duplicate_rubric_item"
  | "missing_rubric_item"
  | "unknown_verdict"
  | "forged_evidence_ref"
  | "forged_excerpt"
  | "forged_interaction_ref"
  | "duplicate_ref"
  | "invalid_confidence"
  | "contract_evidence_mismatch";

export interface AssessmentCriticFailure {
  readonly code: AssessmentCriticFailureCode;
  readonly message: string;
}

export class AssessmentCriticError extends Error {
  readonly code: AssessmentCriticFailureCode;

  constructor(message: string, code: AssessmentCriticFailureCode) {
    super(message);
    this.name = "AssessmentCriticError";
    this.code = code;
  }
}

// ─── sha256（音频替换 / replay 攻击的完整性校验）────────────────────────
// 单一来源：packages/shared/src/content-hash.ts（security_review HIGH #2 修复——
// 必须与服务端 voice-service 使用同一 computeVoiceContentHash，避免格式断裂）。

// ─── 独立 Agent Session system policy ───────────────────────────────────

/**
 * 构建独立 Assessment Critic system policy。
 * - 独立 Agent Session、system policy 与模型快照（不继承 Supervisor 自由文本判断）；
 * - 显式禁止输出 mastery / interval / 总体 outcome / 共享图关系真值；
 * - runtime Critic 不给自己的 RC Gold 打分（"no_rc_gold_self_score"）。
 */
export function buildAssessmentCriticSystemPolicy(
  modelSnapshot: ModelSnapshot,
): AssessmentCriticSystemPolicy {
  const forbiddenOutputs: readonly string[] = [
    "overall_outcome",
    "mastery",
    "review_interval",
    "shared_graph_truth",
    "rc_gold_self_score",
  ];
  const systemPrompt = [
    "你是独立 Agent Session 中的 Assessment Critic（INDEPENDENT_ASSESS）。",
    "不继承 Supervisor 的自由文本判断；使用本 policy 绑定的模型快照。",
    "只读完整锁定 artifact、冻结 RubricTarget 与预绑定 evidence refs；不生成 probe、不修改 artifact。",
    "每个冻结 rubric item 恰好输出一条最终 assessment，verdict ∈ {covered, partial, missing, contradicted, not_assessable}。",
    "evidence refs 必须是 RubricTarget 预绑定 evidenceRefIds 的子集；answer excerpt 必须能从锁定 transcript/text 重建；interaction refs 必须来自 artifact。",
    "ordering / 固定 graph / typed repair 由 deterministic modality scorer 产生逐项 evidence；本 Critic 只处理开放语义、语音与复杂理由。",
    "禁止输出：总体 outcome、mastery、复习间隔、共享图关系真值；runtime Critic 不给自己的 RC Gold 打分。",
    "ASR 不可靠（低置信 / hash 失配 / 音频替换 / replay 攻击）→ not_assessable，绝不猜测补全。",
    "rationale 内容最小化：只存 reason code 与必要的 rubric/evidence ref。",
  ].join("\n");
  return {
    policyId: "assessment-critic-policy-v1",
    policyVersion: "1.0.0",
    role: LearningAgentRole.ASSESSMENT_CRITIC,
    modelSnapshot,
    systemPrompt,
    forbiddenOutputs,
    allowedToolIds: [
      LearningToolId.READ_LOCKED_ARTIFACT,
      LearningToolId.READ_RUBRIC_TARGET,
      LearningToolId.READ_EVIDENCE_REFS,
      LearningToolId.SUBMIT_ASSESSMENT_VERDICT,
    ],
  };
}

/** 创建 Assessment Critic 角色规格 */
export function createAssessmentCriticRole(): LearningRoleSpec {
  return {
    role: LearningAgentRole.ASSESSMENT_CRITIC,
    description:
      "INDEPENDENT_ASSESS 逐项证据化评估者：只读锁定 artifact / 冻结 RubricTarget / 预绑定 evidence，输出逐项 assessment，不返回总体 outcome。",
    allowedToolIds: [
      LearningToolId.READ_LOCKED_ARTIFACT,
      LearningToolId.READ_RUBRIC_TARGET,
      LearningToolId.READ_EVIDENCE_REFS,
      LearningToolId.SUBMIT_ASSESSMENT_VERDICT,
    ],
  };
}

// ─── canonical 回答文本重建（excerpt 校验基础）──────────────────────────

/** 从锁定 artifact 重建 canonical 回答文本（transcript 优先，其次拼接 segments）。 */
export function canonicalAnswerText(artifact: LockedArtifactView): string | null {
  if (artifact.transcript !== undefined) return artifact.transcript;
  if (artifact.segments !== undefined && artifact.segments.length > 0) {
    return artifact.segments.map((s) => s.text).join("");
  }
  return null;
}

/** excerpt 必须能从锁定 transcript/text 重建；无 excerpt 视为合法。 */
export function excerptReconstructible(
  artifact: LockedArtifactView,
  excerpt: string | undefined,
): boolean {
  if (excerpt === undefined || excerpt === "") return true;
  const text = canonicalAnswerText(artifact);
  if (text === null) return false;
  return text.includes(excerpt);
}

// ─── 内容可靠性：ASR 失败 / 低置信 / 音频替换 / replay 攻击 fail closed ─

export interface ReliabilityResult {
  readonly reliable: boolean;
  readonly reasonCode?: string;
}

/**
 * 内容可靠性判定（纯函数）。不可靠 → not_assessable（可无损重试）：
 * - voice：ASR 低置信 / transcript 缺失 / transcript hash 重建失配（音频替换、replay 攻击）；
 * - ordering：空 / 重复 ID / 非 allowlisted 未知 ID；
 * - graph / typed_repair：空 / 重复元素。
 */
export function assessReliability(
  artifact: LockedArtifactView,
  target: FrozenRubricTarget,
): ReliabilityResult {
  if (target.scoringMode === "voice" || artifact.modality === "voice") {
    if (artifact.asrConfidence !== undefined && artifact.asrConfidence < MIN_ASR_CONFIDENCE) {
      return { reliable: false, reasonCode: "asr_low_confidence" };
    }
    const text = canonicalAnswerText(artifact);
    if (text === null) {
      return { reliable: false, reasonCode: "asr_no_transcript" };
    }
    if (artifact.transcriptHash === undefined) {
      // transcript hash 缺失：无法验证完整性 → fail closed（不允许短路跳过）
      return { reliable: false, reasonCode: "transcript_hash_missing" };
    }
    if (computeVoiceContentHash(text) !== artifact.transcriptHash) {
      // transcript hash 重建不一致（与服务端同格式）：音频替换 / replay 攻击 → fail closed
      return { reliable: false, reasonCode: "transcript_hash_mismatch" };
    }
  }
  if (target.scoringMode === "ordering") {
    const ids = artifact.orderedIds;
    if (ids === undefined || ids.length === 0) {
      return { reliable: false, reasonCode: "ordering_empty" };
    }
    if (hasDuplicates(ids)) {
      return { reliable: false, reasonCode: "ordering_duplicate_id" };
    }
    if (
      artifact.allowlistedItemIds !== undefined &&
      ids.some((id) => !artifact.allowlistedItemIds!.includes(id))
    ) {
      return { reliable: false, reasonCode: "ordering_unknown_id" };
    }
  }
  if (target.scoringMode === "graph") {
    if (artifact.edges === undefined || artifact.edges.length === 0) {
      return { reliable: false, reasonCode: "graph_empty" };
    }
    if (hasDuplicates(artifact.edges)) {
      return { reliable: false, reasonCode: "graph_duplicate_edge" };
    }
  }
  if (target.scoringMode === "typed_repair") {
    if (artifact.repairOps === undefined || artifact.repairOps.length === 0) {
      return { reliable: false, reasonCode: "repair_empty" };
    }
    if (hasDuplicates(artifact.repairOps)) {
      return { reliable: false, reasonCode: "repair_duplicate_op" };
    }
  }
  return { reliable: true };
}

// ─── 序列比较工具 ───────────────────────────────────────────────────────

function hasDuplicates(items: readonly unknown[]): boolean {
  return new Set(items).size !== items.length;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function setEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((v) => setB.has(v));
}

/** a 是否为 b 的子序列（保持相对顺序） */
function isSubsequenceOf(a: readonly string[], b: readonly string[]): boolean {
  let i = 0;
  for (const value of b) {
    if (i < a.length && a[i] === value) i++;
  }
  return i === a.length;
}

/** 最长公共子序列长度（顺序敏感） */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  return dp[n]![m]!;
}

// ─── deterministic modality scorer ──────────────────────────────────────

export interface DeterministicScorerInput {
  readonly artifact: LockedArtifactView;
  readonly rubricTarget: FrozenRubricTarget;
}

/**
 * deterministic modality scorer：仅对 ordering / graph / typed_repair 产生逐项 evidence；
 * 其它模式返回 null（交给 Critic）。evidenceRefIds 从 target.evidenceRefIds 按期望元素位置
 * 选取命中项，因此自动 ⊆ 预绑定集合。内容不可靠时返回 not_assessable（fail closed）。
 */
export function deterministicScorer(
  input: DeterministicScorerInput,
): DeterministicScoring | null {
  const { artifact, rubricTarget: target } = input;
  if (!DETERMINISTIC_SCORING_MODES.includes(target.scoringMode as DeterministicScoringMode)) {
    return null;
  }
  const reliability = assessReliability(artifact, target);
  if (!reliability.reliable) {
    return {
      verdict: "not_assessable",
      evidenceRefIds: [],
      rationale: `not_assessable:${reliability.reasonCode ?? "unreliable"}`,
      confidence: 0,
      detail: {
        reasonCode: reliability.reasonCode ?? "unreliable",
        matched: 0,
        total: 0,
      },
    };
  }
  if (target.scoringMode === "ordering") {
    return scoreOrdering(artifact.orderedIds!, target);
  }
  if (target.scoringMode === "graph") {
    return scoreGraph(artifact.edges!, target);
  }
  return scoreRepair(artifact.repairOps!, target);
}

function confidenceForVerdict(verdict: AssessmentVerdict): number {
  switch (verdict) {
    case "covered": return 1;
    case "contradicted": return 0.9;
    case "partial": return 0.7;
    case "missing": return 0.9;
    case "not_assessable": return 0;
  }
}

function scoreOrdering(
  actual: readonly string[],
  target: FrozenRubricTarget,
): DeterministicScoring {
  const expected = target.expectedOrderIds ?? [];
  const refs = target.evidenceRefIds;
  const total = expected.length;
  const expectedSet = new Set(expected);

  if (arraysEqual(actual, expected)) {
    return deterministicResult(
      "covered", expected, refs, total, "ordering_exact", actual,
    );
  }
  const inExpected = actual.filter((id) => expectedSet.has(id));
  if (inExpected.length === 0) {
    return deterministicResult(
      "missing", expected, refs, 0, "ordering_no_overlap", actual,
    );
  }
  if (setEqual(actual, expected) && !arraysEqual(actual, expected)) {
    return deterministicResult(
      "contradicted", expected, refs, lcsLength(actual, expected), "ordering_wrong_sequence", actual,
    );
  }
  // actual ⊆ expected：按相对顺序是否一致分 partial / contradicted
  if (isSubsequenceOf(inExpected, expected) && actual.length === inExpected.length) {
    return deterministicResult(
      "partial", expected, refs, inExpected.length, "ordering_missing_items", actual,
    );
  }
  // 其余：乱序 / 越界 → contradicted
  return deterministicResult(
    "contradicted", expected, refs, lcsLength(actual, expected), "ordering_wrong_sequence_or_extra", actual,
  );
}

/**
 * 组装 deterministic 结果：evidenceRefIds = 期望位置 i 命中（出现在实际集合且顺序相关）的 refs。
 * 命中判定为「出现在实际回答中」；matched 由调用方语义传入。
 */
function deterministicResult(
  verdict: AssessmentVerdict,
  expected: readonly string[],
  refs: readonly string[],
  matched: number,
  reasonCode: string,
  actual: readonly string[],
): DeterministicScoring {
  const present = new Set(actual);
  const hitRefs = expected
    .map((id, i) => (present.has(id) ? refs[i] : undefined))
    .filter((ref): ref is string => ref !== undefined);
  const total = expected.length;
  return {
    verdict,
    evidenceRefIds: hitRefs,
    rationale: `${verdict}:${reasonCode}:${matched}/${total}`,
    confidence: confidenceForVerdict(verdict),
    detail: { reasonCode, matched, total },
  };
}

function splitEdge(edge: string): { source: string; relation: string; target: string } | null {
  const parts = edge.split(":");
  if (parts.length !== 3) return null;
  return { source: parts[0]!, relation: parts[1]!, target: parts[2]! };
}

/** 存在直接冲突边：同 (source,target) 但 relation 不同。 */
function hasEdgeConflict(actual: readonly string[], expected: readonly string[]): boolean {
  const expectedMap = new Map<string, string>();
  for (const e of expected) {
    const parsed = splitEdge(e);
    if (parsed === null) continue;
    expectedMap.set(`${parsed.source}|${parsed.target}`, parsed.relation);
  }
  for (const a of actual) {
    const parsed = splitEdge(a);
    if (parsed === null) continue;
    const expectedRel = expectedMap.get(`${parsed.source}|${parsed.target}`);
    if (expectedRel !== undefined && expectedRel !== parsed.relation) return true;
  }
  return false;
}

function scoreGraph(
  actual: readonly string[],
  target: FrozenRubricTarget,
): DeterministicScoring {
  const expected = target.expectedEdgeSet ?? [];
  const refs = target.evidenceRefIds;
  const total = expected.length;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);

  if (arraysEqual(actual, expected)) {
    return deterministicResult("covered", expected, refs, total, "graph_exact", actual);
  }
  if (hasEdgeConflict(actual, expected)) {
    return deterministicResult("contradicted", expected, refs, 0, "graph_conflict_edge", actual);
  }
  const overlap = expected.filter((e) => actualSet.has(e)).length;
  if (overlap === 0) {
    return deterministicResult("missing", expected, refs, 0, "graph_no_overlap", actual);
  }
  const expectedInActual = expected.every((e) => actualSet.has(e));
  const actualInExpected = actual.every((e) => expectedSet.has(e));
  if (expectedInActual && !actualInExpected) {
    // 实际包含全部期望边且还有额外边（多选越界）→ contradicted
    return deterministicResult("contradicted", expected, refs, overlap, "graph_extra_edge", actual);
  }
  if (actualInExpected && !expectedInActual) {
    return deterministicResult("partial", expected, refs, overlap, "graph_missing_edge", actual);
  }
  return deterministicResult("contradicted", expected, refs, overlap, "graph_partial_conflict", actual);
}

/** typed repair 操作格式 "action:target" 或 "action:target:param"；冲突 = 同 target 不同 action。 */
function hasRepairConflict(actual: readonly string[], expected: readonly string[]): boolean {
  const expectedMap = new Map<string, string>();
  for (const op of expected) {
    const [action, target] = op.split(":");
    if (action === undefined || target === undefined) continue;
    expectedMap.set(target, action);
  }
  for (const op of actual) {
    const [action, target] = op.split(":");
    if (action === undefined || target === undefined) continue;
    const expectedAction = expectedMap.get(target);
    if (expectedAction !== undefined && expectedAction !== action) return true;
  }
  return false;
}

function scoreRepair(
  actual: readonly string[],
  target: FrozenRubricTarget,
): DeterministicScoring {
  const expected = target.expectedRepairOps ?? [];
  const refs = target.evidenceRefIds;
  const total = expected.length;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);

  if (arraysEqual(actual, expected)) {
    return deterministicResult("covered", expected, refs, total, "repair_exact", actual);
  }
  if (hasRepairConflict(actual, expected)) {
    return deterministicResult("contradicted", expected, refs, 0, "repair_conflict_op", actual);
  }
  const overlap = expected.filter((e) => actualSet.has(e)).length;
  if (overlap === 0) {
    return deterministicResult("missing", expected, refs, 0, "repair_no_overlap", actual);
  }
  const expectedInActual = expected.every((e) => actualSet.has(e));
  const actualInExpected = actual.every((e) => expectedSet.has(e));
  if (expectedInActual && !actualInExpected) {
    return deterministicResult("contradicted", expected, refs, overlap, "repair_extra_op", actual);
  }
  if (actualInExpected && !expectedInActual) {
    return deterministicResult("partial", expected, refs, overlap, "repair_missing_op", actual);
  }
  return deterministicResult("contradicted", expected, refs, overlap, "repair_partial_conflict", actual);
}

// ─── fail closed checks ─────────────────────────────────────────────────

export interface SingleAssessmentValidationInput {
  readonly artifact: LockedArtifactView;
  readonly rubricTarget: FrozenRubricTarget;
  readonly preboundEvidenceRefIds: readonly string[];
  readonly verdict?: AssessmentVerdict;
  readonly evidenceRefIds?: readonly string[];
  readonly answerExcerpt?: string;
  readonly interactionRefs?: readonly string[];
  readonly confidence?: number;
}

/**
 * 单条 assessment 的 fail closed 校验（纯函数）。返回失败清单；空数组 = 通过。
 * unknown / duplicate / missing / 伪造引用（evidence、excerpt、interaction）全部 fail closed；
 * redacted artifact 不允许 semantic re-audit。
 */
export function runFailClosedChecks(
  input: SingleAssessmentValidationInput,
): readonly AssessmentCriticFailure[] {
  const failures: AssessmentCriticFailure[] = [];
  const { artifact, rubricTarget: target } = input;

  if (artifact.status === "redacted") {
    failures.push({
      code: "artifact_redacted_semantic_audit",
      message: "redacted artifact 已删除 transcript，不能做完整语义重审（仅可 canonical replay）",
    });
  } else if (artifact.status !== "locked") {
    failures.push({
      code: "artifact_not_locked",
      message: `artifact 状态 ${artifact.status}，仅 locked 可进入评估`,
    });
  }
  if (!ARTIFACT_MODALITIES.includes(artifact.modality)) {
    failures.push({
      code: "artifact_unknown_modality",
      message: `未知模态 ${artifact.modality}`,
    });
  }
  if (input.verdict !== undefined && !ASSESSMENT_VERDICTS.includes(input.verdict)) {
    failures.push({ code: "unknown_verdict", message: `未知 verdict ${input.verdict}` });
  }
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
  ) {
    failures.push({
      code: "invalid_confidence",
      message: `confidence 必须在 [0,1] 有穷区间，得到 ${input.confidence}`,
    });
  }
  // prebound 与 RubricTarget 预绑定必须一致（契约破坏 fail closed）
  if (!sameSetIgnoreOrder(input.preboundEvidenceRefIds, target.evidenceRefIds)) {
    failures.push({
      code: "contract_evidence_mismatch",
      message: "read_evidence_refs 返回的 prebound refs 与 RubricTarget.evidenceRefIds 不一致",
    });
  }
  // 伪造 evidence refs：必须是 prebound（= 预绑定）子集
  const claimedEvidence = input.evidenceRefIds ?? [];
  const preboundSet = new Set(input.preboundEvidenceRefIds);
  const forged = claimedEvidence.filter((ref) => !preboundSet.has(ref));
  if (forged.length > 0) {
    failures.push({
      code: "forged_evidence_ref",
      message: `evidence refs ${forged.join(",")} 不在预绑定集合`,
    });
  }
  if (hasDuplicates(claimedEvidence)) {
    failures.push({ code: "duplicate_ref", message: "evidence refs 内部重复" });
  }
  // 伪造 excerpt：必须能从锁定 transcript/text 重建
  if (!excerptReconstructible(artifact, input.answerExcerpt)) {
    failures.push({
      code: "forged_excerpt",
      message: "answerExcerpt 无法从锁定 transcript/text 重建",
    });
  }
  // 伪造 interaction refs：必须来自 artifact
  const claimedInteractions = input.interactionRefs ?? [];
  const artifactInteractions = artifact.interactionRefs ?? [];
  if (artifactInteractions.length === 0 && claimedInteractions.length > 0) {
    failures.push({
      code: "forged_interaction_ref",
      message: "artifact 无 interaction refs，claimed refs 无法来自 artifact",
    });
  } else {
    const artifactInteractionSet = new Set(artifactInteractions);
    const forgedInteraction = claimedInteractions.filter((ref) => !artifactInteractionSet.has(ref));
    if (forgedInteraction.length > 0) {
      failures.push({
        code: "forged_interaction_ref",
        message: `interaction refs ${forgedInteraction.join(",")} 不来自 artifact`,
      });
    }
    if (hasDuplicates(claimedInteractions)) {
      failures.push({ code: "duplicate_ref", message: "interaction refs 内部重复" });
    }
  }
  return failures;
}

function sameSetIgnoreOrder(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const v of setA) if (!setB.has(v)) return false;
  return true;
}

// ─── 单条最终 assessment 组装 ──────────────────────────────────────────

export interface AssessRubricItemInput {
  readonly artifact: LockedArtifactView;
  readonly rubricTarget: FrozenRubricTarget;
  readonly preboundEvidenceRefIds: readonly string[];
  /** critic / user_declared_unable 模式才需要（deterministic 模式自动评分） */
  readonly claimedVerdict?: AssessmentVerdict;
  readonly claimedEvidenceRefIds?: readonly string[];
  readonly claimedAnswerExcerpt?: string;
  readonly claimedInteractionRefs?: readonly string[];
  readonly claimedConfidence?: number;
  readonly claimedRationale?: string;
  readonly claimedSource?: Exclude<AssessmentSource, "deterministic">;
}

/**
 * 逐项评估：每个冻结 rubric item 恰好一条最终 assessment。
 * - deterministic 模式由 deterministicScorer 产生逐项 evidence（Critic 不参与）；
 * - open_semantic / voice / complex_reasoning 使用 critic 的 claimed 判定，
 *   但 ASR 不可靠时降级为 not_assessable；
 * - 任何 fail closed 情形抛 AssessmentCriticError。
 */
export function assessRubricItem(input: AssessRubricItemInput): RubricAssessment {
  const { artifact, rubricTarget: target } = input;
  const failures = runFailClosedChecks({
    artifact,
    rubricTarget: target,
    preboundEvidenceRefIds: input.preboundEvidenceRefIds,
    verdict: input.claimedVerdict,
    evidenceRefIds: input.claimedEvidenceRefIds,
    answerExcerpt: input.claimedAnswerExcerpt,
    interactionRefs: input.claimedInteractionRefs,
    confidence: input.claimedConfidence,
  });
  if (failures.length > 0) {
    const first = failures[0]!;
    const detail = failures.map((f) => f.code).join(",");
    throw new AssessmentCriticError(
      `assessment fail closed: ${first.message}（${detail}）`,
      first.code,
    );
  }

  const scoringMode = target.scoringMode;
  if (DETERMINISTIC_SCORING_MODES.includes(scoringMode as DeterministicScoringMode)) {
    const scoring = deterministicScorer({ artifact, rubricTarget: target });
    if (scoring === null) {
      throw new AssessmentCriticError(
        "deterministic 模式未产生评分",
        "missing_rubric_item",
      );
    }
    return {
      rubricItemId: target.rubricItemId,
      verdict: scoring.verdict,
      responseBindings: [
        {
          responseArtifactId: artifact.artifactId,
          answerExcerpt: scoring.answerExcerpt,
          interactionRefs: scoring.interactionRefs
            ? [...scoring.interactionRefs]
            : undefined,
        },
      ],
      evidenceRefIds: [...scoring.evidenceRefIds],
      assessmentSource: "deterministic",
      rationale: scoring.rationale,
      confidence: scoring.confidence,
    };
  }

  // critic / user_declared_unable 模式
  if (input.claimedVerdict === undefined) {
    throw new AssessmentCriticError(
      `${scoringMode} 模式缺少 critic verdict`,
      "missing_rubric_item",
    );
  }
  const source = input.claimedSource ?? "critic";
  if (source === "user_declared_unable" && input.claimedVerdict !== "not_assessable") {
    throw new AssessmentCriticError(
      "user_declared_unable 只允许 not_assessable verdict",
      "unknown_verdict",
    );
  }
  const reliability = assessReliability(artifact, target);
  const verdict: AssessmentVerdict =
    reliability.reliable ? input.claimedVerdict : "not_assessable";
  // fail closed：not_assessable 的 confidence 一律为 0（不携带 critic 声称的信任）
  const confidence =
    verdict === "not_assessable"
      ? 0
      : input.claimedConfidence ?? confidenceForVerdict(verdict);
  const rationale =
    input.claimedRationale ??
    (source === "user_declared_unable"
      ? "not_assessable:user_declared_unable"
      : reliability.reliable
        ? `critic:${verdict}`
        : `not_assessable:${reliability.reasonCode ?? "unreliable"}`);
  return {
    rubricItemId: target.rubricItemId,
    verdict,
    responseBindings: [
      {
        responseArtifactId: artifact.artifactId,
        answerExcerpt: input.claimedAnswerExcerpt,
        interactionRefs: input.claimedInteractionRefs
          ? [...input.claimedInteractionRefs]
          : undefined,
      },
    ],
    evidenceRefIds: [...(input.claimedEvidenceRefIds ?? [])],
    assessmentSource: source,
    rationale,
    confidence,
  };
}

// ─── 聚合：每冻结 rubric item 恰好一条最终 assessment ───────────────────

export interface ProposedAssessment {
  readonly rubricItemId: string;
  readonly verdict: AssessmentVerdict;
  readonly evidenceRefIds?: readonly string[];
  readonly answerExcerpt?: string;
  readonly interactionRefs?: readonly string[];
  readonly confidence?: number;
  readonly rationale?: string;
  readonly source?: Exclude<AssessmentSource, "deterministic">;
}

export interface AssessRubricSetInput {
  readonly artifact: LockedArtifactView;
  readonly frozenRubricTargets: readonly FrozenRubricTarget[];
  readonly preboundEvidenceByItem: Readonly<Record<string, readonly string[]>>;
  readonly proposals?: readonly ProposedAssessment[];
}

/**
 * 聚合评估：对冻结 rubric item 集输出恰好一条最终 assessment 每项。
 * unknown / duplicate / missing 全部 fail closed（抛 AssessmentCriticError）。
 */
export function assessRubricSet(input: AssessRubricSetInput): RubricAssessment[] {
  const { frozenRubricTargets, proposals = [] } = input;
  const coverageFailures: AssessmentCriticFailure[] = [];

  const proposedIds = proposals.map((p) => p.rubricItemId);
  const frozenIds = new Set(frozenRubricTargets.map((t) => t.rubricItemId));

  // unknown：提议了不在冻结集中的 item
  for (const id of proposedIds) {
    if (!frozenIds.has(id)) {
      coverageFailures.push({
        code: "unknown_rubric_item",
        message: `proposal 引用未知 rubric item ${id}`,
      });
    }
  }
  // duplicate：同一 item 多条最终 assessment
  if (hasDuplicates(proposedIds)) {
    coverageFailures.push({
      code: "duplicate_rubric_item",
      message: "同一冻结 rubric item 存在多条最终 assessment",
    });
  }
  // missing：critic 模式必须提供 proposal（deterministic 模式自动评分）
  for (const target of frozenRubricTargets) {
    const isDeterministic = DETERMINISTIC_SCORING_MODES.includes(
      target.scoringMode as DeterministicScoringMode,
    );
    if (!isDeterministic && !proposals.some((p) => p.rubricItemId === target.rubricItemId)) {
      coverageFailures.push({
        code: "missing_rubric_item",
        message: `冻结 rubric item ${target.rubricItemId} 缺少最终 assessment`,
      });
    }
  }
  if (coverageFailures.length > 0) {
    const first = coverageFailures[0]!;
    throw new AssessmentCriticError(
      `覆盖校验 fail closed: ${first.message}`,
      first.code,
    );
  }

  return frozenRubricTargets.map((target) => {
    const proposal = proposals.find((p) => p.rubricItemId === target.rubricItemId);
    return assessRubricItem({
      artifact: input.artifact,
      rubricTarget: target,
      preboundEvidenceRefIds: input.preboundEvidenceByItem[target.rubricItemId] ?? [],
      claimedVerdict: proposal?.verdict,
      claimedEvidenceRefIds: proposal?.evidenceRefIds,
      claimedAnswerExcerpt: proposal?.answerExcerpt,
      claimedInteractionRefs: proposal?.interactionRefs,
      claimedConfidence: proposal?.confidence,
      claimedRationale: proposal?.rationale,
      claimedSource: proposal?.source,
    });
  });
}
