/**
 * AIQ-01 纯函数评分器
 *
 * 对应 ADR-0005 第 1 条："评分器版本化并提交"。
 *
 * 设计原则：
 * - 纯函数：不依赖数据库、Provider 或任何外部状态
 * - 确定性：相同输入永远产生相同输出
 * - 版本化：评分逻辑变更时递增 SCORER_VERSION
 * - 与 benchmark service calculateMetrics 逻辑一致：
 *   但独立于数据库，可直接在 CI 中运行
 *
 * 指标定义（与 BENCHMARK_QUALITY_THRESHOLDS 一致）：
 * - hardCitationPrecision：正确对齐数 / 硬证据对齐总数（≥ 90%）
 * - keyPointHardCoverage：硬证据覆盖的 key point 数 / 总 key point 数（≥ 85%）
 * - validationExpectedPointsHardCoverage：期望位置命中数 / 期望位置总数（≥ 85%）
 *
 * 版本历史：
 * - 1.0.0：初始版本，从 benchmark service calculateMetrics 迁移
 * - 1.1.0：按黄金 ordinal 完整覆盖校验并以黄金标签作为覆盖率分母
 */

import type {
  AlignmentResult,
  GoldenLabelFile,
  ScorerMetrics,
  ScorerReport,
} from "./types.ts";
import { DATASET_VERSION } from "./dataset.ts";
import { LABEL_VERSION } from "./labels.ts";

/**
 * 评分器版本号。
 * 评分逻辑变更时必须递增此版本号，并记录决策。
 */
export const SCORER_VERSION = "1.1.0";

/**
 * Prompt 版本号。
 * 与 apps/api/src/ai/prompts/generate-card.v1.md 对应。
 */
export const PROMPT_VERSION = "generate-card.v3";

/**
 * 单篇样本的运行结果。
 * 包含模型输出和对齐结果。
 */
export interface SampleRunResult {
  /** 样本 file key */
  noteFile: string;
  /** 模型输出的 key point 对齐结果列表 */
  keyPoints: AlignmentResult[];
  /** 运行错误（如有） */
  error: string | null;
}

/**
 * 计算评分指标。
 *
 * 这是评分器的核心纯函数。逻辑与 benchmark service calculateMetrics 一致：
 * 1. 只有有人工标签时才计算指标（防止 AI 自评 100%）
 * 2. metricsVerified 要求完整数据集、零运行失败、全部 key point 均经人工标注
 * 3. hardCitationPrecision = 正确对齐数 / 硬证据对齐总数
 * 4. keyPointHardCoverage = 硬证据覆盖的 key point 数 / 总 key point 数
 * 5. validationExpectedPointsHardCoverage = 期望位置命中数 / 期望位置总数
 *
 * @param results - 所有样本的运行结果
 * @param labels - 黄金标签（可为 null，表示无人工标注）
 * @returns 评分指标
 */
export function calculateMetrics(
  results: SampleRunResult[],
  labels: GoldenLabelFile[] | null,
): ScorerMetrics {
  // F-013: 只有存在人工标签并验证完整 ordinal 覆盖时，指标才能作为
  // 发布结论；覆盖率的分母始终取黄金标签，避免模型少生成要点抬高分数。
  let keyPointHardCoverage: number | null = null;
  let validationExpectedPointsHardCoverage: number | null = null;
  let metricsVerified = false;

  let hardCitationPrecision: number | null = null;
  if (labels && labels.length > 0) {
    const resultMap = new Map<string, SampleRunResult>();
    let duplicateResultFiles = false;
    for (const result of results) {
      if (resultMap.has(result.noteFile)) duplicateResultFiles = true;
      resultMap.set(result.noteFile, result);
    }

    let exactOrdinalCoverage = !duplicateResultFiles
      && resultMap.size === labels.length
      && labels.every((label) => resultMap.has(label.noteFile));
    let totalGoldenKeyPoints = 0;
    for (const label of labels) {
      totalGoldenKeyPoints += label.keyPoints.length;
      const result = resultMap.get(label.noteFile);
      if (!result) {
        exactOrdinalCoverage = false;
        continue;
      }
      const modelOrdinals = result.keyPoints.map((kp) => kp.ordinal);
      const uniqueModelOrdinals = new Set(modelOrdinals);
      const labelOrdinals = new Set(label.keyPoints.map((kp) => kp.ordinal));
      if (
        uniqueModelOrdinals.size !== modelOrdinals.length
        || uniqueModelOrdinals.size !== labelOrdinals.size
        || [...labelOrdinals].some((ordinal) => !uniqueModelOrdinals.has(ordinal))
      ) {
        exactOrdinalCoverage = false;
      }
    }

    // 退出结论要求完整数据集、零运行失败，并且每篇输出与黄金 ordinal
    // 一一对应。只生成一个“容易命中”的 key point 不能获得 verified。
    metricsVerified =
      !results.some((result) => Boolean(result.error)) &&
      totalGoldenKeyPoints > 0 &&
      exactOrdinalCoverage;

    // 计算硬引用精确率和期望位置覆盖率
    let correctCount = 0;
    let totalHardLabeled = 0;
    let expectedCount = 0;
    let expectedHardCoveredCount = 0;
    let hardEvidenceCount = 0;
    for (const labelFile of labels) {
      const result = resultMap.get(labelFile.noteFile);
      const resultByOrdinal = new Map(
        result?.keyPoints.map((keyPoint) => [keyPoint.ordinal, keyPoint]) ?? [],
      );
      for (const label of labelFile.keyPoints) {
        const kp = resultByOrdinal.get(label.ordinal);
        if (kp?.alignment === "aligned") {
          hardEvidenceCount++;
          totalHardLabeled++;
          if (label.isCorrectlyAligned) correctCount++;
        }
        if (label.expectedBlockOrdinal !== null) {
          expectedCount++;
          if (
            kp?.alignment === "aligned" &&
            kp.blockOrdinal === label.expectedBlockOrdinal &&
            label.isCorrectlyAligned
          ) {
            expectedHardCoveredCount++;
          }
        }
      }
    }
    keyPointHardCoverage = totalGoldenKeyPoints > 0
      ? hardEvidenceCount / totalGoldenKeyPoints
      : 0;
    if (totalHardLabeled > 0) {
      hardCitationPrecision = correctCount / totalHardLabeled;
    }
    if (expectedCount > 0) {
      validationExpectedPointsHardCoverage = expectedHardCoveredCount / expectedCount;
    }
  }

  return {
    hardCitationPrecision,
    keyPointHardCoverage,
    validationExpectedPointsHardCoverage,
    metricsVerified,
  };
}

/**
 * 生成评分报告。
 *
 * 包含运行配置指纹（版本号组合）和计算出的指标。
 * 用于 PR 门禁和 RC manifest 记录。
 */
export function generateScorerReport(
  results: SampleRunResult[],
  labels: GoldenLabelFile[] | null,
): ScorerReport {
  const totalKeyPoints = results.reduce((sum, r) => sum + r.keyPoints.length, 0);
  const metrics = calculateMetrics(results, labels);

  return {
    scorerVersion: SCORER_VERSION,
    datasetVersion: DATASET_VERSION,
    labelVersion: LABEL_VERSION,
    promptVersion: PROMPT_VERSION,
    timestamp: new Date().toISOString(),
    totalSamples: results.length,
    totalKeyPoints,
    metrics,
    hasLabels: labels !== null && labels.length > 0,
  };
}

/**
 * 判断指标是否满足 RC 硬阈值。
 *
 * RC 门禁要求（ADR-0005 第 3 条）：
 * - hardCitationPrecision ≥ 90%
 * - keyPointHardCoverage ≥ 85%
 * - validationExpectedPointsHardCoverage ≥ 85%
 * - metricsVerified = true（全部 key point 均经人工标注）
 *
 * PR 门禁只要求结构完整和 metricsVerified，
 * 不要求指标达标（因为 PR 使用 Mock 输出，指标不代表真实质量）。
 */
export function meetsRCThreshold(metrics: ScorerMetrics): boolean {
  if (!metrics.metricsVerified) return false;
  if (metrics.hardCitationPrecision === null) return false;
  if (metrics.keyPointHardCoverage === null) return false;
  if (metrics.validationExpectedPointsHardCoverage === null) return false;

  return (
    metrics.hardCitationPrecision >= 0.9 &&
    metrics.keyPointHardCoverage >= 0.85 &&
    metrics.validationExpectedPointsHardCoverage >= 0.85
  );
}
