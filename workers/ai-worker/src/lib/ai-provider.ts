import type { EvaluateValidationOutput, LearningCardOutput } from "@ailearn/shared";

export interface GenerateCardInput {
  noteTitle: string;
  blocks: Array<{ ordinal: number; type: string; content: string }>;
}

export interface EvaluateValidationInput {
  question: string;
  questionType: string;
  claim: string;
  quote: string;
  userAnswer: string;
}

export interface AIProvider {
  id: string;
  modelId: string;
  promptVersion: string;
  generateCard(input: GenerateCardInput, signal?: AbortSignal): Promise<LearningCardOutput>;
  evaluateValidation(input: EvaluateValidationInput, signal?: AbortSignal): Promise<EvaluateValidationOutput>;
}

import { MockProvider } from "./providers/mock.ts";
import { DashScopeProvider } from "./providers/dashscope.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";

export interface AIProviderRuntimeConfig {
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
}

/**
 * N-011: 根据 provider 名称创建 AIProvider 实例。
 * @param providerName provider 标识（mock | dashscope | openai_compatible）
 */
export function createProvider(
  providerName: string,
  config: AIProviderRuntimeConfig = {},
): AIProvider {
  const id = providerName.toLowerCase();
  if (id === "mock") return new MockProvider();
  if (id === "dashscope" || id === "qwen") {
    return new DashScopeProvider({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseUrl ? { basePath: config.baseUrl } : {}),
      ...(config.model ? { model: config.model } : {}),
    });
  }
  if (id === "openai_compatible") {
    if (!config.apiKey || !config.baseUrl || !config.model) {
      throw new Error("personal OpenAI-compatible provider requires apiKey, baseUrl, and model");
    }
    return new OpenAICompatibleProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
  }
  throw new Error(`provider ${id} not implemented in worker (supported: mock, dashscope, openai_compatible)`);
}

/**
 * 获取 AI provider。优先使用任务发起人的个人配置，再读取 workspace 配置。
 */
export async function getProvider(workspaceId?: string, userId?: string): Promise<AIProvider> {
  if (userId) {
    const { getPersonalAIProviderRuntimeConfig } = await import("./governance.ts");
    const personal = await getPersonalAIProviderRuntimeConfig(userId);
    if (personal) return createProvider(personal.provider, personal);
  }
  // N-011: 优先使用 workspace 级 provider 配置
  if (workspaceId) {
    const { getWorkspaceAIProvider } = await import("./governance.ts");
    const providerName = await getWorkspaceAIProvider(workspaceId, userId);
    return createProvider(providerName);
  }
  // 回退到全局环境变量
  const id = (process.env.AI_PROVIDER_CARD ?? "mock").toLowerCase();
  return createProvider(id);
}
