/**
 * review/attempt-service.ts 补充测试
 *
 * 覆盖 ReviewAttemptError 类的所有错误码和 statusCode 映射，
 * 以及结果类型接口的完整性验证。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReviewAttemptError,
  type ReviewAttemptErrorCode,
  type ReviewAttemptStartResult,
  type ReviewAttemptSubmitResult,
  type ReviewAttemptLaterResult,
  type ReviewAttemptHistoryItem,
  type ReviewAttemptHistoryResult,
} from "../modules/review/attempt-service.ts";

// ─── ReviewAttemptError statusCode 映射 ──────────────────────────────────

test("schedule_not_found 返回 404", () => {
  const err = new ReviewAttemptError("schedule_not_found");
  assert.equal(err.statusCode, 404);
  assert.equal(err.code, "schedule_not_found");
});

test("attempt_not_found 返回 404", () => {
  const err = new ReviewAttemptError("attempt_not_found");
  assert.equal(err.statusCode, 404);
});

test("card_not_found 返回 404", () => {
  const err = new ReviewAttemptError("card_not_found");
  assert.equal(err.statusCode, 404);
});

test("key_point_not_found 返回 404", () => {
  const err = new ReviewAttemptError("key_point_not_found");
  assert.equal(err.statusCode, 404);
});

test("question_not_found 返回 404", () => {
  const err = new ReviewAttemptError("question_not_found");
  assert.equal(err.statusCode, 404);
});

test("schedule_not_pending 返回 409", () => {
  const err = new ReviewAttemptError("schedule_not_pending");
  assert.equal(err.statusCode, 409);
});

test("attempt_not_started 返回 409", () => {
  const err = new ReviewAttemptError("attempt_not_started");
  assert.equal(err.statusCode, 409);
});

test("question_expired 返回 410", () => {
  const err = new ReviewAttemptError("question_expired");
  assert.equal(err.statusCode, 410);
});

// ─── ReviewAttemptError 类行为 ───────────────────────────────────────────

test("ReviewAttemptError 是 Error 的实例", () => {
  const err = new ReviewAttemptError("schedule_not_found");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof ReviewAttemptError);
});

test("ReviewAttemptError name 属性正确", () => {
  const err = new ReviewAttemptError("attempt_not_found");
  assert.equal(err.name, "ReviewAttemptError");
});

test("ReviewAttemptError message 等于 code", () => {
  const codes: ReviewAttemptErrorCode[] = [
    "schedule_not_found",
    "schedule_not_pending",
    "attempt_not_found",
    "attempt_not_started",
    "attempt_already_completed",
    "question_not_found",
    "question_expired",
    "card_not_found",
    "key_point_not_found",
  ];
  for (const code of codes) {
    const err = new ReviewAttemptError(code);
    assert.equal(err.message, code, `message should equal code for ${code}`);
    assert.equal(err.code, code);
  }
});

test("所有错误码均可达且 statusCode 在合理范围", () => {
  const codeToStatus: Record<ReviewAttemptErrorCode, number> = {
    schedule_not_found: 404,
    schedule_not_pending: 409,
    attempt_not_found: 404,
    attempt_not_started: 409,
    attempt_already_completed: 409,
    question_not_found: 404,
    question_expired: 410,
    card_not_found: 404,
    key_point_not_found: 404,
  };
  for (const [code, expectedStatus] of Object.entries(codeToStatus)) {
    const err = new ReviewAttemptError(code as ReviewAttemptErrorCode);
    assert.equal(err.statusCode, expectedStatus, `${code} should have status ${expectedStatus}`);
    assert.ok(err.statusCode >= 400 && err.statusCode < 500, "should be 4xx");
  }
});

// ─── 结果类型接口完整性 ─────────────────────────────────────────────────

test("ReviewAttemptStartResult 包含必需字段", () => {
  const result: ReviewAttemptStartResult = {
    attemptId: "att-1",
    reviewScheduleId: "sch-1",
    subjectType: "card",
    subjectId: "card-1",
    status: "started",
    startedAt: new Date(),
    idempotent: false,
  };
  assert.ok("attemptId" in result);
  assert.ok("reviewScheduleId" in result);
  assert.ok("subjectType" in result);
  assert.ok("subjectId" in result);
  assert.ok("status" in result);
  assert.ok("startedAt" in result);
  assert.ok("idempotent" in result);
});

test("ReviewAttemptSubmitResult 包含调度决策字段", () => {
  const result: ReviewAttemptSubmitResult = {
    attemptId: "att-1",
    status: "completed",
    outcome: "correct",
    scheduleReasonCode: "correct_advance",
    understandingEffect: "upgrade",
    beforeIntervalDays: 1,
    afterIntervalDays: 3,
    nextReviewAt: new Date(),
    nextScheduleId: "sch-2",
    idempotent: false,
  };
  assert.ok("scheduleReasonCode" in result);
  assert.ok("understandingEffect" in result);
  assert.ok("beforeIntervalDays" in result);
  assert.ok("afterIntervalDays" in result);
  assert.ok("nextReviewAt" in result);
  assert.ok("nextScheduleId" in result);
});

test("ReviewAttemptLaterResult 包含跳过和调度字段", () => {
  const result: ReviewAttemptLaterResult = {
    attemptId: "att-1",
    status: "skipped",
    scheduleReasonCode: "later_short_deferral",
    nextReviewAt: new Date(),
    intervalDays: 1,
    idempotent: false,
  };
  assert.ok("status" in result);
  assert.ok("scheduleReasonCode" in result);
  assert.ok("intervalDays" in result);
  assert.ok("idempotent" in result);
});

test("ReviewAttemptHistoryItem 不包含 answerText（隐私边界）", () => {
  const item: ReviewAttemptHistoryItem = {
    id: "att-1",
    reviewScheduleId: "sch-1",
    subjectType: "card",
    subjectId: "card-1",
    answerType: "free_text",
    outcome: "correct",
    confidence: 85,
    skipReason: null,
    scheduleBeforeIntervalDays: 1,
    scheduleAfterIntervalDays: 3,
    scheduleReasonCode: "correct_advance",
    understandingEffect: "upgrade",
    nextReviewAt: new Date(),
    nextScheduleId: null,
    status: "completed",
    startedAt: new Date(),
    completedAt: new Date(),
  };
  const keys = Object.keys(item);
  assert.ok(!keys.includes("answerText"), "不应包含 answerText");
  assert.ok(!keys.includes("answer_text"), "不应包含 answer_text");
  assert.ok("answerType" in item, "应包含 answerType（类型标识非正文）");
});

test("ReviewAttemptHistoryResult 包含分页字段", () => {
  const result: ReviewAttemptHistoryResult = {
    items: [],
    nextCursor: null,
  };
  assert.ok("items" in result);
  assert.ok("nextCursor" in result);
});

test("ReviewAttemptHistoryResult 支持游标分页", () => {
  const result: ReviewAttemptHistoryResult = {
    items: [],
    nextCursor: "base64cursor",
  };
  assert.equal(typeof result.nextCursor, "string");
});
