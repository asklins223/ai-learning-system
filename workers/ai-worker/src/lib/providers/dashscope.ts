import type {
  LearningCardOutput,
  EvaluateValidationOutput,
} from "@ailearn/shared";
import {
  evaluateValidationOutputSchema,
  learningCardOutputSchema,
} from "@ailearn/shared";
import { resolveDashScopeTextEndpoint } from "@ailearn/shared/ai-endpoints";
import type {
  AIProvider,
  GenerateCardInput,
  EvaluateValidationInput,
} from "../ai-provider.ts";
import { SYSTEM_PROMPT, EVAL_SYSTEM_PROMPT } from "../prompts.ts";
import {
  readChatCompletionContent,
  readProviderCode,
  readProviderErrorMessage,
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
  promptVersion = "v6-dashscope";

  private readonly apiKey: string;
  private readonly basePath: string;
  private readonly workspace?: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: {
    apiKey?: string;
    basePath?: string;
    model?: string;
    workspace?: string;
    request?: typeof globalThis.fetch;
  } = {}) {
    const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new Error("DASHSCOPE_API_KEY is required for DashScopeProvider");
    }
    this.apiKey = apiKey;
    this.modelId = options.model ?? process.env.DASHSCOPE_MODEL ?? "qwen-plus";
    this.basePath = (options.basePath
      ?? process.env.DASHSCOPE_BASE_URL
      ?? process.env.DASHSCOPE_HTTP_BASE_URL
      ?? "https://dashscope.aliyuncs.com/api/v1").replace(/\/$/, "");
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

  private async callOnce(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature = 0.2,
    signal?: AbortSignal,
    maxTokens = 4096,
  ): Promise<string> {
    if (signal?.aborted) throw abortError(signal, "before DashScope request");
    const endpoint = resolveDashScopeTextEndpoint(this.basePath, this.modelId);
    const body = {
      model: this.modelId,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      // Force the model to emit valid JSON. Both SYSTEM_PROMPT and
      // EVAL_SYSTEM_PROMPT mention "JSON" so this constraint is honoured.
      response_format: { type: "json_object" as const },
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
      throw new Error(`dashscope returned empty output (${this.modelId})`);
    }
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
