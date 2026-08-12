import type {
  AgentTurnRequest,
  AgentTurnResult,
  ProviderCapability,
  ChatMessage,
  ChatOptions,
  ChatResult,
} from "@ailearn/shared";

// ─── v0.6: Provider Usage Tracking (计划 §6.6, §10.5) ───────────────────

// R2: DEFAULT_CONTEXT_WINDOW_TOKENS moved to provider-constants.ts to break
// circular dependency (ai-provider.ts → providers/*.ts → ai-provider.ts).
// Re-exported here for backward compatibility.
export { DEFAULT_CONTEXT_WINDOW_TOKENS } from "./provider-constants.ts";


/**
 * Token usage returned by an AI provider after a call.
 *
 * All fields are optional because not all providers return usage data
 * (e.g., Mock provider returns estimated values).
 *
 * This is used to populate:
 * - `ai_artifacts.cost_tokens` (§6.6)
 * - `ai_audit_log.cost_tokens` via `logAICall` (§10.5)
 */
export interface ProviderUsage {
  /** Total tokens (prompt + completion) */
  totalTokens?: number | null;
  /** Prompt/input tokens */
  promptTokens?: number | null;
  /** Completion/output tokens */
  completionTokens?: number | null;
  /** Provider request ID (for traceability, §5.2 Should) */
  requestId?: string | null;
  /**
   * B2（计划 §2.5）：prompt cache 命中的 token 数。
   * provider 返回 cache 命中时记录，用于成本观测。
   */
  cacheHitTokens?: number | null;
  /**
   * B2（计划 §2.5）：prompt cache 未命中的 token 数。
   */
  cacheMissTokens?: number | null;
}

/**
 * R5: EvaluateValidationInput — kept here for backward compatibility.
 * Previously used by provider.evaluateValidation(); now used by the
 * evaluateValidationViaChat() helper in business-ai-ops.ts.
 */
export interface EvaluateValidationInput {
  question: string;
  questionType: string;
  claim: string;
  quote: string;
  userAnswer: string;
}

/**
 * R5: AIProvider interface — slimmed down to capability methods only.
 *
 * Business-specific methods (evaluateValidation, generateValidationQuestion,
 * evaluateRubric, analyzeImage) have been removed. Callers should use the
 * helper functions in business-ai-ops.ts, which use chatCompletion +
 * caller-side prompt/schema. analyzeImage's multimodal message construction
 * now lives in analyzeImageViaChat().
 */
export interface AIProvider {
  id: string;
  modelId: string;
  visionModelId: string;
  promptVersion: string;

  // ── R5: Generic capability methods ──
  /** Generic chat completion (replaces business-specific methods). */
  chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult>;

  /**
   * §8.2 真实流式 chat completion：逐 token/增量调用 onDelta（不可为空串），
   * 返回累积全文。可选实现——调用方（companion-dialogue worker）优先使用，
   * 缺失时回退 chatCompletion + 分批写库（模拟流式节奏）。
   */
  chatCompletionStream?(
    messages: ChatMessage[],
    options: ChatOptions,
    signal: AbortSignal | undefined,
    onDelta: (deltaText: string) => void,
  ): Promise<{ content: string }>;

  // ── Supervisor Agent v1（计划 §8.1） ──
  executeAgentTurn?(request: AgentTurnRequest, signal?: AbortSignal): Promise<AgentTurnResult>;
  getCapabilities?(): ProviderCapability;

  // ── Embedding (optional) ──
  embed?(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

import { MockProvider } from "./providers/mock.ts";
import { DashScopeProvider } from "./providers/dashscope.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import { SiliconFlowProvider } from "./providers/siliconflow.ts";
import { createCapabilityProvider, hasFactory } from "./provider-factory.ts";
import type { ProviderRuntimeConfig as SharedRuntimeConfig } from "@ailearn/shared";
import { resolveSystemPlatform } from "@ailearn/shared";
import type { PlatformOptions } from "@ailearn/shared";

export interface AIProviderRuntimeConfig {
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  visionModel?: string | null;
  /** Provider-specific options from config file (disableThinking, etc.) */
  options?: PlatformOptions;
}

export interface AIProviderSelection {
  providerName: string;
  config: AIProviderRuntimeConfig;
}

/**
 * N-011: 根据 provider 名称创建 AIProvider 实例。
 *
 * R2: 委托到 provider 注册表（createCapabilityProvider），
 * 回退到旧 if-else 链（向后兼容，含 qwen 别名）。
 *
 * @param providerName provider 标识（mock | dashscope | qwen | openai_compatible | siliconflow）
 */
export function createProvider(
  providerName: string,
  config: AIProviderRuntimeConfig = {},
): AIProvider {
  const id = providerName.toLowerCase();

  // §2.3 缺 key 判定 fail-fast：非 mock provider 收到含 ${VAR} 字面文本的 apiKey 时，
  // 说明 config/ai-platforms.json 引用了未设置的 env var。立即报错而非等到请求期 401。
  // （resolveSystemPlatform 已对同一场景返回 null → mock 回退，此处是防御性二次检查。）
  if (id !== "mock" && config.apiKey && config.apiKey.includes("${")) {
    // 不回显 apiKey 内容（即使其形式为未解析的 ${VAR} 占位符，也可能
    // 泄露配置细节到错误/日志）。
    throw new Error(
      `Provider "${providerName}" received an unresolved env var reference in apiKey (e.g. \${VAR}). `
      + "Set the referenced environment variable or remove the reference in config/ai-platforms.json.",
    );
  }

  // R2: Try the factory registry first (for providers in PROVIDER_METADATA)
  // Use "agent_turn" as the default capability — the factory creates the same
  // provider instance for all capabilities in R2.
  if (id !== "qwen" && hasFactory(id, "agent_turn")) {
    const impl = createCapabilityProvider(id, "agent_turn", config as SharedRuntimeConfig);
    if (impl) {
      return impl as unknown as AIProvider;
    }
  }

  // Backward-compatible fallback (also handles qwen alias and edge cases)
  if (id === "mock") return new MockProvider();
  if (id === "dashscope" || id === "qwen") {
    return new DashScopeProvider({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseUrl ? { basePath: config.baseUrl } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.visionModel ? { visionModel: config.visionModel } : {}),
    });
  }
  if (id === "openai_compatible") {
    const apiKey = config.apiKey ?? process.env.OPENAI_COMPAT_API_KEY;
    const baseUrl = config.baseUrl ?? process.env.OPENAI_COMPAT_BASE_URL;
    const model = config.model ?? process.env.OPENAI_COMPAT_MODEL;
    const visionModel = config.visionModel ?? process.env.OPENAI_COMPAT_VISION_MODEL;
    if (!apiKey || !baseUrl || !model) {
      throw new Error(
        "OpenAI-compatible provider requires apiKey, baseUrl, and model"
        + " (configure in config/ai-platforms.json or set OPENAI_COMPAT_API_KEY, OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL)",
      );
    }
    return new OpenAICompatibleProvider({
      apiKey,
      baseUrl,
      model,
      ...(visionModel ? { visionModel } : {}),
      ...(config.options ? { platformOptions: config.options } : {}),
    });
  }
  if (id === "siliconflow") {
    // SiliconFlow 只提供 embedding + rerank 能力（BAAI/bge-m3）。
    // 文本生成仍由主 provider（AI_PROVIDER_AGENT_TURN）承担，因此 createProvider
    // 仅在确实配置了 SILICONFLOW_API_KEY 时返回实例；缺 key 时抛错。
    const apiKey = config.apiKey ?? process.env.SILICONFLOW_API_KEY;
    if (!apiKey) {
      throw new Error(
        "SiliconFlow provider requires SILICONFLOW_API_KEY"
        + " (set SILICONFLOW_API_KEY or configure config/ai-platforms.json)",
      );
    }
    return new SiliconFlowProvider({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.model ? { embeddingModel: config.model } : {}),
    }) as unknown as AIProvider;
  }
  throw new Error(`provider ${id} not implemented in worker (supported: mock, dashscope, openai_compatible, siliconflow)`);
}

/**
 * Resolve the provider configuration once per job. Governance and provider
 * construction must use this same snapshot so a concurrent settings change
 * cannot make the checked provider differ from the provider being called.
 *
 * BUG-11: When callers have already resolved a governance context via
 * `resolveAIGovernanceContext`, they should pass it as `cachedContext` to
 * avoid a redundant workspace query and ensure provider selection is based
 * on the same workspace snapshot as the governance check.
 *
 * ARCH-06 fix: This function now delegates to `resolveAIGovernanceContext`
 * when no `cachedContext` is provided, eliminating the dual code path that
 * previously queried the workspaces table independently. All production
 * callers should prefer `resolveAIGovernanceContext` directly; this function
 * is retained for backward compatibility (mainly tests).
 */
export async function resolveProviderSelection(
  workspaceId?: string,
  userId?: string,
  cachedContext?: { providerName: string; providerConfig: AIProviderRuntimeConfig },
): Promise<AIProviderSelection> {
  // BUG-11: If a cached governance context is available, reuse its provider
  // resolution to avoid querying the workspaces table a second time.
  if (cachedContext) {
    return {
      providerName: cachedContext.providerName,
      config: cachedContext.providerConfig,
    };
  }

  // ARCH-06: Delegate to resolveAIGovernanceContext so there is a single
  // code path for system platform config resolution. This ensures
  // provider selection and governance checks always see the same snapshot.
  if (workspaceId) {
    const { resolveAIGovernanceContext } = await import("./governance.ts");
    const ctx = await resolveAIGovernanceContext(workspaceId, userId ?? null);
    return { providerName: ctx.providerName, config: ctx.providerConfig };
  }

  // Use platform config file to resolve system-level provider + config.
  // Falls back to legacy env var resolution if no config file exists.
  const platform = resolveSystemPlatform("agent_turn");
  if (platform) {
    return {
      providerName: platform.type,
      config: {
        apiKey: platform.apiKey,
        baseUrl: platform.baseUrl,
        model: platform.model,
        visionModel: platform.visionModel,
        options: platform.options,
      },
    };
  }
  return {
    providerName: "mock",
    config: {},
  };
}

/**
 * Embedding provider interface (subset of AIProvider used for semantic search).
 * Matches EvidenceEmbeddingProvider from agent/tools/evidence.ts.
 */
export interface EmbeddingProviderLike {
  readonly id: string;
  readonly embeddingModelId: string;
  embed(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

/**
 * Create a standalone embedding provider.
 *
 * R2: Delegates to createCapabilityProvider(id, "embedding", config),
 * removing the duplicate if-else chain. The factory returns null when
 * the provider doesn't support embedding or config is missing, which
 * covers the previous `typeof embed === "function"` runtime check.
 *
 * Resolution order (first match wins):
 *   1. Cached governance context's embedding slot (if provided)
 *   2. System-level embedding platform from config/ai-platforms.json
 *   3. Returns null — callers should fall back to the main provider's embed()
 *
 * Note: `qwen` is mapped to `dashscope` since it's not in PROVIDER_METADATA.
 *
 * @param userId Kept for API compatibility but no longer used (platform config is system-level).
 * @param cachedGovCtx Optional governance context with pre-resolved embedding config.
 */
export async function createEmbeddingProvider(
  userId?: string,
  cachedGovCtx?: { embeddingProviderName: string | null; embeddingProviderConfig: AIProviderRuntimeConfig | null } | null,
): Promise<EmbeddingProviderLike | null> {
  void userId; // No longer used for BYOK lookup
  // 1. Use cached governance context if available (avoids redundant DB query)
  if (cachedGovCtx?.embeddingProviderName && cachedGovCtx?.embeddingProviderConfig) {
    const providerId = cachedGovCtx.embeddingProviderName === "qwen" ? "dashscope" : cachedGovCtx.embeddingProviderName;
    const impl = createCapabilityProvider(providerId, "embedding", {
      apiKey: cachedGovCtx.embeddingProviderConfig.apiKey,
      baseUrl: cachedGovCtx.embeddingProviderConfig.baseUrl,
      model: cachedGovCtx.embeddingProviderConfig.model,
      visionModel: cachedGovCtx.embeddingProviderConfig.visionModel,
      ...(cachedGovCtx.embeddingProviderConfig.options ? { options: cachedGovCtx.embeddingProviderConfig.options } : {}),
    } as SharedRuntimeConfig);
    if (impl) {
      return impl as unknown as EmbeddingProviderLike;
    }
  }

  // 2. System-level config from platform config file (or legacy env vars)
  const platform = resolveSystemPlatform("embedding");
  if (!platform) return null;

  const providerId = platform.type === "qwen" ? "dashscope" : platform.type;
  const impl = createCapabilityProvider(providerId, "embedding", {
    apiKey: platform.apiKey,
    baseUrl: platform.baseUrl,
    model: platform.model,
    ...(platform.options ? { options: platform.options } : {}),
  } as SharedRuntimeConfig);
  if (impl) {
    return impl as unknown as EmbeddingProviderLike;
  }
  return null;
}
