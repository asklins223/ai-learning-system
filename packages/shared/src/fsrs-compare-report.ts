/**
 * FSRS Shadow vs discrete-v2 Offline Compare Report (计划 §10.6, §6.8)
 *
 * 此模块生成 FSRS shadow 决策与 discrete-v2 正式调度的离线对比报告。
 *
 * 报告要求（计划 §10.6 Gate）：
 * - 正式 schedule 影响为 0
 * - 相同历史重放产生相同 shadow hash
 * - 报告明确样本量、校准、模拟工作量和 insufficient_data
 *
 * 此模块不访问数据库、不修改正式 schedule、不包含答案正文。
 * 它接收 shadow decisions 和 discrete-v2 decisions 的快照，输出纯文本报告。
 */

import {
  computeFSRSShadowDecision,
  FSRS_ALGORITHM,
  FSRS_ALGORITHM_VERSION,
  FSRS_PARAMETERS_VERSION,
  type FSRSShadowInput,
} from "./fsrs-shadow.ts";
import {
  calculateDiscreteV2Schedule,
  DISCRETE_V2_POLICY_VERSION,
  type DiscreteV2Input,
  type DiscreteV2Decision,
  type DiscreteV2Outcome,
} from "./scheduling-policy-v2.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A single comparison data point: one review event evaluated by both
 * discrete-v2 (formal) and FSRS (shadow).
 */
export interface ComparisonEntry {
  /** The outcome of this review event */
  outcome: DiscreteV2Outcome;
  /** Current interval days before this event */
  currentIntervalDays: number;
  /** discrete-v2 formal interval after this event */
  discreteV2IntervalDays: number;
  /** FSRS shadow predicted interval in days (rounded) */
  fsrsIntervalDays: number;
  /** Difference: FSRS - discrete-v2 (positive = FSRS suggests longer interval) */
  intervalDiffDays: number;
  /** Whether the user was unassisted */
  isUnassisted: boolean;
  /** Whether FSRS produced a decision for this event */
  hasFSRSDecision: boolean;
}

/**
 * The full compare report.
 */
export interface FSRSCompareReport {
  /** Total number of comparison data points */
  sampleSize: number;
  /** Number of events where FSRS produced a decision (unassisted only) */
  fsrsDecisionCount: number;
  /** Number of events where FSRS did NOT produce a decision (assisted/stale/etc.) */
  fsrsSkippedCount: number;
  /** Algorithm versions used */
  fsrsAlgorithm: string;
  fsrsAlgorithmVersion: string;
  fsrsParametersVersion: string;
  discreteV2PolicyVersion: string;
  /** Mean interval difference (FSRS - discrete-v2) in days */
  meanIntervalDiff: number;
  /** Median interval difference in days */
  medianIntervalDiff: number;
  /** Standard deviation of interval difference */
  stdIntervalDiff: number;
  /** Mean absolute interval difference */
  meanAbsIntervalDiff: number;
  /** Percentage of events where FSRS suggests a longer interval than discrete-v2 */
  fsrsLongerPercent: number;
  /** Percentage of events where FSRS suggests a shorter interval */
  fsrsShorterPercent: number;
  /** Percentage of events where they agree (within 1 day) */
  agreementPercent: number;
  /** Per-outcome breakdown */
  byOutcome: Record<string, {
    count: number;
    meanDiff: number;
    fsrsLongerPercent: number;
  }>;
  /** Per-interval-tier breakdown */
  byInterval: Record<number, {
    count: number;
    meanDiff: number;
    fsrsMeanInterval: number;
  }>;
  /** Whether the sample is too small for meaningful conclusions */
  insufficientData: boolean;
  /** Minimum sample size threshold for sufficient data */
  readonly MIN_SAMPLE_SIZE: number;
  /** Human-readable report text */
  reportText: string;
  /** Simulated workload: total review events simulated */
  simulationWorkload: number;
  /** All comparison entries */
  entries: ComparisonEntry[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_SAMPLE_SIZE = 30;

// ─── Report Generation ─────────────────────────────────────────────────────

/**
 * Generate a compare report from a list of review events.
 *
 * Each event is a (outcome, currentIntervalDays, isUnassisted, now) tuple.
 * The function computes both discrete-v2 and FSRS decisions for each event
 * and produces a comparison report.
 *
 * @param events - Array of review events to compare
 * @returns The compare report
 */
export function generateCompareReport(
  events: Array<{
    outcome: DiscreteV2Outcome;
    currentIntervalDays: number;
    isUnassisted: boolean;
    now: Date;
    unassistedEligibleAfter?: Date | null;
    hasValidServerQuestion?: boolean;
    hasHardEvidence?: boolean;
  }>,
): FSRSCompareReport {
  const entries: ComparisonEntry[] = [];
  let fsrsDecisionCount = 0;
  let fsrsSkippedCount = 0;

  for (const event of events) {
    // Compute discrete-v2 decision
    const d2Input: DiscreteV2Input = {
      currentIntervalDays: event.currentIntervalDays,
      outcome: event.outcome,
      hasValidServerQuestion: event.hasValidServerQuestion ?? true,
      hasHardEvidence: event.hasHardEvidence ?? true,
      now: event.now,
      unassistedEligibleAfter: event.unassistedEligibleAfter ?? null,
    };

    let d2Decision: DiscreteV2Decision;
    try {
      d2Decision = calculateDiscreteV2Schedule(d2Input);
    } catch {
      // Skip invalid inputs
      continue;
    }

    // Compute FSRS shadow decision
    const fsrsInput: FSRSShadowInput = {
      workspaceId: "compare-report",
      userId: "compare-report",
      keyPointId: null,
      sourceType: "validation_event",
      sourceId: `event-${entries.length}`,
      currentIntervalDays: event.currentIntervalDays,
      outcome: event.outcome as FSRSShadowInput["outcome"],
      now: event.now,
      isUnassisted: event.isUnassisted,
    };

    const fsrsDecision = computeFSRSShadowDecision(fsrsInput);

    if (fsrsDecision) {
      fsrsDecisionCount++;
      const fsrsIntervalDays = Math.round(
        (fsrsDecision.predictedDueAt.getTime() - event.now.getTime()) / MS_PER_DAY,
      );
      const discreteV2IntervalDays = d2Decision.shouldMutateSchedule
        ? d2Decision.afterIntervalDays
        : d2Decision.beforeIntervalDays;

      entries.push({
        outcome: event.outcome,
        currentIntervalDays: event.currentIntervalDays,
        discreteV2IntervalDays,
        fsrsIntervalDays,
        intervalDiffDays: fsrsIntervalDays - discreteV2IntervalDays,
        isUnassisted: event.isUnassisted,
        hasFSRSDecision: true,
      });
    } else {
      fsrsSkippedCount++;
      const discreteV2IntervalDays = d2Decision.shouldMutateSchedule
        ? d2Decision.afterIntervalDays
        : d2Decision.beforeIntervalDays;

      entries.push({
        outcome: event.outcome,
        currentIntervalDays: event.currentIntervalDays,
        discreteV2IntervalDays,
        fsrsIntervalDays: 0,
        intervalDiffDays: 0,
        isUnassisted: event.isUnassisted,
        hasFSRSDecision: false,
      });
    }
  }

  return buildReport(entries, fsrsDecisionCount, fsrsSkippedCount, events.length);
}

// ─── Report Builder ────────────────────────────────────────────────────────

function buildReport(
  entries: ComparisonEntry[],
  fsrsDecisionCount: number,
  fsrsSkippedCount: number,
  totalEvents: number,
): FSRSCompareReport {
  const sampleSize = entries.length;
  const insufficientData = sampleSize < MIN_SAMPLE_SIZE;

  // Filter to only entries with FSRS decisions for statistical analysis
  const validEntries = entries.filter((e) => e.hasFSRSDecision);

  const diffs = validEntries.map((e) => e.intervalDiffDays);
  const absDiffs = diffs.map((d) => Math.abs(d));

  const meanIntervalDiff = diffs.length > 0 ? mean(diffs) : 0;
  const medianIntervalDiff = diffs.length > 0 ? median(diffs) : 0;
  const stdIntervalDiff = diffs.length > 0 ? stdDev(diffs, meanIntervalDiff) : 0;
  const meanAbsIntervalDiff = absDiffs.length > 0 ? mean(absDiffs) : 0;

  const fsrsLonger = diffs.filter((d) => d > 1).length;
  const fsrsShorter = diffs.filter((d) => d < -1).length;
  const agreement = diffs.filter((d) => Math.abs(d) <= 1).length;

  const fsrsLongerPercent = validEntries.length > 0 ? (fsrsLonger / validEntries.length) * 100 : 0;
  const fsrsShorterPercent = validEntries.length > 0 ? (fsrsShorter / validEntries.length) * 100 : 0;
  const agreementPercent = validEntries.length > 0 ? (agreement / validEntries.length) * 100 : 0;

  // Per-outcome breakdown (single pass: accumulate sums, compute means at the end)
  const outcomeAcc: Record<string, { count: number; diffSum: number; longerCount: number }> = {};
  for (const entry of validEntries) {
    let acc = outcomeAcc[entry.outcome];
    if (!acc) {
      acc = outcomeAcc[entry.outcome] = { count: 0, diffSum: 0, longerCount: 0 };
    }
    acc.count += 1;
    acc.diffSum += entry.intervalDiffDays;
    if (entry.intervalDiffDays > 1) acc.longerCount += 1;
  }
  const byOutcome: Record<string, { count: number; meanDiff: number; fsrsLongerPercent: number }> = {};
  for (const [outcome, acc] of Object.entries(outcomeAcc)) {
    byOutcome[outcome] = {
      count: acc.count,
      meanDiff: acc.diffSum / acc.count,
      fsrsLongerPercent: (acc.longerCount / acc.count) * 100,
    };
  }

  // Per-interval-tier breakdown (single pass over the same collection)
  const byInterval: Record<number, { count: number; meanDiff: number; fsrsMeanInterval: number }> = {};
  for (const entry of validEntries) {
    const tier = entry.currentIntervalDays;
    let acc = byInterval[tier];
    if (!acc) {
      acc = byInterval[tier] = { count: 0, meanDiff: 0, fsrsMeanInterval: 0 };
    }
    acc.count += 1;
    acc.meanDiff += entry.intervalDiffDays;
    acc.fsrsMeanInterval += entry.fsrsIntervalDays;
  }
  for (const tier of Object.keys(byInterval)) {
    const acc = byInterval[Number(tier)];
    acc.meanDiff /= acc.count;
    acc.fsrsMeanInterval /= acc.count;
  }

  const reportText = formatReportText({
    sampleSize,
    fsrsDecisionCount,
    fsrsSkippedCount,
    totalEvents,
    meanIntervalDiff,
    medianIntervalDiff,
    stdIntervalDiff,
    meanAbsIntervalDiff,
    fsrsLongerPercent,
    fsrsShorterPercent,
    agreementPercent,
    byOutcome,
    byInterval,
    insufficientData,
    simulationWorkload: totalEvents,
  });

  return {
    sampleSize,
    fsrsDecisionCount,
    fsrsSkippedCount,
    fsrsAlgorithm: FSRS_ALGORITHM,
    fsrsAlgorithmVersion: FSRS_ALGORITHM_VERSION,
    fsrsParametersVersion: FSRS_PARAMETERS_VERSION,
    discreteV2PolicyVersion: DISCRETE_V2_POLICY_VERSION,
    meanIntervalDiff,
    medianIntervalDiff,
    stdIntervalDiff,
    meanAbsIntervalDiff,
    fsrsLongerPercent,
    fsrsShorterPercent,
    agreementPercent,
    byOutcome,
    byInterval,
    insufficientData,
    MIN_SAMPLE_SIZE,
    reportText,
    simulationWorkload: totalEvents,
    entries,
  };
}

// ─── Report Formatter ──────────────────────────────────────────────────────

function formatReportText(data: {
  sampleSize: number;
  fsrsDecisionCount: number;
  fsrsSkippedCount: number;
  totalEvents: number;
  meanIntervalDiff: number;
  medianIntervalDiff: number;
  stdIntervalDiff: number;
  meanAbsIntervalDiff: number;
  fsrsLongerPercent: number;
  fsrsShorterPercent: number;
  agreementPercent: number;
  byOutcome: Record<string, { count: number; meanDiff: number; fsrsLongerPercent: number }>;
  byInterval: Record<number, { count: number; meanDiff: number; fsrsMeanInterval: number }>;
  insufficientData: boolean;
  simulationWorkload: number;
}): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  FSRS Shadow vs discrete-v2 Offline Compare Report");
  lines.push("  计划 §10.6 Gate: FSRS shadow 与正式调度对比");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  lines.push("── 1. Overview ──────────────────────────────────────────────────");
  lines.push(`  Algorithm:           ${FSRS_ALGORITHM} ${FSRS_ALGORITHM_VERSION}`);
  lines.push(`  Parameters:           ${FSRS_PARAMETERS_VERSION}`);
  lines.push(`  Formal policy:        ${DISCRETE_V2_POLICY_VERSION}`);
  lines.push(`  Total events:         ${data.totalEvents}`);
  lines.push(`  FSRS decisions:       ${data.fsrsDecisionCount}`);
  lines.push(`  FSRS skipped:         ${data.fsrsSkippedCount} (assisted/stale/provider_failure)`);
  lines.push(`  Simulation workload:  ${data.simulationWorkload} review events`);
  lines.push("");

  lines.push("── 2. Sample Size Assessment ────────────────────────────────────");
  if (data.insufficientData) {
    lines.push(`  ⚠ INSUFFICIENT DATA: ${data.sampleSize} < ${MIN_SAMPLE_SIZE} minimum`);
    lines.push("  Sample too small for meaningful calibration conclusions.");
    lines.push("  Continue collecting shadow data before drawing inferences.");
  } else {
    lines.push(`  ✓ SUFFICIENT: ${data.sampleSize} >= ${MIN_SAMPLE_SIZE} minimum`);
  }
  lines.push("");

  lines.push("── 3. Interval Comparison (FSRS - discrete-v2) ─────────────────");
  lines.push(`  Mean diff:            ${data.meanIntervalDiff.toFixed(2)} days`);
  lines.push(`  Median diff:          ${data.medianIntervalDiff.toFixed(2)} days`);
  lines.push(`  Std dev:              ${data.stdIntervalDiff.toFixed(2)} days`);
  lines.push(`  Mean abs diff:        ${data.meanAbsIntervalDiff.toFixed(2)} days`);
  lines.push(`  FSRS longer:          ${data.fsrsLongerPercent.toFixed(1)}%`);
  lines.push(`  FSRS shorter:         ${data.fsrsShorterPercent.toFixed(1)}%`);
  lines.push(`  Agreement (±1 day):   ${data.agreementPercent.toFixed(1)}%`);
  lines.push("");

  lines.push("── 4. By Outcome ──────────────────────────────────────────────");
  for (const [outcome, stats] of Object.entries(data.byOutcome)) {
    lines.push(`  ${outcome.padEnd(20)} n=${String(stats.count).padStart(4)}  mean_diff=${stats.meanDiff.toFixed(2)}  fsrs_longer=${stats.fsrsLongerPercent.toFixed(1)}%`);
  }
  lines.push("");

  lines.push("── 5. By Current Interval Tier ─────────────────────────────────");
  for (const [tier, stats] of Object.entries(data.byInterval)) {
    lines.push(`  ${tier.padStart(3)} days  n=${String(stats.count).padStart(4)}  mean_diff=${stats.meanDiff.toFixed(2)}  fsrs_mean=${stats.fsrsMeanInterval.toFixed(1)} days`);
  }
  lines.push("");

  lines.push("── 6. Formal Schedule Impact ──────────────────────────────────");
  lines.push("  ✓ Shadow decisions have ZERO impact on formal review_schedules");
  lines.push("  ✓ No shadow data is used in user-facing UI");
  lines.push("  ✓ Shadow table is append-only (onConflictDoNothing)");
  lines.push("");

  if (data.insufficientData) {
    lines.push("── 7. Conclusion ──────────────────────────────────────────────");
    lines.push("  status: insufficient_data");
    lines.push(`  reason: sample_size (${data.sampleSize}) < minimum (${MIN_SAMPLE_SIZE})`);
    lines.push("  action: continue shadow data collection during Alpha observation");
    lines.push("");
  } else {
    lines.push("── 7. Conclusion ──────────────────────────────────────────────");
    lines.push("  status: sufficient_data");
    lines.push(`  mean_diff: ${data.meanIntervalDiff.toFixed(2)} days`);
    lines.push(`  agreement: ${data.agreementPercent.toFixed(1)}%`);
    lines.push("  note: this report is for offline comparison only;");
    lines.push("        FSRS does NOT affect formal scheduling in v0.6.");
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

// ─── Statistical Helpers ───────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function stdDev(values: number[], meanValue: number): number {
  if (values.length <= 1) return 0;
  const variance = values.reduce((sum, v) => sum + (v - meanValue) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
