/**
 * Supervisor Agent v1 质量评估 Scorer（计划 §17.1, §17.2, §W0）
 *
 * 基于黄金集的自动化质量评估器。
 * 对一次 run 的输出进行多维度评分，并与公测质量阈值对比。
 *
 * 评分维度（计划 §17.2）：
 * 1. coverage — 样本运行、physical、assignment、decision coverage
 * 2. evidenceIntegrity — evidence allowlist / quote-hash / typed evidence
 * 3. unsupportedClaims — published unsupported/contradicted claim
 * 4. semanticSupportPrecision — 语义支撑精确率
 * 5. importantConceptRecall — 重要概念召回率
 * 6. criticalConceptRecall — 关键概念召回率
 * 7. expectedSectionRecall — 期望章节召回率
 * 8. humanDeckAcceptRate — 人工 deck 接受率
 * 9. titleSummaryAcceptRate — 标题/摘要接受率
 * 10. crossCardDuplicationRate — 跨卡语义重复率
 * 11. hardBudgetCompliance — hard budget 遵循率
 *
 * 盲评维度（计划 §17.2）：
 * - Agent v1 vs v2 综合胜率
 * - 95% 置信区间下界
 * - 关键维度不得下降超过 2pp
 */

import {
  QUALITY_THRESHOLDS,
  BLIND_COMPARISON_THRESHOLDS,
  PERFORMANCE_THRESHOLDS,
  type GoldenSet,
} from "./golden-set-schema.ts";

// ─── 类型定义 ─────────────────────────────────────────────────────────────

/** 单个样本的运行结果 */
export interface SampleRunResult {
  /** 样本 ID */
  sampleId: string;
  /** 生成的 Card Set 中的卡片列表 */
  cards: PublishedCard[];
  /** coverage 报告 */
  coverage: {
    sourcePhysical: number;
    bundleAssignment: number;
    explicitDecision: number;
    candidateSurvival: number;
    publishedConcept: number;
  };
  /** evidence 完整性 */
  evidenceIntegrity: {
    allowlistCompliant: boolean;
    quoteHashValid: boolean;
    typedEvidence: boolean;
  };
  /** unsupported/contradicted claim 数量 */
  unsupportedClaimCount: number;
  /** 语义支撑详情 */
  semanticSupport: {
    total: number;
    supported: number;
    partial: number;
    unsupported: number;
    contradicted: number;
  };
  /** 概念召回 */
  conceptRecall: {
    importantHits: number;
    importantTotal: number;
    criticalHits: number;
    criticalTotal: number;
  };
  /** 章节召回 */
  sectionRecall: {
    hits: number;
    total: number;
  };
  /** 预算遵循 */
  budgetCompliance: {
    turnBudgetExceeded: boolean;
    tokenBudgetExceeded: boolean;
    toolCallBudgetExceeded: boolean;
    costCapExceeded: boolean;
  };
  /** 跨卡重复 */
  crossCardDuplicates: number;
  /** 人工评估（可选，盲评时填充） */
  humanEvaluation?: {
    deckAccepted: boolean;
    titleSummaryAccepted: boolean;
  };
}

/** 发布的卡片 */
export interface PublishedCard {
  cardId: string;
  title: string;
  summary: string;
  sectionKey: string;
  candidateIds: string[];
  evidenceRefIds: string[];
}

/** 单维度评分结果 */
export interface DimensionScore {
  /** 维度名称 */
  name: string;
  /** 实际值 */
  value: number;
  /** 阈值 */
  threshold: number;
  /** 是否通过 */
  passed: boolean;
  /** 描述 */
  description: string;
}

/** 样本评分结果 */
export interface SampleScore {
  sampleId: string;
  dimensions: DimensionScore[];
  allPassed: boolean;
}

/** 整体评分结果 */
export interface ScorerResult {
  /** 每个样本的评分 */
  samples: SampleScore[];
  /** 聚合指标 */
  aggregate: {
    /** 通过率 */
    passRate: number;
    /** 平均 coverage */
    avgCoverage: number;
    /** 平均概念召回 */
    avgImportantConceptRecall: number;
    /** 平均 critical 概念召回 */
    avgCriticalConceptRecall: number;
    /** 平均跨卡重复率 */
    avgCrossCardDuplication: number;
    /** 总 unsupported claim 数 */
    totalUnsupportedClaims: number;
    /** 人工 deck 接受率 */
    humanDeckAcceptRate: number;
    /** 人工标题/摘要接受率 */
    humanTitleSummaryAcceptRate: number;
  };
  /** 是否达到公测质量阈值 */
  meetsPublicBetaThreshold: boolean;
  /** 未通过的维度 */
  failedDimensions: string[];
}

// ─── Scorer 实现 ─────────────────────────────────────────────────────────

/**
 * 黄金集质量评估器。
 *
 * 对一组样本运行结果进行评分，输出维度级别的通过/失败和聚合指标。
 */
export class GoldenSetScorer {
  private readonly goldenSet: GoldenSet;

  constructor(goldenSet: GoldenSet) {
    this.goldenSet = goldenSet;
  }

  /**
   * 评估所有样本运行结果。
   */
  score(results: SampleRunResult[]): ScorerResult {
    // 建立 sampleId → GoldenSample 的一次性索引，避免每个 result 都线性扫描
    // goldenSet（O(R×G)），改为 O(R) 哈希查找。
    const goldenById = new Map<string, GoldenSet[number]>();
    for (const sample of this.goldenSet) {
      goldenById.set(sample.sampleId, sample);
    }
    const sampleScores = results.map((result) => this.scoreSample(result, goldenById));

    const aggregate = this.computeAggregate(sampleScores, results);
  const failedDimensions = this.collectFailedDimensions(sampleScores);

  // R46 修复：聚合维度检查（humanDeckAcceptRate 和 titleSummaryAcceptRate）。
  // 这两个维度在逐样本检查中已被移除（因为是聚合阈值），需要在这里检查聚合值。
  const aggregateFailedDimensions: string[] = [];
  if (aggregate.humanDeckAcceptRate < QUALITY_THRESHOLDS.humanDeckAcceptRate) {
    aggregateFailedDimensions.push("humanDeckAcceptRate");
  }
  if (aggregate.humanTitleSummaryAcceptRate < QUALITY_THRESHOLDS.titleSummaryAcceptRate) {
    aggregateFailedDimensions.push("titleSummaryAcceptRate");
  }

  const allFailedDimensions = [...failedDimensions, ...aggregateFailedDimensions];

  return {
    samples: sampleScores,
    aggregate,
    meetsPublicBetaThreshold: allFailedDimensions.length === 0,
    failedDimensions: allFailedDimensions,
  };
}

  /**
   * 评估单个样本。
   */
  private scoreSample(
    result: SampleRunResult,
    goldenById: ReadonlyMap<string, GoldenSet[number]>,
  ): SampleScore {
    const sample = goldenById.get(result.sampleId);
    if (!sample) {
      throw new Error(`样本 ${result.sampleId} 不在黄金集中`);
    }

    const dimensions: DimensionScore[] = [];

    // 1. coverage
    const minCoverage = Math.min(
      result.coverage.sourcePhysical,
      result.coverage.bundleAssignment,
      result.coverage.explicitDecision,
    );
    dimensions.push({
      name: "coverage",
      value: minCoverage,
      threshold: QUALITY_THRESHOLDS.coverageFull,
      passed: minCoverage >= QUALITY_THRESHOLDS.coverageFull,
      description: "样本运行、physical、assignment、decision coverage",
    });

    // 2. evidenceIntegrity
    const evidenceOk =
      result.evidenceIntegrity.allowlistCompliant &&
      result.evidenceIntegrity.quoteHashValid &&
      result.evidenceIntegrity.typedEvidence;
    dimensions.push({
      name: "evidenceIntegrity",
      value: evidenceOk ? 1.0 : 0.0,
      threshold: QUALITY_THRESHOLDS.evidenceIntegrity,
      passed: evidenceOk,
      description: "evidence allowlist / quote-hash / typed evidence",
    });

    // 3. unsupportedClaims
    dimensions.push({
      name: "unsupportedClaims",
      value: result.unsupportedClaimCount,
      threshold: QUALITY_THRESHOLDS.unsupportedClaims,
      passed: result.unsupportedClaimCount <= QUALITY_THRESHOLDS.unsupportedClaims,
      description: "published unsupported/contradicted claim",
    });

    // 4. semanticSupportPrecision
    // P1-14 修复：零 claims 时 precision = 0（不是 1），
    // partial 不计入 correct（只有 supported 才算正确）。
    const totalClaims = result.semanticSupport.total;
    const correctClaims = result.semanticSupport.supported;
    const precision = totalClaims > 0 ? correctClaims / totalClaims : 0.0;
    dimensions.push({
      name: "semanticSupportPrecision",
      value: precision,
      threshold: QUALITY_THRESHOLDS.semanticSupportPrecision,
      passed: precision >= QUALITY_THRESHOLDS.semanticSupportPrecision,
      description: "语义支撑精确率",
    });

    // 5. importantConceptRecall
    const importantRecall =
      result.conceptRecall.importantTotal > 0
        ? result.conceptRecall.importantHits / result.conceptRecall.importantTotal
        : 1.0;
    dimensions.push({
      name: "importantConceptRecall",
      value: importantRecall,
      threshold: QUALITY_THRESHOLDS.importantConceptRecall,
      passed: importantRecall >= QUALITY_THRESHOLDS.importantConceptRecall,
      description: "重要概念召回率",
    });

    // 6. criticalConceptRecall
    const criticalRecall =
      result.conceptRecall.criticalTotal > 0
        ? result.conceptRecall.criticalHits / result.conceptRecall.criticalTotal
        : 1.0;
    dimensions.push({
      name: "criticalConceptRecall",
      value: criticalRecall,
      threshold: QUALITY_THRESHOLDS.criticalConceptRecall,
      passed: criticalRecall >= QUALITY_THRESHOLDS.criticalConceptRecall,
      description: "critical concept recall",
    });

    // 7. expectedSectionRecall
    const sectionRecall =
      result.sectionRecall.total > 0
        ? result.sectionRecall.hits / result.sectionRecall.total
        : 1.0;
    dimensions.push({
      name: "expectedSectionRecall",
      value: sectionRecall,
      threshold: QUALITY_THRESHOLDS.expectedSectionRecall,
      passed: sectionRecall >= QUALITY_THRESHOLDS.expectedSectionRecall,
      description: "expected section recall",
    });

    // 8. crossCardDuplicationRate
    const totalCards = result.cards.length;
    const duplicationRate = totalCards > 0 ? result.crossCardDuplicates / totalCards : 0;
    dimensions.push({
      name: "crossCardDuplicationRate",
      value: duplicationRate,
      threshold: QUALITY_THRESHOLDS.crossCardDuplicationRate,
      passed: duplicationRate <= QUALITY_THRESHOLDS.crossCardDuplicationRate,
      description: "跨卡语义重复率",
    });

    // 9. hardBudgetCompliance
    const budgetOk =
      !result.budgetCompliance.turnBudgetExceeded &&
      !result.budgetCompliance.tokenBudgetExceeded &&
      !result.budgetCompliance.toolCallBudgetExceeded &&
      !result.budgetCompliance.costCapExceeded;
    dimensions.push({
      name: "hardBudgetCompliance",
      value: budgetOk ? 1.0 : 0.0,
      threshold: QUALITY_THRESHOLDS.hardBudgetCompliance,
      passed: budgetOk,
      description: "hard budget 遵循率",
    });

    // R46 修复：humanDeckAcceptRate 和 titleSummaryAcceptRate 是聚合阈值（85%, 90%），
    // 不应逐样本检查。逐样本检查会将单个样本的 boolean (true/false) 与阈值 (0.85/0.90) 比较，
    // 导致即使聚合率达标（如 91.6% > 90%），但有样本未通过时 still 导致整体失败。
    // 移除逐样本检查，聚合检查在 score() 方法的 meetsPublicBetaThreshold 中进行。

    const allPassed = dimensions.every((d) => d.passed);

    return {
      sampleId: result.sampleId,
      dimensions,
      allPassed,
    };
  }

  /**
   * 计算聚合指标。
   */
  private computeAggregate(
    sampleScores: SampleScore[],
    results: SampleRunResult[],
  ): ScorerResult["aggregate"] {
    const total = results.length;
    if (total === 0) {
      return {
        passRate: 0,
        avgCoverage: 0,
        avgImportantConceptRecall: 0,
        avgCriticalConceptRecall: 0,
        avgCrossCardDuplication: 0,
        totalUnsupportedClaims: 0,
        humanDeckAcceptRate: 0,
        humanTitleSummaryAcceptRate: 0,
      };
    }

    const passedCount = sampleScores.filter((s) => s.allPassed).length;
    const totalUnsupported = results.reduce((sum, r) => sum + r.unsupportedClaimCount, 0);

    const avgCoverage =
      results.reduce((sum, r) => {
        return sum + Math.min(r.coverage.sourcePhysical, r.coverage.bundleAssignment, r.coverage.explicitDecision);
      }, 0) / total;

    const avgImportantRecall =
      results.reduce((sum, r) => {
        return sum + (r.conceptRecall.importantTotal > 0
          ? r.conceptRecall.importantHits / r.conceptRecall.importantTotal
          : 1.0);
      }, 0) / total;

    const avgCriticalRecall =
      results.reduce((sum, r) => {
        return sum + (r.conceptRecall.criticalTotal > 0
          ? r.conceptRecall.criticalHits / r.conceptRecall.criticalTotal
          : 1.0);
      }, 0) / total;

    const avgDuplication =
      results.reduce((sum, r) => {
        const cards = r.cards.length;
        return sum + (cards > 0 ? r.crossCardDuplicates / cards : 0);
      }, 0) / total;

    const humanEvalResults = results.filter((r) => r.humanEvaluation);
    const humanDeckAccept = humanEvalResults.length > 0
      ? humanEvalResults.filter((r) => r.humanEvaluation!.deckAccepted).length / humanEvalResults.length
      : 0;
    const humanTitleAccept = humanEvalResults.length > 0
      ? humanEvalResults.filter((r) => r.humanEvaluation!.titleSummaryAccepted).length / humanEvalResults.length
      : 0;

    return {
      passRate: passedCount / total,
      avgCoverage,
      avgImportantConceptRecall: avgImportantRecall,
      avgCriticalConceptRecall: avgCriticalRecall,
      avgCrossCardDuplication: avgDuplication,
      totalUnsupportedClaims: totalUnsupported,
      humanDeckAcceptRate: humanDeckAccept,
      humanTitleSummaryAcceptRate: humanTitleAccept,
    };
  }

  /**
   * 收集所有未通过的维度名称。
   */
  private collectFailedDimensions(sampleScores: SampleScore[]): string[] {
    const failed = new Set<string>();
    for (const sample of sampleScores) {
      for (const dim of sample.dimensions) {
        if (!dim.passed) {
          failed.add(dim.name);
        }
      }
    }
    return [...failed];
  }
}

// ─── 盲评比较器 ──────────────────────────────────────────────────────────

/** 盲评对比结果 */
export interface BlindComparisonResult {
  /** Agent v1 胜数 */
  agentWins: number;
  /** v2 胜数 */
  v2Wins: number;
  /** 平局数 */
  ties: number;
  /** 总样本数 */
  total: number;
  /** Agent 综合胜率（tie=0.5） */
  agentWinRate: number;
  /** 是否达到阈值 */
  meetsThreshold: boolean;
  /** 95% 置信区间下界（Wilson interval） */
  confidenceIntervalLowerBound: number;
  /** 关键维度回退情况 */
  dimensionRegressions: Array<{
    dimension: string;
    regression: number;
    exceedsLimit: boolean;
  }>;
}

/**
 * 执行 Agent v1 vs v2 盲评比较。
 *
 * 计划 §17.2:
 * - Agent 综合胜率（tie=0.5）≥ 65%
 * - 95% 置信区间下界 > 50%
 * - 关键维度不得下降超过 2pp
 */
export function compareBlind(
  _agentResults: ScorerResult,
  _v2Results: ScorerResult,
  pairwiseVerdicts: Array<{
    sampleId: string;
    winner: "agent" | "v2" | "tie";
    dimensionDeltas: Array<{ dimension: string; delta: number }>;
  }>,
): BlindComparisonResult {
  const total = pairwiseVerdicts.length;
  const agentWins = pairwiseVerdicts.filter((v) => v.winner === "agent").length;
  const v2Wins = pairwiseVerdicts.filter((v) => v.winner === "v2").length;
  const ties = pairwiseVerdicts.filter((v) => v.winner === "tie").length;

  const winRate = total > 0 ? (agentWins + 0.5 * ties) / total : 0;

  // Wilson 95% 置信区间下界
  const z = 1.96;
  const p = winRate;
  const n = total;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  const ciLower = center - margin;

  // 关键维度回退：先按维度聚合所有 delta，一次遍历即可，避免每个关键维度
  // 都 flatMap+filter 全量 verdicts（O(keyDimensions × verdicts × deltas)）。
  const keyDimensions = [
    "coverage",
    "evidenceIntegrity",
    "semanticSupportPrecision",
    "importantConceptRecall",
    "criticalConceptRecall",
  ];
  const deltasByDimension = new Map<string, number[]>();
  for (const verdict of pairwiseVerdicts) {
    for (const delta of verdict.dimensionDeltas) {
      const list = deltasByDimension.get(delta.dimension);
      if (list) {
        list.push(delta.delta);
      } else {
        deltasByDimension.set(delta.dimension, [delta.delta]);
      }
    }
  }

  const dimensionRegressions = keyDimensions.map((dim) => {
    const deltas = deltasByDimension.get(dim) ?? [];
    const avgDelta = deltas.length > 0
      ? deltas.reduce((sum, d) => sum + d, 0) / deltas.length
      : 0;
    return {
      dimension: dim,
      regression: avgDelta,
      exceedsLimit: avgDelta < -BLIND_COMPARISON_THRESHOLDS.maxRegressionPerDimension,
    };
  });

  const meetsThreshold =
    winRate >= BLIND_COMPARISON_THRESHOLDS.agentWinRate &&
    ciLower > BLIND_COMPARISON_THRESHOLDS.confidenceIntervalLowerBound &&
    !dimensionRegressions.some((d) => d.exceedsLimit);

  return {
    agentWins,
    v2Wins,
    ties,
    total,
    agentWinRate: winRate,
    meetsThreshold,
    confidenceIntervalLowerBound: ciLower,
    dimensionRegressions,
  };
}

/**
 * 检查性能阈值（计划 §17.3）。
 */
export function checkPerformanceThresholds(metrics: {
  snapshotEnqueueApiP95: number;
  stateChangeObservable: number;
  shortNoteE2EP95Regression: number;
  longNoteE2EP95Regression: number;
  nonCancelRunSuccessRate: number;
  retryAmplification: number;
  repairTriggerRate: number;
  overContextRequests: number;
  costIncreasePerKeyPoint: number;
  validationQueueP95Regression: number;
}): Array<{ name: string; value: number; threshold: number; passed: boolean }> {
  const checks: Array<{ name: string; value: number; threshold: number; passed: boolean }> = [
    {
      name: "snapshotEnqueueApiP95",
      value: metrics.snapshotEnqueueApiP95,
      threshold: PERFORMANCE_THRESHOLDS.snapshotEnqueueApiP95,
      passed: metrics.snapshotEnqueueApiP95 <= PERFORMANCE_THRESHOLDS.snapshotEnqueueApiP95,
    },
    {
      name: "stateChangeObservable",
      value: metrics.stateChangeObservable,
      threshold: PERFORMANCE_THRESHOLDS.stateChangeObservable,
      passed: metrics.stateChangeObservable <= PERFORMANCE_THRESHOLDS.stateChangeObservable,
    },
    {
      name: "shortNoteE2EP95Regression",
      value: metrics.shortNoteE2EP95Regression,
      threshold: PERFORMANCE_THRESHOLDS.shortNoteE2EP95Regression,
      passed: metrics.shortNoteE2EP95Regression <= PERFORMANCE_THRESHOLDS.shortNoteE2EP95Regression,
    },
    {
      name: "longNoteE2EP95Regression",
      value: metrics.longNoteE2EP95Regression,
      threshold: PERFORMANCE_THRESHOLDS.longNoteE2EP95Regression,
      passed: metrics.longNoteE2EP95Regression <= PERFORMANCE_THRESHOLDS.longNoteE2EP95Regression,
    },
    {
      name: "nonCancelRunSuccessRate",
      value: metrics.nonCancelRunSuccessRate,
      threshold: PERFORMANCE_THRESHOLDS.nonCancelRunSuccessRate,
      passed: metrics.nonCancelRunSuccessRate >= PERFORMANCE_THRESHOLDS.nonCancelRunSuccessRate,
    },
    {
      name: "retryAmplification",
      value: metrics.retryAmplification,
      threshold: PERFORMANCE_THRESHOLDS.retryAmplification,
      passed: metrics.retryAmplification <= PERFORMANCE_THRESHOLDS.retryAmplification,
    },
    {
      name: "repairTriggerRate",
      value: metrics.repairTriggerRate,
      // R45 修复：原代码 threshold 使用 repairTriggerRateTarget (0.25)，
      // 但 passed 检查使用 repairTriggerRateStopExpansion (0.30)。
      // 这导致 threshold 显示与实际检查不一致：value=0.28 时看起来应失败 (0.28 > 0.25)，
      // 但实际 passed=true (0.28 <= 0.30)。
      // 计划 §17.3："Repair 触发率目标 ≤25%，>30% 停止扩量"。
      // stopExpansion 是硬门禁，应同时用于 threshold 和 passed。
      threshold: PERFORMANCE_THRESHOLDS.repairTriggerRateStopExpansion,
      passed: metrics.repairTriggerRate <= PERFORMANCE_THRESHOLDS.repairTriggerRateStopExpansion,
    },
    {
      name: "overContextRequests",
      value: metrics.overContextRequests,
      threshold: PERFORMANCE_THRESHOLDS.overContextRequests,
      passed: metrics.overContextRequests === PERFORMANCE_THRESHOLDS.overContextRequests,
    },
    {
      name: "costIncreasePerKeyPoint",
      value: metrics.costIncreasePerKeyPoint,
      threshold: PERFORMANCE_THRESHOLDS.costIncreasePerKeyPoint,
      passed: metrics.costIncreasePerKeyPoint <= PERFORMANCE_THRESHOLDS.costIncreasePerKeyPoint,
    },
    {
      name: "validationQueueP95Regression",
      value: metrics.validationQueueP95Regression,
      threshold: PERFORMANCE_THRESHOLDS.validationQueueP95Regression,
      passed: metrics.validationQueueP95Regression <= PERFORMANCE_THRESHOLDS.validationQueueP95Regression,
    },
  ];

  return checks;
}
