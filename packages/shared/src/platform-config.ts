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
 * Supported platform types: mock, dashscope, openai_compatible, siliconflow,
 * opencode_go (OpenAI Responses API).
 * Adding a new platform type requires code (implementing the provider class +
 * registering the factory). Adding a new platform instance of an existing
 * type only requires editing the config file.
 */

import type { Capability } from "./provider-capabilities.ts";
// 2026-08-13：node:fs 依赖的 loadPlatformConfig/resolveSystemPlatform 已拆至
// platform-config-node.ts（服务端子路径）；本文件保持 web 客户端可打包。

// ─── Config schema ───────────────────────────────────────────────────────

/**
 * OpenAI Responses API 的 reasoning 档位（请求体 `reasoning.effort`）。
 *
 * 各模型支持范围不同，设成模型不支持的值会直接 400（实测于 OpenCode Go）：
 * - muse-spark-*：minimal/low/medium/high/xhigh/max（**不支持 none**）
 * - deepseek-v4.1-flash / v4-flash / v4-pro：支持 none（关闭思考）
 * - gpt-5.6-luna：**不支持 minimal**，支持 none
 * 因此「最低档」/「关闭」都没有通用值，只能按目标模型显式指定。
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Provider-specific options (passed through to the provider constructor). */
export interface PlatformOptions {
  /** Disable thinking/reasoning mode (e.g., for deepseek-v4, qwen3). */
  disableThinking?: boolean;
  /** Disable max_tokens field in API requests. */
  disableMaxTokens?: boolean;
  /** Enable thinking mode (DashScope opt-in, default off). */
  enableThinking?: boolean;
  /**
   * 显式指定 Responses API 的 reasoning 档位（`reasoning.effort`）。
   *
   * 设置后优先于 disableThinking/enableThinking：档位是否被目标模型接受只有
   * 平台配置知道，因此显式值就是最终值。缺省时回退到旧语义
   * （disableThinking → minimal、enableThinking → high、都不设 → 交给网关默认）。
   *
   * @see ReasoningEffort 各模型支持范围差异
   */
  reasoningEffort?: ReasoningEffort;
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

/**
 * TTS 引擎设置 —— config/ai-platforms.json 的可选 `tts` 节点。
 *
 * 设计 P1-7（2026-09-15 审计）：此前该节点**不在本契约内**（AIPlatformConfig 只有
 * platforms + capabilities），API 侧由 voice-providers/tts-config.ts 自行 cast 读取，
 * 于是"配置文件里有一个契约描述不到的节点"，两侧各自维护默认值。
 * 现在把它纳入契约：字段与优先级有单一出处，读取方按类型解析。
 *
 * 取值优先级（workerId 为例，其余字段同理）：
 *   配置文件 tts.qwen.* > 环境变量 DASHSCOPE_TTS_WORKSPACE_ID > 默认值。
 */
export interface TtsQwenSettings {
  /** DashScope TTS workspaceId（wss:// 端点标识）。 */
  workspaceId?: string;
  model?: string;
  voice?: string;
  /** 输出格式，默认 mp3。 */
  format?: string;
  sampleRate?: number;
  /** 指令控制（≤100 字符）。 */
  instruction?: string;
}

/** edge-tts（容器内）语音设置。 */
export interface TtsEdgeSettings {
  voice?: string;
  rate?: string;
}

export interface TtsEngineSettings {
  /** 引擎选择：qwen（默认）| edge。 */
  engine?: "qwen" | "edge";
  qwen?: TtsQwenSettings;
  edge?: TtsEdgeSettings;
}

/** The full config file schema. */
export interface AIPlatformConfig {
  /** Platform definitions keyed by user-defined identifier. */
  platforms: Record<string, PlatformDefinition>;
  /** Capability → platform + model mappings. */
  capabilities: Partial<Record<Capability, CapabilityMapping>>;
  /** TTS 引擎设置（可选；见 TtsEngineSettings 的优先级说明）。 */
  tts?: TtsEngineSettings;
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
  /** Platform options (thinking mode etc.). */
  options?: PlatformOptions;
}
