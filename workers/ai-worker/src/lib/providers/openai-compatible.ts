import {
  evaluateValidationOutputSchema,
  learningCardOutputSchema,
  generateValidationQuestionOutputSchema,
  evaluateRubricOutputSchema,
  cardMapOutputSchema,
  imageInsightOutputSchema,
  type EvaluateValidationOutput,
  type LearningCardOutput,
  type GenerateValidationQuestionOutput,
  type EvaluateRubricOutput,
  type GenerateValidationQuestionInput,
  type EvaluateRubricInput,
  type CardMapInput,
  type CardMapOutput,
  type ImageInsightOutput,
} from "@ailearn/shared";
import { resolveOpenAIChatCompletionsUrl } from "@ailearn/shared/ai-endpoints";
import {
  postJsonToPublicEndpoint,
  type PublicJsonRequester,
} from "@ailearn/shared/public-json-http";
import type { AIProvider, AnalyzeImageInput, EvaluateValidationInput, GenerateCardInput, RepairCardInput, ProviderUsage } from "../ai-provider.ts";
import {
  CARD_MAP_SYSTEM_PROMPT,
  IMAGE_UNDERSTANDING_SYSTEM_PROMPT,
  EVAL_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  QUESTION_GENERATION_PROMPT,
  RUBRIC_EVALUATION_PROMPT,
} from "../prompts.ts";
import {
  readChatCompletionContent,
  readProviderErrorMessage,
  readUsage,
} from "./json-response.ts";

export class OpenAICompatibleProvider implements AIProvider {
  id = "openai_compatible";
  promptVersion = "v6-openai-compatible";
  readonly modelId: string;
  readonly visionModelId: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly request: PublicJsonRequester;

  // v0.6: Track usage from the last API call (计划 §6.6, §10.5)
  private lastUsage: ProviderUsage | null = null;

  getLastUsage(): ProviderUsage | null {
    return this.lastUsage;
  }

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    visionModel?: string;
    request?: PublicJsonRequester;
  }) {
    this.apiKey = options.apiKey;
    this.modelId = options.model;
    this.visionModelId = options.visionModel ?? options.model;
    this.endpoint = resolveOpenAIChatCompletionsUrl(options.baseUrl);
    this.request = options.request ?? postJsonToPublicEndpoint;
  }

  async generateCard(input: GenerateCardInput, signal?: AbortSignal): Promise<LearningCardOutput> {
    // temperature 0.3：比 0.2 略高，有助于模型进行抽象提炼而非直接截取原文。
    // max_tokens 4096：配合 key_points 限制为 5 个，覆盖 95%+ 场景。
    const raw = await this.call([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ note_title: input.noteTitle, blocks: input.blocks }) },
    ], signal, 4096, 0.3);
    const result = learningCardOutputSchema.safeParse(parseModelJson(raw));
    if (!result.success) {
      throw new Error(`OpenAI-compatible output failed schema check: ${result.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
    }
    return result.data;
  }

  async extractCardCandidates(
    input: CardMapInput,
    signal?: AbortSignal,
  ): Promise<CardMapOutput> {
    const raw = await this.call([
      { role: "system", content: CARD_MAP_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], signal, 4096, 0.2);
    const result = cardMapOutputSchema.safeParse(parseModelJson(raw));
    if (!result.success) {
      throw new Error(`OpenAI-compatible card map failed schema check: ${result.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
    }
    return result.data;
  }

  async analyzeImage(input: AnalyzeImageInput, signal?: AbortSignal): Promise<ImageInsightOutput> {
    const description = input.userDescription?.trim();
    const raw = await this.call([
      { role: "system", content: IMAGE_UNDERSTANDING_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              task: "extract_image_insight",
              coordinateSystem: "normalized_0_10000",
              width: input.width,
              height: input.height,
              ...(description ? { userDescription: description } : {}),
            }),
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${input.mimeType};base64,${input.body.toString("base64")}`,
              detail: "high",
            },
          },
        ],
      },
    ], signal, 4096, 0, this.visionModelId);
    const result = imageInsightOutputSchema.safeParse(parseModelJson(raw));
    if (!result.success) {
      throw new Error(`OpenAI-compatible image insight failed schema check: ${result.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
    }
    return result.data;
  }

  async evaluateValidation(input: EvaluateValidationInput, signal?: AbortSignal): Promise<EvaluateValidationOutput> {
    const raw = await this.call([
      { role: "system", content: EVAL_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], signal, 2048);
    const result = evaluateValidationOutputSchema.safeParse(parseModelJson(raw));
    if (!result.success) {
      throw new Error(`OpenAI-compatible evaluation failed schema check: ${result.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
    }
    return result.data;
  }

  // v0.6: AI question + rubric generation (计划 §7.1)
  async generateValidationQuestion(
    input: GenerateValidationQuestionInput,
    signal?: AbortSignal,
  ): Promise<GenerateValidationQuestionOutput> {
    const userPayload = JSON.stringify({
      claim: input.claim,
      quote: input.quote,
      evidenceRefs: input.evidenceRefs,
      ...(input.preferredType ? { preferredType: input.preferredType } : {}),
    });
    const raw = await this.call([
      { role: "system", content: QUESTION_GENERATION_PROMPT },
      { role: "user", content: userPayload },
    ], signal, 2048, 0.3);
    const result = generateValidationQuestionOutputSchema.safeParse(parseModelJson(raw));
    if (!result.success) {
      throw new Error(`OpenAI-compatible question generation failed schema check: ${result.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
    }
    return result.data;
  }

  // v0.6: rubric-based point evaluation (计划 §7.2)
  async evaluateRubric(
    input: EvaluateRubricInput,
    signal?: AbortSignal,
  ): Promise<EvaluateRubricOutput> {
    const raw = await this.call([
      { role: "system", content: RUBRIC_EVALUATION_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], signal, 2048, 0.2);
    const result = evaluateRubricOutputSchema.safeParse(parseModelJson(raw));
    if (!result.success) {
      throw new Error(`OpenAI-compatible rubric evaluation failed schema check: ${result.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
    }
    return result.data;
  }

  // v0.6: conditional card repair (计划 §7.7)
  // Provider/SDK 传输层 maxAttempts=1，不发生隐式自动重发
  async repairCard(
    input: RepairCardInput,
    signal?: AbortSignal,
  ): Promise<LearningCardOutput> {
    const repairPrompt = `你之前生成的学习卡存在质量问题，请修复后重新输出。

## 质量问题
${input.issues.map((i) => `- ${i.severity === "hard" ? "严重" : "次要"}：${i.code}${i.keyPointOrdinal !== undefined ? `（要点 ${i.keyPointOrdinal + 1}）` : ""}`).join("\n")}

## 之前输出
${JSON.stringify(input.draft)}

## 原文 blocks
${JSON.stringify(input.sourceBlocks)}

请根据上述质量问题修复学习卡，确保 quote_text 是原文的逐字片段，claim 是基于原文的抽象知识断言。`;
    const raw = await this.call([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: repairPrompt },
    ], signal, 4096, 0.3);
    const result = learningCardOutputSchema.safeParse(parseModelJson(raw));
    if (!result.success) {
      throw new Error(`OpenAI-compatible repairCard failed schema check: ${result.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
    }
    return result.data;
  }

  private async call(
    messages: Array<{
      role: "system" | "user";
      content: string | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
      >;
    }>,
    signal?: AbortSignal,
    maxTokens = 4096,
    temperature = 0.3,
    model = this.modelId,
  ): Promise<string> {
    // Usage belongs to one request only. A failed follow-up request must not
    // inherit token accounting from the previous successful call.
    this.lastUsage = null;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("AI request aborted");
    const response = await this.request(
      this.endpoint,
      { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
      {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        // Opt-in switch for qwen3/qwen3.5-class hybrid models served through
        // an OpenAI-compatible gateway (e.g. DashScope compatible-mode, vLLM):
        // their default thinking phase blows bounded non-streaming budgets.
        // Kept opt-in because strict OpenAI endpoints reject unknown fields.
        ...(process.env.OPENAI_COMPAT_DISABLE_THINKING === "true"
          ? { enable_thinking: false }
          : {}),
      },
      signal,
    );
    if (response.status < 200 || response.status >= 300) {
      const message = (readProviderErrorMessage(response.body) ?? response.statusText).slice(0, 500);
      throw new Error(`OpenAI-compatible endpoint ${response.status}: ${message}`);
    }
    const content = readChatCompletionContent(response.body);
    if (typeof content !== "string" || !content.trim()) {
      throw new Error(`OpenAI-compatible endpoint returned empty output (${model})`);
    }

    // v0.6: Extract usage from API response (计划 §6.6, §10.5)
    this.lastUsage = readUsage(response.body);

    return content;
  }
}

export function resolveChatCompletionsUrl(baseUrl: string): string {
  return resolveOpenAIChatCompletionsUrl(baseUrl);
}

function parseModelJson(raw: string): unknown {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    if (start < 0) throw new Error("model returned no JSON object");
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < stripped.length; index += 1) {
      const character = stripped[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        return JSON.parse(stripped.slice(start, index + 1));
      }
    }
    throw new Error("model returned malformed JSON");
  }
}
