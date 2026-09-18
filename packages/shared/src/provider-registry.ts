/**
 * R2: Provider 静态元数据注册表。
 *
 * 纯数据 const 数组，无副作用。apps/api 和 workers/ai-worker 都可直接 import。
 * 这是 provider 列表、能力、默认值的「单一来源」。
 *
 * 进程边界约束：
 * - `packages/shared` 只持有静态元数据（PROVIDER_METADATA const），两端可直接 import。
 * - `create()` 工厂绑定在 worker 侧 `provider-factory.ts`，仅 worker 进程可用。
 * - 这样 API 的 GET /auth/ai-providers 能返回完整 provider 列表，不会拿到空注册表。
 *
 * @see docs/plans/provider-registry-refactor.md §3.2
 */

import type { Capability } from "./provider-capabilities.ts";
import { resolveDashScopeTextEndpoint } from "./ai-endpoints.ts";
import type { PlatformOptions } from "./platform-config.ts";

/** 运行时配置（API Key、Base URL、模型等） */
export interface ProviderRuntimeConfig {
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  visionModel?: string | null;
  /** Provider-specific options from config file (disableThinking, etc.) */
  options?: PlatformOptions;
}

/** Provider 每种能力的默认配置 */
export interface ProviderDefaults {
  baseUrl?: string;
  model?: string;
}

/**
 * Provider 静态元数据 — 纯数据声明，无副作用。
 * 新增 provider 在 PROVIDER_METADATA 数组加一行 + 在 worker 侧注册工厂。
 */
export interface ProviderDescriptor {
  /** 唯一标识："mock" | "openai_compatible" | "dashscope" | "siliconflow" | "opencode_go" | ... */
  id: string;
  /** 用户可见名称 */
  label: string;
  /** 该 provider 支持的能力列表 */
  capabilities: Capability[];
  /** 每种能力的默认配置 */
  defaults: Partial<Record<Capability, ProviderDefaults>>;
  /** 域名校验规则（SSRF 防护）— 纯函数，无 worker 依赖 */
  validateBaseUrl?(baseUrl: string): string | Error;
  /** Provider endpoint resolver — pure function */
  resolveEndpoint?(baseUrl: string): string;
  /** 额外请求参数（如 DashScope 的 enable_thinking: false）— 纯数据 */
  extraRequestParams?: Record<string, unknown>;
  /** 额外请求头（如 DashScope 的 X-DashScope-WorkSpace）— 纯数据 */
  extraHeaders?: Record<string, string>;
}

/**
 * 所有 provider 的静态元数据 — 直接声明，不靠副作用填充。
 * 新增 provider 在此数组加一行 + 在 worker 侧注册工厂。
 */
export const PROVIDER_METADATA: readonly ProviderDescriptor[] = [
  {
    id: "mock",
    label: "Mock（开发用）",
    capabilities: ["text_generation", "vision", "agent_turn", "embedding", "rerank"],
    defaults: {},
  },
  {
    id: "openai_compatible",
    label: "OpenAI 兼容接口",
    capabilities: ["text_generation", "vision", "agent_turn", "embedding"],
    defaults: {
      text_generation: { baseUrl: "", model: "" },
      embedding: { model: "" },
    },
  },
  {
    id: "dashscope",
    label: "阿里云百炼 / DashScope",
    capabilities: ["text_generation", "vision", "agent_turn", "embedding"],
    defaults: {
      text_generation: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-plus",
      },
      vision: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3-vl-plus",
      },
      embedding: { model: "text-embedding-v1" },
    },
    validateBaseUrl: (baseUrl: string): string | Error => {
      try {
        const hostname = new URL(baseUrl).hostname;
        if (!/^dashscope(?:-[a-z0-9]+)?\.aliyuncs\.com$/.test(hostname)) {
          return new Error("DashScope 必须使用 aliyuncs.com 官方域名");
        }
        return baseUrl;
      } catch {
        return new Error(`Invalid URL: ${baseUrl}`);
      }
    },
    resolveEndpoint: (baseUrl: string): string =>
      resolveDashScopeTextEndpoint(baseUrl).url,
    extraRequestParams: { enable_thinking: false },
    // 迁移遗漏修复：不再在模块加载时读取 DASHSCOPE_WORKSPACE（此 extraHeaders 无任何读取方，
    // 且模块加载期读 env 会掩盖配置文件中 options.workspace 的真实值）。
    // DashScope workspace 由 provider 工厂从 config.options.workspace 传入。
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    // NOTE: text_generation 为计划新增能力，当前 SiliconFlowProvider 仅实现 embedding + rerank。
    // text_generation 待后续通过 OpenAICompatibleProvider 复用 SiliconFlow 的 /chat/completions 端点。
    capabilities: ["embedding", "rerank"],
    defaults: {
      embedding: { baseUrl: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3" },
      rerank: { model: "BAAI/bge-reranker-v2-m3" },
    },
  },
  {
    id: "opencode_go",
    label: "OpenCode Go",
    // 协议为 OpenAI Responses API（/responses），不是 chat/completions：
    // OpenCode Go 的 muse-spark-*（含 muse-spark-1.3-contributor，1M 上下文）、
    // grok-4.6、gpt-5.6-luna 只在 /responses 提供，走 /chat/completions 会稳定 500。
    // 该端点的 chat/completions 系模型（deepseek-*、glm-*、kimi-* 等）请用
    // openai_compatible 平台实例指向同一个 baseUrl。
    // 端点校验与 URL 解析在 worker 侧工厂（providers/opencode-go.ts），与 dashscope 一致。
    capabilities: ["agent_turn"],
    defaults: {
      agent_turn: {
        baseUrl: "https://opencode.ai/zen/go/v1",
        model: "muse-spark-1.3-contributor",
      },
    },
  },
];

// ── 纯查询函数（无副作用，两端可用）──

/**
 * 按 id 查询 provider 元数据。
 *
 * 2026-09-15 审计（设计 P1-9 / AGENTS.md 清理）：同文件里的
 * `getAllProviders` / `getProvidersByCapability` / `getSupportedModelTypes`
 * （及其私有表 `CAPABILITY_TO_MODEL_TYPE`）全仓零生产消费方，已删除；
 * 保留的只此一个（能力声明与配置一致性检查在用）。
 */
export function getProviderById(id: string): ProviderDescriptor | undefined {
  return PROVIDER_METADATA.find((d) => d.id === id);
}
