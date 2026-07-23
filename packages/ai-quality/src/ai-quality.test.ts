/**
 * AIQ-01 评分器与完整性校验单元测试
 *
 * 验证内容：
 * 1. 数据集和标签完整性校验通过
 * 2. PR Mock runner 生成正确的 Mock 输出
 * 3. 评分器计算逻辑正确
 * 4. metricsVerified 在完整覆盖时为 true
 * 5. meetsRCThreshold 正确判断阈值
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GOLDEN_DATASET,
  DATASET_VERSION,
  getDatasetSample,
  getDatasetFileKeys,
} from "./dataset.ts";
import {
  GOLDEN_LABELS,
  LABEL_VERSION,
  getGoldenLabels,
} from "./labels.ts";
import { validateIntegrity, validateOutputCoverage } from "./integrity.ts";
import {
  SCORER_VERSION,
  PROMPT_VERSION,
  calculateMetrics,
  generateScorerReport,
  meetsRCThreshold,
  type SampleRunResult,
} from "./scorer.ts";
import {
  runPRGate,
  generateMockOutput,
  mockAlignEvidence,
} from "./pr-runner.ts";

describe("AIQ-01 数据集", () => {
  it("数据集包含 30 篇样本", () => {
    assert.equal(GOLDEN_DATASET.length, 30);
  });

  it("数据集版本号非空", () => {
    assert.ok(DATASET_VERSION.length > 0);
  });

  it("每个样本有唯一 file key", () => {
    const files = getDatasetFileKeys();
    const unique = new Set(files);
    assert.equal(files.length, unique.size);
  });

  it("每个样本有标题和至少一个块", () => {
    for (const sample of GOLDEN_DATASET) {
      assert.ok(sample.title.length > 0, `样本 ${sample.file} 标题为空`);
      assert.ok(sample.blocks.length > 0, `样本 ${sample.file} 块为空`);
    }
  });

  it("getDatasetSample 返回正确样本", () => {
    const sample = getDatasetSample("note-01-distributed-system-cap");
    assert.ok(sample);
    assert.equal(sample?.title, "分布式系统中的 CAP 定理");
  });
});

describe("AIQ-01 黄金标签", () => {
  it("标签版本号非空", () => {
    assert.ok(LABEL_VERSION.length > 0);
  });

  it("每个数据集样本有对应标签", () => {
    for (const sample of GOLDEN_DATASET) {
      const label = GOLDEN_LABELS.find((l) => l.noteFile === sample.file);
      assert.ok(label, `样本 ${sample.file} 缺少标签`);
    }
  });

  it("标签 ordinal 在同一文件内唯一", () => {
    for (const label of GOLDEN_LABELS) {
      const ordinals = label.keyPoints.map((kp) => kp.ordinal);
      const unique = new Set(ordinals);
      assert.equal(
        ordinals.length,
        unique.size,
        `标签 ${label.noteFile} 有重复 ordinal`,
      );
    }
  });

  it("expectedBlockOrdinal 在样本块范围内", () => {
    for (const label of GOLDEN_LABELS) {
      const sample = getDatasetSample(label.noteFile);
      assert.ok(sample, `标签 ${label.noteFile} 引用不存在的样本`);
      for (const kp of label.keyPoints) {
        if (kp.expectedBlockOrdinal !== null) {
          assert.ok(
            kp.expectedBlockOrdinal >= 0 && kp.expectedBlockOrdinal < sample.blocks.length,
            `标签 ${label.noteFile} ordinal ${kp.ordinal} 的 expectedBlockOrdinal 超出范围`,
          );
        }
      }
    }
  });
});

describe("AIQ-01 完整性校验", () => {
  it("validateIntegrity 通过", () => {
    const result = validateIntegrity();
    assert.ok(result.valid, `完整性校验失败：\n${result.errors.join("\n")}`);
    assert.equal(result.datasetSampleCount, 30);
    assert.equal(result.labelFileCount, 30);
    assert.ok(result.totalLabels > 0);
  });

  it("validateOutputCoverage 检测缺失 ordinal", () => {
    const coverage = validateOutputCoverage(
      "test",
      [{ ordinal: 0 }, { ordinal: 1 }],
      [{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }],
    );
    assert.equal(coverage.covered, false);
    assert.deepEqual(coverage.missingOrdinals, [2]);
  });

  it("validateOutputCoverage 检测多余 ordinal", () => {
    const coverage = validateOutputCoverage(
      "test",
      [{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }],
      [{ ordinal: 0 }, { ordinal: 1 }],
    );
    assert.equal(coverage.covered, false);
    assert.deepEqual(coverage.extraOrdinals, [2]);
  });

  it("validateOutputCoverage 完全覆盖时返回 true", () => {
    const coverage = validateOutputCoverage(
      "test",
      [{ ordinal: 0 }, { ordinal: 1 }],
      [{ ordinal: 0 }, { ordinal: 1 }],
    );
    assert.equal(coverage.covered, true);
  });
});

describe("AIQ-01 评分器", () => {
  it("评分器版本号非空", () => {
    assert.ok(SCORER_VERSION.length > 0);
  });

  it("prompt 版本号非空", () => {
    assert.ok(PROMPT_VERSION.length > 0);
  });

  it("无标签时 metrics 为 null 且 metricsVerified 为 false", () => {
    const results: SampleRunResult[] = [
      {
        noteFile: "note-01-distributed-system-cap",
        keyPoints: [
          { ordinal: 0, alignment: "aligned", alignmentScore: 100, alignmentMethod: "exact", blockOrdinal: 1 },
        ],
        error: null,
      },
    ];
    const metrics = calculateMetrics(results, null);
    assert.equal(metrics.hardCitationPrecision, null);
    assert.equal(metrics.keyPointHardCoverage, null);
    assert.equal(metrics.validationExpectedPointsHardCoverage, null);
    assert.equal(metrics.metricsVerified, false);
  });

  it("有运行错误时 metricsVerified 为 false", () => {
    const results: SampleRunResult[] = [
      {
        noteFile: "note-01-distributed-system-cap",
        keyPoints: [],
        error: "模拟错误",
      },
    ];
    const labels = getGoldenLabels();
    const metrics = calculateMetrics(results, labels);
    assert.equal(metrics.metricsVerified, false);
  });

  it("缺少黄金 ordinal 时保持未验证且覆盖率使用黄金标签作分母", () => {
    const results: SampleRunResult[] = GOLDEN_LABELS.map((label) => ({
      noteFile: label.noteFile,
      keyPoints: label.keyPoints.slice(0, 1).map((kp) => ({
        ordinal: kp.ordinal,
        alignment: "aligned",
        alignmentScore: 100,
        alignmentMethod: "exact",
        blockOrdinal: kp.expectedBlockOrdinal,
      })),
      error: null,
    }));

    const metrics = calculateMetrics(results, getGoldenLabels());

    assert.equal(metrics.metricsVerified, false);
    assert.ok(metrics.keyPointHardCoverage !== null);
    assert.equal(
      metrics.keyPointHardCoverage,
      GOLDEN_LABELS.length / GOLDEN_LABELS.reduce((sum, label) => sum + label.keyPoints.length, 0),
    );
    assert.equal(meetsRCThreshold(metrics), false);
  });

  it("重复 ordinal 或重复样本不能伪装成完整覆盖", () => {
    const results: SampleRunResult[] = GOLDEN_LABELS.map((label) => ({
      noteFile: label.noteFile,
      keyPoints: label.keyPoints.map((kp) => ({
        ordinal: kp.ordinal,
        alignment: "aligned",
        alignmentScore: 100,
        alignmentMethod: "exact",
        blockOrdinal: kp.expectedBlockOrdinal,
      })),
      error: null,
    }));
    results[0]!.keyPoints[1]!.ordinal = results[0]!.keyPoints[0]!.ordinal;
    assert.equal(calculateMetrics(results, getGoldenLabels()).metricsVerified, false);

    results[0]!.keyPoints = GOLDEN_LABELS[0]!.keyPoints.map((kp) => ({
      ordinal: kp.ordinal,
      alignment: "aligned",
      alignmentScore: 100,
      alignmentMethod: "exact",
      blockOrdinal: kp.expectedBlockOrdinal,
    }));
    results.push(results[0]!);
    assert.equal(calculateMetrics(results, getGoldenLabels()).metricsVerified, false);
  });

  it("完整覆盖且全部 aligned 时 metricsVerified 为 true 且指标达标", () => {
    // 为每个样本生成全部 aligned 的对齐结果
    const results: SampleRunResult[] = GOLDEN_DATASET.map((sample) => {
      const label = GOLDEN_LABELS.find((l) => l.noteFile === sample.file);
      const keyPoints = label
        ? label.keyPoints.map((kp) => ({
            ordinal: kp.ordinal,
            alignment: "aligned" as const,
            alignmentScore: 100,
            alignmentMethod: "exact",
            blockOrdinal: kp.expectedBlockOrdinal,
          }))
        : [];
      return { noteFile: sample.file, keyPoints, error: null };
    });

    const labels = getGoldenLabels();
    const metrics = calculateMetrics(results, labels);

    assert.equal(metrics.metricsVerified, true);
    assert.ok(metrics.hardCitationPrecision !== null);
    assert.ok(metrics.hardCitationPrecision >= 0.9);
    assert.ok(metrics.keyPointHardCoverage !== null);
    assert.ok(metrics.keyPointHardCoverage >= 0.85);
    assert.ok(metrics.validationExpectedPointsHardCoverage !== null);
    assert.ok(metrics.validationExpectedPointsHardCoverage >= 0.85);
  });

  it("meetsRCThreshold 在指标达标时返回 true", () => {
    const metrics = {
      hardCitationPrecision: 0.95,
      keyPointHardCoverage: 0.9,
      validationExpectedPointsHardCoverage: 0.88,
      metricsVerified: true,
    };
    assert.equal(meetsRCThreshold(metrics), true);
  });

  it("meetsRCThreshold 在指标不达标时返回 false", () => {
    const metrics = {
      hardCitationPrecision: 0.8,
      keyPointHardCoverage: 0.9,
      validationExpectedPointsHardCoverage: 0.88,
      metricsVerified: true,
    };
    assert.equal(meetsRCThreshold(metrics), false);
  });

  it("meetsRCThreshold 在 metricsVerified 为 false 时返回 false", () => {
    const metrics = {
      hardCitationPrecision: 0.95,
      keyPointHardCoverage: 0.9,
      validationExpectedPointsHardCoverage: 0.88,
      metricsVerified: false,
    };
    assert.equal(meetsRCThreshold(metrics), false);
  });

  it("generateScorerReport 包含正确的版本号", () => {
    const results: SampleRunResult[] = [];
    const report = generateScorerReport(results, null);
    assert.equal(report.scorerVersion, SCORER_VERSION);
    assert.equal(report.datasetVersion, DATASET_VERSION);
    assert.equal(report.labelVersion, LABEL_VERSION);
    assert.equal(report.promptVersion, PROMPT_VERSION);
  });
});

describe("AIQ-01 PR Mock Runner", () => {
  it("generateMockOutput 为每个样本生成与标签匹配的 key point", () => {
    for (const sample of GOLDEN_DATASET) {
      const output = generateMockOutput(sample.file);
      const label = GOLDEN_LABELS.find((l) => l.noteFile === sample.file);
      assert.ok(label);
      assert.equal(output.key_points.length, label.keyPoints.length);
      for (const kp of output.key_points) {
        const labelKp = label.keyPoints.find((lkp) => lkp.ordinal === kp.ordinal);
        assert.ok(labelKp, `样本 ${sample.file} 的 Mock ordinal ${kp.ordinal} 不在标签中`);
      }
    }
  });

  it("mockAlignEvidence 对 Mock 输出返回 aligned", () => {
    for (const sample of GOLDEN_DATASET) {
      const output = generateMockOutput(sample.file);
      const alignments = mockAlignEvidence(sample.file, output);
      for (const align of alignments) {
        assert.equal(align.alignment, "aligned", `样本 ${sample.file} ordinal ${align.ordinal} 应为 aligned`);
        assert.ok(align.blockOrdinal !== null, `样本 ${sample.file} ordinal ${align.ordinal} blockOrdinal 不应为 null`);
      }
    }
  });

  it("runPRGate 通过", () => {
    const result = runPRGate();
    assert.ok(result.passed, `PR Mock 门禁失败：\n${result.errors.join("\n")}`);
    assert.equal(result.gate, "ai-quality-pr");
    assert.ok(result.report.metrics.metricsVerified);
  });

  it("runPRGate 报告包含正确的版本号", () => {
    const result = runPRGate();
    assert.equal(result.report.scorerVersion, SCORER_VERSION);
    assert.equal(result.report.datasetVersion, DATASET_VERSION);
    assert.equal(result.report.labelVersion, LABEL_VERSION);
    assert.equal(result.report.promptVersion, PROMPT_VERSION);
  });

  it("runPRGate 总样本数为 30", () => {
    const result = runPRGate();
    assert.equal(result.report.totalSamples, 30);
  });
});
