/** Provider-reported usage and explicit pricing helpers for the paid RC gate. */

export interface TokenPricing {
  inputUsdPerThousandTokens: number;
  outputUsdPerThousandTokens: number;
}

function parsePositiveFinite(value: string | number | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
}

export function resolveTokenPricing(
  modelId: string,
  inputRate: string | undefined,
  outputRate: string | undefined,
): TokenPricing {
  const defaultInputRate = modelId === "qwen-plus" ? 0.004 : undefined;
  const defaultOutputRate = modelId === "qwen-plus" ? 0.012 : undefined;
  return {
    inputUsdPerThousandTokens: parsePositiveFinite(
      inputRate ?? defaultInputRate,
      "AIQ_INPUT_USD_PER_1K_TOKENS",
    ),
    outputUsdPerThousandTokens: parsePositiveFinite(
      outputRate ?? defaultOutputRate,
      "AIQ_OUTPUT_USD_PER_1K_TOKENS",
    ),
  };
}

export function calculateProviderUsageCost(
  payload: Record<string, unknown>,
  pricing: TokenPricing,
): number {
  const usage = payload.usage as Record<string, unknown> | undefined;
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens);
  if (
    !Number.isInteger(inputTokens)
    || inputTokens < 0
    || !Number.isInteger(outputTokens)
    || outputTokens < 0
  ) {
    throw new Error("Provider response is missing valid token usage");
  }
  return (
    inputTokens * pricing.inputUsdPerThousandTokens
    + outputTokens * pricing.outputUsdPerThousandTokens
  ) / 1000;
}

export function parseRCBudgetUsd(raw: string | undefined, fallback: number): number {
  const budget = Number(raw ?? fallback);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 10) {
    throw new Error("AIQ_RC_MAX_BUDGET_USD must be greater than 0 and at most 10");
  }
  return budget;
}
