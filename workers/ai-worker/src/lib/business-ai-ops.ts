/**
 * R5: Business AI operations — decoupled from provider.
 *
 * Previously, prompt selection and schema validation were embedded inside
 * provider methods (evaluateValidation, generateValidationQuestion, evaluateRubric).
 * R5 moves this logic to standalone helper functions that use the provider's
 * generic `chatCompletion` method, so providers only handle API transport.
 *
 * Each helper:
 * 1. Selects the appropriate system prompt
 * 2. Constructs messages (system + user with JSON.stringify(input))
 * 3. Calls provider.chatCompletion(messages, options, signal)
 * 4. Parses JSON from the response content
 * 5. Validates with the appropriate zod schema
 * 6. Returns { output, usage } — usage comes from ChatResult, not getLastUsage()
 *
 * @see docs/plans/provider-registry-refactor.md §3.5 (R5)
 */

import type {
  EvaluateValidationOutput,
  GenerateValidationQuestionOutput,
  EvaluateRubricOutput,
  GenerateValidationQuestionInput,
  EvaluateRubricInput,
  ImageInsightOutput,
} from "@ailearn/shared";
import {
  evaluateValidationOutputSchema,
  generateValidationQuestionOutputSchema,
  evaluateRubricOutputSchema,
  imageInsightOutputSchema,
  sanitizeImageInsightOutput,
} from "@ailearn/shared";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  ProviderUsage,
} from "@ailearn/shared";
import type { AnalyzeImageInput } from "@ailearn/shared";
import {
  EVAL_SYSTEM_PROMPT,
  QUESTION_GENERATION_PROMPT,
  RUBRIC_EVALUATION_PROMPT,
  IMAGE_UNDERSTANDING_SYSTEM_PROMPT,
} from "./prompts.ts";
import { extractJsonFromText } from "./providers/json-response.ts";
import type { EvaluateValidationInput } from "./ai-provider.ts";

/** Result of a business AI operation: parsed output + token usage. */
export interface BusinessAIResult<T> {
  output: T;
  usage: ProviderUsage;
}

/**
 * Minimal interface needed by business helpers.
 * This is a subset of AIProvider — only chatCompletion is required.
 * Using this interface avoids forcing callers to pass the full AIProvider.
 */
export interface ChatCapableProvider {
  chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
}

/**
 * R5: Evaluate validation via generic chatCompletion.
 *
 * Replaces provider.evaluateValidation(). The caller passes a provider that
 * implements chatCompletion; prompt selection and schema validation happen here.
 */
export async function evaluateValidationViaChat(
  provider: ChatCapableProvider,
  input: EvaluateValidationInput,
  signal?: AbortSignal,
): Promise<BusinessAIResult<EvaluateValidationOutput>> {
  const messages: ChatMessage[] = [
    { role: "system", content: EVAL_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(input) },
  ];
  const options: ChatOptions = { temperature: 0.2, maxTokens: 2048 };
  const result = await provider.chatCompletion(messages, options, signal);
  const parsed = extractJsonFromText(result.content);
  const validated = evaluateValidationOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `evaluateValidation schema check failed: ${validated.error.issues.slice(0, 3).map((i) => i.message).join("; ")}`,
    );
  }
  return { output: validated.data, usage: result.usage };
}

/**
 * R5: Generate validation question via generic chatCompletion.
 *
 * Replaces provider.generateValidationQuestion(). Prompt selection and schema
 * validation happen here, not in the provider.
 */
export async function generateValidationQuestionViaChat(
  provider: ChatCapableProvider,
  input: GenerateValidationQuestionInput,
  signal?: AbortSignal,
): Promise<BusinessAIResult<GenerateValidationQuestionOutput>> {
  const userPayload = JSON.stringify({
    claim: input.claim,
    quote: input.quote,
    evidenceRefs: input.evidenceRefs,
    ...(input.preferredType ? { preferredType: input.preferredType } : {}),
  });
  const messages: ChatMessage[] = [
    { role: "system", content: QUESTION_GENERATION_PROMPT },
    { role: "user", content: userPayload },
  ];
  const options: ChatOptions = { temperature: 0.3, maxTokens: 2048 };
  const result = await provider.chatCompletion(messages, options, signal);
  const parsed = extractJsonFromText(result.content);
  const validated = generateValidationQuestionOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `generateValidationQuestion schema check failed: ${validated.error.issues.slice(0, 3).map((i) => i.message).join("; ")}`,
    );
  }
  return { output: validated.data, usage: result.usage };
}

/**
 * R5: Provider that supports vision via chatCompletion + a vision model id.
 *
 * analyzeImage was previously a method on AIProvider that built multimodal
 * messages, called the transport, and ran schema validation inline. R5 moves
 * all of that to this caller-side helper; providers only do chatCompletion.
 */
export interface VisionCapableProvider {
  readonly visionModelId: string;
  chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
}

/**
 * R5: Analyze an image via generic chatCompletion.
 *
 * Replaces provider.analyzeImage(). Builds the multimodal (text + image_url)
 * message, calls chatCompletion with the provider's vision model, then parses
 * JSON and validates with imageInsightOutputSchema. The sanitizeImageInsightOutput
 * fallback is applied here (not in the provider) so providers stay prompt-agnostic.
 */
export async function analyzeImageViaChat(
  provider: VisionCapableProvider,
  input: AnalyzeImageInput,
  signal?: AbortSignal,
): Promise<ImageInsightOutput> {
  const description = input.userDescription?.trim();
  const messages: ChatMessage[] = [
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
  ];
  const options: ChatOptions = { temperature: 0, maxTokens: 4096, model: provider.visionModelId };
  const result = await provider.chatCompletion(messages, options, signal);
  const parsed = extractJsonFromText(result.content);
  const validated = imageInsightOutputSchema.safeParse(parsed);
  if (!validated.success) {
    const sanitized = sanitizeImageInsightOutput(parsed);
    if (sanitized) return sanitized;
    throw new Error(
      `analyzeImage schema check failed: ${validated.error.issues.slice(0, 3).map((i) => i.message).join("; ")}`,
    );
  }
  return validated.data;
}

/**
 * R5: Evaluate rubric via generic chatCompletion.
 *
 * Replaces provider.evaluateRubric(). Prompt selection and schema validation
 * happen here, not in the provider.
 */
export async function evaluateRubricViaChat(
  provider: ChatCapableProvider,
  input: EvaluateRubricInput,
  signal?: AbortSignal,
): Promise<BusinessAIResult<EvaluateRubricOutput>> {
  const messages: ChatMessage[] = [
    { role: "system", content: RUBRIC_EVALUATION_PROMPT },
    { role: "user", content: JSON.stringify(input) },
  ];
  const options: ChatOptions = { temperature: 0.2, maxTokens: 2048 };
  const result = await provider.chatCompletion(messages, options, signal);
  const parsed = extractJsonFromText(result.content);
  const validated = evaluateRubricOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `evaluateRubric schema check failed: ${validated.error.issues.slice(0, 3).map((i) => i.message).join("; ")}`,
    );
  }
  return { output: validated.data, usage: result.usage };
}


