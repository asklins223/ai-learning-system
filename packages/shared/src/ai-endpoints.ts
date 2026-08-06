/** Resolve provider API roots without duplicating their terminal REST paths. */
export function resolveOpenAIChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized)
    ? normalized
    : `${normalized}/chat/completions`;
}

/** Resolve the OpenAI-compatible embeddings endpoint from a base URL. */
export function resolveOpenAIEmbeddingsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/embeddings$/i.test(normalized)
    ? normalized
    : `${normalized}/embeddings`;
}

export function resolveDashScopeGenerationUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/services\/aigc\/text-generation\/generation$/i.test(normalized)
    ? normalized
    : `${normalized}/services/aigc/text-generation/generation`;
}

export type DashScopeTextProtocol = "native_text" | "openai_compatible";

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
 * The legacy native text-generation endpoint is no longer used.  A caller can
 * still pass any DashScope base URL (`/api/v1` or `/compatible-mode/v1`) and
 * the function normalises it to the compatible chat-completions URL.
 */
export function resolveDashScopeTextEndpoint(baseUrl: string, _model?: string): DashScopeTextEndpoint {
  const normalized = baseUrl.replace(/\/+$/, "");

  // Already pointing at compatible-mode — just append the chat path.
  if (/\/compatible-mode\/v1(?:\/chat\/completions)?$/i.test(normalized)) {
    return {
      protocol: "openai_compatible",
      url: resolveOpenAIChatCompletionsUrl(normalized),
    };
  }

  // Rewrite the legacy `/api/v1` root to the compatible-mode root.
  if (/\/api\/v1$/i.test(normalized)) {
    const compatibleRoot = normalized.replace(/\/api\/v1$/i, "/compatible-mode/v1");
    return {
      protocol: "openai_compatible",
      url: resolveOpenAIChatCompletionsUrl(compatibleRoot),
    };
  }

  // Fallback: assume the caller already supplied a compatible root.
  return {
    protocol: "openai_compatible",
    url: resolveOpenAIChatCompletionsUrl(normalized),
  };
}
