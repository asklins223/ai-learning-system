import assert from "node:assert/strict";
import { test } from "node:test";
import { safeErrorMessage } from "@ailearn/shared";
import {
  classifyGenerationFailure,
  GenerationRunBlockedError,
  ProviderRequestError,
} from "../lib/generation-failure-policy.ts";
import { BudgetExhaustedError } from "../agent/budget.ts";
import { CoverageViolationError } from "../agent/coverage-ledger.ts";
import { AgentOutputError } from "../lib/non-retryable-errors.ts";

test("output truncation is a deterministic unit failure (no auto retry)", () => {
  for (const code of ["output_truncated", "arguments_malformed"] as const) {
    const policy = classifyGenerationFailure(
      new AgentOutputError(code, `test ${code}`),
    );
    assert.deepEqual(policy, {
      scope: "unit",
      autoRetry: false,
      code,
    });
  }
});

test("only typed run-wide failures stop the whole generation fan-out", () => {
  for (const code of [
    "ai_consent_required",
    "external_ai_disabled",
    "provider_config_invalid",
    "provider_snapshot_mismatch",
    "prompt_bundle_incompatible",
  ] as const) {
    assert.deepEqual(
      classifyGenerationFailure(new GenerationRunBlockedError(code)),
      { scope: "run", autoRetry: false, code },
    );
  }
  for (const code of [
    "image_content_not_allowed",
    "vision_provider_snapshot_mismatch",
  ] as const) {
    assert.deepEqual(
      classifyGenerationFailure(new GenerationRunBlockedError(code)),
      { scope: "kind", autoRetry: false, code },
    );
  }
});

test("provider transport policy separates account failures from transient failures", () => {
  assert.deepEqual(
    classifyGenerationFailure(new ProviderRequestError({
      provider: "dashscope",
      status: 401,
      providerCode: "InvalidApiKey",
    })),
    { scope: "run", autoRetry: false, code: "provider_authentication" },
  );
  assert.deepEqual(
    classifyGenerationFailure(new ProviderRequestError({
      provider: "dashscope",
      status: 400,
      providerCode: "overdue-payment",
    })),
    { scope: "run", autoRetry: false, code: "provider_configuration" },
  );
  for (const status of [408, 429, 500, 503]) {
    const policy = classifyGenerationFailure(new ProviderRequestError({
      provider: "openai_compatible",
      status,
    }));
    assert.equal(policy.scope, "unit");
    assert.equal(policy.autoRetry, true);
  }
  for (const status of [400, 403, 404]) {
    const policy = classifyGenerationFailure(new ProviderRequestError({
      provider: "openai_compatible",
      status,
    }));
    assert.equal(policy.scope, "unit");
    assert.equal(policy.autoRetry, false);
  }
});

test("free-form errors can stop one job retry but can never trip the run breaker", () => {
  assert.deepEqual(
    classifyGenerationFailure(new Error("permission denied")),
    { scope: "unit", autoRetry: false, code: null },
  );
  assert.deepEqual(
    classifyGenerationFailure(new Error("network socket closed")),
    { scope: "unit", autoRetry: true, code: null },
  );
});

test("provider errors retain safe status/code without retaining upstream message text", () => {
  const error = new ProviderRequestError({
    provider: "dashscope",
    status: 402,
    providerCode: "overdue-payment",
  });
  assert.equal(error.status, 402);
  assert.equal(error.providerCode, "overdue-payment");
  assert.doesNotMatch(error.message, /secret upstream body/i);
  assert.doesNotMatch(safeErrorMessage(error), /overdue-payment/i);
});

test("budget exhaustion is run-scoped and never auto-retried (R55)", () => {
  // 计划 §11.1: budget/deadline exhausted → 停止，绝不 partial publish
  // 计划 §12: budget failure 只有在输入条件或新 run budget 改变后才能重新创建 run
  const budgetError = new BudgetExhaustedError(
    "global",
    "maxProviderCalls",
    10,
    10,
  );
  const policy = classifyGenerationFailure(budgetError);
  assert.equal(policy.scope, "run", "budget exhaustion should be run-scoped");
  assert.equal(policy.autoRetry, false, "budget exhaustion must not auto-retry");
  assert.equal(policy.code, "budget_exhausted");
});

test("coverage violation is run-scoped and never auto-retried (R55)", () => {
  // CoverageViolationError（如 blocking_decision_exists）是结构性问题，
  // model_omitted/protocol_error/auto_supplemented 不会因重试而自动消失。
  for (const code of [
    "blocking_decision_exists",
    "forbidden_omitted_rewrite",
    "physical_coverage_incomplete",
    "assignment_coverage_incomplete",
    "decision_coverage_incomplete",
  ] as const) {
    const coverageError = new CoverageViolationError(
      `coverage violation: ${code}`,
      code,
    );
    const policy = classifyGenerationFailure(coverageError);
    assert.equal(policy.scope, "run", `coverage violation ${code} should be run-scoped`);
    assert.equal(policy.autoRetry, false, `coverage violation ${code} must not auto-retry`);
    assert.equal(policy.code, code, `coverage violation should preserve error code`);
  }
});


