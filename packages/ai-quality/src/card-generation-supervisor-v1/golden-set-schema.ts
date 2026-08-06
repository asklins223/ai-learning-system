/**
 * Supervisor Agent v1 黄金集 Schema（计划 §17.1, §W0）
 *
 * 至少 60 篇 note-level 样本，覆盖：
 * - 2K、13K/126 短段、50K
 * - 多章节、中英、代码、公式、procedure
 * - 否定、数值、边界、比较符、时序、矛盾
 * - 1/10/30 图、表格、图表、流程图、公式图、image-only
 * - prompt injection、伪 evidence ID、跨版本引用
 * - 三档 density
 *
 * 每个样本冻结：
 * - mustLearn/critical concepts
 * - acceptable evidence IDs
 * - expected sections
 * - must-not-merge pairs
 * - candidate/card budget
 * - title/summary/grouping rubric
 */

import { z } from "zod";

/** 黄金集样本 schema */
export const goldenSampleSchema = z.object({
  /** 样本 ID */
  sampleId: z.string().min(1),
  /** 笔记标题 */
  noteTitle: z.string(),
  /** 笔记内容（blocks JSON） */
  noteContent: z.string(),
  /** 内容桶分类 */
  contentBucket: z.enum([
    "2k_text",
    "13k_short_segments",
    "50k_long",
    "500k_extreme",
    "multimodal_1img",
    "multimodal_10img",
    "multimodal_30img",
    "code_heavy",
    "formula_heavy",
    "procedure",
    "negation_boundary",
    "contradiction",
    "prompt_injection",
    "cross_version_ref",
    "image_only",
  ]),
  /** 密度 */
  density: z.enum(["overview", "standard", "complete"]),
  /** 必须学到的概念 */
  mustLearnConcepts: z.array(z.string()),
  /** 关键概念（recall ≥ 95%） */
  criticalConcepts: z.array(z.string()),
  /** 可接受的 evidence IDs */
  acceptableEvidenceIds: z.array(z.string()),
  /** 期望的章节 */
  expectedSections: z.array(z.string()),
  /** 不能合并的对 */
  mustNotMergePairs: z.array(z.object({
    conceptA: z.string(),
    conceptB: z.string(),
    reason: z.string(),
  })),
  /** 候选预算 */
  candidateBudget: z.number().int().positive(),
  /** 卡片预算 */
  cardBudget: z.number().int().positive(),
  /** 标题/摘要评分标准 */
  titleSummaryRubric: z.object({
    mustContain: z.array(z.string()),
    shouldContain: z.array(z.string()),
    mustNotContain: z.array(z.string()),
  }),
  /** 分组评分标准 */
  groupingRubric: z.object({
    expectedGroups: z.array(z.string()),
    maxCardsPerGroup: z.number().int().positive(),
  }),
});

export type GoldenSample = z.infer<typeof goldenSampleSchema>;

/** 黄金集 */
export const goldenSetSchema = z.array(goldenSampleSchema);

export type GoldenSet = z.infer<typeof goldenSetSchema>;

/**
 * 质量阈值（计划 §17.2）。
 * 主 Provider 固定 immutable revision 连续两轮分别达标。
 */
export const QUALITY_THRESHOLDS = {
  /** 样本运行、physical、assignment、decision coverage */
  coverageFull: 1.0,
  /** evidence allowlist / quote-hash / typed evidence */
  evidenceIntegrity: 1.0,
  /** published unsupported/contradicted claim */
  unsupportedClaims: 0,
  /** semantic support precision */
  semanticSupportPrecision: 0.95,
  /** 重要概念召回 */
  importantConceptRecall: 0.85,
  /** critical concept recall */
  criticalConceptRecall: 0.95,
  /** expected section recall */
  expectedSectionRecall: 0.90,
  /** 人工 deck accept rate */
  humanDeckAcceptRate: 0.85,
  /** title/summary accept rate */
  titleSummaryAcceptRate: 0.90,
  /** 跨卡语义重复率 */
  crossCardDuplicationRate: 0.10,
  /** hard budget 遵循率 */
  hardBudgetCompliance: 1.0,
} as const;

/**
 * Agent v1 vs v2 盲评标准。
 * Agent 综合胜率（tie=0.5）≥ 65%，95% 置信区间下界 > 50%。
 * 关键维度不得下降超过 2pp。
 */
export const BLIND_COMPARISON_THRESHOLDS = {
  agentWinRate: 0.65,
  confidenceIntervalLowerBound: 0.50,
  maxRegressionPerDimension: 0.02,
} as const;

/**
 * 性能与成本阈值（计划 §17.3）。
 */
export const PERFORMANCE_THRESHOLDS = {
  snapshotEnqueueApiP95: 1000, // ms
  stateChangeObservable: 2000, // ms
  shortNoteE2EP95Regression: 0.15, // 相对 v2 回退 ≤15%
  longNoteE2EP95Regression: 0.25, // 相对 v2 回退 ≤25%
  nonCancelRunSuccessRate: 0.98,
  retryAmplification: 1.25,
  repairTriggerRateTarget: 0.25,
  repairTriggerRateStopExpansion: 0.30,
  overContextRequests: 0,
  costIncreasePerKeyPoint: 0.35,
  validationQueueP95Regression: 0.10,
} as const;
