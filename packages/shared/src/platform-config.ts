/**
 * Platform configuration — config-file-driven platform registry.
 *
 * Replaces the scattered AI_PROVIDER_* env vars with a single JSON config file.
 * Users define platform instances with their own identifiers, map capabilities
 * to platform + model, and can add new platforms without changing code.
 *
 * Config file location:
 *   - AI_PLATFORMS_CONFIG env var (path to JSON file)
 *   - Default: config/ai-platforms.json (relative to CWD)
 *
 * Config file schema:
 * {
 *   "platforms": {
 *     "myqwen": {                          // user-defined identifier
 *       "type": "dashscope",               // protocol implementation
 *       "apiKey": "${DASHSCOPE_API_KEY}",  // env var interpolation
 *       "baseUrl": "https://...",
 *       "options": { ... }                 // provider-specific options
 *     },
 *     ...
 *   },
 *   "capabilities": {
 *     "agent_turn":      { "platform": "myqwen", "model": "qwen-plus" },
 *     "text_generation": { "platform": "free",   "model": "glm-4-9b" },
 *     "vision":          { "platform": "myqwen", "model": "qwen-vl-plus" },
 *     "embedding":       { "platform": "free",   "model": "bge-m3" }
 *   }
 * }
 *
 * Supported platform types: mock, dashscope, openai_compatible, siliconflow
 * Adding a new platform type requires code (implementing the provider class +
 * registering the factory). Adding a new platform instance of an existing
 * type only requires editing the config file.
 */

import type { Capability } from "./provider-capabilities.ts";
// 2026-08-13：node:fs 依赖的 loadPlatformConfig/resolveSystemPlatform 已拆至
// platform-config-node.ts（服务端子路径）；本文件保持 web 客户端可打包。
import { getProviderById } from "./provider-registry.ts";

// ─── Config schema ───────────────────────────────────────────────────────

/** Provider-specific options (passed through to the provider constructor). */
export interface PlatformOptions {
  /** Disable thinking/reasoning mode (e.g., for deepseek-v4, qwen3). */
  disableThinking?: boolean;
  /** Disable max_tokens field in API requests. */
  disableMaxTokens?: boolean;
  /** Enable thinking mode (DashScope opt-in, default off). */
  enableThinking?: boolean;
  /** DashScope workspace ID (sent as X-DashScope-WorkSpace header). */
  workspace?: string;
  /** Override context window tokens. */
  contextWindowTokens?: number;
  /** Override max output tokens for agent turns (bounds request.max_tokens). */
  maxOutputTokens?: number;
  /** Extra request headers. */
  extraHeaders?: Record<string, string>;
}

/** A platform definition from the config file. */
export interface PlatformDefinition {
  /** Provider type (protocol implementation): mock, dashscope, openai_compatible, siliconflow. */
  type: string;
  /** API key (supports ${ENV_VAR} interpolation). */
  apiKey?: string;
  /** Base URL (supports ${ENV_VAR} interpolation). */
  baseUrl?: string;
  /** Default model for this platform. */
  model?: string;
  /** Default vision model. */
  visionModel?: string;
  /** Default embedding model. */
  embeddingModel?: string;
  /** Provider-specific options. */
  options?: PlatformOptions;
}

/** A capability mapping from the config file. */
export interface CapabilityMapping {
  /** Platform identifier (references a key in platforms). */
  platform: string;
  /** Model to use for this capability. */
  model: string;
  /** Optional vision model override (for vision capability). */
  visionModel?: string;
  /** Optional embedding model override (for embedding capability). */
  embeddingModel?: string;
}

/** The full config file schema. */
export interface AIPlatformConfig {
  /** Platform definitions keyed by user-defined identifier. */
  platforms: Record<string, PlatformDefinition>;
  /** Capability → platform + model mappings. */
  capabilities: Partial<Record<Capability, CapabilityMapping>>;
}


// ─── Resolution ──────────────────────────────────────────────────────────

/**
 * Resolved platform config for a specific capability.
 * Contains everything needed to create a provider instance.
 */

/**
 * Resolve connection config from legacy per-provider env vars.
 *
 * Exported so the worker governance layer can resolve config for a
 * workspace-pinned provider type that has no matching config-file platform
 * (see resolveAIGovernanceContext workspace branch). Returns null when the
 * provider's required env vars are not set.
 */
export function resolveLegacyProviderConfig(providerName: string): {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  visionModel?: string;
  embeddingModel?: string;
  options?: PlatformOptions;
} | null {
  switch (providerName) {
    case "mock":
      return { model: "mock-v1" };

    case "dashscope":
    case "qwen": {
      const apiKey = process.env.DASHSCOPE_API_KEY;
      if (!apiKey) return null;
      return {
        apiKey,
        baseUrl: process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: process.env.DASHSCOPE_MODEL ?? "qwen-plus",
        visionModel: process.env.DASHSCOPE_VISION_MODEL,
        embeddingModel: process.env.DASHSCOPE_EMBEDDING_MODEL,
        options: {
          enableThinking: process.env.DASHSCOPE_ENABLE_THINKING === "true",
          workspace: process.env.DASHSCOPE_WORKSPACE,
          contextWindowTokens: process.env.DASHSCOPE_CONTEXT_WINDOW_TOKENS
            ? Number(process.env.DASHSCOPE_CONTEXT_WINDOW_TOKENS)
            : undefined,
        },
      };
    }

    case "openai_compatible": {
      const apiKey = process.env.OPENAI_COMPAT_API_KEY;
      const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
      const model = process.env.OPENAI_COMPAT_MODEL;
      if (!apiKey || !baseUrl || !model) return null;
      return {
        apiKey,
        baseUrl,
        model,
        visionModel: process.env.OPENAI_COMPAT_VISION_MODEL,
        embeddingModel: process.env.OPENAI_COMPAT_EMBEDDING_MODEL,
        options: {
          disableThinking: process.env.OPENAI_COMPAT_DISABLE_THINKING === "true",
          disableMaxTokens: process.env.OPENAI_COMPAT_DISABLE_MAX_TOKENS === "true",
          contextWindowTokens: process.env.OPENAI_COMPAT_CONTEXT_WINDOW_TOKENS
            ? Number(process.env.OPENAI_COMPAT_CONTEXT_WINDOW_TOKENS)
            : undefined,
        },
      };
    }

    case "siliconflow": {
      const apiKey = process.env.SILICONFLOW_API_KEY;
      if (!apiKey) return null;
      return {
        apiKey,
        baseUrl: process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1",
        model: process.env.SILICONFLOW_EMBEDDING_MODEL ?? "BAAI/bge-m3",
        embeddingModel: process.env.SILICONFLOW_EMBEDDING_MODEL ?? "BAAI/bge-m3",
      };
    }

    default:
      return null;
  }
}

export function isSupportedPlatformType(type: string): boolean {
  return getProviderById(type) !== undefined;
}

export interface ResolvedPlatform {
  /** Provider type (protocol implementation). */
  type: string;
  /** Platform identifier from config. */
  platformId: string;
  /** API key (interpolated from config or env). */
  apiKey?: string;
  /** Base URL. */
  baseUrl?: string;
  /** Model for this capability. */
  model: string;
  /** Vision model (if specified). */
  visionModel?: string;
  /** Embedding model (if specified). */
  embeddingModel?: string;
  /** Platform options (thinking mode etc.). */
  options?: PlatformOptions;
}
