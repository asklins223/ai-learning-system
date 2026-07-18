import {
  evaluateValidationOutputSchema,
  learningCardOutputSchema,
  type EvaluateValidationOutput,
  type LearningCardOutput,
} from "@ailearn/shared";
import { resolveOpenAIChatCompletionsUrl } from "@ailearn/shared/ai-endpoints";
import {
  postJsonToPublicEndpoint,
  type PublicJsonRequester,
} from "@ailearn/shared/public-json-http";
import type { AIProvider, EvaluateValidationInput, GenerateCardInput } from "../ai-provider.ts";
import { EVAL_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../prompts.ts";
import {
  readChatCompletionContent,
  readProviderErrorMessage,
} from "./json-response.ts";

export class OpenAICompatibleProvider implements AIProvider {
  id = "openai_compatible";
  promptVersion = "v1-openai-compatible";
  readonly modelId: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly request: PublicJsonRequester;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    request?: PublicJsonRequester;
  }) {
    this.apiKey = options.apiKey;
    this.modelId = options.model;
    this.endpoint = resolveOpenAIChatCompletionsUrl(options.baseUrl);
    this.request = options.request ?? postJsonToPublicEndpoint;
  }

  async generateCard(input: GenerateCardInput, signal?: AbortSignal): Promise<LearningCardOutput> {
    const raw = await this.call([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ note_title: input.noteTitle, blocks: input.blocks }) },
    ], signal);
    const result = learningCardOutputSchema.safeParse(parseModelJson(raw));
    if (!result.success) {
      throw new Error(`OpenAI-compatible output failed schema check: ${result.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
    }
    return result.data;
  }

  async evaluateValidation(input: EvaluateValidationInput, signal?: AbortSignal): Promise<EvaluateValidationOutput> {
    const raw = await this.call([
      { role: "system", content: EVAL_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ], signal);
    const result = evaluateValidationOutputSchema.safeParse(parseModelJson(raw));
    if (!result.success) {
      throw new Error(`OpenAI-compatible evaluation failed schema check: ${result.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
    }
    return result.data;
  }

  private async call(
    messages: Array<{ role: "system" | "user"; content: string }>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("AI request aborted");
    const response = await this.request(
      this.endpoint,
      { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
      { model: this.modelId, messages, temperature: 0.2 },
      signal,
    );
    if (response.status < 200 || response.status >= 300) {
      const message = (readProviderErrorMessage(response.body) ?? response.statusText).slice(0, 500);
      throw new Error(`OpenAI-compatible endpoint ${response.status}: ${message}`);
    }
    const content = readChatCompletionContent(response.body);
    if (typeof content !== "string" || !content.trim()) {
      throw new Error(`OpenAI-compatible endpoint returned empty output (${this.modelId})`);
    }
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
