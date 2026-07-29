import type {
  EvaluateValidationOutput,
  LearningCardOutput,
  GenerateValidationQuestionOutput,
  EvaluateRubricOutput,
  CardMapInput,
  CardMapOutput,
  ImageInsightOutput,
} from "@ailearn/shared";
import type {
  GenerateValidationQuestionInput,
  EvaluateRubricInput,
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
}

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

export interface AnalyzeImageInput {
  body: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
  sha256: string;
  userDescription?: string;
}

// ─── v0.6: Card Repair Provider Contract (计划 §7.7) ──────────────────────

/**
 * v0.6 卡片修复 Provider 输入。
 *
 * repair 使用同一 Provider/model、同一治理上下文，
 * 只发送 draft、source blocks 和结构化 issue。
 */
export interface RepairCardInput {
  /** 原始 draft 输出 */
  draft: LearningCardOutput;
  /** 原文 blocks 的内容数组 */
  sourceBlocks: string[];
  /** 质量评估发现的结构化 issue reason codes */
  issues: Array<{
    code: string;
    severity: "hard" | "soft";
    keyPointOrdinal?: number;
  }>;
}

export interface AIProvider {
  id: string;
  modelId: string;
  visionModelId: string;
  promptVersion: string;
  generateCard(input: GenerateCardInput, signal?: AbortSignal): Promise<LearningCardOutput>;
  extractCardCandidates(input: CardMapInput, signal?: AbortSignal): Promise<CardMapOutput>;
  analyzeImage(input: AnalyzeImageInput, signal?: AbortSignal): Promise<ImageInsightOutput>;
  evaluateValidation(input: EvaluateValidationInput, signal?: AbortSignal): Promise<EvaluateValidationOutput>;
  // v0.6: AI question + rubric generation (计划 §7.1)
  generateValidationQuestion(
    input: GenerateValidationQuestionInput,
    signal?: AbortSignal,
  ): Promise<GenerateValidationQuestionOutput>;
  // v0.6: rubric-based point evaluation (计划 §7.2)
  evaluateRubric(
    input: EvaluateRubricInput,
    signal?: AbortSignal,
  ): Promise<EvaluateRubricOutput>;
  // v0.6: conditional card repair (计划 §7.7)
  // Provider/SDK 传输层 maxAttempts=1，不发生隐式自动重发
  repairCard(input: RepairCardInput, signal?: AbortSignal): Promise<LearningCardOutput>;
  // v0.6: Get usage data from the last API call (计划 §6.6, §10.5)
  // Returns null if no call was made or provider doesn't report usage.
  // Must be called immediately after a provider method to get valid data.
  getLastUsage(): ProviderUsage | null;
}

import { MockProvider } from "./providers/mock.ts";
import { DashScopeProvider } from "./providers/dashscope.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";

export interface AIProviderRuntimeConfig {
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  visionModel?: string | null;
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
      ...(config.visionModel ? { visionModel: config.visionModel } : {}),
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
      ...(config.visionModel ? { visionModel: config.visionModel } : {}),
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
