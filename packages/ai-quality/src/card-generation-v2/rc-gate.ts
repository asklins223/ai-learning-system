/**
 * 方案 20 §23.4/§23.5 — RC Gate 阈值与裁决。
 *
 * Hard gates（§23.4，任何一项失败阻止 RC）与内容质量门槛（§23.5）
 * 在此冻结；指标必须按 micro/long/zero/safety/modality/language 分桶，
 * 总平均达标不能掩盖 micro-note 退化（§23.5 末句）。
 */

import type { DeterministicScoreV2 } from "./deterministic-scorer.ts";

/** §23.5 首版内容质量门槛。 */
export const CONTENT_QUALITY_GATES_V2 = {
  microNoteCountWithinRange: 0.95, // ≥95%
  overGenerationRate: 0.05, // ≤5%
  severeOverGenerationMax: 0, // 超过 max+2 的样本 = 0
  zeroCardPrecision: 0.9,
  zeroCardRecall: 0.9,
  criticalObjectiveRecall: 0.95,
  importantObjectiveRecall: 0.9,
  surfaceParaphraseOnlyRate: 0.05,
  deckSemanticDuplicateRate: 0.05,
  nonCriticalFrontLeakRate: 0.02,
} as const;

/** §23.4 硬门禁（数值型部分）。 */
export const HARD_GATES_V2 = {
  evidenceRubricRequiredUnitClosure: 1, // 100%
  unsupportedContradictedPublishedUnit: 0,
  criticalAnswerLeakage: 0,
  crossWorkspaceLeakage: 0,
  candidateFormalSideEffects: 0,
  criticBypassOrFallbackRestore: 0,
  mixedWriter: 0,
  destructiveCascadeHistoryLoss: 0,
  activationIdempotencyDuplicateCanonical: 0,
  failedMislabeledAsZeroCard: 0,
} as const;

export interface RcGateInputV2 {
  scores: DeterministicScoreV2[];
  zeroCardFixtureIds: string[]; // gold 允许 0 卡的 fixture
  zeroCardPredictedIds: string[]; // 系统输出 0 卡的 fixture
  hardGateCounts: Record<keyof typeof HARD_GATES_V2, number>;
  /**
   * §23.5：按 micro/long/zero/safety/modality/language 分桶的 fixture 归属。
   * 由调用方（评测 harness）依据 fixture 元数据（content 长度/modality/
   * zeroCardReasonCodes/language）生成。未提供时仅报告现有全局门槛。
   */
  bucketAssignments?: Array<{ fixtureId: string; bucket: string }>;
  /**
   * §23.9（R36）：评测版本闭包（immutable provider/model snapshot）。
   * RC 报告必须保存 model、prompt、policy、dataset、judge、code commit，
   * 防止"为了过门禁静默放宽阈值"或无法复现。
   */
  snapshot?: {
    providerId: string;
    modelSnapshot: string;
    promptRevision: string;
    policyVersion: string;
    datasetSnapshot: string;
    judgeVersion: string;
    codeCommit: string;
    runAt: string;
  };
}

export interface RcGateResultV2 {
  contentGates: Record<string, { actual: number; threshold: number; passed: boolean }>;
  hardGates: Record<string, { actual: number; threshold: number; passed: boolean }>;
  microBucketPassed: boolean;
  /**
   * §23.5 分桶报告：每桶样本数 + countWithinRange 率。
   * micro/long/zero/safety/modality 桶强制 ≥95%（总平均达标不能掩盖
   * 单桶退化）；language 桶为报告制（首版 zh 单语言，不强制通过）。
   */
  buckets: Record<string, { count: number; withinRangeRate: number; passed: boolean }>;
  /** §23.9：本次裁决的 immutable 版本闭包（与阈值/数据集一起冻结）。 */
  snapshot: NonNullable<RcGateInputV2["snapshot"]>;
  overallPassed: boolean;
}

export function evaluateRcGateV2(input: RcGateInputV2): RcGateResultV2 {
  const total = input.scores.length || 1;
  const microScores = input.scores.filter((s) => s.cardCount <= 2);

  // 聚合只算一次，后续 actual/passed 复用，避免对同一 scores 数组反复
  // filter/reduce 造成多余 O(n) 扫描（300+ fixture 语料上明显）。
  const countWithinRangeCount = input.scores.filter((s) => s.countWithinRange).length;
  const criticalRecallSum = input.scores.reduce((a, s) => a + s.criticalRecall, 0);
  const frontLeakCount = input.scores.filter((s) => s.frontLeaks.length > 0).length;
  const supportOnlyCardedCount = input.scores.filter((s) => s.supportOnlyCarded.length > 0).length;
  const microCountWithinRange = microScores.filter((s) => s.countWithinRange).length;

  const content: RcGateResultV2["contentGates"] = {
    microNoteCountWithinRange: {
      actual: countWithinRangeCount / total,
      threshold: CONTENT_QUALITY_GATES_V2.microNoteCountWithinRange,
      passed: countWithinRangeCount / total >= CONTENT_QUALITY_GATES_V2.microNoteCountWithinRange,
    },
    criticalObjectiveRecall: {
      actual: criticalRecallSum / total,
      threshold: CONTENT_QUALITY_GATES_V2.criticalObjectiveRecall,
      passed: criticalRecallSum / total >= CONTENT_QUALITY_GATES_V2.criticalObjectiveRecall,
    },
    frontLeakRate: {
      actual: frontLeakCount / total,
      threshold: CONTENT_QUALITY_GATES_V2.nonCriticalFrontLeakRate,
      passed: frontLeakCount / total <= CONTENT_QUALITY_GATES_V2.nonCriticalFrontLeakRate,
    },
    supportOnlyCardedRate: {
      actual: supportOnlyCardedCount / total,
      threshold: 0,
      passed: supportOnlyCardedCount === 0,
    },
  };

  // 零卡 precision/recall
  const zeroCardFixtureSet = new Set(input.zeroCardFixtureIds);
  const truePositive = input.zeroCardPredictedIds.filter((id) => zeroCardFixtureSet.has(id)).length;
  const predicted = input.zeroCardPredictedIds.length || 1;
  const gold = input.zeroCardFixtureIds.length || 1;
  content.zeroCardPrecision = {
    actual: truePositive / predicted,
    threshold: CONTENT_QUALITY_GATES_V2.zeroCardPrecision,
    passed: truePositive / predicted >= CONTENT_QUALITY_GATES_V2.zeroCardPrecision,
  };
  content.zeroCardRecall = {
    actual: truePositive / gold,
    threshold: CONTENT_QUALITY_GATES_V2.zeroCardRecall,
    passed: truePositive / gold >= CONTENT_QUALITY_GATES_V2.zeroCardRecall,
  };

  const hard: RcGateResultV2["hardGates"] = {};
  for (const [key, threshold] of Object.entries(HARD_GATES_V2)) {
    const actual = input.hardGateCounts[key as keyof typeof HARD_GATES_V2] ?? 0;
    hard[key] = { actual, threshold, passed: actual <= threshold };
  }

  // micro 分桶：micro-note 退化不得被总平均掩盖
  const microPassed = microScores.every((s) => s.countWithinRange)
    || microCountWithinRange / (microScores.length || 1) >= CONTENT_QUALITY_GATES_V2.microNoteCountWithinRange;

  // §23.5 全分桶：micro/long/zero/safety/modality 强制 ≥95% withinRange；
  // language 报告制（首版 zh 单语言）。
  const buckets: RcGateResultV2["buckets"] = {};
  const byBucket = new Map<string, DeterministicScoreV2[]>();
  // 一次构建 fixtureId → score 的索引，避免每个 bucketAssignment 都线性扫全表。
  const scoreByFixtureId = new Map<string, DeterministicScoreV2>();
  for (const score of input.scores) scoreByFixtureId.set(score.fixtureId, score);
  for (const a of input.bucketAssignments ?? []) {
    const score = scoreByFixtureId.get(a.fixtureId);
    if (!score) continue;
    const list = byBucket.get(a.bucket) ?? [];
    list.push(score);
    byBucket.set(a.bucket, list);
  }
  let bucketsPassed = true;
  for (const [name, list] of byBucket) {
    const within = list.filter((sc) => sc.countWithinRange).length / list.length;
    const passed = name === "language"
      ? true // 报告制
      : within >= CONTENT_QUALITY_GATES_V2.microNoteCountWithinRange;
    buckets[name] = { count: list.length, withinRangeRate: within, passed };
    if (!passed) bucketsPassed = false;
  }

  const contentPassed = Object.values(content).every((g) => g.passed);
  const hardPassed = Object.values(hard).every((g) => g.passed);

  return {
    contentGates: content,
    hardGates: hard,
    microBucketPassed: microPassed,
    buckets,
    snapshot: input.snapshot ?? {
      providerId: "deterministic",
      modelSnapshot: "n/a",
      promptRevision: "n/a",
      policyVersion: "rc-gate-v1",
      datasetSnapshot: "n/a",
      judgeVersion: "deterministic-judge-v1",
      codeCommit: "n/a",
      runAt: new Date().toISOString(),
    },
    overallPassed: contentPassed && hardPassed && microPassed && bucketsPassed,
  };
}
