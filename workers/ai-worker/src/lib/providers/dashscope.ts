import type {
  LearningCardOutput,
  EvaluateValidationOutput,
  GenerateValidationQuestionOutput,
  EvaluateRubricOutput,
  GenerateValidationQuestionInput,
  EvaluateRubricInput,
  ImageInsightOutput,
} from "@ailearn/shared";
import {
  evaluateValidationOutputSchema,
  learningCardOutputSchema,
  generateValidationQuestionOutputSchema,
  evaluateRubricOutputSchema,
  cardMapOutputSchema,
  imageInsightOutputSchema,
} from "@ailearn/shared";
import { resolveDashScopeTextEndpoint } from "@ailearn/shared/ai-endpoints";
import { assertPublicHttpsAIEndpoint } from "@ailearn/shared/public-json-http";
import type {
  AIProvider,
  GenerateCardInput,
  EvaluateValidationInput,
  RepairCardInput,
  ProviderUsage,
  AnalyzeImageInput,
} from "../ai-provider.ts";
import type { CardMapInput, CardMapOutput } from "@ailearn/shared";
import {
  CARD_MAP_SYSTEM_PROMPT,
  IMAGE_UNDERSTANDING_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  EVAL_SYSTEM_PROMPT,
  QUESTION_GENERATION_PROMPT,
  RUBRIC_EVALUATION_PROMPT,
} from "../prompts.ts";
import {
  readChatCompletionContent,
  readProviderCode,
  readProviderErrorMessage,
  readUsage,
} from "./json-response.ts";

// Connection pooling: Node.js 20+ fetch uses undici internally with
// keep-alive enabled by default, so TCP+TLS connections are reused
// across requests automatically. The max_tokens, stream:false, and
// response_format parameters are the primary latency and reliability
// optimizations.

/**
 * DashScope (Alibaba Cloud 百炼 / 通义千问) provider.
 *
 * - Reads DASHSCOPE_API_KEY from env (or `apiKey` config).
 * - Models: set DASHSCOPE_MODEL (default `qwen-plus`).
 * - All requests route through the OpenAI-compatible endpoint
 *   (`/compatible-mode/v1/chat/completions`) which supports:
 *     • `response_format: { type: "json_object" }` for guaranteed JSON output
 *     • `stream: false` for simpler non-streaming responses
 * - Output is validated through Zod after JSON extraction. A tolerant
 *   parser strips ``` fences and finds the first balanced JSON object
 *   as a defensive fallback.
 */
export class DashScopeProvider implements AIProvider {
  id = "dashscope";
  modelId: string;
  visionModelId: string;
  promptVersion = "v6-dashscope";

  private static readonly DEFAULT_BASE_PATH = "https://dashscope.aliyuncs.com/api/v1";

  private readonly apiKey: string;
  private readonly basePath: string;
  private readonly workspace?: string;
  private readonly request: typeof globalThis.fetch;
  /** Custom endpoints are validated once per provider instance. */
  private endpointValidated = false;

  // v0.6: Track usage from the last API call (计划 §6.6, §10.5)
  private lastUsage: ProviderUsage | null = null;

  getLastUsage(): ProviderUsage | null {
    return this.lastUsage;
  }

  constructor(options: {
    apiKey?: string;
    basePath?: string;
    model?: string;
    visionModel?: string;
    workspace?: string;
    request?: typeof globalThis.fetch;
  } = {}) {
    const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new Error("DASHSCOPE_API_KEY is required for DashScopeProvider");
    }
    this.apiKey = apiKey;
    this.modelId = options.model ?? process.env.DASHSCOPE_MODEL ?? "qwen-plus";
    this.visionModelId = options.visionModel
      ?? process.env.DASHSCOPE_VISION_MODEL
      ?? "qwen3-vl-plus";
    this.basePath = (options.basePath
      ?? process.env.DASHSCOPE_BASE_URL
      ?? process.env.DASHSCOPE_HTTP_BASE_URL
      ?? DashScopeProvider.DEFAULT_BASE_PATH).replace(/\/$/, "");
    this.workspace = options.workspace ?? process.env.DASHSCOPE_WORKSPACE;
    this.request = options.request ?? globalThis.fetch;
  }

  async generateCard(input: GenerateCardInput, signal?: AbortSignal): Promise<LearningCardOutput> {
    // R-007: 检查是否已取消
    if (signal?.aborted) throw new Error("aborted before generateCard");
    const userPayload = buildUserPayload(input);
    // temperature 0.3：比 0.2 略高，有助于模型进行抽象提炼而非直接截取原文。
    // max_tokens 4096：配合 key_points 限制为 5 个，覆盖 95%+ 场景。
    const raw = await this.callOnce([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPayload },
    ], 0.3, signal, 4096);
    const parsed = safeParseJson(raw);
    const result = learningCardOutputSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `DashScope output failed schema check: ${result.error.issues
          .slice(0, 3)
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  async extractCardCandidates(
    input: CardMapInput,
    signal?: AbortSignal,
  ): Promise<CardMapOutput> {
    if (signal?.aborted) throw new Error("aborted before extractCardCandidates");
    const raw = await this.callOnce([
      { role: "system", content: CARD_MAP_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], 0.2, signal, 4096);
    const result = cardMapOutputSchema.safeParse(safeParseJson(raw));
    if (!result.success) {
      throw new Error(
        `DashScope card map failed schema check: ${result.error.issues
          .slice(0, 3)
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  async analyzeImage(input: AnalyzeImageInput, signal?: AbortSignal): Promise<ImageInsightOutput> {
    if (signal?.aborted) throw new Error("aborted before analyzeImage");
    const description = input.userDescription?.trim();
    const raw = await this.callOnce([
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
            image_url: { url: `data:${input.mimeType};base64,${input.body.toString("base64")}` },
          },
        ],
      },
    ], 0, signal, 4096, this.visionModelId);
    const result = imageInsightOutputSchema.safeParse(safeParseJson(raw));
    if (!result.success) {
      throw new Error(
        `DashScope image insight failed schema check: ${result.error.issues
          .slice(0, 3)
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  async evaluateValidation(input: EvaluateValidationInput, signal?: AbortSignal): Promise<EvaluateValidationOutput> {
    // R-007: 检查是否已取消
    if (signal?.aborted) throw new Error("aborted before evaluateValidation");
    const userPayload = JSON.stringify(input);
    const raw = await this.callOnce([
      { role: "system", content: EVAL_SYSTEM_PROMPT },
      { role: "user", content: userPayload },
    ], 0.2, signal, 2048);
    const parsed = safeParseJson(raw);
    const result = evaluateValidationOutputSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `DashScope evaluate_validation failed schema check: ${result.error.issues
          .slice(0, 3)
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  // v0.6: AI question + rubric generation (计划 §7.1)
  async generateValidationQuestion(
    input: GenerateValidationQuestionInput,
    signal?: AbortSignal,
  ): Promise<GenerateValidationQuestionOutput> {
    if (signal?.aborted) throw new Error("aborted before generateValidationQuestion");
    const userPayload = JSON.stringify({
      claim: input.claim,
      quote: input.quote,
      evidenceRefs: input.evidenceRefs,
      ...(input.preferredType ? { preferredType: input.preferredType } : {}),
    });
    const raw = await this.callOnce([
      { role: "system", content: QUESTION_GENERATION_PROMPT },
      { role: "user", content: userPayload },
    ], 0.3, signal, 2048);
    const parsed = safeParseJson(raw);
    const result = generateValidationQuestionOutputSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `DashScope generateValidationQuestion failed schema check: ${result.error.issues
          .slice(0, 3)
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  // v0.6: rubric-based point evaluation (计划 §7.2)
  async evaluateRubric(
    input: EvaluateRubricInput,
    signal?: AbortSignal,
  ): Promise<EvaluateRubricOutput> {
    if (signal?.aborted) throw new Error("aborted before evaluateRubric");
    const userPayload = JSON.stringify(input);
    const raw = await this.callOnce([
      { role: "system", content: RUBRIC_EVALUATION_PROMPT },
      { role: "user", content: userPayload },
    ], 0.2, signal, 2048);
    const parsed = safeParseJson(raw);
    const result = evaluateRubricOutputSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `DashScope evaluateRubric failed schema check: ${result.error.issues
          .slice(0, 3)
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  // v0.6: conditional card repair (计划 §7.7)
  // Provider/SDK 传输层 maxAttempts=1，不发生隐式自动重发
  async repairCard(
    input: RepairCardInput,
    signal?: AbortSignal,
  ): Promise<LearningCardOutput> {
    if (signal?.aborted) throw new Error("aborted before repairCard");
    const repairPrompt = `你之前生成的学习卡存在质量问题，请修复后重新输出。

## 质量问题
${input.issues.map((i) => `- ${i.severity === "hard" ? "严重" : "次要"}：${i.code}${i.keyPointOrdinal !== undefined ? `（要点 ${i.keyPointOrdinal + 1}）` : ""}`).join("\n")}

## 之前输出
${JSON.stringify(input.draft)}

## 原文 blocks
${JSON.stringify(input.sourceBlocks)}

请根据上述质量问题修复学习卡，确保 quote_text 是原文的逐字片段，claim 是基于原文的抽象知识断言。`;
    const raw = await this.callOnce([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: repairPrompt },
    ], 0.3, signal, 4096);
    const parsed = safeParseJson(raw);
    const result = learningCardOutputSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `DashScope repairCard failed schema check: ${result.error.issues
          .slice(0, 3)
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  private async callOnce(
    messages: Array<{
      role: "system" | "user" | "assistant";
      content: string | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
    }>,
    temperature = 0.2,
    signal?: AbortSignal,
    maxTokens = 4096,
    model = this.modelId,
  ): Promise<string> {
    // Usage belongs to one request only. A failed follow-up request must not
    // inherit token accounting from the previous successful call.
    this.lastUsage = null;
    if (signal?.aborted) throw abortError(signal, "before DashScope request");
    const endpoint = resolveDashScopeTextEndpoint(this.basePath, model);
    // SSRF guard: a personal/workspace config can inject a custom baseUrl into
    // this provider, and this transport uses plain fetch (no pinned public
    // request path like the OpenAI-compatible provider). Validate custom
    // endpoints once: HTTPS-only + public-address resolution. The well-known
    // default base and injected test transports skip the network check.
    if (
      !this.endpointValidated
      && this.basePath !== DashScopeProvider.DEFAULT_BASE_PATH
      && this.request === globalThis.fetch
    ) {
      await assertPublicHttpsAIEndpoint(endpoint.url);
    }
    this.endpointValidated = true;
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      // Force the model to emit valid JSON. Both SYSTEM_PROMPT and
      // EVAL_SYSTEM_PROMPT mention "JSON" so this constraint is honoured.
      response_format: { type: "json_object" as const },
      // qwen3/qwen3.5 hybrid models default to thinking mode, which front-loads
      // a long hidden reasoning phase before the JSON payload. On a bounded
      // non-streaming call that reads as "every request times out" regardless
      // of input size, and thinking tokens also eat into max_tokens. Structured
      // extraction never needs it — disable unless explicitly re-enabled via
      // DASHSCOPE_ENABLE_THINKING=true. Non-hybrid models ignore the flag.
      ...(process.env.DASHSCOPE_ENABLE_THINKING === "true"
        ? {}
        : { enable_thinking: false }),
    };
    const response = await this.request(
      endpoint.url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(this.workspace ? { "X-DashScope-WorkSpace": this.workspace } : {}),
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (signal?.aborted) throw abortError(signal, "after DashScope response");

    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch (err) {
      throw new Error(
        `dashscope returned invalid JSON (${response.status} ${response.statusText})`,
        { cause: err },
      );
    }
    if (!response.ok) {
      const code = readProviderCode(payload) ?? response.status;
      const message = readProviderErrorMessage(payload) ?? response.statusText;
      throw new Error(`dashscope ${code}: ${message}`);
    }
    if (signal?.aborted) throw abortError(signal, "after DashScope body read");

    const responseRecord = payload as Record<string, unknown>;
    if (!responseRecord) {
      const code = readProviderCode(payload) ?? "unknown";
      const message = readProviderErrorMessage(payload) ?? "no output";
      throw new Error(`dashscope ${code}: ${message}`);
    }
    const text = readChatCompletionContent(responseRecord);
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`dashscope returned empty output (${model})`);
    }

    // v0.6: Extract usage from API response (计划 §6.6, §10.5)
    this.lastUsage = readUsage(responseRecord);

    return text;
  }
}

function abortError(signal: AbortSignal, phase: string): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(`DashScope request aborted ${phase}`);
}

function buildUserPayload(input: GenerateCardInput): string {
  const blocksPayload = input.blocks.map((b) => ({
    ordinal: b.ordinal,
    type: b.type,
    content: b.content,
  }));
  return JSON.stringify({
    note_title: input.noteTitle,
    blocks: blocksPayload,
  });
}

/**
 * Tolerant JSON extraction. Even with response_format: { type: "json_object" }
 * some models may occasionally wrap output in ```json fences or prefix prose.
 * We strip fences and find the first balanced JSON object as a fallback.
 */
function safeParseJson(raw: string): unknown {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through
  }
  const start = stripped.indexOf("{");
  if (start === -1) {
    throw new Error("DashScope returned no JSON object");
  }
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("DashScope returned JSON that could not be parsed");
}
