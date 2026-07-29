/**
 * v0.6 prediction-based AI quality scorers (计划 §4.2).
 *
 * Gold fixtures describe expected labels. They are not model outputs. Every
 * RC score therefore requires a separate prediction collection; absent or
 * duplicate predictions fail coverage closed and can never pass a gate.
 */

import type {
  QuestionRubricScorerMetrics,
  EvaluationScorerMetrics,
  CardRepairScorerMetrics,
  QuestionRubricGoldSample,
  EvaluationGoldSample,
  CardRepairGoldSample,
  QuestionRubricPrediction,
  EvaluationPrediction,
  CardRepairPrediction,
  V06ScorerPredictions,
} from "./types.ts";
import {
  QUESTION_RUBRIC_THRESHOLDS,
  EVALUATION_THRESHOLDS,
  CARD_REPAIR_THRESHOLDS,
} from "./types.ts";

export const V06_SCORER_VERSION = "2.0.0";

type PredictionWithSampleId = { sampleId: string };

function indexUniquePredictions<T extends PredictionWithSampleId>(
  predictions: readonly T[],
): Map<string, T> {
  const index = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const prediction of predictions) {
    if (index.has(prediction.sampleId)) duplicates.add(prediction.sampleId);
    index.set(prediction.sampleId, prediction);
  }
  for (const duplicate of duplicates) index.delete(duplicate);
  return index;
}

function coverage(evaluatedSamples: number, totalSamples: number): number {
  return totalSamples === 0 ? 0 : evaluatedSamples / totalSamples;
}

function finiteUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// ─── Question/Rubric Scorer ───────────────────────────────────────────────

export function scoreQuestionRubric(
  samples: QuestionRubricGoldSample[],
  predictions: QuestionRubricPrediction[] = [],
): QuestionRubricScorerMetrics {
  const totalSamples = samples.length;
  const predictionIndex = indexUniquePredictions(predictions);
  const evaluatedSamples = samples.filter((sample) => predictionIndex.has(sample.id)).length;
  const predictionCoverage = coverage(evaluatedSamples, totalSamples);

  if (totalSamples === 0) {
    return {
      schemaRefIntegrity: 0,
      answerLeakageRate: 0,
      hardEvidenceSupportPrecision: 0,
      humanAcceptRate: 0,
      totalSamples,
      evaluatedSamples,
      predictionCoverage,
      meetsGate: false,
    };
  }

  let schemaValid = 0;
  let leaked = 0;
  let supportedEvidenceRefs = 0;
  let predictedEvidenceRefs = 0;
  let accepted = 0;

  for (const sample of samples) {
    const prediction = predictionIndex.get(sample.id);
    if (!prediction) continue;

    const allowedEvidenceRefs = new Set(
      sample.expectedRubricItems.map((item) => item.evidenceRefId),
    );
    const refsArePresentAndAllowed =
      prediction.rubricEvidenceRefIds.length > 0
      && prediction.rubricEvidenceRefIds.every((refId) => allowedEvidenceRefs.has(refId));
    if (prediction.schemaRefIntegrityPassed && refsArePresentAndAllowed) schemaValid++;
    if (prediction.leakageReason !== null) leaked++;
    if (prediction.humanAccepted) accepted++;

    for (const refId of prediction.rubricEvidenceRefIds) {
      predictedEvidenceRefs++;
      if (allowedEvidenceRefs.has(refId)) supportedEvidenceRefs++;
    }
  }

  const schemaRefIntegrity = schemaValid / totalSamples;
  const answerLeakageRate = evaluatedSamples > 0 ? leaked / evaluatedSamples : 0;
  const hardEvidenceSupportPrecision =
    predictedEvidenceRefs > 0 ? supportedEvidenceRefs / predictedEvidenceRefs : 0;
  const humanAcceptRate = accepted / totalSamples;

  const meetsGate =
    predictionCoverage === 1
    && schemaRefIntegrity >= QUESTION_RUBRIC_THRESHOLDS.schemaRefIntegrity
    && answerLeakageRate <= QUESTION_RUBRIC_THRESHOLDS.answerLeakageRate
    && hardEvidenceSupportPrecision >= QUESTION_RUBRIC_THRESHOLDS.hardEvidenceSupportPrecision
    && humanAcceptRate >= QUESTION_RUBRIC_THRESHOLDS.humanAcceptRate
    && totalSamples >= 60;

  return {
    schemaRefIntegrity,
    answerLeakageRate,
    hardEvidenceSupportPrecision,
    humanAcceptRate,
    totalSamples,
    evaluatedSamples,
    predictionCoverage,
    meetsGate,
  };
}

// ─── Evaluation Scorer ────────────────────────────────────────────────────

const OUTCOMES = [
  "preliminary_understanding",
  "unclear_expression",
  "misunderstanding",
  "unknown",
] as const;

type EvaluationOutcome = EvaluationGoldSample["trueOutcome"];

function quadraticWeightedKappa(
  samples: EvaluationGoldSample[],
  predictionIndex: Map<string, EvaluationPrediction>,
): number {
  if (samples.length === 0 || samples.some((sample) => !predictionIndex.has(sample.id))) {
    return 0;
  }

  const size = OUTCOMES.length;
  const goldCounts = new Array<number>(size).fill(0);
  const predictionCounts = new Array<number>(size).fill(0);
  let observedDisagreement = 0;

  for (const sample of samples) {
    const predicted = predictionIndex.get(sample.id)!.outcome;
    const goldIndex = OUTCOMES.indexOf(sample.trueOutcome);
    const predictedIndex = OUTCOMES.indexOf(predicted);
    if (goldIndex < 0 || predictedIndex < 0) return 0;
    goldCounts[goldIndex]++;
    predictionCounts[predictedIndex]++;
    observedDisagreement += ((goldIndex - predictedIndex) / (size - 1)) ** 2;
  }
  observedDisagreement /= samples.length;

  let expectedDisagreement = 0;
  for (let goldIndex = 0; goldIndex < size; goldIndex++) {
    for (let predictedIndex = 0; predictedIndex < size; predictedIndex++) {
      const expectedFrequency =
        (goldCounts[goldIndex] * predictionCounts[predictedIndex])
        / (samples.length ** 2);
      expectedDisagreement +=
        expectedFrequency * (((goldIndex - predictedIndex) / (size - 1)) ** 2);
    }
  }

  if (expectedDisagreement === 0) {
    return observedDisagreement === 0 ? 1 : 0;
  }
  return Math.max(-1, Math.min(1, 1 - observedDisagreement / expectedDisagreement));
}

export function scoreEvaluation(
  samples: EvaluationGoldSample[],
  predictions: EvaluationPrediction[] = [],
): EvaluationScorerMetrics {
  const totalSamples = samples.length;
  const predictionIndex = indexUniquePredictions(predictions);
  const evaluatedSamples = samples.filter((sample) => predictionIndex.has(sample.id)).length;
  const predictionCoverage = coverage(evaluatedSamples, totalSamples);

  if (totalSamples === 0) {
    return {
      outcomeWeightedKappa: 0,
      criticalCategoryRecall: { correct: 0, partial: 0, misunderstanding: 0, unable: 0 },
      falseMasteryRate: 0,
      totalSamples,
      evaluatedSamples,
      predictionCoverage,
      meetsGate: false,
    };
  }

  const recallFor = (outcome: EvaluationOutcome): number => {
    const matching = samples.filter((sample) => sample.trueOutcome === outcome);
    if (matching.length === 0) return 0;
    const correct = matching.filter(
      (sample) => predictionIndex.get(sample.id)?.outcome === outcome,
    ).length;
    return correct / matching.length;
  };

  const criticalCategoryRecall = {
    correct: recallFor("preliminary_understanding"),
    partial: recallFor("unclear_expression"),
    misunderstanding: recallFor("misunderstanding"),
    unable: recallFor("unknown"),
  };
  const criticalMisunderstandings = samples.filter(
    (sample) => sample.isCriticalMisunderstanding,
  );
  const falseMasteryCount = criticalMisunderstandings.filter(
    (sample) =>
      predictionIndex.get(sample.id)?.outcome === "preliminary_understanding",
  ).length;
  const falseMasteryRate = criticalMisunderstandings.length > 0
    ? falseMasteryCount / criticalMisunderstandings.length
    : 0;
  const outcomeWeightedKappa = quadraticWeightedKappa(samples, predictionIndex);

  const meetsGate =
    predictionCoverage === 1
    && outcomeWeightedKappa >= EVALUATION_THRESHOLDS.outcomeWeightedKappa
    && criticalCategoryRecall.correct >= EVALUATION_THRESHOLDS.criticalCategoryRecall
    && criticalCategoryRecall.partial >= EVALUATION_THRESHOLDS.criticalCategoryRecall
    && criticalCategoryRecall.misunderstanding >= EVALUATION_THRESHOLDS.criticalCategoryRecall
    && criticalCategoryRecall.unable >= EVALUATION_THRESHOLDS.criticalCategoryRecall
    && falseMasteryRate <= EVALUATION_THRESHOLDS.falseMasteryRate
    && totalSamples >= 120;

  return {
    outcomeWeightedKappa,
    criticalCategoryRecall,
    falseMasteryRate,
    totalSamples,
    evaluatedSamples,
    predictionCoverage,
    meetsGate,
  };
}

// ─── Card Repair Scorer ───────────────────────────────────────────────────

export function scoreCardRepair(
  samples: CardRepairGoldSample[],
  predictions: CardRepairPrediction[] = [],
): CardRepairScorerMetrics {
  const totalSamples = samples.length;
  const predictionIndex = indexUniquePredictions(predictions);
  const evaluatedSamples = samples.filter((sample) => predictionIndex.has(sample.id)).length;
  const predictionCoverage = coverage(evaluatedSamples, totalSamples);

  if (totalSamples === 0) {
    return {
      hardViolationRate: 0,
      nonRegression: {
        hardCitationPrecision: 0,
        keyPointHardCoverage: 0,
        validationExpectedPointsHardCoverage: 0,
      },
      nonTriggeredSecondCallRate: 0,
      totalSamples,
      evaluatedSamples,
      predictionCoverage,
      meetsGate: false,
    };
  }

  const triggeredSamples = samples.filter((sample) => sample.shouldTriggerRepair);
  const nonTriggeredSamples = samples.filter((sample) => !sample.shouldTriggerRepair);
  let hardViolations = 0;
  let nonTriggeredSecondCalls = 0;
  let allNonRegressed = true;
  const metricTotals = {
    hardCitationPrecision: 0,
    keyPointHardCoverage: 0,
    validationExpectedPointsHardCoverage: 0,
  };

  for (const sample of samples) {
    const prediction = predictionIndex.get(sample.id);
    if (!prediction) {
      if (sample.shouldTriggerRepair) hardViolations++;
      allNonRegressed = false;
      continue;
    }

    const post = prediction.postRepairMetrics;
    const baseline = prediction.baselineMetrics;
    metricTotals.hardCitationPrecision += finiteUnitInterval(post.hardCitationPrecision);
    metricTotals.keyPointHardCoverage += finiteUnitInterval(post.keyPointHardCoverage);
    metricTotals.validationExpectedPointsHardCoverage += finiteUnitInterval(
      post.validationExpectedPointsHardCoverage,
    );

    if (
      post.hardCitationPrecision < baseline.hardCitationPrecision
      || post.keyPointHardCoverage < baseline.keyPointHardCoverage
      || post.validationExpectedPointsHardCoverage
        < baseline.validationExpectedPointsHardCoverage
    ) {
      allNonRegressed = false;
    }

    if (sample.shouldTriggerRepair) {
      const expected = sample.expectedPostRepairHardGate;
      if (
        !prediction.repairTriggered
        || !prediction.hardGatePassed
        || post.hardCitationPrecision < expected.hardCitationPrecision
        || post.keyPointHardCoverage < expected.keyPointHardCoverage
        || post.validationExpectedPointsHardCoverage
          < expected.validationExpectedPointsHardCoverage
      ) {
        hardViolations++;
      }
    } else if (prediction.repairTriggered || prediction.secondCallMade) {
      nonTriggeredSecondCalls++;
    }
  }

  const divisor = totalSamples;
  const nonRegression = {
    hardCitationPrecision: metricTotals.hardCitationPrecision / divisor,
    keyPointHardCoverage: metricTotals.keyPointHardCoverage / divisor,
    validationExpectedPointsHardCoverage:
      metricTotals.validationExpectedPointsHardCoverage / divisor,
  };
  const hardViolationRate = triggeredSamples.length > 0
    ? hardViolations / triggeredSamples.length
    : 1;
  const nonTriggeredSecondCallRate = nonTriggeredSamples.length > 0
    ? nonTriggeredSecondCalls / nonTriggeredSamples.length
    : 1;

  const meetsGate =
    predictionCoverage === 1
    && hardViolationRate <= CARD_REPAIR_THRESHOLDS.hardViolationRate
    && nonTriggeredSecondCallRate <= CARD_REPAIR_THRESHOLDS.nonTriggeredSecondCallRate
    && allNonRegressed
    && nonRegression.hardCitationPrecision >= 0.90
    && nonRegression.keyPointHardCoverage >= 0.85
    && nonRegression.validationExpectedPointsHardCoverage >= 0.85
    && totalSamples >= 30;

  return {
    hardViolationRate,
    nonRegression,
    nonTriggeredSecondCallRate,
    totalSamples,
    evaluatedSamples,
    predictionCoverage,
    meetsGate,
  };
}

// ─── Report ───────────────────────────────────────────────────────────────

export function generateV06ScorerReport(
  questionRubricSamples: QuestionRubricGoldSample[],
  evaluationSamples: EvaluationGoldSample[],
  cardRepairSamples: CardRepairGoldSample[],
  predictions?: Partial<V06ScorerPredictions>,
) {
  return {
    scorerVersion: V06_SCORER_VERSION,
    timestamp: new Date().toISOString(),
    questionRubric: scoreQuestionRubric(
      questionRubricSamples,
      predictions?.questionRubric ?? [],
    ),
    evaluation: scoreEvaluation(
      evaluationSamples,
      predictions?.evaluation ?? [],
    ),
    cardRepair: scoreCardRepair(
      cardRepairSamples,
      predictions?.cardRepair ?? [],
    ),
  };
}
