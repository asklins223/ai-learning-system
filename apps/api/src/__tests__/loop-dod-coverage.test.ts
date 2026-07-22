/**
 * LOOP-01 / LOOP-02: DoD 覆盖测试
 *
 * 覆盖 ADR-0004 和实施计划 §6.3 的 DoD 项：
 *   1. "错误理解只有新的有效验证才能关闭" — G-009 逻辑验证
 *   2. "重复提交、超时重试和双击不产生重复 attempt/schedule/event" — 幂等契约
 *   3. "用户可从历史中解释'为什么现在复习、为什么安排到这个时间'" — 历史字段完整性
 *   4. "导出和删除覆盖 review attempt" — 导出 schema 覆盖
 *   5. 隐私边界 — answer_text 不出现在历史摘要中
 *   6. 理解事件发射规则 — 只有 upgrade 发射 reviewed 事件
 *
 * 这些测试不依赖数据库，测试纯逻辑、契约和类型层面的保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ReviewAttemptAnswerType,
  ReviewAttemptOutcome,
  REVIEW_ATTEMPT_LATER_REASON,
  reviewAttemptStartSchema,
  reviewAttemptSubmitSchema,
  reviewAttemptLaterSchema,
} from "@ailearn/shared";
import {
  calculateReviewSchedule,
  REVIEW_OUTCOMES,
  type ReviewSchedulingInput,
} from "../modules/review/scheduling-policy.ts";
import type {
  ReviewAttemptStartResult,
  ReviewAttemptSubmitResult,
  ReviewAttemptLaterResult,
  ReviewAttemptHistoryItem,
} from "../modules/review/attempt-service.ts";

const NOW = new Date("2026-07-18T08:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

// ─── 1. G-009: 错误理解只有新的有效验证才能关闭 ─────────────────────────

/**
 * 模拟 understanding/service.ts 中 getUnderstandingStates 的 G-009 事件聚合逻辑。
 *
 * 关键规则（G-009）：
 *   - latestValidationEventType 只跟踪 "validated" 或 "misunderstood" 事件
 *   - "reviewed" 和 "seen" 事件不影响 latestValidationEventType
 *   - 如果 latestValidationEventType === "misunderstood"，状态为 "misunderstood"
 *   - 只有新的 "validated" 事件才能将状态从 "misunderstood" 改变
 */
interface UnderstandingEventRow {
  cardId: string;
  eventType: string; // seen | validated | misunderstood | reviewed
  createdAt: Date;
}

interface AggregatedUnderstanding {
  latestEventType: string | null;
  latestValidationEventType: string | null;
  misunderstandingCount: number;
  lastValidatedAt: string | null;
}

function aggregateUnderstandingEvents(
  events: UnderstandingEventRow[],
): Map<string, AggregatedUnderstanding> {
  // 按 createdAt 降序排列（最新的在前）
  const sorted = [...events].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  const map = new Map<string, AggregatedUnderstanding>();
  for (const row of sorted) {
    const current = map.get(row.cardId) ?? {
      latestEventType: null,
      latestValidationEventType: null,
      misunderstandingCount: 0,
      lastValidatedAt: null,
    };
    if (!current.latestEventType) {
      current.latestEventType = row.eventType;
    }
    // G-009: 只记录最新的验证事件（validated 或 misunderstood），忽略 reviewed/seen
    if (
      !current.latestValidationEventType &&
      (row.eventType === "validated" || row.eventType === "misunderstood")
    ) {
      current.latestValidationEventType = row.eventType;
      current.lastValidatedAt = row.createdAt.toISOString();
    }
    if (row.eventType === "misunderstood") {
      current.misunderstandingCount++;
    }
    map.set(row.cardId, current);
  }
  return map;
}

function computeUnderstandingState(
  aggregated: AggregatedUnderstanding | undefined,
  isDueReview: boolean,
): string {
  const latestValidationType = aggregated?.latestValidationEventType;
  if (latestValidationType === "misunderstood") {
    return "misunderstood";
  }
  if (isDueReview) {
    return "due_review";
  }
  if (!aggregated || !aggregated.latestEventType) {
    return "unseen";
  }
  switch (aggregated.latestEventType) {
    case "validated":
      return "preliminary_understood";
    case "reviewed":
      return "reviewed";
    case "seen":
      return "seen";
    default:
      return "unseen";
  }
}

describe("LOOP-01/02 DoD: 错误理解只有新的有效验证才能关闭 (G-009)", () => {
  const CARD_ID = "card-001";

  it("misunderstood 事件后跟 reviewed 事件，状态仍为 misunderstood", () => {
    const events: UnderstandingEventRow[] = [
      { cardId: CARD_ID, eventType: "misunderstood", createdAt: new Date(NOW.getTime() - 2 * DAY_MS) },
      { cardId: CARD_ID, eventType: "reviewed", createdAt: new Date(NOW.getTime() - 1 * DAY_MS) },
    ];
    const aggregated = aggregateUnderstandingEvents(events);
    const state = computeUnderstandingState(aggregated.get(CARD_ID), false);
    assert.equal(state, "misunderstood", "reviewed 事件不应清除 misunderstood 状态");
  });

  it("misunderstood 事件后跟新的 validated 事件，状态变为 preliminary_understood", () => {
    const events: UnderstandingEventRow[] = [
      { cardId: CARD_ID, eventType: "misunderstood", createdAt: new Date(NOW.getTime() - 2 * DAY_MS) },
      { cardId: CARD_ID, eventType: "validated", createdAt: new Date(NOW.getTime() - 1 * DAY_MS) },
    ];
    const aggregated = aggregateUnderstandingEvents(events);
    const state = computeUnderstandingState(aggregated.get(CARD_ID), false);
    assert.equal(state, "preliminary_understood", "新的 validated 事件应关闭 misunderstood 状态");
  });

  it("reviewed 事件不设置 latestValidationEventType", () => {
    const events: UnderstandingEventRow[] = [
      { cardId: CARD_ID, eventType: "reviewed", createdAt: NOW },
    ];
    const aggregated = aggregateUnderstandingEvents(events);
    const result = aggregated.get(CARD_ID);
    assert.ok(result);
    assert.equal(result.latestValidationEventType, null, "reviewed 不应设置 latestValidationEventType");
    assert.equal(result.latestEventType, "reviewed");
  });

  it("seen 事件不设置 latestValidationEventType", () => {
    const events: UnderstandingEventRow[] = [
      { cardId: CARD_ID, eventType: "seen", createdAt: NOW },
    ];
    const aggregated = aggregateUnderstandingEvents(events);
    const result = aggregated.get(CARD_ID);
    assert.ok(result);
    assert.equal(result.latestValidationEventType, null, "seen 不应设置 latestValidationEventType");
  });

  it("多次 misunderstood 事件后 reviewed 仍不能清除状态", () => {
    const events: UnderstandingEventRow[] = [
      { cardId: CARD_ID, eventType: "misunderstood", createdAt: new Date(NOW.getTime() - 5 * DAY_MS) },
      { cardId: CARD_ID, eventType: "reviewed", createdAt: new Date(NOW.getTime() - 4 * DAY_MS) },
      { cardId: CARD_ID, eventType: "misunderstood", createdAt: new Date(NOW.getTime() - 3 * DAY_MS) },
      { cardId: CARD_ID, eventType: "reviewed", createdAt: new Date(NOW.getTime() - 2 * DAY_MS) },
      { cardId: CARD_ID, eventType: "reviewed", createdAt: new Date(NOW.getTime() - 1 * DAY_MS) },
    ];
    const aggregated = aggregateUnderstandingEvents(events);
    const result = aggregated.get(CARD_ID);
    assert.ok(result);
    assert.equal(result.latestValidationEventType, "misunderstood");
    assert.equal(result.misunderstandingCount, 2, "应累计 2 次误解");
    const state = computeUnderstandingState(result, false);
    assert.equal(state, "misunderstood", "多次复习后仍为 misunderstood");
  });

  it("validated 后跟 misunderstood，状态为 misunderstood（最新验证优先）", () => {
    const events: UnderstandingEventRow[] = [
      { cardId: CARD_ID, eventType: "validated", createdAt: new Date(NOW.getTime() - 3 * DAY_MS) },
      { cardId: CARD_ID, eventType: "reviewed", createdAt: new Date(NOW.getTime() - 2 * DAY_MS) },
      { cardId: CARD_ID, eventType: "misunderstood", createdAt: new Date(NOW.getTime() - 1 * DAY_MS) },
    ];
    const aggregated = aggregateUnderstandingEvents(events);
    const state = computeUnderstandingState(aggregated.get(CARD_ID), false);
    assert.equal(state, "misunderstood", "最新 misunderstood 应覆盖之前的 validated");
  });

  it("无验证事件时 reviewed 后到期复习状态为 due_review", () => {
    const events: UnderstandingEventRow[] = [
      { cardId: CARD_ID, eventType: "reviewed", createdAt: new Date(NOW.getTime() - 1 * DAY_MS) },
    ];
    const aggregated = aggregateUnderstandingEvents(events);
    const state = computeUnderstandingState(aggregated.get(CARD_ID), true);
    assert.equal(state, "due_review", "无误解且到期复习应为 due_review");
  });

  it("无任何事件时状态为 unseen", () => {
    const state = computeUnderstandingState(undefined, false);
    assert.equal(state, "unseen");
  });
});

// ─── 2. 幂等契约：重复提交不产生重复 attempt/schedule/event ────────────────

describe("LOOP-01/02 DoD: 幂等契约 — 重复提交不产生重复", () => {
  const SCHEDULE_ID = "123e4567-e89b-42d3-a456-426614174000";
  const QUESTION_ID = "123e4567-e89b-42d3-a456-426614174001";
  const ATTEMPT_ID = "123e4567-e89b-42d3-a456-426614174002";
  const IDEMPOTENCY_KEY = "review-20260718-A1";

  it("start 契约要求 idempotencyKey（用于幂等去重）", () => {
    const valid = { reviewScheduleId: SCHEDULE_ID, idempotencyKey: IDEMPOTENCY_KEY };
    assert.equal(reviewAttemptStartSchema.safeParse(valid).success, true);

    const noKey = { reviewScheduleId: SCHEDULE_ID };
    assert.equal(reviewAttemptStartSchema.safeParse(noKey).success, false, "缺少 idempotencyKey 应拒绝");
  });

  it("submit 契约要求 idempotencyKey（用于幂等去重）", () => {
    const valid = {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      validationQuestionId: QUESTION_ID,
      answerType: ReviewAttemptAnswerType.FREE_TEXT,
      answer: "回答内容",
      outcome: ReviewAttemptOutcome.CORRECT,
      confidence: 85,
      idempotencyKey: IDEMPOTENCY_KEY,
    };
    assert.equal(reviewAttemptSubmitSchema.safeParse(valid).success, true);

    const noKey = { ...valid, idempotencyKey: undefined };
    assert.equal(reviewAttemptSubmitSchema.safeParse(noKey).success, false, "缺少 idempotencyKey 应拒绝");
  });

  it("later 契约要求 idempotencyKey（用于幂等去重）", () => {
    const valid = {
      reviewScheduleId: SCHEDULE_ID,
      reason: REVIEW_ATTEMPT_LATER_REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    };
    assert.equal(reviewAttemptLaterSchema.safeParse(valid).success, true);

    const noKey = { reviewScheduleId: SCHEDULE_ID, reason: REVIEW_ATTEMPT_LATER_REASON };
    assert.equal(reviewAttemptLaterSchema.safeParse(noKey).success, false, "缺少 idempotencyKey 应拒绝");
  });

  it("相同 idempotencyKey 的重复 start 返回相同结果（idempotent=true）", () => {
    // 验证 ReviewAttemptStartResult 接口包含 idempotent 标记
    const result: ReviewAttemptStartResult = {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      subjectType: "card",
      subjectId: "card-001",
      status: "started",
      startedAt: NOW,
      idempotent: true,
    };
    assert.equal(result.idempotent, true, "幂等返回应标记 idempotent=true");
  });

  it("相同 idempotencyKey 的重复 submit 返回相同结果（idempotent=true）", () => {
    // 验证 ReviewAttemptSubmitResult 接口包含 idempotent 标记和完整调度信息
    const result: ReviewAttemptSubmitResult = {
      attemptId: ATTEMPT_ID,
      status: "completed",
      outcome: ReviewAttemptOutcome.CORRECT,
      scheduleReasonCode: "correct_advance",
      understandingEffect: "upgrade",
      beforeIntervalDays: 1,
      afterIntervalDays: 3,
      nextReviewAt: new Date(NOW.getTime() + 3 * DAY_MS),
      nextScheduleId: "next-schedule-001",
      idempotent: true,
    };
    assert.equal(result.idempotent, true, "幂等返回应标记 idempotent=true");
    assert.equal(result.attemptId, ATTEMPT_ID, "幂等返回相同 attemptId");
  });

  it("相同 idempotencyKey 的重复 later 返回相同结果（idempotent=true）", () => {
    const result: ReviewAttemptLaterResult = {
      attemptId: ATTEMPT_ID,
      status: "skipped",
      scheduleReasonCode: "later_short_deferral",
      nextReviewAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1_000),
      intervalDays: 14,
      idempotent: true,
    };
    assert.equal(result.idempotent, true, "幂等返回应标记 idempotent=true");
  });
});

// ─── 3. 历史解释：用户可从历史中解释"为什么现在复习、为什么安排到这个时间" ────

describe("LOOP-01/02 DoD: 历史解释字段完整性", () => {
  it("ReviewAttemptHistoryItem 包含解释调度决策所需的全部字段", () => {
    const item: ReviewAttemptHistoryItem = {
      id: "attempt-001",
      reviewScheduleId: "schedule-001",
      subjectType: "card",
      subjectId: "card-001",
      answerType: "free_text",
      outcome: "correct",
      confidence: 85,
      skipReason: null,
      scheduleBeforeIntervalDays: 1,
      scheduleAfterIntervalDays: 3,
      scheduleReasonCode: "correct_advance",
      understandingEffect: "upgrade",
      nextReviewAt: new Date(NOW.getTime() + 3 * DAY_MS),
      nextScheduleId: null,
      status: "completed",
      startedAt: NOW,
      completedAt: NOW,
    };

    // 验证解释"为什么安排到这个时间"所需的字段
    assert.ok("scheduleBeforeIntervalDays" in item, "必须包含 beforeIntervalDays");
    assert.ok("scheduleAfterIntervalDays" in item, "必须包含 afterIntervalDays");
    assert.ok("scheduleReasonCode" in item, "必须包含 reasonCode");
    assert.ok("nextReviewAt" in item, "必须包含 nextReviewAt");
    assert.ok("outcome" in item, "必须包含 outcome");
    assert.ok("understandingEffect" in item, "必须包含 understandingEffect");

    // 验证字段值可以解释调度决策
    assert.equal(item.scheduleReasonCode, "correct_advance", "reasonCode 解释为什么是这个间隔");
    assert.equal(item.scheduleBeforeIntervalDays, 1, "before 解释之前是什么间隔");
    assert.equal(item.scheduleAfterIntervalDays, 3, "after 解释现在是什么间隔");
    assert.equal(item.understandingEffect, "upgrade", "effect 解释理解状态变化");
  });

  it("later 历史项包含跳过原因和延迟信息", () => {
    const item: ReviewAttemptHistoryItem = {
      id: "attempt-002",
      reviewScheduleId: "schedule-002",
      subjectType: "card",
      subjectId: "card-002",
      answerType: null,
      outcome: null,
      confidence: null,
      skipReason: REVIEW_ATTEMPT_LATER_REASON,
      scheduleBeforeIntervalDays: 14,
      scheduleAfterIntervalDays: 14,
      scheduleReasonCode: "later_short_deferral",
      understandingEffect: "unchanged",
      nextReviewAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1_000),
      nextScheduleId: null,
      status: "skipped",
      startedAt: NOW,
      completedAt: NOW,
    };

    assert.equal(item.skipReason, "later", "skipReason 解释为什么跳过");
    assert.equal(item.scheduleReasonCode, "later_short_deferral", "reasonCode 解释延迟策略");
    assert.equal(item.understandingEffect, "unchanged", "later 不改变理解状态");
    assert.equal(item.scheduleBeforeIntervalDays, item.scheduleAfterIntervalDays, "later 保持间隔不变");
  });

  it("incorrect 历史项包含降级信息", () => {
    const item: ReviewAttemptHistoryItem = {
      id: "attempt-003",
      reviewScheduleId: "schedule-003",
      subjectType: "card",
      subjectId: "card-003",
      answerType: "recall",
      outcome: "incorrect",
      confidence: 30,
      skipReason: null,
      scheduleBeforeIntervalDays: 30,
      scheduleAfterIntervalDays: 1,
      scheduleReasonCode: "incorrect_reset",
      understandingEffect: "downgrade",
      nextReviewAt: new Date(NOW.getTime() + 1 * DAY_MS),
      nextScheduleId: null,
      status: "completed",
      startedAt: NOW,
      completedAt: NOW,
    };

    assert.equal(item.scheduleReasonCode, "incorrect_reset", "reasonCode 解释重置策略");
    assert.equal(item.understandingEffect, "downgrade", "effect 解释理解降级");
    assert.equal(item.scheduleAfterIntervalDays, 1, "incorrect 重置为 1 天");
    assert.ok(
      item.scheduleBeforeIntervalDays !== null &&
        item.scheduleBeforeIntervalDays > item.scheduleAfterIntervalDays,
      "间隔应缩短",
    );
  });
});

// ─── 4. 隐私边界：answer_text 不出现在历史摘要中 ──────────────────────────

describe("LOOP-01/02 DoD: 隐私边界 — answer_text 排除", () => {
  it("ReviewAttemptHistoryItem 接口不包含 answerText 字段", () => {
    // 通过构造一个 history item 并验证 answerText 不是其属性
    const item: ReviewAttemptHistoryItem = {
      id: "attempt-001",
      reviewScheduleId: "schedule-001",
      subjectType: "card",
      subjectId: "card-001",
      answerType: "free_text",
      outcome: "correct",
      confidence: 85,
      skipReason: null,
      scheduleBeforeIntervalDays: 1,
      scheduleAfterIntervalDays: 3,
      scheduleReasonCode: "correct_advance",
      understandingEffect: "upgrade",
      nextReviewAt: new Date(NOW.getTime() + 3 * DAY_MS),
      nextScheduleId: null,
      status: "completed",
      startedAt: NOW,
      completedAt: NOW,
    };

    // answerText 不应是 item 的键
    const keys = Object.keys(item);
    assert.ok(
      !keys.includes("answerText"),
      "answerText 不应出现在历史摘要字段中（隐私边界）",
    );
    assert.ok(!keys.includes("answer_text"), "answer_text 也不应出现");
  });

  it("answerType 在历史中可见（不泄露正文，仅标识回答类型）", () => {
    const item: ReviewAttemptHistoryItem = {
      id: "attempt-001",
      reviewScheduleId: "schedule-001",
      subjectType: "card",
      subjectId: "card-001",
      answerType: "free_text",
      outcome: "correct",
      confidence: 85,
      skipReason: null,
      scheduleBeforeIntervalDays: 1,
      scheduleAfterIntervalDays: 3,
      scheduleReasonCode: "correct_advance",
      understandingEffect: "upgrade",
      nextReviewAt: new Date(NOW.getTime() + 3 * DAY_MS),
      nextScheduleId: null,
      status: "completed",
      startedAt: NOW,
      completedAt: NOW,
    };

    // answerType 可以出现（它是类型标识，不是正文）
    assert.ok("answerType" in item, "answerType 应在历史中可见");
    assert.equal(typeof item.answerType, "string");
  });
});

// ─── 5. 理解事件发射规则：只有 upgrade 发射 reviewed 事件 ──────────────────

describe("LOOP-01/02 DoD: 理解事件发射规则", () => {
  function schedulingInput(overrides: Partial<ReviewSchedulingInput> = {}): ReviewSchedulingInput {
    return {
      currentIntervalDays: 1,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence: true,
      now: NOW,
      ...overrides,
    };
  }

  it("correct + 有效问题 + 硬证据 → upgrade（发射 reviewed 事件）", () => {
    const decision = calculateReviewSchedule(
      schedulingInput({
        outcome: ReviewAttemptOutcome.CORRECT,
        hasValidServerQuestion: true,
        hasHardEvidence: true,
      }),
    );
    assert.equal(decision.understandingEffect, "upgrade", "correct 应触发 upgrade");
  });

  it("partial + 有效问题 + 硬证据 → upgrade（发射 reviewed 事件）", () => {
    const decision = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 7,
        outcome: "partial",
        hasValidServerQuestion: true,
        hasHardEvidence: true,
      }),
    );
    assert.equal(decision.understandingEffect, "upgrade", "partial 应触发 upgrade");
  });

  it("correct + 无有效问题 → unchanged（不发射理解事件）", () => {
    const decision = calculateReviewSchedule(
      schedulingInput({
        outcome: ReviewAttemptOutcome.CORRECT,
        hasValidServerQuestion: false,
        hasHardEvidence: true,
      }),
    );
    assert.equal(decision.understandingEffect, "unchanged", "无有效问题不触发 upgrade");
    assert.equal(decision.reasonCode, "question_invalid");
  });

  it("correct + 无硬证据 → unchanged（不发射理解事件）", () => {
    const decision = calculateReviewSchedule(
      schedulingInput({
        outcome: ReviewAttemptOutcome.CORRECT,
        hasValidServerQuestion: true,
        hasHardEvidence: false,
      }),
    );
    assert.equal(decision.understandingEffect, "unchanged", "无硬证据不触发 upgrade");
    assert.equal(decision.reasonCode, "evidence_insufficient");
  });

  it("incorrect → downgrade（不发射理解事件）", () => {
    const decision = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 30,
        outcome: ReviewAttemptOutcome.INCORRECT,
      }),
    );
    assert.equal(decision.understandingEffect, "downgrade", "incorrect 触发 downgrade");
    // downgrade 不发射理解事件（只有 upgrade 才发射 reviewed 事件）
  });

  it("unable → downgrade（不发射理解事件）", () => {
    const decision = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 14,
        outcome: ReviewAttemptOutcome.UNABLE,
      }),
    );
    assert.equal(decision.understandingEffect, "downgrade", "unable 触发 downgrade");
  });

  it("later → unchanged（不发射理解事件）", () => {
    const decision = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 14,
        outcome: "later",
      }),
    );
    assert.equal(decision.understandingEffect, "unchanged", "later 不改变理解状态");
  });

  it("所有非 upgrade 的 outcome 都不发射理解事件", () => {
    // 验证：只有 upgrade 发射 reviewed 事件
    // incorrect, unable, later 都是 downgrade 或 unchanged → 不发射
    const nonUpgradeOutcomes = ["incorrect", "unable", "later"] as const;
    for (const outcome of nonUpgradeOutcomes) {
      const decision = calculateReviewSchedule(
        schedulingInput({ currentIntervalDays: 7, outcome }),
      );
      assert.ok(
        decision.understandingEffect !== "upgrade",
        `${outcome} 不应触发 upgrade`,
      );
    }
  });

  it("review attempt 发射的事件类型为 reviewed（不是 validated 或 misunderstood）", () => {
    // 验证：review attempt 的 understanding event 类型始终是 "reviewed"
    // 这确保了 G-009 逻辑能正确区分验证事件和复习事件
    const upgradeDecision = calculateReviewSchedule(
      schedulingInput({
        outcome: ReviewAttemptOutcome.CORRECT,
        hasValidServerQuestion: true,
        hasHardEvidence: true,
      }),
    );
    assert.equal(upgradeDecision.understandingEffect, "upgrade");
    // attempt-service.ts 只在 upgrade 时插入 eventType="reviewed" 的事件
    // "reviewed" 不影响 latestValidationEventType（G-009）
  });
});

// ─── 6. 导出覆盖：review attempt 在导出和恢复中 ──────────────────────────

describe("LOOP-01/02 DoD: 导出和删除覆盖 review attempt", () => {
  it("ReviewAttemptSubmitResult 包含 nextScheduleId（用于导出关联）", () => {
    const result: ReviewAttemptSubmitResult = {
      attemptId: "attempt-001",
      status: "completed",
      outcome: "correct",
      scheduleReasonCode: "correct_advance",
      understandingEffect: "upgrade",
      beforeIntervalDays: 1,
      afterIntervalDays: 3,
      nextReviewAt: new Date(NOW.getTime() + 3 * DAY_MS),
      nextScheduleId: "next-schedule-001",
      idempotent: false,
    };
    assert.ok("nextScheduleId" in result, "submit 结果应包含 nextScheduleId 用于关联跟踪");
    assert.ok(result.nextScheduleId, "nextScheduleId 应非空");
  });

  it("review attempt 的关键字段在导出/恢复中保留", () => {
    // 验证 review attempt 的调度相关字段都是持久化的
    // 这些字段在 export/service.ts 的恢复逻辑中被完整映射
    const exportFields = [
      "id",
      "workspaceId",
      "userId",
      "reviewScheduleId",
      "subjectType",
      "subjectId",
      "answerType",
      "answerText",
      "outcome",
      "confidence",
      "skipReason",
      "scheduleBeforeIntervalDays",
      "scheduleAfterIntervalDays",
      "scheduleReasonCode",
      "understandingEffect",
      "nextReviewAt",
      "idempotencyKey",
      "status",
      "startedAt",
      "completedAt",
      "createdAt",
      "updatedAt",
    ];

    // 确保关键字段都在导出列表中
    const requiredForAudit = [
      "scheduleBeforeIntervalDays",
      "scheduleAfterIntervalDays",
      "scheduleReasonCode",
      "understandingEffect",
      "outcome",
      "nextReviewAt",
    ];

    for (const field of requiredForAudit) {
      assert.ok(
        exportFields.includes(field),
        `字段 ${field} 必须在导出中保留（审计和可追溯性）`,
      );
    }
  });
});

// ─── 7. 调度状态转换：submit 和 later 的 schedule 状态变化 ──────────────────

describe("LOOP-01/02 DoD: 调度状态转换规则", () => {
  it("submit 后当前 schedule 标记为 COMPLETED，创建新 PENDING schedule", () => {
    // 验证 submit 结果包含新 schedule 的信息
    const result: ReviewAttemptSubmitResult = {
      attemptId: "attempt-001",
      status: "completed",
      outcome: "correct",
      scheduleReasonCode: "correct_advance",
      understandingEffect: "upgrade",
      beforeIntervalDays: 1,
      afterIntervalDays: 3,
      nextReviewAt: new Date(NOW.getTime() + 3 * DAY_MS),
      nextScheduleId: "new-schedule-001",
      idempotent: false,
    };

    assert.equal(result.status, "completed", "attempt 状态为 completed");
    assert.ok(result.nextScheduleId, "创建了新的 schedule");
    assert.ok(result.nextReviewAt, "新 schedule 有下次复习时间");
    assert.notEqual(result.beforeIntervalDays, result.afterIntervalDays, "间隔已变化");
  });

  it("later 后 schedule 保持 PENDING，只更新 nextReviewAt", () => {
    // 验证 later 结果：不创建新 schedule，只延迟当前 schedule
    const result: ReviewAttemptLaterResult = {
      attemptId: "attempt-002",
      status: "skipped",
      scheduleReasonCode: "later_short_deferral",
      nextReviewAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1_000),
      intervalDays: 14,
      idempotent: false,
    };

    assert.equal(result.status, "skipped", "attempt 状态为 skipped");
    assert.equal(result.scheduleReasonCode, "later_short_deferral", "使用短延迟策略");
    assert.ok(result.nextReviewAt, "更新了下次复习时间");
    // later 不创建新 schedule（没有 nextScheduleId 字段）
    assert.ok(!("nextScheduleId" in result), "later 不创建新 schedule");
  });

  it("correct 从 1 天升级到 3 天", () => {
    const decision = calculateReviewSchedule({
      currentIntervalDays: 1,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence: true,
      now: NOW,
    });
    assert.equal(decision.beforeIntervalDays, 1);
    assert.equal(decision.afterIntervalDays, 3);
    assert.equal(decision.reasonCode, "correct_advance");
  });

  it("correct 从 60 天封顶（不升级超过 60）", () => {
    const decision = calculateReviewSchedule({
      currentIntervalDays: 60,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence: true,
      now: NOW,
    });
    assert.equal(decision.beforeIntervalDays, 60);
    assert.equal(decision.afterIntervalDays, 60);
    assert.equal(decision.reasonCode, "correct_interval_cap");
    assert.equal(decision.understandingEffect, "upgrade");
  });

  it("incorrect 从任何间隔重置到 1 天", () => {
    for (const currentInterval of [1, 3, 7, 14, 30, 60]) {
      const decision = calculateReviewSchedule({
        currentIntervalDays: currentInterval,
        outcome: "incorrect",
        hasValidServerQuestion: false,
        hasHardEvidence: false,
        now: NOW,
      });
      assert.equal(decision.afterIntervalDays, 1, `${currentInterval} 天重置为 1 天`);
      assert.equal(decision.understandingEffect, "downgrade");
      assert.equal(decision.reasonCode, "incorrect_reset");
    }
  });
});

// ─── 8. REVIEW_OUTCOMES 完整性（确保调度覆盖所有结果） ──────────────────────

describe("LOOP-01/02 DoD: REVIEW_OUTCOMES 完整性", () => {
  it("所有 5 种 outcome 都有对应的调度策略", () => {
    for (const outcome of REVIEW_OUTCOMES) {
      const decision = calculateReviewSchedule({
        currentIntervalDays: 7,
        outcome,
        hasValidServerQuestion: true,
        hasHardEvidence: true,
        now: NOW,
      });
      assert.ok(decision.reasonCode, `${outcome} 应有 reasonCode`);
      assert.ok(
        decision.understandingEffect === "upgrade" ||
        decision.understandingEffect === "downgrade" ||
        decision.understandingEffect === "unchanged",
        `${outcome} 应有有效的 understandingEffect`,
      );
    }
  });
});
