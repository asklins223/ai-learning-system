/**
 * FSRS Shadow Adapter (计划 §6.8, §10.6)
 *
 * 此模块只写 shadow decision，对正式 schedule 零影响。
 * FSRS 结果不进入普通用户 UI。
 *
 * 算法语义以 [FSRS 官方算法说明](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)
 * 和 [官方 benchmark](https://github.com/open-spaced-repetition/srs-benchmark) 为参考。
 *
 * Rating 映射（计划 §16 M0 开放决策）：
 * - 独立作答的 correct → Good (Rating.Good = 3)
 * - partial → Hard (Rating.Hard = 2)
 * - incorrect/unable → Again (Rating.Again = 1)
 * - assisted/invalid/provider failure 不作为有效训练事件
 * - 不虚构 Easy (Rating.Easy = 4)
 *
 * 算法版本：ts-fsrs@4.6.0 (pinned)
 */

import {
  fsrs,
  Rating,
  createEmptyCard,
  type Card as FSRSCard,
} from "ts-fsrs";

// ─── Constants ──────────────────────────────────────────────────────────────

export const FSRS_ALGORITHM = "fsrs" as const;
export const FSRS_ALGORITHM_VERSION = "ts-fsrs-4.6.0" as const;
export const FSRS_PARAMETERS_VERSION = "fsrs-default-2026-07-25" as const;

// ─── Types ──────────────────────────────────────────────────────────────────

/** FSRS review rating (计划 §16 映射) */
export type FSRSRating = 1 | 2 | 3; // Again | Hard | Good

/**
 * Shadow decision input — 不含答案正文。
 */
export interface FSRSShadowInput {
  workspaceId: string;
  userId: string;
  keyPointId: string | null;
  sourceType: "validation_event" | "review_attempt";
  sourceId: string;
  /** 当前正式 interval days (来自 discrete-v2) */
  currentIntervalDays: number;
  /** 本次 outcome */
  outcome: "correct" | "partial" | "incorrect" | "unable" | "source_viewed" | "stale" | "provider_failure";
  /** 服务器时间 */
  now: Date;
  /** 用户是否独立作答（assisted/invalid 不作为有效训练事件） */
  isUnassisted: boolean;
}

/**
 * FSRS shadow decision — 写入 scheduling_shadow_decisions 表。
 */
export interface FSRSShadowDecision {
  workspaceId: string;
  userId: string;
  keyPointId: string | null;
  sourceType: string;
  sourceId: string;
  algorithm: string;
  algorithmVersion: string;
  parametersVersion: string;
  inputSnapshot: Record<string, unknown>;
  predictedDueAt: Date;
  stability: unknown;
  difficulty: unknown;
  retrievability: unknown;
}

// ─── FSRS Engine ───────────────────────────────────────────────────────────

/**
 * Pinned FSRS instance with default parameters.
 * The parameters are the library defaults; in v0.7 we can optimize per-user.
 */
const fsrsInstance = fsrs();

/**
 * Map validation/review outcome to FSRS rating (计划 §16).
 *
 * Only unassisted results produce valid training events:
 * - correct → Good (Rating.Good = 3)
 * - partial → Hard (Rating.Hard = 2)
 * - incorrect/unable → Again (Rating.Again = 1)
 * - source_viewed, stale, provider_failure, or assisted → not a valid event
 *
 * We never fabricate Easy (Rating.Easy = 4).
 */
export function outcomeToFSRSRating(
  outcome: FSRSShadowInput["outcome"],
  isUnassisted: boolean,
): FSRSRating | null {
  if (!isUnassisted) return null;

  switch (outcome) {
    case "correct":
      return Rating.Good as FSRSRating; // 3
    case "partial":
      return Rating.Hard as FSRSRating; // 2
    case "incorrect":
    case "unable":
      return Rating.Again as FSRSRating; // 1
    case "source_viewed":
    case "stale":
    case "provider_failure":
      return null; // Not a valid training event
    default:
      return null;
  }
}

/**
 * Compute FSRS shadow decision for a single review event.
 *
 * If the input is not a valid training event (assisted, stale, etc.),
 * returns null — caller should skip writing the shadow row.
 *
 * For the first review (no prior FSRS state), we start from State.New.
 * For subsequent reviews, we simulate by creating a card with the current
 * interval as a starting point, then scheduling the next review.
 *
 * v0.6 已知限制：此函数始终从 State.New 的空卡片开始计算，不使用
 * `currentIntervalDays` 初始化卡片状态。这意味着每次 shadow decision
 * 都模拟"首次复习"场景，不累积 stability/difficulty。对于 v0.6 的
 * shadow 目的（确定性回放和离线对比），这是可接受的；完整的 FSRS
 * 状态累积进入 v0.7。
 *
 * The shadow decision includes the predicted due date, stability,
 * difficulty, and retrievability — all for offline comparison only.
 */
export function computeFSRSShadowDecision(
  input: FSRSShadowInput,
): FSRSShadowDecision | null {
  const rating = outcomeToFSRSRating(input.outcome, input.isUnassisted);
  if (rating === null) return null;

  // Create an empty card (State.New) for the first review.
  const card: FSRSCard = createEmptyCard();

  // Schedule the next review
  const now = input.now;
  const scheduledCards = fsrsInstance.repeat(card, now);

  // Get the result for the given rating
  const result = scheduledCards[rating];
  if (!result) return null;

  return {
    workspaceId: input.workspaceId,
    userId: input.userId,
    keyPointId: input.keyPointId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    algorithm: FSRS_ALGORITHM,
    algorithmVersion: FSRS_ALGORITHM_VERSION,
    parametersVersion: FSRS_PARAMETERS_VERSION,
    inputSnapshot: {
      currentIntervalDays: input.currentIntervalDays,
      outcome: input.outcome,
      isUnassisted: input.isUnassisted,
      rating,
      // 不含答案正文
    },
    predictedDueAt: result.card.due,
    stability: result.card.stability,
    difficulty: result.card.difficulty,
    retrievability: fsrsInstance.get_retrievability(result.card, now),
  };
}

/**
 * Check if the FSRS shadow is enabled (feature flag).
 * Default: false (计划 §12.2).
 */
export function isFSRSShadowEnabled(): boolean {
  return process.env.FSRS_SHADOW_ENABLED === "true";
}

// ─── Golden Vectors (计划 §10.6) ───────────────────────────────────────────

/**
 * Golden vector: a fixed input→output pair that verifies the pinned FSRS
 * implementation produces deterministic results.
 *
 * If the library changes or the algorithm version changes, these vectors
 * must be re-verified.
 */
export interface FSRSGoldenVector {
  name: string;
  input: {
    rating: FSRSRating;
    now: string; // ISO date
  };
  expected: {
    due: string; // ISO date
    stability: number;
    difficulty: number;
  };
}

/**
 * Immutable outputs captured from ts-fsrs@4.6.0 with its default parameters.
 * A dependency or parameter drift must make verification fail until these
 * values are intentionally reviewed and versioned.
 */
export const FSRS_GOLDEN_VECTORS: readonly FSRSGoldenVector[] = [
  {
    name: "first_review_incorrect_again",
    input: { rating: 1, now: "2026-07-25T00:00:00.000Z" },
    expected: {
      due: "2026-07-25T00:01:00.000Z",
      stability: 0.40255,
      difficulty: 7.1949,
    },
  },
  {
    name: "first_review_partial_hard",
    input: { rating: 2, now: "2026-07-25T00:00:00.000Z" },
    expected: {
      due: "2026-07-25T00:05:00.000Z",
      stability: 1.18385,
      difficulty: 6.48830527,
    },
  },
  {
    name: "first_review_correct_good",
    input: { rating: 3, now: "2026-07-25T00:00:00.000Z" },
    expected: {
      due: "2026-07-25T00:10:00.000Z",
      stability: 3.173,
      difficulty: 5.28243442,
    },
  },
] as const;

/**
 * Verify golden vectors against the pinned FSRS implementation.
 * Returns true if all vectors pass, false otherwise.
 *
 * Callers may pass a candidate vector set to test the verifier itself.
 */
export function verifyGoldenVectors(
  vectors: readonly FSRSGoldenVector[] = FSRS_GOLDEN_VECTORS,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];

  for (const vector of vectors) {
    const testDate = new Date(vector.input.now);
    const card = createEmptyCard(testDate);
    const results = fsrsInstance.repeat(card, testDate);
    const result = results[vector.input.rating];

    if (!result) {
      failures.push(`${vector.name}: no result returned`);
      continue;
    }

    if (result.card.due.toISOString() !== vector.expected.due) {
      failures.push(
        `${vector.name}: due expected ${vector.expected.due}, got ${result.card.due.toISOString()}`,
      );
    }
    if (result.card.stability !== vector.expected.stability) {
      failures.push(
        `${vector.name}: stability expected ${vector.expected.stability}, got ${result.card.stability}`,
      );
    }
    if (result.card.difficulty !== vector.expected.difficulty) {
      failures.push(
        `${vector.name}: difficulty expected ${vector.expected.difficulty}, got ${result.card.difficulty}`,
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Generate golden vectors for documentation purposes.
 * This function computes the expected outputs for each rating
 * using the pinned library version.
 */
export function generateGoldenVectors(): FSRSGoldenVector[] {
  return FSRS_GOLDEN_VECTORS.map((vector) => ({
    name: vector.name,
    input: { ...vector.input },
    expected: { ...vector.expected },
  }));
}
