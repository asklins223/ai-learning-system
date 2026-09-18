/**
 * Tests for non-retryable-errors.ts — detection of billing/auth/config errors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isNonRetryableError, AgentOutputError, CompanionAgentBudgetExceededError } from "../lib/non-retryable-errors.ts";
import { JobPayloadContractError } from "@ailearn/shared/job-payload-contracts";
import { JobType } from "@ailearn/shared";
import { safeErrorMessage } from "@ailearn/shared";

test("detects AgentOutputError (output_truncated) as non-retryable", () => {
  const error = new AgentOutputError(
    "output_truncated",
    'agent output truncated at finish_reason="length" (toolCalls=1, malformed=1)',
  );
  assert.equal(isNonRetryableError(error), true);
});

test("detects CompanionAgentBudgetExceededError as non-retryable (预算跨重投累计)", () => {
  assert.equal(
    isNonRetryableError(new CompanionAgentBudgetExceededError("companion agent tool budget exceeded")),
    true,
  );
  assert.equal(
    isNonRetryableError(new CompanionAgentBudgetExceededError("companion agent deadline exceeded")),
    true,
  );
});

test("detects AgentOutputError (arguments_malformed) as non-retryable", () => {
  const error = new AgentOutputError(
    "arguments_malformed",
    'tool call "record_extraction_decisions" has malformed arguments JSON',
  );
  assert.equal(isNonRetryableError(error), true);
});

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

test("detects provider config errors (missing API key / provider not configured)", () => {
  assert.equal(isNonRetryableError(new Error("DASHSCOPE_API_KEY is required")), true);
  assert.equal(isNonRetryableError(new Error("provider dashscope is not configured for agent_turn")), true);
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

// 稳定 P1（2026-09-15 审计）：作业 payload 与作业类型契约不符是确定性失败——
// 重试不会让缺失字段出现，只会空转三次租约。必须直接 dead。
test("flags job payload contract violations as non-retryable", () => {
  const violation = new JobPayloadContractError(
    JobType.PARSE_SOURCE,
    "payload.sourceId must be a non-empty string",
  );
  assert.equal(isNonRetryableError(violation), true);
  // 结构化 code 会经 safeErrorMessage 落到 last_error（`...:job_payload_contract_error`），
  // API 侧据此把失败原因呈现给用户——不是靠解析自然语言消息。
  assert.equal(violation.code, "job_payload_contract_error");
  assert.match(safeErrorMessage(violation), /:job_payload_contract_error$/);
  // 反向 1：普通"缺字段"业务错误不得被误判（否则会把可重试错误打死）。
  assert.equal(isNonRetryableError(new Error("missing sourceId in payload")), false);
  // 反向 2：文本分类器不认识这条消息（识别靠类型，不靠文案）——记录该边界，
  // 以免日后有人以为"改文案就能改变重试行为"。
  assert.equal(isNonRetryableError(violation.message), false);
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
