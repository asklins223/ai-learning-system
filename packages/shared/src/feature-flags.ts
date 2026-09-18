/**
 * Server-side feature flags
 *
 * Centralised feature flag utilities for the API server and AI Worker.
 * Flags are read from process.env (NOT NEXT_PUBLIC_*) so they are only
 * available on the server side.
 *
 * Default behaviour: provider prompt caching is disabled.
 */
/**
 * PROMPT_CACHE_ENABLED — gates provider prompt caching (B2, 计划 §2.5).
 *
 * When false (default): no cache control markers are sent to providers,
 * and cache-related usage fields are parsed but not actively requested.
 *
 * When true: providers in the PROMPT_CACHE_PROVIDERS whitelist will have
 * cache control hints added to their requests, enabling prompt prefix
 * reuse across turns within the same run.
 *
 * Risk control: flag default off; parse failure silently degrades.
 */
function isPromptCacheEnabled(): boolean {
  return process.env.PROMPT_CACHE_ENABLED === "true";
}

// PROMPT_CACHE_PROVIDERS is effectively static in production; parse it once
// and reuse the Set to avoid per-call env split + allocation on hot LLM paths.
// Cache is keyed by the raw env value so tests that mutate env still get correct
// per-value parsing.
let promptCacheProvidersCache: { raw: string | undefined; set: Set<string> } | null = null;

/**
 * Get the set of provider IDs allowed to use prompt caching.
 *
 * Reads from PROMPT_CACHE_PROVIDERS env var (comma-separated).
 * When PROMPT_CACHE_ENABLED is true but PROMPT_CACHE_PROVIDERS is unset,
 * defaults to "dashscope" (the most commonly supported provider).
 *
 * @returns Set of lowercase provider IDs (e.g., {"dashscope", "openai_compatible"})
 */
export function getPromptCacheProviders(): Set<string> {
  const raw = process.env.PROMPT_CACHE_PROVIDERS;
  if (promptCacheProvidersCache && promptCacheProvidersCache.raw === raw) {
    return promptCacheProvidersCache.set;
  }

  let parsed: Set<string>;
  if (!raw || raw.trim() === "") {
    parsed = new Set(["dashscope"]);
  } else {
    const items = raw.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    // If all entries were empty/whitespace, fall back to default
    parsed = items.length > 0 ? new Set(items) : new Set(["dashscope"]);
  }
  promptCacheProvidersCache = { raw, set: parsed };
  return parsed;
}

/**
 * Check if a specific provider should use prompt caching.
 * Convenience wrapper: checks both the global flag and the provider whitelist.
 */
export function shouldUsePromptCache(providerId: string): boolean {
  if (!isPromptCacheEnabled()) return false;
  return getPromptCacheProviders().has(providerId.toLowerCase());
}
