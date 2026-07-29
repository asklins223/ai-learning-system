/**
 * v0.6 AI Quality 黄金集类型定义 (计划 §4.2)
 *
 * 计划定义三套黄金集：
 * 1. Question/Rubric Gold v1 — ≥ 60 个跨领域 key point
 * 2. Evaluation Gold v1 — ≥ 120 个回答，覆盖正确/部分/明确误解/无法判断
 * 3. Card Repair Gold v1 — ≥ 30 个含可注入质量缺陷的 card draft
 */

// ─── 通用类型 ─────────────────────────────────────────────────────────────

export interface GoldDatasetVersion {
  version: string;
  createdAt: string;
  minimumSize: number;
}

// ─── Question/Rubric Gold v1 (计划 §4.2) ──────────────────────────────────

export interface QuestionRubricGoldSample {
  /** 唯一标识 */
  id: string;
  /** 领域 */
  domain: string;
  /** key point claim */
  claim: string;
  /** key point quote */
  quote: string;
  /** 期望题型 */
  questionType: "explain" | "example" | "apply";
  /** 期望题面（人工撰写，用于检验 AI 出题质量） */
  expectedQuestion: string;
  /** 期望 rubric items（人工标注） */
  expectedRubricItems: ExpectedRubricItem[];
  /** 人工标注：是否可接受 */
  humanAccepted: boolean;
  /** 人工标注：答案泄漏 reason code（无泄漏为 null） */
  leakageReason: string | null;
  /** 标签者 */
  labeler: string;
}

export interface ExpectedRubricItem {
  key: string;
  criterion: string;
  expectedConcept: string;
  weight: 1 | 2 | 3;
  required: boolean;
  evidenceRefId: string;
}

// ─── Evaluation Gold v1 (计划 §4.2) ────────────────────────────────────────

export interface EvaluationGoldSample {
  /** 唯一标识 */
  id: string;
  /** 关联的 question gold sample ID */
  questionGoldId: string;
  /** 用户回答正文 */
  userAnswer: string;
  /** 人工标注的真实 outcome */
  trueOutcome: "preliminary_understanding" | "unclear_expression" | "misunderstanding" | "unknown";
  /** 人工标注的逐项 verdict */
  trueItemVerdicts: TrueItemVerdict[];
  /** 是否为关键误解样本（用于 false-mastery 检测） */
  isCriticalMisunderstanding: boolean;
  /** 标签者 */
  labeler: string;
  /** 第二标签者（高风险样本双人独立标注） */
  secondLabeler?: string;
  /** 标签分歧是否已解决 */
  disagreementResolved?: boolean;
}

export interface TrueItemVerdict {
  rubricItemKey: string;
  verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
}

// ─── Card Repair Gold v1 (计划 §4.2) ──────────────────────────────────────

export interface CardRepairGoldSample {
  /** 唯一标识 */
  id: string;
  /** 卡片 draft（含可注入质量缺陷） */
  draft: CardDraftWithDefects;
  /** 原始 source blocks（用于修复时参考） */
  sourceBlocks: SourceBlock[];
  /** 人工标注的 trigger reasons */
  expectedTriggers: CardRepairTrigger[];
  /** 修复后应通过的 hard gate */
  expectedPostRepairHardGate: {
    hardCitationPrecision: number;
    keyPointHardCoverage: number;
    validationExpectedPointsHardCoverage: number;
  };
  /** 非触发样本不应进行第二次调用 */
  shouldTriggerRepair: boolean;
  /** 标签者 */
  labeler: string;
}

export interface CardDraftWithDefects {
  title: string;
  summary: string;
  keyPoints: Array<{
    ordinal: number;
    claim: string;
    quoteText: string;
    evidenceId?: string;
  }>;
}

export interface SourceBlock {
  ordinal: number;
  blockType: string;
  content: string;
}

export type CardRepairTrigger =
  | "quote_not_in_source"
  | "claim_too_short"
  | "claim_vague"
  | "claim_quote_unrelated"
  | "claim_quote_too_similar"
  | "duplicate_key_point"
  | "insufficient_valid_key_points"
  | "coverage_too_low"
  | "schema_invalid_bounded"
  | "schema_unparseable";

// ─── Runner predictions ──────────────────────────────────────────────────

/**
 * Measured output from a Question/Rubric runner. Gold labels are never used
 * as model predictions; a missing/duplicate prediction fails coverage closed.
 */
export interface QuestionRubricPrediction {
  sampleId: string;
  schemaRefIntegrityPassed: boolean;
  leakageReason: string | null;
  rubricEvidenceRefIds: string[];
  humanAccepted: boolean;
}

export interface EvaluationPrediction {
  sampleId: string;
  outcome: EvaluationGoldSample["trueOutcome"];
}

export interface CardRepairMetricSnapshot {
  hardCitationPrecision: number;
  keyPointHardCoverage: number;
  validationExpectedPointsHardCoverage: number;
}

export interface CardRepairPrediction {
  sampleId: string;
  repairTriggered: boolean;
  secondCallMade: boolean;
  hardGatePassed: boolean;
  baselineMetrics: CardRepairMetricSnapshot;
  postRepairMetrics: CardRepairMetricSnapshot;
}

export interface V06ScorerPredictions {
  questionRubric: QuestionRubricPrediction[];
  evaluation: EvaluationPrediction[];
  cardRepair: CardRepairPrediction[];
}

// ─── 评分器结果类型 ───────────────────────────────────────────────────────

export interface QuestionRubricScorerMetrics {
  /** schema/ref 完整性 */
  schemaRefIntegrity: number;
  /** 答案泄漏率（目标 0） */
  answerLeakageRate: number;
  /** hard-evidence support precision（目标 ≥ 95%） */
  hardEvidenceSupportPrecision: number;
  /** 人工接受率（目标 ≥ 85%） */
  humanAcceptRate: number;
  /** 总样本数 */
  totalSamples: number;
  /** 有且仅有一条预测结果的样本数 */
  evaluatedSamples: number;
  /** 预测覆盖率；RC gate 要求 100% */
  predictionCoverage: number;
  /** 是否通过门禁 */
  meetsGate: boolean;
}

export interface EvaluationScorerMetrics {
  /** outcome weighted κ（目标 ≥ 0.75） */
  outcomeWeightedKappa: number;
  /** 关键类别 recall（目标均 ≥ 0.70） */
  criticalCategoryRecall: {
    correct: number;
    partial: number;
    misunderstanding: number;
    unable: number;
  };
  /** false-mastery rate（目标 ≤ 5%） */
  falseMasteryRate: number;
  /** 总样本数 */
  totalSamples: number;
  /** 有且仅有一条预测结果的样本数 */
  evaluatedSamples: number;
  /** 预测覆盖率；RC gate 要求 100% */
  predictionCoverage: number;
  /** 是否通过门禁 */
  meetsGate: boolean;
}

export interface CardRepairScorerMetrics {
  /** hard violation rate（目标 0） */
  hardViolationRate: number;
  /** 既有指标不回归 */
  nonRegression: {
    hardCitationPrecision: number;
    keyPointHardCoverage: number;
    validationExpectedPointsHardCoverage: number;
  };
  /** 非触发样本二次调用率（目标 0） */
  nonTriggeredSecondCallRate: number;
  /** 总样本数 */
  totalSamples: number;
  /** 有且仅有一条预测结果的样本数 */
  evaluatedSamples: number;
  /** 预测覆盖率；RC gate 要求 100% */
  predictionCoverage: number;
  /** 是否通过门禁 */
  meetsGate: boolean;
}

// ─── RC 门禁阈值 (计划 §4.2) ──────────────────────────────────────────────

export const QUESTION_RUBRIC_THRESHOLDS = {
  schemaRefIntegrity: 1.0, // 100%
  answerLeakageRate: 0.0, // 0
  hardEvidenceSupportPrecision: 0.95, // ≥ 95%
  humanAcceptRate: 0.85, // ≥ 85%
} as const;

export const EVALUATION_THRESHOLDS = {
  outcomeWeightedKappa: 0.75, // ≥ 0.75
  criticalCategoryRecall: 0.70, // 均 ≥ 0.70
  falseMasteryRate: 0.05, // ≤ 5%
} as const;

export const CARD_REPAIR_THRESHOLDS = {
  hardViolationRate: 0.0, // 0
  nonTriggeredSecondCallRate: 0.0, // 0
} as const;
