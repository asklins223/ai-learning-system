/** Resolve provider API roots without duplicating their terminal REST paths. */
export function resolveOpenAIChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized)
    ? normalized
    : `${normalized}/chat/completions`;
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
 * Qwen 3.5/3.6 cannot use DashScope's legacy text-generation endpoint. When a
 * user keeps the familiar `/api/v1` root for these model families, route the
 * request through the official OpenAI-compatible endpoint on the same origin.
 * A caller can also opt into that contract explicitly with a
 * `/compatible-mode/v1` base URL.
 */
export function resolveDashScopeTextEndpoint(baseUrl: string, model: string): DashScopeTextEndpoint {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/compatible-mode\/v1(?:\/chat\/completions)?$/i.test(normalized)) {
    return {
      protocol: "openai_compatible",
      url: resolveOpenAIChatCompletionsUrl(normalized),
    };
  }

  const requiresModernContract = /^qwen3\.(?:5|6)(?:[-.]|$)/i.test(model.trim());
  if (requiresModernContract && /\/api\/v1$/i.test(normalized)) {
    const compatibleRoot = normalized.replace(/\/api\/v1$/i, "/compatible-mode/v1");
    return {
      protocol: "openai_compatible",
      url: resolveOpenAIChatCompletionsUrl(compatibleRoot),
    };
  }

  return {
    protocol: "native_text",
    url: resolveDashScopeGenerationUrl(normalized),
  };
}
