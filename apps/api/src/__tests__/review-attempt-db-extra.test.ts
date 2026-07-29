/**
 * review/attempt-service.ts DB 依赖函数补充测试
 *
 * 通过 mock db 对象的 transaction/query 属性，
 * 测试 startReviewAttempt / submitReviewAttempt / laterReviewAttempt /
 * listReviewAttemptHistory 的核心业务逻辑分支，覆盖幂等返回、
 * 状态校验、调度决策、理解事件发射等路径。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  startReviewAttempt,
  submitReviewAttempt,
  laterReviewAttempt,
  listReviewAttemptHistory,
  ReviewAttemptError,
} from "../modules/review/attempt-service.ts";
import { db } from "../db/client.ts";
import { ReviewStatus } from "@ailearn/shared";
import { encodeCursor } from "../lib/pagination.ts";
import { reviewAttempts, reviewSchedules } from "../db/schema/evidence.ts";

// ─── Mock helpers ───────────────────────────────────────────────────────

function chainable<T>(value: T): any {
  const obj: any = {
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
    catch: (fn: any) => Promise.resolve(value).catch(fn),
    finally: (fn: any) => Promise.resolve(value).finally(fn),
  };
  return new Proxy(obj, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === Symbol.toPrimitive) return () => String(value);
      return () => chainable(value);
    },
  });
}

interface MockTxConfig {
  workspaceId: string;
  userId: string;
  insertReturning?: any[][];
  selectResult?: any[][];
  reviewAttemptsFindFirstQueue?: any[];
  reviewSchedulesFindFirstQueue?: any[];
  reviewAttemptsSelectQueue?: any[];
  reviewSchedulesSelectQueue?: any[];
  validationEventsFindFirstQueue?: any[];
  validationQuestionsFindFirstQueue?: any[];
  evidencesFindMany?: any[];
  reviewAttemptsFindManyQueue?: any[];
}

function createMockTx(config: MockTxConfig): any {
  let insertIdx = 0;
  let raFindFirstIdx = 0;
  let rsFindFirstIdx = 0;
  let veIdx = 0;
  let vqIdx = 0;
  let raSelectIdx = 0;
  let rsSelectIdx = 0;
  let raFindManyIdx = 0;

  const insertReturning = config.insertReturning ?? [];
  const raQueue = config.reviewAttemptsFindFirstQueue ?? [undefined];
  const rsQueue = config.reviewSchedulesFindFirstQueue ?? [undefined];
  const raSelectQueue = config.reviewAttemptsSelectQueue ?? raQueue;
  const rsSelectQueue = config.reviewSchedulesSelectQueue ?? rsQueue;
  const veQueue = config.validationEventsFindFirstQueue ?? [undefined];
  const vqQueue = config.validationQuestionsFindFirstQueue ?? [undefined];
  const raFindManyQueue = config.reviewAttemptsFindManyQueue ?? [];

  return {
    execute: async () => [
      { workspace_id: config.workspaceId, user_id: config.userId },
    ],
    insert: (_table: any) => ({
      values: (_data: any) => ({
        returning: () => chainable(insertReturning[insertIdx++] ?? []),
        onConflictDoNothing: () => ({
          returning: () => chainable(insertReturning[insertIdx++] ?? []),
        }),
        onConflictDoUpdate: () => ({
          set: () => ({
            where: () => chainable(insertReturning[insertIdx++] ?? []),
          }),
        }),
      }),
    }),
    update: (_table: any) => ({
      set: (_data: any) => ({
        where: () => ({
          returning: () => chainable([{ id: "mock-update-id" }]),
        }),
      }),
    }),
    delete: (_table: any) => ({
      where: () => chainable(undefined),
    }),
    select: (_fields: any) => ({
      from: (table: any) => {
        let queue: any[];
        let idx: number;
        if (table === reviewSchedules) {
          queue = rsSelectQueue;
          idx = rsSelectIdx++;
        } else if (table === reviewAttempts) {
          queue = raSelectQueue;
          idx = raSelectIdx++;
        } else {
          queue = [];
          idx = 0;
        }
        const item = queue[idx];
        const result = item != null ? [item] : [];
        return {
          where: () => ({
            for: () => chainable(result),
          }),
        };
      },
    }),
    query: {
      reviewAttempts: {
        findFirst: async () => raQueue[raFindFirstIdx++],
        findMany: async () => raFindManyQueue[raFindManyIdx++] ?? [],
      },
      reviewSchedules: {
        findFirst: async () => rsQueue[rsFindFirstIdx++],
        findMany: async () => [],
      },
      validationEvents: {
        findFirst: async () => veQueue[veIdx++],
        findMany: async () => [],
      },
      validationQuestions: {
        findFirst: async () => vqQueue[vqIdx++],
        findMany: async () => [],
      },
      evidences: {
        findMany: async () => config.evidencesFindMany ?? [],
        findFirst: async () => undefined,
      },
      evidenceOverrides: {
        findMany: async () => [],
        findFirst: async () => undefined,
      },
      understandingEvents: {
        findFirst: async () => undefined,
        findMany: async () => [],
      },
      validationActionCommands: {
        findFirst: async () => undefined,
        findMany: async () => [],
      },
    },
  };
}

// ─── Constants ──────────────────────────────────────────────────────────

const WS_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";
const SCHEDULE_ID = "10000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "10000000-0000-4000-8000-000000000002";
const QUESTION_ID = "10000000-0000-4000-8000-000000000003";
const CARD_ID = "10000000-0000-4000-8000-000000000004";
const KEY_POINT_ID = "10000000-0000-4000-8000-000000000005";
const NEXT_SCHEDULE_ID = "10000000-0000-4000-8000-000000000007";
const IDEMPOTENCY_KEY = "review-20260720-A1";

// ─── Global db mock setup ──────────────────────────────────────────────

let originalTransaction: typeof db.transaction;

before(() => {
  originalTransaction = db.transaction;
});

after(() => {
  db.transaction = originalTransaction;
});

function setupDbMock(config: MockTxConfig) {
  const mockTx = createMockTx(config);
  db.transaction = (async (fn: any) => fn(mockTx)) as typeof db.transaction;
}

// ─── startReviewAttempt ─────────────────────────────────────────────────

describe("attempt-service startReviewAttempt (DB mock)", () => {
  it("成功创建复习尝试", async () => {
    const startedAt = new Date();
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID,
          status: ReviewStatus.PENDING,
          subjectType: "card",
          subjectId: CARD_ID,
          validationEventId: null,
        },
      ],
      reviewAttemptsFindFirstQueue: [undefined], // no existing attempt
      insertReturning: [[{
        id: ATTEMPT_ID,
        startedAt,
        reviewScheduleId: SCHEDULE_ID,
        subjectType: "card",
        subjectId: CARD_ID,
        status: "started",
      }]],
    });

    const result = await startReviewAttempt(WS_ID, USER_ID, {
      reviewScheduleId: SCHEDULE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.attemptId, ATTEMPT_ID);
    assert.equal(result.reviewScheduleId, SCHEDULE_ID);
    assert.equal(result.subjectType, "card");
    assert.equal(result.subjectId, CARD_ID);
    assert.equal(result.status, "started");
    assert.equal(result.idempotent, false);
  });

  it("schedule 不存在时抛 schedule_not_found", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [undefined],
    });

    await assert.rejects(
      () => startReviewAttempt(WS_ID, USER_ID, {
        reviewScheduleId: SCHEDULE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      (err: unknown) => err instanceof ReviewAttemptError && err.code === "schedule_not_found",
    );
  });

  it("schedule 状态不是 pending 时抛 schedule_not_pending", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [
        { id: SCHEDULE_ID, status: ReviewStatus.COMPLETED, subjectType: "card", subjectId: CARD_ID },
      ],
    });

    await assert.rejects(
      () => startReviewAttempt(WS_ID, USER_ID, {
        reviewScheduleId: SCHEDULE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      (err: unknown) => err instanceof ReviewAttemptError && err.code === "schedule_not_pending",
    );
  });

  it("幂等返回已存在的 attempt", async () => {
    const startedAt = new Date();
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [
        { id: SCHEDULE_ID, status: ReviewStatus.PENDING, subjectType: "card", subjectId: CARD_ID },
      ],
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID,
          reviewScheduleId: SCHEDULE_ID,
          subjectType: "card",
          subjectId: CARD_ID,
          status: "started",
          startedAt,
        },
      ],
    });

    const result = await startReviewAttempt(WS_ID, USER_ID, {
      reviewScheduleId: SCHEDULE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.attemptId, ATTEMPT_ID);
    assert.equal(result.idempotent, true);
  });
});

// ─── submitReviewAttempt ────────────────────────────────────────────────

describe("attempt-service submitReviewAttempt (DB mock)", () => {
  it("成功提交 card 类型复习（correct + 有问题 + 有硬证据 → upgrade）", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID,
          status: "started",
          subjectType: "card",
          subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: null,
          scheduleReasonCode: null,
          understandingEffect: null,
          scheduleBeforeIntervalDays: null,
          scheduleAfterIntervalDays: null,
          nextReviewAt: null,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID,
          status: ReviewStatus.PENDING,
          subjectType: "card",
          subjectId: CARD_ID,
          validationEventId: null,
          intervalDays: 1,
        },
      ],
      validationQuestionsFindFirstQueue: [
        { id: QUESTION_ID, keyPointId: KEY_POINT_ID, expiresAt: null },
      ],
      evidencesFindMany: [
        { id: "ev-1", alignment: "aligned", userOverride: null, keyPointId: KEY_POINT_ID },
      ],
      insertReturning: [[{ id: NEXT_SCHEDULE_ID }]],
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      validationQuestionId: QUESTION_ID,
      answerType: "free_text",
      answer: "这是我的回答",
      outcome: "correct",
      confidence: 85,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.attemptId, ATTEMPT_ID);
    assert.equal(result.status, "completed");
    assert.equal(result.outcome, "correct");
    assert.equal(result.understandingEffect, "upgrade");
    assert.equal(result.afterIntervalDays, 3);
    assert.equal(result.scheduleReasonCode, "correct_advance");
    assert.equal(result.nextScheduleId, NEXT_SCHEDULE_ID);
    assert.equal(result.idempotent, false);
  });

  it("成功提交 card 类型复习（correct + 无硬证据 → unchanged）", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "started",
          subjectType: "card", subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: null, scheduleReasonCode: null, understandingEffect: null,
          scheduleBeforeIntervalDays: null, scheduleAfterIntervalDays: null,
          nextReviewAt: null,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "card", subjectId: CARD_ID,
          validationEventId: null, intervalDays: 7,
        },
      ],
      validationQuestionsFindFirstQueue: [
        { id: QUESTION_ID, keyPointId: KEY_POINT_ID, expiresAt: null },
      ],
      evidencesFindMany: [], // no hard evidence
      insertReturning: [[{ id: NEXT_SCHEDULE_ID }]],
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      validationQuestionId: QUESTION_ID,
      answerType: "free_text",
      answer: "回答内容",
      outcome: "correct",
      confidence: 90,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.understandingEffect, "unchanged");
    assert.equal(result.scheduleReasonCode, "evidence_insufficient");
  });

  it("成功提交 card 类型复习（incorrect → downgrade）", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "started",
          subjectType: "card", subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: null, scheduleReasonCode: null, understandingEffect: null,
          scheduleBeforeIntervalDays: null, scheduleAfterIntervalDays: null,
          nextReviewAt: null,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "card", subjectId: CARD_ID,
          validationEventId: null, intervalDays: 30,
        },
      ],
      evidencesFindMany: [],
      insertReturning: [[{ id: NEXT_SCHEDULE_ID }]],
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      answerType: "recall",
      answer: "我记不清了",
      outcome: "incorrect",
      confidence: 20,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.understandingEffect, "downgrade");
    assert.equal(result.afterIntervalDays, 1);
    assert.equal(result.scheduleReasonCode, "incorrect_reset");
  });

  it("成功提交 validation 类型复习", async () => {
    const validationEventId = "10000000-0000-4000-8000-000000000006";
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "started",
          subjectType: "validation", subjectId: "val-1",
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: null, scheduleReasonCode: null, understandingEffect: null,
          scheduleBeforeIntervalDays: null, scheduleAfterIntervalDays: null,
          nextReviewAt: null,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "validation", subjectId: "val-1",
          validationEventId, intervalDays: 1,
        },
      ],
      validationEventsFindFirstQueue: [
        { id: validationEventId, cardId: CARD_ID, keyPointId: KEY_POINT_ID },
      ],
      validationQuestionsFindFirstQueue: [
        { id: QUESTION_ID, keyPointId: KEY_POINT_ID, expiresAt: null },
      ],
      evidencesFindMany: [
        { id: "ev-1", alignment: "aligned", userOverride: null, keyPointId: KEY_POINT_ID },
      ],
      insertReturning: [[{ id: NEXT_SCHEDULE_ID }]],
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      validationQuestionId: QUESTION_ID,
      answerType: "free_text",
      answer: "解释内容",
      outcome: "correct",
      confidence: 80,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.understandingEffect, "upgrade");
  });

  it("validation 类型但 validationEvent 不存在时仍处理（cardId 为 null）", async () => {
    const validationEventId = "10000000-0000-4000-8000-000000000006";
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "started",
          subjectType: "validation", subjectId: "val-1",
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: null, scheduleReasonCode: null, understandingEffect: null,
          scheduleBeforeIntervalDays: null, scheduleAfterIntervalDays: null,
          nextReviewAt: null,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "validation", subjectId: "val-1",
          validationEventId, intervalDays: 1,
        },
      ],
      validationEventsFindFirstQueue: [undefined], // ve not found
      evidencesFindMany: [],
      insertReturning: [[{ id: NEXT_SCHEDULE_ID }]],
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      answerType: "recall",
      answer: "回答",
      outcome: "incorrect",
      confidence: 30,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.understandingEffect, "downgrade");
  });

  it("attempt 不存在时抛 attempt_not_found", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [undefined],
    });

    await assert.rejects(
      () => submitReviewAttempt(WS_ID, USER_ID, {
        attemptId: ATTEMPT_ID,
        reviewScheduleId: SCHEDULE_ID,
        answerType: "recall",
        answer: "回答",
        outcome: "incorrect",
        confidence: 30,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      (err: unknown) => err instanceof ReviewAttemptError && err.code === "attempt_not_found",
    );
  });

  it("attempt 状态不是 started 也不是 completed 时抛 attempt_not_started", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "skipped",
          subjectType: "card", subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "card", subjectId: CARD_ID,
        },
      ],
    });

    await assert.rejects(
      () => submitReviewAttempt(WS_ID, USER_ID, {
        attemptId: ATTEMPT_ID,
        reviewScheduleId: SCHEDULE_ID,
        answerType: "recall",
        answer: "回答",
        outcome: "incorrect",
        confidence: 30,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      (err: unknown) => err instanceof ReviewAttemptError && err.code === "attempt_not_started",
    );
  });

  it("schedule 不存在时抛 schedule_not_found", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "started",
          subjectType: "card", subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ],
      reviewSchedulesFindFirstQueue: [undefined],
    });

    await assert.rejects(
      () => submitReviewAttempt(WS_ID, USER_ID, {
        attemptId: ATTEMPT_ID,
        reviewScheduleId: SCHEDULE_ID,
        answerType: "recall",
        answer: "回答",
        outcome: "incorrect",
        confidence: 30,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      (err: unknown) => err instanceof ReviewAttemptError && err.code === "schedule_not_found",
    );
  });

  it("已完成的 attempt 返回幂等结果", async () => {
    const nextReviewAt = new Date("2026-07-25T00:00:00.000Z");
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "completed",
          subjectType: "card", subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: "correct",
          scheduleReasonCode: "correct_advance",
          understandingEffect: "upgrade",
          scheduleBeforeIntervalDays: 1,
          scheduleAfterIntervalDays: 3,
          nextReviewAt,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        { id: NEXT_SCHEDULE_ID, nextReviewAt, status: ReviewStatus.PENDING },
      ],
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      validationQuestionId: QUESTION_ID,
      answerType: "free_text",
      answer: "回答",
      outcome: "correct",
      confidence: 85,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.attemptId, ATTEMPT_ID);
    assert.equal(result.idempotent, true);
    assert.equal(result.outcome, "correct");
    assert.equal(result.understandingEffect, "upgrade");
    assert.equal(result.nextScheduleId, NEXT_SCHEDULE_ID);
  });

  it("已完成的 attempt 幂等返回时 nextSchedule 不存在使用 attempt 的 nextReviewAt", async () => {
    const nextReviewAt = new Date("2026-07-25T00:00:00.000Z");
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "completed",
          subjectType: "card", subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: "correct",
          scheduleReasonCode: "correct_advance",
          understandingEffect: "upgrade",
          scheduleBeforeIntervalDays: 1,
          scheduleAfterIntervalDays: 3,
          nextReviewAt,
        },
      ],
      // select needs a schedule for the lock; findFirst returns undefined (no next schedule)
      reviewSchedulesSelectQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "card", subjectId: CARD_ID,
        },
      ],
      reviewSchedulesFindFirstQueue: [undefined], // next schedule not found
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      validationQuestionId: QUESTION_ID,
      answerType: "free_text",
      answer: "回答",
      outcome: "correct",
      confidence: 85,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.idempotent, true);
    assert.equal(result.nextScheduleId, "");
  });

  it("提交时 question 已过期（hasValidServerQuestion=false）", async () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "started",
          subjectType: "card", subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: null, scheduleReasonCode: null, understandingEffect: null,
          scheduleBeforeIntervalDays: null, scheduleAfterIntervalDays: null,
          nextReviewAt: null,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "card", subjectId: CARD_ID,
          validationEventId: null, intervalDays: 7,
        },
      ],
      validationQuestionsFindFirstQueue: [
        { id: QUESTION_ID, keyPointId: KEY_POINT_ID, expiresAt: past }, // expired
      ],
      evidencesFindMany: [
        { id: "ev-1", alignment: "aligned", userOverride: null, keyPointId: KEY_POINT_ID },
      ],
      insertReturning: [[{ id: NEXT_SCHEDULE_ID }]],
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      validationQuestionId: QUESTION_ID,
      answerType: "free_text",
      answer: "回答",
      outcome: "correct",
      confidence: 85,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    // question expired → hasValidServerQuestion=false → blocks upgrade
    assert.equal(result.understandingEffect, "unchanged");
    assert.equal(result.scheduleReasonCode, "question_invalid");
  });

  it("无 keyPointId 时不检查硬证据", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "started",
          subjectType: "card", subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: null, scheduleReasonCode: null, understandingEffect: null,
          scheduleBeforeIntervalDays: null, scheduleAfterIntervalDays: null,
          nextReviewAt: null,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "card", subjectId: CARD_ID,
          validationEventId: null, intervalDays: 1,
        },
      ],
      // No validationQuestionId provided → question=null → keyPointId stays null
      evidencesFindMany: [], // won't be called since keyPointId is null
      insertReturning: [[{ id: NEXT_SCHEDULE_ID }]],
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      answerType: "recall",
      answer: "回答",
      outcome: "incorrect",
      confidence: 20,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.understandingEffect, "downgrade");
    assert.equal(result.afterIntervalDays, 1);
  });

  it("unable outcome 不需要答案和问题", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID, status: "started",
          subjectType: "card", subjectId: CARD_ID,
          reviewScheduleId: SCHEDULE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: null, scheduleReasonCode: null, understandingEffect: null,
          scheduleBeforeIntervalDays: null, scheduleAfterIntervalDays: null,
          nextReviewAt: null,
        },
      ],
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "card", subjectId: CARD_ID,
          validationEventId: null, intervalDays: 14,
        },
      ],
      evidencesFindMany: [],
      insertReturning: [[{ id: NEXT_SCHEDULE_ID }]],
    });

    const result = await submitReviewAttempt(WS_ID, USER_ID, {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      answerType: "recall",
      outcome: "unable",
      confidence: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.understandingEffect, "downgrade");
    assert.equal(result.afterIntervalDays, 1);
    assert.equal(result.scheduleReasonCode, "unable_reset");
  });
});

// ─── laterReviewAttempt ─────────────────────────────────────────────────

describe("attempt-service laterReviewAttempt (DB mock)", () => {
  it("成功推迟复习", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID,
          status: ReviewStatus.PENDING,
          subjectType: "card",
          subjectId: CARD_ID,
          validationEventId: null,
          intervalDays: 14,
        },
      ],
      reviewAttemptsFindFirstQueue: [undefined], // no existing attempt
      insertReturning: [[{ id: ATTEMPT_ID }]],
    });

    const result = await laterReviewAttempt(WS_ID, USER_ID, {
      reviewScheduleId: SCHEDULE_ID,
      reason: "later",
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.attemptId, ATTEMPT_ID);
    assert.equal(result.status, "skipped");
    assert.equal(result.scheduleReasonCode, "later_short_deferral");
    assert.equal(result.intervalDays, 14);
    assert.equal(result.idempotent, false);
  });

  it("schedule 不存在时抛 schedule_not_found", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [undefined],
    });

    await assert.rejects(
      () => laterReviewAttempt(WS_ID, USER_ID, {
        reviewScheduleId: SCHEDULE_ID,
        reason: "later",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      (err: unknown) => err instanceof ReviewAttemptError && err.code === "schedule_not_found",
    );
  });

  it("schedule 状态不是 pending 时抛 schedule_not_pending", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [
        { id: SCHEDULE_ID, status: ReviewStatus.COMPLETED, subjectType: "card", subjectId: CARD_ID, intervalDays: 1 },
      ],
    });

    await assert.rejects(
      () => laterReviewAttempt(WS_ID, USER_ID, {
        reviewScheduleId: SCHEDULE_ID,
        reason: "later",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      (err: unknown) => err instanceof ReviewAttemptError && err.code === "schedule_not_pending",
    );
  });

  it("幂等返回已存在的 later attempt", async () => {
    const nextReviewAt = new Date("2026-07-20T12:00:00.000Z");
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID,
          status: ReviewStatus.PENDING,
          subjectType: "card",
          subjectId: CARD_ID,
          validationEventId: null,
          intervalDays: 14,
        },
      ],
      reviewAttemptsFindFirstQueue: [
        {
          id: ATTEMPT_ID,
          reviewScheduleId: SCHEDULE_ID,
          status: "skipped",
          skipReason: "later",
          scheduleReasonCode: "later_short_deferral",
          scheduleAfterIntervalDays: 14,
          nextReviewAt,
        },
      ],
    });

    const result = await laterReviewAttempt(WS_ID, USER_ID, {
      reviewScheduleId: SCHEDULE_ID,
      reason: "later",
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(result.attemptId, ATTEMPT_ID);
    assert.equal(result.idempotent, true);
    assert.equal(result.intervalDays, 14);
  });

  it("已有 attempt 但 skipReason 不是 later 时抛 attempt_not_started", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [
        {
          id: SCHEDULE_ID, status: ReviewStatus.PENDING,
          subjectType: "card", subjectId: CARD_ID,
          validationEventId: null, intervalDays: 7,
        },
      ],
      reviewAttemptsFindFirstQueue: [
        {
          // existing attempt but skipReason is null (started, not skipped)
          id: ATTEMPT_ID, status: "started", skipReason: null,
          reviewScheduleId: SCHEDULE_ID,
          scheduleReasonCode: null, scheduleAfterIntervalDays: null,
          nextReviewAt: null,
        },
      ],
    });

    await assert.rejects(
      () => laterReviewAttempt(WS_ID, USER_ID, {
        reviewScheduleId: SCHEDULE_ID,
        reason: "later",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      (err: unknown) => err instanceof ReviewAttemptError && err.code === "attempt_not_started",
    );
  });
});

// ─── listReviewAttemptHistory ───────────────────────────────────────────

describe("attempt-service listReviewAttemptHistory (DB mock)", () => {
  it("返回历史记录列表", async () => {
    const now = new Date();
    const rows = [
      {
        id: "att-1", reviewScheduleId: SCHEDULE_ID,
        subjectType: "card", subjectId: CARD_ID,
        answerType: "free_text", outcome: "correct",
        confidence: 85, skipReason: null,
        scheduleBeforeIntervalDays: 1, scheduleAfterIntervalDays: 3,
        scheduleReasonCode: "correct_advance", understandingEffect: "upgrade",
        nextReviewAt: now, status: "completed",
        startedAt: now, completedAt: now,
        createdAt: now,
      },
    ];

    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindManyQueue: [rows],
    });

    const result = await listReviewAttemptHistory(WS_ID, USER_ID, { limit: 20 });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, "att-1");
    assert.equal(result.items[0].outcome, "correct");
    assert.equal(result.nextCursor, null);
  });

  it("空历史返回空列表", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindManyQueue: [[]],
    });

    const result = await listReviewAttemptHistory(WS_ID, USER_ID, { limit: 20 });
    assert.equal(result.items.length, 0);
    assert.equal(result.nextCursor, null);
  });

  it("结果超过 limit 时生成 nextCursor", async () => {
    const now = new Date();
    // Return limit+1 items to trigger hasMore
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `att-${i + 1}`, reviewScheduleId: SCHEDULE_ID,
      subjectType: "card", subjectId: CARD_ID,
      answerType: "recall", outcome: "correct",
      confidence: 80, skipReason: null,
      scheduleBeforeIntervalDays: 1, scheduleAfterIntervalDays: 3,
      scheduleReasonCode: "correct_advance", understandingEffect: "upgrade",
      nextReviewAt: now, status: "completed",
      startedAt: now, completedAt: now,
      createdAt: now,
    }));

    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindManyQueue: [rows],
    });

    const result = await listReviewAttemptHistory(WS_ID, USER_ID, { limit: 2 });
    assert.equal(result.items.length, 2);
    assert.ok(result.nextCursor, "应有 nextCursor");
  });

  it("带 filterScheduleId 过滤", async () => {
    const now = new Date();
    const rows = [
      {
        id: "att-1", reviewScheduleId: SCHEDULE_ID,
        subjectType: "card", subjectId: CARD_ID,
        answerType: null, outcome: null,
        confidence: null, skipReason: "later",
        scheduleBeforeIntervalDays: 14, scheduleAfterIntervalDays: 14,
        scheduleReasonCode: "later_short_deferral", understandingEffect: "unchanged",
        nextReviewAt: now, status: "skipped",
        startedAt: now, completedAt: now,
        createdAt: now,
      },
    ];

    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewSchedulesFindFirstQueue: [
        { subjectType: "card", subjectId: CARD_ID },
      ],
      reviewAttemptsFindManyQueue: [rows],
    });

    const result = await listReviewAttemptHistory(
      WS_ID, USER_ID, { limit: 20 }, SCHEDULE_ID,
    );

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].skipReason, "later");
  });

  it("不包含 answerText（隐私边界）", async () => {
    const now = new Date();
    const rows = [
      {
        id: "att-1", reviewScheduleId: SCHEDULE_ID,
        subjectType: "card", subjectId: CARD_ID,
        answerType: "free_text", outcome: "correct",
        confidence: 85, skipReason: null,
        scheduleBeforeIntervalDays: 1, scheduleAfterIntervalDays: 3,
        scheduleReasonCode: "correct_advance", understandingEffect: "upgrade",
        nextReviewAt: now, status: "completed",
        startedAt: now, completedAt: now,
        createdAt: now,
      },
    ];

    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindManyQueue: [rows],
    });

    const result = await listReviewAttemptHistory(WS_ID, USER_ID, { limit: 20 });
    // answerText should not be in the returned items
    const keys = Object.keys(result.items[0]);
    assert.ok(!keys.includes("answerText"), "不应包含 answerText");
    assert.ok(!keys.includes("answer_text"), "不应包含 answer_text");
  });

  it("带 cursor 分页", async () => {
    const now = new Date();
    const rows = [
      {
        id: "att-2", reviewScheduleId: SCHEDULE_ID,
        subjectType: "card", subjectId: CARD_ID,
        answerType: "recall", outcome: "incorrect",
        confidence: 30, skipReason: null,
        scheduleBeforeIntervalDays: 7, scheduleAfterIntervalDays: 1,
        scheduleReasonCode: "incorrect_reset", understandingEffect: "downgrade",
        nextReviewAt: now, status: "completed",
        startedAt: now, completedAt: now,
        createdAt: now,
      },
    ];

    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      reviewAttemptsFindManyQueue: [rows],
    });

    // Use a cursor (encoded)
    const cursor = encodeCursor(now, "att-1");

    const result = await listReviewAttemptHistory(WS_ID, USER_ID, {
      limit: 20,
      cursor,
    });

    assert.equal(result.items.length, 1);
  });
});
