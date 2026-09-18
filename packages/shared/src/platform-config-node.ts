/**
 * node:fs 依赖的配置加载/解析（web 客户端不可打包——SilentProofScene 经
 * @ailearn/shared index 全量导出会引入 node:fs → UnhandledSchemeError）。
 * 2026-08-13：从 platform-config.ts 拆出。worker/api（服务端）从
 * @ailearn/shared/platform-config-node 子路径 import；web 端只依赖
 * platform-config.ts（纯类型/env 逻辑）。
 */
import { readFileSync, existsSync } from "node:fs";
import type { AIPlatformConfig, ResolvedPlatform } from "./platform-config.ts";
import type { Capability } from "./provider-capabilities.ts";

// 设计 P1-6（2026-09-15 审计）：ResolvedPlatform 此前在本文件与
// platform-config.ts 里逐字重复定义（只差一行注释）——加字段时编译器不会报错，
// 两边必然漂移。现在只保留 platform-config.ts 的唯一定义，这里 re-export
// 以保持既有子路径 import 可用。
export type { ResolvedPlatform };

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
      // 显式配置路径不存在时禁用 provider 解析，避免进程误用未声明的配置来源。
      if (process.env.AI_PLATFORMS_CONFIG) {
        console.warn(
          `[ai-platforms] AI_PLATFORMS_CONFIG is set to "${process.env.AI_PLATFORMS_CONFIG}" `
          + "but the file does not exist; provider resolution is disabled.",
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
        + "unmapped capabilities are unavailable until configured.",
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

/**
 * Resolve which platform + model to use for a given capability.
 *
 * The config file is the only provider source. Returns null if no platform is
 * configured for the capability.
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
      // 外部 provider 缺少凭据时不可用，由调用方决定是否使用 mock。
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
    // C7 安全子集：配置文件存在但该 capability 未映射 —— 每进程只告警一次。
    if (!warnedUnmappedCapabilities.has(cap)) {
      warnedUnmappedCapabilities.add(cap);
      console.warn(
        `[ai-platforms] config file does not map capability "${cap}"; `
        + "the capability is unavailable until it is mapped.",
      );
    }
  }

  return null;
}
