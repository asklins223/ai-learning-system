/**
 * v0.6 AI Quality 黄金集单元测试 (计划 §4.2)
 *
 * 验证内容：
 * 1. Question/Rubric Gold 数据集完整性和规模
 * 2. Evaluation Gold 数据集完整性和类别覆盖
 * 3. Card Repair Gold 数据集完整性和触发分布
 * 4. 评分器逻辑正确性
 * 5. 阈值门禁验证
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUESTION_RUBRIC_GOLD,
  QUESTION_RUBRIC_GOLD_VERSION,
  QUESTION_RUBRIC_GOLD_MINIMUM_SIZE,
  getQuestionRubricGoldStats,
  EVALUATION_GOLD,
  EVALUATION_GOLD_VERSION,
  EVALUATION_GOLD_MINIMUM_SIZE,
  getEvaluationGoldStats,
  CARD_REPAIR_GOLD,
  CARD_REPAIR_GOLD_VERSION,
  CARD_REPAIR_GOLD_MINIMUM_SIZE,
  getCardRepairGoldStats,
  QUESTION_RUBRIC_THRESHOLDS,
  EVALUATION_THRESHOLDS,
  CARD_REPAIR_THRESHOLDS,
  scoreQuestionRubric,
  scoreEvaluation,
  scoreCardRepair,
  generateV06ScorerReport,
  V06_SCORER_VERSION,
} from "./index.ts";
import type {
  QuestionRubricPrediction,
  EvaluationPrediction,
  CardRepairPrediction,
} from "./types.ts";

const perfectQuestionPredictions: QuestionRubricPrediction[] =
  QUESTION_RUBRIC_GOLD.map((sample) => ({
    sampleId: sample.id,
    schemaRefIntegrityPassed: true,
    leakageReason: null,
    rubricEvidenceRefIds: sample.expectedRubricItems.map((item) => item.evidenceRefId),
    humanAccepted: sample.humanAccepted,
  }));

const perfectEvaluationPredictions: EvaluationPrediction[] =
  EVALUATION_GOLD.map((sample) => ({
    sampleId: sample.id,
    outcome: sample.trueOutcome,
  }));

const perfectCardRepairPredictions: CardRepairPrediction[] =
  CARD_REPAIR_GOLD.map((sample) => ({
    sampleId: sample.id,
    repairTriggered: sample.shouldTriggerRepair,
    secondCallMade: sample.shouldTriggerRepair,
    hardGatePassed: true,
    baselineMetrics: {
      hardCitationPrecision: Math.min(
        sample.expectedPostRepairHardGate.hardCitationPrecision,
        0.90,
      ),
      keyPointHardCoverage: Math.min(
        sample.expectedPostRepairHardGate.keyPointHardCoverage,
        0.85,
      ),
      validationExpectedPointsHardCoverage: Math.min(
        sample.expectedPostRepairHardGate.validationExpectedPointsHardCoverage,
        0.85,
      ),
    },
    postRepairMetrics: {
      hardCitationPrecision: Math.max(
        sample.expectedPostRepairHardGate.hardCitationPrecision,
        0.95,
      ),
      keyPointHardCoverage: Math.max(
        sample.expectedPostRepairHardGate.keyPointHardCoverage,
        0.90,
      ),
      validationExpectedPointsHardCoverage: Math.max(
        sample.expectedPostRepairHardGate.validationExpectedPointsHardCoverage,
        0.90,
      ),
    },
  }));

// ─── Question/Rubric Gold ───────────────────────────────────────────────

describe("Question/Rubric Gold v1", () => {
  it("数据集版本号非空", () => {
    assert.ok(QUESTION_RUBRIC_GOLD_VERSION.length > 0);
  });

  it("数据集达到最小规模 ≥ 60", () => {
    const stats = getQuestionRubricGoldStats();
    assert.ok(
      stats.total >= QUESTION_RUBRIC_GOLD_MINIMUM_SIZE,
      `Expected ≥ ${QUESTION_RUBRIC_GOLD_MINIMUM_SIZE} samples, got ${stats.total}`,
    );
  });

  it("每个样本有唯一 ID", () => {
    const ids = QUESTION_RUBRIC_GOLD.map((s) => s.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, "IDs must be unique");
  });

  it("每个样本有非空 claim 和 quote", () => {
    for (const sample of QUESTION_RUBRIC_GOLD) {
      assert.ok(sample.claim.length > 0, `Sample ${sample.id} has empty claim`);
      assert.ok(sample.quote.length > 0, `Sample ${sample.id} has empty quote`);
    }
  });

  it("每个样本有至少一个 rubric item", () => {
    for (const sample of QUESTION_RUBRIC_GOLD) {
      assert.ok(
        sample.expectedRubricItems.length > 0,
        `Sample ${sample.id} has no rubric items`,
      );
    }
  });

  it("每个 rubric item有 evidenceRefId", () => {
    for (const sample of QUESTION_RUBRIC_GOLD) {
      for (const ri of sample.expectedRubricItems) {
        assert.ok(
          ri.evidenceRefId.length > 0,
          `Rubric item ${ri.key} in ${sample.id} has no evidenceRefId`,
        );
      }
    }
  });

  it("答案泄漏率为 0（fixture 数据）", () => {
    const stats = getQuestionRubricGoldStats();
    assert.equal(stats.leaked, 0, "Gold samples should have no leakage");
  });

  it("黄金标签不能在没有独立预测时自证通过", () => {
    const metrics = scoreQuestionRubric(QUESTION_RUBRIC_GOLD);
    assert.equal(metrics.predictionCoverage, 0);
    assert.equal(metrics.meetsGate, false);
  });

  it("完整且正确的独立预测通过阈值门禁", () => {
    const metrics = scoreQuestionRubric(
      QUESTION_RUBRIC_GOLD,
      perfectQuestionPredictions,
    );
    assert.ok(metrics.schemaRefIntegrity >= QUESTION_RUBRIC_THRESHOLDS.schemaRefIntegrity);
    assert.ok(metrics.answerLeakageRate <= QUESTION_RUBRIC_THRESHOLDS.answerLeakageRate);
    assert.equal(metrics.predictionCoverage, 1);
    assert.ok(metrics.meetsGate, "Question/Rubric predictions should meet gate threshold");
  });
});

// ─── Evaluation Gold ────────────────────────────────────────────────────

describe("Evaluation Gold v1", () => {
  it("数据集版本号非空", () => {
    assert.ok(EVALUATION_GOLD_VERSION.length > 0);
  });

  it("数据集达到最小规模 ≥ 120", () => {
    const stats = getEvaluationGoldStats();
    assert.ok(
      stats.total >= EVALUATION_GOLD_MINIMUM_SIZE,
      `Expected ≥ ${EVALUATION_GOLD_MINIMUM_SIZE} samples, got ${stats.total}`,
    );
  });

  it("覆盖所有四种 outcome 类别", () => {
    const stats = getEvaluationGoldStats();
    assert.ok(stats.byOutcome.preliminary_understanding > 0, "Should have correct samples");
    assert.ok(stats.byOutcome.unclear_expression > 0, "Should have partial samples");
    assert.ok(stats.byOutcome.misunderstanding > 0, "Should have misunderstanding samples");
    assert.ok(stats.byOutcome.unknown > 0, "Should have unable samples");
  });

  it("每个样本有唯一 ID", () => {
    const ids = EVALUATION_GOLD.map((s) => s.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size);
  });

  it("每个样本有至少一个 item verdict", () => {
    for (const sample of EVALUATION_GOLD) {
      assert.ok(sample.trueItemVerdicts.length > 0, `Sample ${sample.id} has no verdicts`);
    }
  });

  it("高风险样本有双人标注", () => {
    const stats = getEvaluationGoldStats();
    if (stats.criticalMisunderstandings > 0) {
      assert.ok(
        stats.dualLabeled >= stats.criticalMisunderstandings,
        "Critical misunderstandings should have dual labels",
      );
    }
  });

  it("黄金标签不能在没有独立预测时自证通过", () => {
    const metrics = scoreEvaluation(EVALUATION_GOLD);
    assert.equal(metrics.outcomeWeightedKappa, 0);
    assert.equal(metrics.meetsGate, false);
  });

  it("完整且正确的独立预测通过阈值门禁", () => {
    const metrics = scoreEvaluation(
      EVALUATION_GOLD,
      perfectEvaluationPredictions,
    );
    assert.ok(metrics.outcomeWeightedKappa >= EVALUATION_THRESHOLDS.outcomeWeightedKappa);
    assert.equal(metrics.predictionCoverage, 1);
    assert.ok(metrics.meetsGate, "Evaluation predictions should meet gate threshold");
  });
});

// ─── Card Repair Gold ────────────────────────────────────────────────────

describe("Card Repair Gold v1", () => {
  it("数据集版本号非空", () => {
    assert.ok(CARD_REPAIR_GOLD_VERSION.length > 0);
  });

  it("数据集达到最小规模 ≥ 30", () => {
    const stats = getCardRepairGoldStats();
    assert.ok(
      stats.total >= CARD_REPAIR_GOLD_MINIMUM_SIZE,
      `Expected ≥ ${CARD_REPAIR_GOLD_MINIMUM_SIZE} samples, got ${stats.total}`,
    );
  });

  it("每个样本有唯一 ID", () => {
    const ids = CARD_REPAIR_GOLD.map((s) => s.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size);
  });

  it("有触发样本和非触发样本", () => {
    const stats = getCardRepairGoldStats();
    assert.ok(stats.triggered > 0, "Should have triggered samples");
    assert.ok(stats.nonTriggered > 0, "Should have non-triggered samples");
  });

  it("触发样本有 expectedTriggers", () => {
    for (const sample of CARD_REPAIR_GOLD) {
      if (sample.shouldTriggerRepair) {
        assert.ok(
          sample.expectedTriggers.length > 0,
          `Triggered sample ${sample.id} has no expectedTriggers`,
        );
      }
    }
  });

  it("非触发样本不应有 triggers", () => {
    for (const sample of CARD_REPAIR_GOLD) {
      if (!sample.shouldTriggerRepair) {
        assert.equal(
          sample.expectedTriggers.length,
          0,
          `Non-triggered sample ${sample.id} has triggers`,
        );
      }
    }
  });

  it("黄金标签不能在没有独立预测时自证通过", () => {
    const metrics = scoreCardRepair(CARD_REPAIR_GOLD);
    assert.equal(metrics.predictionCoverage, 0);
    assert.equal(metrics.meetsGate, false);
  });

  it("完整且正确的独立预测通过阈值门禁", () => {
    const metrics = scoreCardRepair(
      CARD_REPAIR_GOLD,
      perfectCardRepairPredictions,
    );
    assert.ok(metrics.hardViolationRate <= CARD_REPAIR_THRESHOLDS.hardViolationRate);
    assert.ok(metrics.nonTriggeredSecondCallRate <= CARD_REPAIR_THRESHOLDS.nonTriggeredSecondCallRate);
    assert.equal(metrics.predictionCoverage, 1);
    assert.ok(metrics.meetsGate, "Card Repair predictions should meet gate threshold");
  });
});

// ─── 评分器报告 ──────────────────────────────────────────────────────────

describe("V06 Scorer Report", () => {
  it("generateV06ScorerReport 包含正确版本号", () => {
    const report = generateV06ScorerReport(
      QUESTION_RUBRIC_GOLD,
      EVALUATION_GOLD,
      CARD_REPAIR_GOLD,
    );
    assert.equal(report.scorerVersion, V06_SCORER_VERSION);
    assert.ok(report.timestamp.length > 0);
  });

  it("报告包含三套评分结果", () => {
    const report = generateV06ScorerReport(
      QUESTION_RUBRIC_GOLD,
      EVALUATION_GOLD,
      CARD_REPAIR_GOLD,
    );
    assert.ok(report.questionRubric.totalSamples >= 60);
    assert.ok(report.evaluation.totalSamples >= 120);
    assert.ok(report.cardRepair.totalSamples >= 30);
    assert.equal(report.questionRubric.meetsGate, false);
    assert.equal(report.evaluation.meetsGate, false);
    assert.equal(report.cardRepair.meetsGate, false);
  });

  it("报告只在提供完整独立预测时通过", () => {
    const report = generateV06ScorerReport(
      QUESTION_RUBRIC_GOLD,
      EVALUATION_GOLD,
      CARD_REPAIR_GOLD,
      {
        questionRubric: perfectQuestionPredictions,
        evaluation: perfectEvaluationPredictions,
        cardRepair: perfectCardRepairPredictions,
      },
    );
    assert.equal(report.questionRubric.meetsGate, true);
    assert.equal(report.evaluation.meetsGate, true);
    assert.equal(report.cardRepair.meetsGate, true);
  });

  it("空数据集评分返回零值", () => {
    const qrMetrics = scoreQuestionRubric([]);
    assert.equal(qrMetrics.totalSamples, 0);
    assert.equal(qrMetrics.meetsGate, false);

    const evMetrics = scoreEvaluation([]);
    assert.equal(evMetrics.totalSamples, 0);
    assert.equal(evMetrics.meetsGate, false);

    const crMetrics = scoreCardRepair([]);
    assert.equal(crMetrics.totalSamples, 0);
    assert.equal(crMetrics.meetsGate, false);
  });
});

describe("V06 scorer fail-closed behavior", () => {
  it("duplicate predictions do not count toward coverage", () => {
    const duplicated = [
      ...perfectQuestionPredictions,
      perfectQuestionPredictions[0],
    ];
    const metrics = scoreQuestionRubric(QUESTION_RUBRIC_GOLD, duplicated);
    assert.ok(metrics.predictionCoverage < 1);
    assert.equal(metrics.meetsGate, false);
  });

  it("false mastery predictions fail evaluation quality gates", () => {
    const falseMastery = EVALUATION_GOLD.map((sample) => ({
      sampleId: sample.id,
      outcome: "preliminary_understanding" as const,
    }));
    const metrics = scoreEvaluation(EVALUATION_GOLD, falseMastery);
    assert.ok(metrics.falseMasteryRate > EVALUATION_THRESHOLDS.falseMasteryRate);
    assert.equal(metrics.meetsGate, false);
  });

  it("unnecessary repair calls fail the non-trigger gate", () => {
    const unnecessaryRepair = perfectCardRepairPredictions.map((prediction, index) => {
      const sample = CARD_REPAIR_GOLD[index];
      return sample.shouldTriggerRepair
        ? prediction
        : { ...prediction, repairTriggered: true, secondCallMade: true };
    });
    const metrics = scoreCardRepair(CARD_REPAIR_GOLD, unnecessaryRepair);
    assert.ok(metrics.nonTriggeredSecondCallRate > 0);
    assert.equal(metrics.meetsGate, false);
  });
});
