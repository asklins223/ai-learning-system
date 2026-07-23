import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateProviderUsageCost,
  parseRCBudgetUsd,
  resolveTokenPricing,
} from "./provider-usage-cost.ts";

describe("paid RC usage accounting", () => {
  it("uses Provider-reported prompt and completion tokens", () => {
    const pricing = resolveTokenPricing("qwen-plus", undefined, undefined);
    assert.deepEqual(pricing, {
      inputUsdPerThousandTokens: 0.004,
      outputUsdPerThousandTokens: 0.012,
    });
    assert.equal(calculateProviderUsageCost({
      usage: { prompt_tokens: 2_000, completion_tokens: 500 },
    }, pricing), 0.014);
    assert.equal(calculateProviderUsageCost({
      usage: { input_tokens: 1_000, output_tokens: 1_000 },
    }, pricing), 0.016);
  });

  it("rejects missing, fractional, negative, or non-finite usage", () => {
    const pricing = resolveTokenPricing("qwen-plus", undefined, undefined);
    for (const payload of [
      {},
      { usage: {} },
      { usage: { prompt_tokens: 1.5, completion_tokens: 1 } },
      { usage: { prompt_tokens: -1, completion_tokens: 1 } },
      { usage: { prompt_tokens: 1, completion_tokens: Number.POSITIVE_INFINITY } },
    ]) {
      assert.throws(() => calculateProviderUsageCost(payload, pricing), /token usage/);
    }
  });

  it("requires explicit positive rates for a non-reference model", () => {
    assert.throws(
      () => resolveTokenPricing("another-model", undefined, undefined),
      /AIQ_INPUT_USD_PER_1K_TOKENS/,
    );
    assert.deepEqual(resolveTokenPricing("another-model", "0.01", "0.02"), {
      inputUsdPerThousandTokens: 0.01,
      outputUsdPerThousandTokens: 0.02,
    });
    assert.throws(() => resolveTokenPricing("another-model", "0", "0.02"), /positive/);
  });

  it("keeps the configured RC budget within the release cap", () => {
    assert.equal(parseRCBudgetUsd(undefined, 10), 10);
    assert.equal(parseRCBudgetUsd("0.5", 10), 0.5);
    for (const invalid of ["0", "-1", "10.01", "NaN", "Infinity"]) {
      assert.throws(() => parseRCBudgetUsd(invalid, 10), /at most 10/);
    }
  });
});
