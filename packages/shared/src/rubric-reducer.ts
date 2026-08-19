/**
 * rubric-reducer-v1: 确定性 outcome 计算 (计划 §7.3)
 *
 * 纯函数：不读取时钟、不修改状态、不调用外部服务。
 * 所有 verdict 组合都必须命中且 fail closed。
 *
 * 规则总序：
 * 1. 任一 item（required 或 optional）为 contradicted → misunderstanding
 * 2. 无 contradiction，且全部 item 均为 missing | not_assessable → unknown
 * 3. 无 contradiction，但任一 required item 为 missing | not_assessable | partial → unclear_expression
 * 4. 无 contradiction、全部 required item 为 covered，且加权 (covered + 0.5 × partial) / total ≥ 0.70 → preliminary_understanding
 * 5. 其余情况只要存在 covered | partial → unclear_expression
 * 6. 理论兜底 → unknown，并记录 reducer invariant violation
 */

import {
  RubricVerdict,
  ValidationOutcome,
  type RubricVerdict as RubricVerdictType,
  type ValidationOutcome as ValidationOutcomeType,
} from "./enums.ts";
import { DomainError } from "./domain-error.ts";

// ─── Types ────────────────────────────────────────────────────────────────

export interface RubricItemInput {
  /** Stable key from the AI output, used for diagnostics only */
  key: string;
  verdict: RubricVerdictType;
  weight: number; // 1 | 2 | 3
  required: boolean;
}

export interface RubricReducerResult {
  outcome: ValidationOutcomeType;
  /** Weighted coverage ratio: (covered_weight + 0.5 * partial_weight) / total_weight */
  weightedCoverage: number;
  /** Whether any rubric item was contradicted */
  hasContradiction: boolean;
  /** Whether all required items are covered */
  allRequiredCovered: boolean;
  /** Reducer version for traceability */
  reducerVersion: "rubric-reducer-v1";
  /** Set to true only if the theoretical fallback (rule 6) was hit */
  invariantViolation: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────

export const RUBRIC_REDUCER_VERSION = "rubric-reducer-v1" as const;

/** 加权覆盖阈值 (计划 §16 默认建议) */
export const RUBRIC_COVERAGE_THRESHOLD = 0.70;

const VERDICTS = new Set<string>(Object.values(RubricVerdict));

// ─── Validation ───────────────────────────────────────────────────────────

export class RubricReducerError extends DomainError {
  readonly code: "empty_rubric" | "invalid_verdict" | "invalid_weight" | "no_required_item";

  constructor(code: "empty_rubric" | "invalid_verdict" | "invalid_weight" | "no_required_item") {
    super({ name: "RubricReducerError", code, message: code, statusCode: 400 });
    this.code = code;
  }
}

function validateItems(items: RubricItemInput[]): void {
  if (!Array.isArray(items) || items.length === 0) {
    throw new RubricReducerError("empty_rubric");
  }
  const hasRequired = items.some((item) => item.required);
  if (!hasRequired) {
    throw new RubricReducerError("no_required_item");
  }
  for (const item of items) {
    if (!VERDICTS.has(item.verdict)) {
      throw new RubricReducerError("invalid_verdict");
    }
    if (!Number.isInteger(item.weight) || item.weight < 1 || item.weight > 3) {
      throw new RubricReducerError("invalid_weight");
    }
  }
}

// ─── Reducer ──────────────────────────────────────────────────────────────

/**
 * Compute the canonical validation outcome from rubric item verdicts.
 *
 * This function is a total function over all valid verdict combinations.
 * It never throws for valid inputs (only for structurally invalid inputs
 * like empty rubrics or invalid weights).
 */
export function reduceRubric(items: RubricItemInput[]): RubricReducerResult {
  validateItems(items);

  const hasContradiction = items.some((item) => item.verdict === RubricVerdict.CONTRADICTED);
  const allRequiredCovered = items
    .filter((item) => item.required)
    .every((item) => item.verdict === RubricVerdict.COVERED);

  // Weighted coverage: (sum of covered_weight + 0.5 * partial_weight) / total_weight
  let coveredWeight = 0;
  let partialWeight = 0;
  let totalWeight = 0;
  for (const item of items) {
    totalWeight += item.weight;
    if (item.verdict === RubricVerdict.COVERED) {
      coveredWeight += item.weight;
    } else if (item.verdict === RubricVerdict.PARTIAL) {
      partialWeight += item.weight;
    }
  }
  const weightedCoverage = totalWeight > 0 ? (coveredWeight + 0.5 * partialWeight) / totalWeight : 0;

  // Rule 1: Any contradiction → misunderstanding
  if (hasContradiction) {
    return {
      outcome: ValidationOutcome.MISUNDERSTANDING,
      weightedCoverage,
      hasContradiction: true,
      allRequiredCovered,
      reducerVersion: RUBRIC_REDUCER_VERSION,
      invariantViolation: false,
    };
  }

  // Rule 2: All items missing | not_assessable → unknown
  const allMissingOrNotAssessable = items.every(
    (item) =>
      item.verdict === RubricVerdict.MISSING || item.verdict === RubricVerdict.NOT_ASSESSABLE,
  );
  if (allMissingOrNotAssessable) {
    return {
      outcome: ValidationOutcome.UNKNOWN,
      weightedCoverage,
      hasContradiction: false,
      allRequiredCovered: false,
      reducerVersion: RUBRIC_REDUCER_VERSION,
      invariantViolation: false,
    };
  }

  // Rule 3: Any required item is missing | not_assessable | partial → unclear_expression
  const requiredNotCovered = items.some(
    (item) =>
      item.required &&
      (item.verdict === RubricVerdict.MISSING ||
        item.verdict === RubricVerdict.NOT_ASSESSABLE ||
        item.verdict === RubricVerdict.PARTIAL),
  );
  if (requiredNotCovered) {
    return {
      outcome: ValidationOutcome.UNCLEAR_EXPRESSION,
      weightedCoverage,
      hasContradiction: false,
      allRequiredCovered: false,
      reducerVersion: RUBRIC_REDUCER_VERSION,
      invariantViolation: false,
    };
  }

  // Rule 4: All required covered AND weighted coverage ≥ threshold → preliminary_understanding
  if (allRequiredCovered && weightedCoverage >= RUBRIC_COVERAGE_THRESHOLD) {
    return {
      outcome: ValidationOutcome.PRELIMINARY_UNDERSTANDING,
      weightedCoverage,
      hasContradiction: false,
      allRequiredCovered: true,
      reducerVersion: RUBRIC_REDUCER_VERSION,
      invariantViolation: false,
    };
  }

  // Rule 5: Otherwise, if any covered | partial exists → unclear_expression
  const hasAnyCoveredOrPartial = items.some(
    (item) =>
      item.verdict === RubricVerdict.COVERED || item.verdict === RubricVerdict.PARTIAL,
  );
  if (hasAnyCoveredOrPartial) {
    return {
      outcome: ValidationOutcome.UNCLEAR_EXPRESSION,
      weightedCoverage,
      hasContradiction: false,
      allRequiredCovered,
      reducerVersion: RUBRIC_REDUCER_VERSION,
      invariantViolation: false,
    };
  }

  // Rule 6: Theoretical fallback → unknown + invariant violation
  // This should never be reached if the above rules are exhaustive.
  // If it is, it means the verdict set has been extended without updating the reducer.
  return {
    outcome: ValidationOutcome.UNKNOWN,
    weightedCoverage,
    hasContradiction: false,
    allRequiredCovered,
    reducerVersion: RUBRIC_REDUCER_VERSION,
    invariantViolation: true,
  };
}

// ─── Review outcome mapping (计划 §7.3) ──────────────────────────────────

export const VALIDATION_TO_REVIEW_OUTCOME: Record<ValidationOutcomeType, string> = {
  [ValidationOutcome.PRELIMINARY_UNDERSTANDING]: "correct",
  [ValidationOutcome.UNCLEAR_EXPRESSION]: "partial",
  [ValidationOutcome.MISUNDERSTANDING]: "incorrect",
  [ValidationOutcome.UNKNOWN]: "unable",
};

/**
 * Map a validation outcome to the canonical review outcome.
 * This is the fixed mapping defined in 计划 §7.3.
 */
export function toReviewOutcome(outcome: ValidationOutcomeType): string {
  return VALIDATION_TO_REVIEW_OUTCOME[outcome];
}

// ─── Unable helper (计划 §7.3) ────────────────────────────────────────────

/**
 * Generate deterministic missing assessments for all rubric items when the
 * user explicitly declares "unable". Each item gets verdict=missing with
 * assessment_source=user_declared_unable.
 */
export function unableAssessments(
  items: Array<{ key: string; weight: number; required: boolean }>,
): Array<{
  key: string;
  verdict: RubricVerdictType;
  weight: number;
  required: boolean;
}> {
  return items.map((item) => ({
    key: item.key,
    verdict: RubricVerdict.MISSING,
    weight: item.weight,
    required: item.required,
  }));
}
