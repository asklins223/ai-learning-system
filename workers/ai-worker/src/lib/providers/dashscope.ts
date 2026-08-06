/**
 * R1: DashScope provider — now a thin wrapper around OpenAICompatibleProvider.
 *
 * DashScope (Alibaba Cloud 百炼 / 通义千问) uses the OpenAI-compatible endpoint
 * (`/compatible-mode/v1/chat/completions`). All business methods (evaluateValidation,
 * analyzeImage, executeAgentTurn, etc.) are inherited from OpenAICompatibleProvider.
 *
 * This file provides:
 * 1. DashScope-specific constructor that accepts legacy options (basePath, workspace, request: typeof fetch)
 * 2. DashScope preset configuration (resolveEndpoint, extraRequestParams, extraHeaders, maxTokensStrategy)
 * 3. Backward-compatible DashScopeProvider class for existing test files
 *
 * Environment variables:
 *   DASHSCOPE_API_KEY             Required
 *   DASHSCOPE_MODEL               Default: qwen-plus
 *   DASHSCOPE_VISION_MODEL        Default: qwen3-vl-plus
 *   DASHSCOPE_EMBEDDING_MODEL     Default: text-embedding-v1
 *   DASHSCOPE_BASE_URL            Default: https://dashscope.aliyuncs.com/api/v1
 *   DASHSCOPE_WORKSPACE           Optional workspace ID
 *   DASHSCOPE_ENABLE_THINKING     Optional, default off (enable_thinking: false)
 *   DASHSCOPE_CONTEXT_WINDOW_TOKENS  Optional, overrides default context window
 */

import { resolveDashScopeTextEndpoint } from "@ailearn/shared/ai-endpoints";
import type { PublicJsonRequester } from "@ailearn/shared/public-json-http";
import type { CapabilityImpl, ProviderRuntimeConfig } from "@ailearn/shared";
import { registerFactory } from "../provider-factory.ts";
import { OpenAICompatibleProvider, adaptFetchToPublicJsonRequester } from "./openai-compatible.ts";

/** DashScope default base path (legacy /api/v1, rewritten to /compatible-mode/v1). */
const DEFAULT_BASE_PATH = "https://dashscope.aliyuncs.com/api/v1";

/** R1: DashScope endpoint resolver — rewrites /api/v1 → /compatible-mode/v1 and appends /chat/completions. */
function resolveDashScopeEndpoint(baseUrl: string): string {
  return resolveDashScopeTextEndpoint(baseUrl).url;
}

/** R1: DashScope embedding endpoint resolver — rewrites /api/v1 → /compatible-mode/v1 and appends /embeddings. */
function resolveDashScopeEmbeddingEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/compatible-mode\/v1$/i.test(normalized)) {
    return `${normalized}/embeddings`;
  }
  if (/\/api\/v1$/i.test(normalized)) {
    return `${normalized.replace(/\/api\/v1$/i, "/compatible-mode/v1")}/embeddings`;
  }
  return `${normalized}/embeddings`;
}

/**
 * R1: DashScopeProvider — a thin wrapper around OpenAICompatibleProvider.
 *
 * Accepts the legacy DashScope constructor options and translates them to
 * OpenAICompatibleProvider preset configuration. All business methods are
 * inherited from OpenAICompatibleProvider.
 *
 * This class is kept for backward compatibility with existing test files.
 * New code should use `createProvider("dashscope", ...)` or the future
 * provider registry factory.
 */
export class DashScopeProvider extends OpenAICompatibleProvider {
  constructor(options: {
    apiKey?: string;
    basePath?: string;
    model?: string;
    visionModel?: string;
    embeddingModel?: string;
    workspace?: string;
    request?: typeof globalThis.fetch | PublicJsonRequester;
  } = {}) {
    const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new Error("DASHSCOPE_API_KEY is required for DashScopeProvider");
    }
    const model = options.model ?? process.env.DASHSCOPE_MODEL ?? "qwen-plus";
    const visionModel = options.visionModel
      ?? process.env.DASHSCOPE_VISION_MODEL
      ?? "qwen3-vl-plus";
    const embeddingModel = options.embeddingModel
      ?? process.env.DASHSCOPE_EMBEDDING_MODEL
      ?? "text-embedding-v1";
    const basePath = (options.basePath
      ?? process.env.DASHSCOPE_BASE_URL
      ?? process.env.DASHSCOPE_HTTP_BASE_URL
      ?? DEFAULT_BASE_PATH).replace(/\/$/, "");
    const workspace = options.workspace ?? process.env.DASHSCOPE_WORKSPACE;

    // R1: Compute DashScope-specific preset options
    const enableThinking = process.env.DASHSCOPE_ENABLE_THINKING === "true";
    const extraRequestParams: Record<string, unknown> = enableThinking
      ? {}
      : { enable_thinking: false };
    const extraHeaders: Record<string, string> | undefined = workspace
      ? { "X-DashScope-WorkSpace": workspace }
      : undefined;

    // R1: Adapt typeof fetch to PublicJsonRequester if needed
    let request: PublicJsonRequester | undefined;
    if (options.request) {
      // Check if it's a typeof fetch (has arity 2 and accepts RequestInit)
      // or a PublicJsonRequester (has arity 4 and accepts body as 3rd param)
      const req = options.request as any;
      if (req.length <= 2 || options.request === globalThis.fetch) {
        // typeof fetch — adapt to PublicJsonRequester
        request = adaptFetchToPublicJsonRequester(options.request as typeof globalThis.fetch);
      } else {
        // Already a PublicJsonRequester
        request = options.request as PublicJsonRequester;
      }
    }

    super({
      apiKey,
      baseUrl: basePath,
      model,
      visionModel,
      embeddingModel,
      request,
      // DashScope preset configuration
      resolveEndpoint: resolveDashScopeEndpoint,
      resolveEmbeddingEndpoint: resolveDashScopeEmbeddingEndpoint,
      extraRequestParams,
      extraHeaders,
      maxTokensStrategy: "always",
      providerId: "dashscope",
      promptVersionOverride: "v6-dashscope",
    });
  }
}

// ─── R2: Factory registrations for DashScope ────────────────────────────
// DashScope is a preset of OpenAICompatibleProvider. The factory creates
// an OpenAICompatibleProvider with DashScope-specific resolveEndpoint,
// extraRequestParams, extraHeaders, and maxTokensStrategy.

function createDashScopeProvider(config: ProviderRuntimeConfig): OpenAICompatibleProvider | null {
  const apiKey = config.apiKey ?? process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return null;
  const model = config.model ?? process.env.DASHSCOPE_MODEL ?? "qwen-plus";
  const visionModel = config.visionModel ?? process.env.DASHSCOPE_VISION_MODEL ?? "qwen3-vl-plus";
  // 迁移遗漏修复：embedding 能力由 embedding 工厂显式传入 embeddingModel（来自配置文件的 capability.model），
  // 否则只读 DASHSCOPE_EMBEDDING_MODEL，配置文件的 embedding 模型会被丢弃。
  const embeddingModel = (config as ProviderRuntimeConfig & { embeddingModel?: string | null }).embeddingModel
    ?? process.env.DASHSCOPE_EMBEDDING_MODEL
    ?? "text-embedding-v1";
  const basePath = (config.baseUrl ?? process.env.DASHSCOPE_BASE_URL ?? process.env.DASHSCOPE_HTTP_BASE_URL ?? DEFAULT_BASE_PATH).replace(/\/$/, "");

  // Config file options take precedence over env vars.
  const workspace = config.options?.workspace ?? process.env.DASHSCOPE_WORKSPACE;
  const enableThinking = config.options?.enableThinking
    ?? (process.env.DASHSCOPE_ENABLE_THINKING === "true");
  const extraRequestParams: Record<string, unknown> = enableThinking ? {} : { enable_thinking: false };
  const extraHeaders: Record<string, string> | undefined = workspace
    ? { "X-DashScope-WorkSpace": workspace }
    : undefined;

  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl: basePath,
    model,
    visionModel,
    embeddingModel,
    resolveEndpoint: resolveDashScopeEndpoint,
    resolveEmbeddingEndpoint: resolveDashScopeEmbeddingEndpoint,
    extraRequestParams,
    extraHeaders,
    maxTokensStrategy: "always",
    providerId: "dashscope",
    promptVersionOverride: "v6-dashscope",
    // Pass through any remaining platform options (e.g., contextWindowTokens).
    ...(config.options ? { platformOptions: config.options } : {}),
  });
}

registerFactory("dashscope", "text_generation", (config) => {
  const provider = createDashScopeProvider(config);
  return provider ? provider as unknown as CapabilityImpl : null;
});

registerFactory("dashscope", "vision", (config) => {
  const provider = createDashScopeProvider(config);
  return provider ? provider as unknown as CapabilityImpl : null;
});

registerFactory("dashscope", "agent_turn", (config) => {
  const provider = createDashScopeProvider(config);
  return provider ? provider as unknown as CapabilityImpl : null;
});

registerFactory("dashscope", "embedding", (config) => {
  // 配置文件 embedding 能力的 model 即 embedding 模型，显式传给 createDashScopeProvider。
  const provider = createDashScopeProvider({
    ...config,
    embeddingModel: config.model ?? undefined,
  } as ProviderRuntimeConfig & { embeddingModel?: string | null });
  return provider ? provider as unknown as CapabilityImpl : null;
});
