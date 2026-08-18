import assert from "node:assert/strict";
import { test } from "node:test";
import { safeErrorMessage } from "@ailearn/shared";
import {
  classifyGenerationFailure,
  GenerationRunBlockedError,
  ProviderRequestError,
} from "../lib/generation-failure-policy.ts";
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



