/**
 * AIQ-01 PR Mock Runner
 *
 * 对应 ADR-0005 第 2 条：
 * "PR 只运行 schema/parser/alignment/scorer 与固定 Mock，不访问付费网络"。
 *
 * PR 门禁验证内容：
 * 1. 数据集完整性：样本唯一、非空
 * 2. 标签完整性：每个样本有对应标签、ordinal 唯一、expectedBlockOrdinal 有效
 * 3. Mock 输出 schema 校验：Mock 输出符合 ModelCardOutput 结构
 * 4. 对齐函数校验：固定 Mock 输出经对齐后产生预期的 AlignmentResult
 * 5. 评分器校验：固定 Mock 结果 + 黄金标签产生预期的 ScorerMetrics
 * 6. metricsVerified 校验：完整覆盖时 metricsVerified 必须为 true
 *
 * PR 门禁不要求指标达标（因为使用 Mock 输出），
 * 但要求结构完整、评分器逻辑正确、标签覆盖完整。
 *
 * Mock 输出策略：
 * - 为每个样本生成与标签 ordinal 完全匹配的 Mock key point
 * - Mock quote_text 取自样本期望块的原文内容
 * - Mock alignment 固定为 "aligned"，确保评分器能正确计算
 * - 这样 Mock 运行的 metricsVerified 必须为 true
 */

import { GOLDEN_DATASET, getDatasetSample } from "./dataset.ts";
import { GOLDEN_LABELS, getGoldenLabels } from "./labels.ts";
import { validateIntegrity, validateOutputCoverage } from "./integrity.ts";
import {
  generateScorerReport,
  meetsRCThreshold,
  type SampleRunResult,
} from "./scorer.ts";
import type {
  AlignmentResult,
  ModelCardOutput,
  ModelKeyPoint,
  PRGateResult,
} from "./types.ts";

/**
 * 为指定样本生成固定 Mock 模型输出。
 *
 * Mock 输出策略：
 * - key point ordinal 与黄金标签完全匹配
 * - quote_text 取自期望块的原文内容（确保对齐能命中）
 * - claim 取自期望块的前 100 字符（模拟模型摘要）
 *
 * @param noteFile - 样本 file key
 * @returns Mock 模型输出
 */
export function generateMockOutput(noteFile: string): ModelCardOutput {
  const sample = getDatasetSample(noteFile);
  if (!sample) {
    throw new Error(`样本 ${noteFile} 不存在于数据集中`);
  }

  const label = GOLDEN_LABELS.find((l) => l.noteFile === noteFile);
  if (!label) {
    throw new Error(`样本 ${noteFile} 缺少黄金标签`);
  }

  const keyPoints: ModelKeyPoint[] = label.keyPoints.map((kp) => {
    // 取期望块的原文内容作为 quote_text
    const blockOrdinal = kp.expectedBlockOrdinal ?? 0;
    const block = sample.blocks[blockOrdinal] ?? sample.blocks[0];
    const quoteText = block ? block.content.slice(0, 200) : "";

    return {
      ordinal: kp.ordinal,
      claim: `Mock 要点 ${kp.ordinal}：${block?.content.slice(0, 80) ?? ""}`,
      quote_text: quoteText,
    };
  });

  return {
    title: sample.title,
    summary: `Mock 摘要：${sample.title}`,
    key_points: keyPoints,
  };
}

/**
 * 模拟证据对齐函数。
 *
 * 这是对 ai-worker alignQuote 的简化 Mock：
 * - 如果 quote_text 与期望块内容有重叠，返回 aligned
 * - 否则返回 unaligned
 *
 * 在 PR Mock runner 中，由于 quote_text 直接取自期望块，
 * 对齐结果必然是 aligned，确保评分器能正确计算。
 *
 * @param noteFile - 样本 file key
 * @param modelOutput - Mock 模型输出
 * @returns 对齐结果列表
 */
export function mockAlignEvidence(
  noteFile: string,
  modelOutput: ModelCardOutput,
): AlignmentResult[] {
  const sample = getDatasetSample(noteFile);
  if (!sample) {
    throw new Error(`样本 ${noteFile} 不存在于数据集中`);
  }

  return modelOutput.key_points.map((kp) => {
    // 查找 quote_text 在哪个块中出现
    let bestBlockOrdinal: number | null = null;
    let bestScore = 0;

    for (let i = 0; i < sample.blocks.length; i++) {
      const block = sample.blocks[i];
      if (block.content.includes(kp.quote_text.slice(0, 50))) {
        bestBlockOrdinal = i;
        bestScore = 100;
        break;
      }
    }

    const alignment =
      bestScore >= 85 ? "aligned" : bestScore >= 60 ? "soft" : "unaligned";

    return {
      ordinal: kp.ordinal,
      alignment,
      alignmentScore: bestScore,
      alignmentMethod: bestScore >= 85 ? "exact" : "fuzzy",
      blockOrdinal: bestBlockOrdinal,
    };
  });
}

/**
 * 运行 PR Mock 门禁。
 *
 * 这是 PR 门禁的入口函数。执行以下步骤：
 * 1. 校验数据集和标签完整性
 * 2. 为每个样本生成固定 Mock 输出
 * 3. 模拟证据对齐
 * 4. 用评分器计算指标
 * 5. 验证 metricsVerified 为 true
 * 6. 验证 Mock 输出覆盖所有标签 ordinal
 *
 * @returns PR 门禁结果
 */
export function runPRGate(): PRGateResult {
  const errors: string[] = [];

  // 1. 校验数据集和标签完整性
  const integrity = validateIntegrity();
  if (!integrity.valid) {
    errors.push(...integrity.errors);
    return {
      gate: "ai-quality-pr",
      passed: false,
      report: {
        scorerVersion: "unknown",
        datasetVersion: "unknown",
        labelVersion: "unknown",
        promptVersion: "unknown",
        timestamp: new Date().toISOString(),
        totalSamples: 0,
        totalKeyPoints: 0,
        metrics: {
          hardCitationPrecision: null,
          keyPointHardCoverage: null,
          validationExpectedPointsHardCoverage: null,
          metricsVerified: false,
        },
        hasLabels: false,
      },
      failureReason: "数据集或标签完整性校验失败",
      errors,
    };
  }

  // 2. 为每个样本生成 Mock 输出并模拟对齐
  const results: SampleRunResult[] = [];
  for (const sample of GOLDEN_DATASET) {
    try {
      const mockOutput = generateMockOutput(sample.file);
      const alignments = mockAlignEvidence(sample.file, mockOutput);

      // 3. 验证 Mock 输出覆盖所有标签 ordinal
      const label = GOLDEN_LABELS.find((l) => l.noteFile === sample.file);
      if (label) {
        const coverage = validateOutputCoverage(
          sample.file,
          mockOutput.key_points,
          label.keyPoints,
        );
        if (!coverage.covered) {
          if (coverage.missingOrdinals.length > 0) {
            errors.push(
              `样本 ${sample.file} 的 Mock 输出缺少 ordinal：${coverage.missingOrdinals.join(", ")}`,
            );
          }
          if (coverage.extraOrdinals.length > 0) {
            errors.push(
              `样本 ${sample.file} 的 Mock 输出有多余 ordinal：${coverage.extraOrdinals.join(", ")}`,
            );
          }
        }
      }

      results.push({
        noteFile: sample.file,
        keyPoints: alignments,
        error: null,
      });
    } catch (err) {
      results.push({
        noteFile: sample.file,
        keyPoints: [],
        error: err instanceof Error ? err.message : String(err),
      });
      errors.push(`样本 ${sample.file} Mock 运行失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. 用评分器计算指标
  const labels = getGoldenLabels();
  const report = generateScorerReport(results, labels);

  // 5. 验证 metricsVerified 为 true
  // PR Mock 使用固定输出，metricsVerified 必须为 true
  // 如果为 false，说明评分器逻辑或标签覆盖有问题
  if (!report.metrics.metricsVerified) {
    errors.push(
      "PR Mock 运行的 metricsVerified 为 false，但 Mock 输出应完全覆盖标签。请检查评分器逻辑或标签完整性。",
    );
  }

  // 6. 验证 Mock 指标满足 RC 阈值
  // 由于 Mock 输出直接取自期望块，对齐必然 aligned，指标应达标
  // 这验证了评分器计算逻辑的正确性
  if (report.metrics.metricsVerified && !meetsRCThreshold(report.metrics)) {
    errors.push(
      "PR Mock 运行的指标未达到 RC 阈值，但 Mock 输出应完全命中。请检查评分器计算逻辑。",
    );
  }

  const passed = errors.length === 0;

  return {
    gate: "ai-quality-pr",
    passed,
    report,
    failureReason: passed ? null : "PR Mock 门禁校验失败",
    errors,
  };
}
