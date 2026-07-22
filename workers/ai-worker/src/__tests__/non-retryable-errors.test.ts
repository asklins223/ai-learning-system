/**
 * Tests for non-retryable-errors.ts — detection of billing/auth/config errors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isNonRetryableError } from "../lib/non-retryable-errors.ts";

test("detects overdue-payment billing error from DashScope 400", () => {
  const error = new Error(
    'dashscope 400: Access denied, please make sure your account is in good standing. For details, see: https://help.aliyun.com/zh/model-studio/error-code#overdue-payment',
  );
  assert.equal(isNonRetryableError(error), true);
});

test("detects 'access denied' without overdue-payment suffix", () => {
  assert.equal(isNonRetryableError(new Error("dashscope 403: Access denied")), true);
});

test("detects invalid API key auth error", () => {
  assert.equal(isNonRetryableError(new Error("Invalid API key")), true);
});

test("detects DASHSCOPE_API_KEY is required config error", () => {
  assert.equal(isNonRetryableError(new Error("DASHSCOPE_API_KEY is required for DashScopeProvider")), true);
});

test("detects unauthorized error", () => {
  assert.equal(isNonRetryableError(new Error("401 Unauthorized")), true);
});

test("detects forbidden error", () => {
  assert.equal(isNonRetryableError(new Error("403 Forbidden")), true);
});

test("detects AI consent not signed error", () => {
  assert.equal(isNonRetryableError(new Error("AI consent not signed for this workspace")), true);
});

test("detects account suspended error", () => {
  assert.equal(isNonRetryableError(new Error("account suspended due to billing")), true);
});

test("does NOT flag timeout errors as non-retryable", () => {
  assert.equal(isNonRetryableError(new Error("job timed out after 90000ms")), false);
});

test("does NOT flag schema validation errors as non-retryable", () => {
  assert.equal(isNonRetryableError(new Error("DashScope output failed schema check")), false);
});

test("does NOT flag network errors as non-retryable", () => {
  assert.equal(isNonRetryableError(new Error("fetch failed: ECONNREFUSED")), false);
});

test("does NOT flag 5xx server errors as non-retryable", () => {
  assert.equal(isNonRetryableError(new Error("dashscope 500: Internal Server Error")), false);
});

test("does NOT flag 429 rate limit as non-retryable", () => {
  assert.equal(isNonRetryableError(new Error("dashscope 429: Too Many Requests")), false);
});

test("handles string error messages", () => {
  assert.equal(isNonRetryableError("overdue-payment"), true);
  assert.equal(isNonRetryableError("some transient error"), false);
});

test("handles non-Error non-string values", () => {
  assert.equal(isNonRetryableError(42), false);
  assert.equal(isNonRetryableError(null), false);
  assert.equal(isNonRetryableError(undefined), false);
});
