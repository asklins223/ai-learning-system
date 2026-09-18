/** Resolve provider API roots without duplicating their terminal REST paths. */
export function resolveOpenAIChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized)
    ? normalized
    : `${normalized}/chat/completions`;
}

/**
 * Resolve the OpenAI Responses API endpoint (`/responses`) from a base URL.
 *
 * Responses API 与 chat/completions 是两套 body/响应契约：input items +
 * output items，而不是 messages + choices。OpenCode Go 的 muse-spark-* /
 * grok-4.6 / gpt-5.6-luna 只在 /responses 提供（/chat/completions 对该模型
 * 返回 HTTP 500）。
 */
export function resolveOpenAIResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/responses$/i.test(normalized)
    ? normalized
    : `${normalized}/responses`;
}

/** Resolve the OpenAI-compatible embeddings endpoint from a base URL. */
export function resolveOpenAIEmbeddingsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/embeddings$/i.test(normalized)
    ? normalized
    : `${normalized}/embeddings`;
}

export type DashScopeTextProtocol = "openai_compatible";

export interface DashScopeTextEndpoint {
  protocol: DashScopeTextProtocol;
  url: string;
}

/**
 * Resolve the correct DashScope text contract.
 *
 * All DashScope models — including qwen-plus, qwen-max, and qwen3.x — are now
 * routed through the OpenAI-compatible endpoint.  This gives us:
 *   1. `response_format: { type: "json_object" }` support for guaranteed JSON
 *   2. `stream: false` for simpler non-streaming responses
 *   3. A single code path instead of branching on protocol
 *
 * The native text-generation endpoint is not part of the current provider
 * contract. DashScope callers must use its compatible-mode root explicitly.
 */
export function resolveDashScopeTextEndpoint(baseUrl: string): DashScopeTextEndpoint {
  const normalized = baseUrl.replace(/\/+$/, "");

  if (/\/compatible-mode\/v1(?:\/chat\/completions)?$/i.test(normalized)) {
    return {
      protocol: "openai_compatible",
      url: resolveOpenAIChatCompletionsUrl(normalized),
    };
  }

  throw new Error("DashScope baseUrl must end with /compatible-mode/v1");
}
