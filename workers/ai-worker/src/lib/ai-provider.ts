import type {
  AgentTurnRequest,
  AgentTurnResult,
  ProviderCapability,
  ChatMessage,
  ChatOptions,
  ChatResult,
} from "@ailearn/shared";

// ─── v0.6: Provider Usage Tracking (计划 §6.6, §10.5) ───────────────────


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
 * AIProvider interface: generic model capabilities only.
 */
export interface AIProvider {
  id: string;
  modelId: string;
  visionModelId: string;
  promptVersion: string;

  // ── Generic capability methods ──
  /** Generic chat completion; callers own prompt and output contracts. */
  chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult>;

  /**
   * §8.2 真实流式 chat completion：逐 token/增量调用 onDelta（不可为空串），
   * 返回累积全文与（若实现支持）本轮 native tool_calls。可选实现。
   *
   * 生产调用方：companion agent 的每一步（runStreamingAgentStep，
   * responseFormat="text"），增量经交付管线边生成边落库下发。
   *
   * `toolCalls` 为可选：SSE 里 `delta.tool_calls` 与 `delta.content` 并列，
   * 但只有声明 `chatCompletionStreamToolCalls = true` 的实现才保证把它解析出来。
   * 未声明的实现仍会返回该字段（恒为空数组），调用方据此判断"这一步真的没调工具"
   * 还是"这条流根本看不见工具调用"。
   */
  chatCompletionStream?(
    messages: ChatMessage[],
    options: ChatOptions,
    signal: AbortSignal | undefined,
    onDelta: (deltaText: string) => void,
  ): Promise<{
    content: string;
    toolCalls?: AgentTurnResult["toolCalls"];
    /** SSE 末尾的 finish_reason（缺省视作 stop；"length" 表示输出被截断）。 */
    finishReason?: string;
  }>;

  /**
   * 流式路径是否解析 `delta.tool_calls`（2026-09-19 ④-b）。
   *
   * agent 循环用它决定**带工具的一步**能不能走流式：不能的话那一步必须留在
   * 整段取回路径上（否则模型返回的工具调用会被静默丢掉，用户看到的是一句
   * "我去看看"却什么都没发生）。
   */
  chatCompletionStreamToolCalls?: boolean;

  // ── Supervisor Agent v1（计划 §8.1） ──
  executeAgentTurn?(request: AgentTurnRequest, signal?: AbortSignal): Promise<AgentTurnResult>;
  getCapabilities?(): ProviderCapability;

  // ── Embedding (optional) ──
  embed?(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

// Import provider modules for their factory registrations.
import "./providers/mock.ts";
import "./providers/dashscope.ts";
import "./providers/openai-compatible.ts";
import "./providers/siliconflow.ts";
import "./providers/opencode-go.ts";
import { createCapabilityProvider } from "./provider-factory.ts";
import type { ProviderRuntimeConfig as SharedRuntimeConfig } from "@ailearn/shared";
import { resolveSystemPlatform } from "@ailearn/shared/platform-config-node";
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
 * R2: 只通过 provider 注册表创建实例；provider 配置由治理上下文提供。
 *
 * @param providerName provider 标识（mock | dashscope | openai_compatible | siliconflow | opencode_go）
 */
export function createProvider(
  providerName: string,
  config: AIProviderRuntimeConfig = {},
): AIProvider {
  const id = providerName.toLowerCase();

  // §2.3 缺 key 判定 fail-fast：非 mock provider 收到含 ${VAR} 字面文本的 apiKey 时，
  // 说明 config/ai-platforms.json 引用了未设置的 env var。立即报错而非等到请求期 401。
  // （resolveSystemPlatform 已将同一场景视为不可用，此处阻止未解析占位符进入 provider。）
  if (id !== "mock" && config.apiKey && config.apiKey.includes("${")) {
    // 不回显 apiKey 内容（即使其形式为未解析的 ${VAR} 占位符，也可能
    // 泄露配置细节到错误/日志）。
    throw new Error(
      `Provider "${providerName}" received an unresolved env var reference in apiKey (e.g. \${VAR}). `
      + "Set the referenced environment variable or remove the reference in config/ai-platforms.json.",
    );
  }

  const impl = createCapabilityProvider(id, "agent_turn", config as SharedRuntimeConfig);
  if (!impl) {
    throw new Error(`provider ${id} is not configured for agent_turn`);
  }
  return impl as unknown as AIProvider;
}

/**
 * 交互链路低延迟变体：返回一份显式关闭思考模式的 provider 配置。
 *
 * 平台配置里的 `enableThinking`（如 tokenrhythm）是给后台任务的质量档位；
 * 伴星对话与念头生成是**用户等待中**的交互，而这两条链路都是整段取回
 * （非流式）：等待时间 = 思考 token + 正文，思考全算进首字延迟。各 provider
 * 实现都优先读 `platformOptions.disableThinking`（openai-compatible /
 * opencode-go 发 `enable_thinking: false`；dashscope 缺省即关闭）。
 *
 * 返回新对象、不改写入参：上游 `resolveProviderForTask` 返回的是治理上下文
 * 里的共享配置，就地改写会波及同一 job 的 embedding 等其他能力。
 */
export function withThinkingDisabled(config: AIProviderRuntimeConfig): AIProviderRuntimeConfig {
  return {
    ...config,
    options: { ...(config.options ?? {}), disableThinking: true },
  };
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
 * ARCH-06: This function delegates to `resolveAIGovernanceContext` when no
 * cached context is provided, keeping provider selection on one config path.
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
 * @param cachedGovCtx Optional governance context with pre-resolved embedding config.
 */
export async function createEmbeddingProvider(
  cachedGovCtx?: { embeddingProviderName: string | null; embeddingProviderConfig: AIProviderRuntimeConfig | null } | null,
): Promise<EmbeddingProviderLike | null> {
    // 1. Use cached governance context if available (avoids redundant DB query)
  if (cachedGovCtx?.embeddingProviderName && cachedGovCtx?.embeddingProviderConfig) {
    const providerId = cachedGovCtx.embeddingProviderName;
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

  // 2. System-level config from the platform config file
  const platform = resolveSystemPlatform("embedding");
  if (!platform) return null;

  const providerId = platform.type;
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
