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

import { readFileSync, existsSync } from "node:fs";
import type { Capability } from "./provider-capabilities.ts";
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

// ─── Config loading (cached) ─────────────────────────────────────────────

let cachedConfig: AIPlatformConfig | null = null;
let configLoadAttempted = false;

/** Default config file path. */
const DEFAULT_CONFIG_PATH = "config/ai-platforms.json";

/**
 * Get the config file path from env var or default.
 */
function getConfigPath(): string {
  return process.env.AI_PLATFORMS_CONFIG || DEFAULT_CONFIG_PATH;
}

/** 记录本次加载中未命中的 ${ENV_VAR} 引用，用于加载后一次性告警。 */
const unresolvedEnvRefs = new Set<string>();

/** 已就"capability 未在配置文件中映射"告警过的能力，避免每次解析都刷日志。 */
const warnedUnmappedCapabilities = new Set<string>();

/**
 * Interpolate ${ENV_VAR} references in a string.
 * Returns the env var value if the reference exists, otherwise returns
 * the original ${VAR} text (so the error message is helpful) and records
 * the missing var in unresolvedEnvRefs.
 */
function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      unresolvedEnvRefs.add(varName);
      return match;
    }
    return envValue;
  });
}

/**
 * Recursively interpolate ${ENV_VAR} in all string values of an object.
 */
function interpolateObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return interpolateEnvVars(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateObject) as unknown as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateObject(value);
    }
    return result as unknown as T;
  }
  return obj;
}

/**
 * Load and parse the platform config file.
 * Cached after first successful load.
 *
 * Returns null if:
 * - The config file doesn't exist
 * - AI_PLATFORMS_CONFIG is not set and the default file doesn't exist
 *
 * Throws if the config file exists but is invalid JSON or missing required fields.
 */
export function loadPlatformConfig(): AIPlatformConfig | null {
  if (configLoadAttempted) return cachedConfig;
  configLoadAttempted = true;
  unresolvedEnvRefs.clear();

  const configPath = getConfigPath();

  try {
    if (!existsSync(configPath)) {
      // 迁移遗漏修复（C8）：AI_PLATFORMS_CONFIG 被显式设置但文件不存在时，整个配置迁移
      // 会静默失效并回退 legacy env。加载时告警，避免部署后才发现没在用配置文件。
      if (process.env.AI_PLATFORMS_CONFIG) {
        console.warn(
          `[ai-platforms] AI_PLATFORMS_CONFIG is set to "${process.env.AI_PLATFORMS_CONFIG}" `
          + "but the file does not exist; falling back to legacy AI_PROVIDER_* env vars / mock. "
          + "This usually means the config-file migration is not active in this deployment.",
        );
      }
      return null;
    }
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as AIPlatformConfig;

    // Validate required fields
    if (!parsed.platforms || typeof parsed.platforms !== "object") {
      throw new Error("config file missing 'platforms' object");
    }
    if (!parsed.capabilities || typeof parsed.capabilities !== "object") {
      throw new Error("config file missing 'capabilities' object");
    }
    if (Object.keys(parsed.capabilities).length === 0) {
      console.warn(
        "[ai-platforms] config file exists but has no capability mappings; "
        + "provider resolution will fall back to legacy AI_PROVIDER_* env vars / mock.",
      );
    }

    // Interpolate ${ENV_VAR} in all string values
    cachedConfig = interpolateObject(parsed);
    // 迁移遗漏修复：未命中的 ${VAR} 会以字面文本进入配置（如 apiKey="${BIGMODEL_API_KEY}"），
    // 后续表现为 401 且难以排查。加载时一次性告警，方便尽早发现。
    if (unresolvedEnvRefs.size > 0) {
      const missing = [...unresolvedEnvRefs].sort().join(", ");
      console.warn(
        `[ai-platforms] config file references unset env vars: ${missing}. `
        + "The literal ${VAR} text will be used as the value, which usually causes "
        + "provider auth failures. Set these variables in the environment or remove the references.",
      );
    }
    return cachedConfig;
  } catch (err) {
    if (err instanceof Error && err.message.includes("ENOENT")) {
      // File doesn't exist — not an error, just no config
      return null;
    }
    throw new Error(`Failed to load AI platform config from ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Reset the config cache. Useful for testing.
 */
export function resetPlatformConfigCache(): void {
  cachedConfig = null;
  configLoadAttempted = false;
}

/**
 * Force-set the config (for testing).
 */
export function setPlatformConfig(config: AIPlatformConfig | null): void {
  cachedConfig = config;
  configLoadAttempted = true;
}

// ─── Resolution ──────────────────────────────────────────────────────────

/**
 * Resolved platform config for a specific capability.
 * Contains everything needed to create a provider instance.
 */
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
  /** Provider-specific options. */
  options?: PlatformOptions;
}

/**
 * Resolve which platform + model to use for a given capability.
 *
 * Resolution order:
 *   1. Platform config file (config/ai-platforms.json)
 *   2. Fallback to legacy env var resolution (resolveSystemProviderForCapability)
 *
 * Returns null if no platform is configured for the capability.
 */
export function resolveSystemPlatform(cap: Capability): ResolvedPlatform | null {
  const config = loadPlatformConfig();

  if (config) {
    const capMapping = config.capabilities[cap];
    if (capMapping) {
      const platform = config.platforms[capMapping.platform];
      if (!platform) {
        throw new Error(`capability "${cap}" references platform "${capMapping.platform}" which is not defined in platforms`);
      }
      // §2.3 缺 key 判定：非 mock 平台但 apiKey 为空或仍含未解析的 ${VAR} 字面文本时，
      // 视为「系统未配置外部模型」→ 返回 null（调用方回退到 mock，豁免 consent）。
      // 消除 config 文件与 legacy env 两种配置源对同一缺失的语义分歧。
      if (platform.type.toLowerCase() !== "mock") {
        const apiKey = platform.apiKey;
        if (!apiKey || apiKey.includes("${")) {
          return null;
        }
      }

      return {
        type: platform.type,
        platformId: capMapping.platform,
        apiKey: platform.apiKey,
        baseUrl: platform.baseUrl,
        model: capMapping.model,
        visionModel: capMapping.visionModel ?? platform.visionModel,
        embeddingModel: capMapping.embeddingModel ?? platform.embeddingModel,
        options: platform.options,
      };
    }
    // C7 安全子集：配置文件存在但该 capability 未映射 —— 每进程只告警一次，
    // 避免部署以为在用配置文件、实际该能力静默回退到 legacy env / mock。
    if (!warnedUnmappedCapabilities.has(cap)) {
      warnedUnmappedCapabilities.add(cap);
      console.warn(
        `[ai-platforms] config file does not map capability "${cap}"; `
        + "falling back to legacy AI_PROVIDER_* env vars / mock.",
      );
    }
  }

  // Fallback: legacy env var resolution
  return resolveLegacyEnvVar(cap);
}

/**
 * Legacy env var resolution (backward compatibility when no config file exists).
 * Maps capabilities to provider names via AI_PROVIDER_* env vars.
 */
function resolveLegacyEnvVar(cap: Capability): ResolvedPlatform | null {
  // Map capability to the env var chain
  let providerName: string | undefined;

  switch (cap) {
    case "agent_turn":
      providerName = (process.env.AI_PROVIDER_AGENT_TURN ?? process.env.AI_PROVIDER_CARD ?? "mock").toLowerCase();
      break;
    case "text_generation":
      providerName = (process.env.AI_PROVIDER_TEXT_GENERATION
        ?? process.env.AI_PROVIDER_AGENT_TURN
        ?? process.env.AI_PROVIDER_CARD
        ?? "mock").toLowerCase();
      break;
    case "vision":
      providerName = (process.env.AI_PROVIDER_VISION
        ?? process.env.AI_PROVIDER_AGENT_TURN
        ?? process.env.AI_PROVIDER_CARD
        ?? "mock").toLowerCase();
      break;
    case "embedding":
      providerName = (process.env.AI_PROVIDER_EMBEDDING ?? "").toLowerCase().trim() || undefined;
      break;
    case "rerank":
      providerName = (process.env.AI_PROVIDER_RERANK
        ?? process.env.AI_PROVIDER_EMBEDDING
        ?? "").toLowerCase().trim() || undefined;
      break;
    default:
      return null;
  }

  if (!providerName) return null;

  // Resolve provider-specific env vars for connection config
  const platform = resolveLegacyProviderConfig(providerName);
  if (!platform) return null;

  return {
    type: providerName,
    platformId: providerName,
    apiKey: platform.apiKey,
    baseUrl: platform.baseUrl,
    model: platform.model ?? "",
    visionModel: platform.visionModel,
    embeddingModel: platform.embeddingModel,
    options: platform.options,
  };
}

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

/**
 * Get the list of all defined platform identifiers (for diagnostics).
 */
export function getDefinedPlatformIds(): string[] {
  const config = loadPlatformConfig();
  if (config) return Object.keys(config.platforms);
  // Legacy fallback: return provider IDs from PROVIDER_METADATA
  return [];
}

/**
 * Check if a platform type is supported (i.e., has a provider implementation).
 */
export function isSupportedPlatformType(type: string): boolean {
  return getProviderById(type) !== undefined;
}
