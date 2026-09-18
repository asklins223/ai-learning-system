/**
 * R1: DashScope provider — now a thin wrapper around OpenAICompatibleProvider.
 *
 * DashScope (Alibaba Cloud 百炼 / 通义千问) uses the OpenAI-compatible endpoint
 * (`/compatible-mode/v1/chat/completions`). Generic chat and Agent transport
 * methods are inherited from OpenAICompatibleProvider.
 *
 * This file provides the DashScope preset configuration (resolveEndpoint,
 * extraRequestParams, extraHeaders, maxTokensStrategy) and its factory
 * registrations.
 */

import { resolveDashScopeTextEndpoint, resolveOpenAIEmbeddingsUrl } from "@ailearn/shared/ai-endpoints";
import type { CapabilityImpl, ProviderRuntimeConfig } from "@ailearn/shared";
import { registerFactory } from "../provider-factory.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";

/** DashScope default base path. */
const DEFAULT_BASE_PATH = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** DashScope endpoint resolver. */
function resolveDashScopeEndpoint(baseUrl: string): string {
  return resolveDashScopeTextEndpoint(baseUrl).url;
}

/** DashScope embedding endpoint resolver. */
function resolveDashScopeEmbeddingEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (!/\/compatible-mode\/v1(?:\/embeddings)?$/i.test(normalized)) {
    throw new Error("DashScope baseUrl must end with /compatible-mode/v1");
  }
  return resolveOpenAIEmbeddingsUrl(normalized);
}

// ─── R2: Factory registrations for DashScope ────────────────────────────
// DashScope is a preset of OpenAICompatibleProvider. The factory creates
// an OpenAICompatibleProvider with DashScope-specific resolveEndpoint,
// extraRequestParams, extraHeaders, and maxTokensStrategy.

function createDashScopeProvider(config: ProviderRuntimeConfig): OpenAICompatibleProvider | null {
  const apiKey = config.apiKey;
  if (!apiKey) return null;
  const model = config.model ?? "qwen-plus";
  const visionModel = config.visionModel ?? "qwen3-vl-plus";
  const embeddingModel = (config as ProviderRuntimeConfig & { embeddingModel?: string | null }).embeddingModel
    ?? "text-embedding-v1";
  const basePath = (config.baseUrl ?? DEFAULT_BASE_PATH).replace(/\/$/, "");

  const workspace = config.options?.workspace;
  const enableThinking = config.options?.enableThinking ?? false;
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
