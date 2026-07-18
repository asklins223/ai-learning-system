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

export interface AIProviderSelection {
  providerName: string;
  config: AIProviderRuntimeConfig;
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
 * Resolve the provider configuration once per job. Governance and provider
 * construction must use this same snapshot so a concurrent settings change
 * cannot make the checked provider differ from the provider being called.
 */
export async function resolveProviderSelection(
  workspaceId?: string,
  userId?: string,
): Promise<AIProviderSelection> {
  if (userId) {
    const { getPersonalAIProviderRuntimeConfig } = await import("./governance.ts");
    const personal = await getPersonalAIProviderRuntimeConfig(userId);
    if (personal) {
      return { providerName: personal.provider, config: personal };
    }
  }

  if (workspaceId) {
    const { getWorkspaceAIProvider } = await import("./governance.ts");
    return { providerName: await getWorkspaceAIProvider(workspaceId), config: {} };
  }

  return {
    providerName: (process.env.AI_PROVIDER_CARD ?? "mock").toLowerCase(),
    config: {},
  };
}
