export type JsonRecord = Record<string, unknown>;

export function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function readString(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readProviderCode(value: unknown): string | number | undefined {
  const code = asJsonRecord(value)?.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

export function readProviderErrorMessage(value: unknown): string | undefined {
  const payload = asJsonRecord(value);
  const nestedMessage = readString(asJsonRecord(payload?.error), "message");
  return nestedMessage ?? readString(payload, "message");
}

export function readChatCompletionContent(value: unknown): string | undefined {
  const choices = asJsonRecord(value)?.choices;
  if (!Array.isArray(choices)) return undefined;
  const firstChoice = asJsonRecord(choices[0]);
  return readString(asJsonRecord(firstChoice?.message), "content");
}

// ─── v0.6: Provider Usage Extraction (计划 §6.6, §10.5) ──────────────────

/**
 * Extract token usage from an OpenAI-compatible chat completion response.
 *
 * Standard response shape:
 * {
 *   "usage": {
 *     "total_tokens": 1234,
 *     "prompt_tokens": 567,
 *     "completion_tokens": 667
 *   },
 *   "id": "chatcmpl-xxx"
 * }
 *
 * Returns null if no usage data is present.
 */
export function readUsage(value: unknown): {
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  requestId: string | null;
} | null {
  const record = asJsonRecord(value);
  if (!record) return null;

  const usage = asJsonRecord(record.usage);
  if (!usage) return null;

  // 用户可配置的 openai-compatible 端点可能返回非法 usage（Infinity、浮点、
  // 负数）；这些值会流入 cost_tokens 的整数列并可能让整个发布事务失败。
  // 只接受非负安全整数。
  const asTokenCount = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const totalTokens = asTokenCount(usage.total_tokens);
  const promptTokens = asTokenCount(usage.prompt_tokens);
  const completionTokens = asTokenCount(usage.completion_tokens);

  // If none of the token fields are present, there's no usage data
  if (totalTokens === null && promptTokens === null && completionTokens === null) {
    return null;
  }

  // Derive total if only components are present
  const derivedTotal = totalTokens
    ?? (promptTokens !== null && completionTokens !== null
      ? promptTokens + completionTokens
      : null);

  const requestId = typeof record.id === "string" ? record.id : null;

  return {
    totalTokens: derivedTotal,
    promptTokens,
    completionTokens,
    requestId,
  };
}
