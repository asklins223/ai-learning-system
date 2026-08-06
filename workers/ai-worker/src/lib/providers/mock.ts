import type {
  AIProvider,
  ProviderUsage,
  EvaluateValidationInput,
} from "../ai-provider.ts";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../provider-constants.ts";
import type {
  AgentTurnRequest,
  AgentTurnResult,
  ProviderCapability,
  ChatMessage,
  ChatOptions,
  ChatResult,
  CapabilityImpl,
  GenerateValidationQuestionInput,
  EvaluateRubricInput,
  PlatformOptions,
} from "@ailearn/shared";
import type {
  ImageInsightOutput,
} from "@ailearn/shared";
import {
  EVAL_SYSTEM_PROMPT,
  QUESTION_GENERATION_PROMPT,
  RUBRIC_EVALUATION_PROMPT,
  IMAGE_UNDERSTANDING_SYSTEM_PROMPT,
} from "../prompts.ts";
import { generateDeterministicQuestion } from "@ailearn/shared";
import { registerFactory } from "../provider-factory.ts";

// ─── R5: Mock business logic (moved from removed provider methods) ──────

/** Compute word-level overlap ratio between quote and userAnswer. */
function computeOverlap(quote: string, userAnswer: string): number {
  const quoteWords = new Set(quote.toLowerCase().split(/\s+/).filter((w) => w.length > 0));
  if (quoteWords.size === 0) return 0;
  const answerWords = userAnswer.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  let hits = 0;
  for (const w of answerWords) {
    if (quoteWords.has(w)) hits++;
  }
  return hits / quoteWords.size;
}

/** R5: Mock evaluateValidation logic (moved from removed provider method). */
function mockEvaluateValidation(input: EvaluateValidationInput) {
  const overlap = computeOverlap(input.quote, input.userAnswer);
  const claimTrunc = input.claim.slice(0, 40);
  const quoteTrunc = input.quote.slice(0, 60);

  if (overlap > 0.6) {
    return {
      outcome: "preliminary_understanding",
      confidence: 0.9,
      feedback: "回答与原文一致，理解到位。",
      covered_points: [claimTrunc],
      missing_points: [],
      misunderstandings: [],
      evidence_refs: [],
    };
  } else if (overlap > 0.3) {
    return {
      outcome: "unclear_expression",
      confidence: 0.6,
      feedback: "部分要点命中，但表述不够完整。",
      covered_points: [],
      missing_points: [claimTrunc],
      misunderstandings: [],
      evidence_refs: [],
    };
  } else if (overlap > 0.05) {
    return {
      outcome: "unclear_expression",
      confidence: 0.4,
      feedback: "与原文相关性较弱，需要进一步澄清。",
      covered_points: [],
      missing_points: [claimTrunc],
      misunderstandings: [],
      evidence_refs: [],
    };
  } else {
    return {
      outcome: "misunderstanding",
      confidence: 0.7,
      feedback: "未命中原文要点，回答与预期不符。",
      covered_points: [],
      missing_points: [],
      misunderstandings: [claimTrunc],
      evidence_refs: quoteTrunc ? [quoteTrunc] : [],
    };
  }
}

/** R5: Mock evaluateRubric logic (moved from removed provider method). */

/**
 * Compute character-level overlap ratio between criterion and userAnswer.
 * Uses character bigrams to handle CJK text that lacks whitespace word boundaries.
 */
function computeCharOverlap(criterion: string, userAnswer: string): number {
  const c = criterion.toLowerCase();
  const a = userAnswer.toLowerCase();
  if (c.length < 2) return a.includes(c) ? 1 : 0;
  const bigrams = new Set<string>();
  for (let i = 0; i < c.length - 1; i++) {
    bigrams.add(c.slice(i, i + 2));
  }
  if (bigrams.size === 0) return 0;
  let hits = 0;
  for (let i = 0; i < a.length - 1; i++) {
    if (bigrams.has(a.slice(i, i + 2))) hits++;
  }
  return Math.min(1, hits / bigrams.size);
}

function mockEvaluateRubric(input: EvaluateRubricInput) {
  // Use character length for CJK text that lacks whitespace word boundaries.
  const isShortAnswer = input.userAnswer.trim().length <= 1;

  const itemResults = input.rubricItems.map((item) => {
    const overlap = computeCharOverlap(item.criterion, input.userAnswer);

    let verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
    let confidence: number;

    if (isShortAnswer) {
      verdict = "not_assessable";
      confidence = 0.3;
    } else if (overlap > 0.3) {
      verdict = "covered";
      confidence = 0.85;
    } else if (overlap > 0.1) {
      verdict = "partial";
      confidence = 0.5;
    } else {
      verdict = "missing";
      confidence = 0.7;
    }

    return {
      rubricItemId: item.rubricItemId,
      verdict,
      confidence,
      rationale: `Mock assessment based on overlap (${(overlap * 100).toFixed(0)}%).`,
      answerExcerpt: input.userAnswer.slice(0, 100),
    };
  });

  return {
    itemResults,
    feedback: "Mock rubric evaluation completed.",
  };
}

// ARCH-05: contextWindowTokens 可通过 MOCK_CONTEXT_WINDOW_TOKENS 环境变量覆盖。

export class MockProvider implements AIProvider {
  id = "mock";
  modelId = "mock-v1";
  visionModelId = "mock-vision-v1";
  promptVersion = "v2-mock";
  /** 配置文件 options（含 contextWindowTokens），从 config/ai-platforms.json 传入。 */
  private readonly platformOptions: PlatformOptions | undefined;

  constructor(options?: { platformOptions?: PlatformOptions }) {
    this.platformOptions = options?.platformOptions;
  }

  /**
   * Estimate token count for mock responses.
   * Mock doesn't call a real API, so we estimate based on input/output size.
   *
   * BUG-10: Previous estimate used `length / 4` uniformly, which severely
   * underestimates CJK text (where ~1 token ≈ 1.5 chars). We now detect
   * CJK characters and apply a more accurate ratio for them.
   */
  private estimateUsage(inputText: string, outputText: string): ProviderUsage {
    const promptTokens = estimateTokenCount(inputText);
    const completionTokens = estimateTokenCount(outputText);
    return {
      totalTokens: promptTokens + completionTokens,
      promptTokens,
      completionTokens,
      requestId: null,
    };
  }

  // ─── Supervisor Agent v1: executeAgentTurn + getCapabilities (计划 §8.1, §8.2) ──

  /**
   * Mock Agent turn executor.
   *
   * 根据 role 和 messages 生成合理的 tool calls，使 Supervisor Agent loop
   * 能在开发和测试环境中完整运行。
   *
   * 策略：
   * - generation_supervisor: 返回 request_verification（最短路径）
   * - text_extractor/code_extractor/vision_specialist: 返回 complete_agent_task
   * - deck_composer: 返回 submit_deck_proposal + complete_agent_task
   * - grounding_critic: 返回 submit_quality_report + complete_agent_task
   * - repairer: 返回 submit_draft_patch + complete_agent_task
   */
  async executeAgentTurn(
    request: AgentTurnRequest,
    signal?: AbortSignal,
  ): Promise<AgentTurnResult> {
    if (signal?.aborted) throw new Error("aborted before executeAgentTurn");

    const role = request.role;
    const toolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];

    // 根据 role 生成不同的 tool calls
    switch (role) {
      case "generation_supervisor":
        // Mock Supervisor: 直接请求 verification（最短路径）
        toolCalls.push({
          id: `call_mock_${Date.now()}`,
          name: "request_verification",
          arguments: { draftHash: "mock_draft_hash" },
        });
        break;

      case "text_extractor":
      case "code_extractor":
      case "vision_specialist":
        // Mock Extractor: 完成 task
        toolCalls.push({
          id: `call_mock_${Date.now()}`,
          name: "complete_agent_task",
          arguments: { outputHash: `mock_output_${role}` },
        });
        break;

      case "deck_composer":
        // Mock Composer: 提交 proposal + 完成
        toolCalls.push({
          id: `call_mock_${Date.now()}`,
          name: "submit_deck_proposal",
          arguments: {
            proposal: {
              deckTitle: "Mock Deck",
              deckSummary: "Mock generated deck",
              cards: [],
            },
          },
        });
        toolCalls.push({
          id: `call_mock_${Date.now() + 1}`,
          name: "complete_agent_task",
          arguments: { outputHash: "mock_composer_output" },
        });
        break;

      case "grounding_critic":
        // Mock Critic: 提交通过的 Quality Report + 完成
        toolCalls.push({
          id: `call_mock_${Date.now()}`,
          name: "submit_quality_report",
          arguments: {
            report: {
              draftHash: "mock_draft_hash",
              candidatePoolHash: "mock_pool_hash",
              sourceLedgerHash: "mock_ledger_hash",
              hardIssues: [],
              softIssues: [],
              perClaimVerdicts: [],
              metrics: {},
              criticStatus: "passed",
              deterministicStatus: "passed",
            },
          },
        });
        toolCalls.push({
          id: `call_mock_${Date.now() + 1}`,
          name: "complete_agent_task",
          arguments: { outputHash: "mock_critic_output" },
        });
        break;

      case "repairer":
        // Mock Repairer: 提交空 patch + 完成
        toolCalls.push({
          id: `call_mock_${Date.now()}`,
          name: "submit_draft_patch",
          arguments: {
            baseDraftHash: "mock_draft_hash",
            patches: [],
          },
        });
        toolCalls.push({
          id: `call_mock_${Date.now() + 1}`,
          name: "complete_agent_task",
          arguments: { outputHash: "mock_repair_output" },
        });
        break;
    }

    const outputText = JSON.stringify({ role, toolCallCount: toolCalls.length });
    const usage = this.estimateUsage(JSON.stringify(request), outputText);

    return {
      content: null,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage,
      providerRequestId: `mock_req_${Date.now()}`,
    };
  }

  /**
   * 返回 Mock Provider 能力快照（计划 §8.2）。
   * capability fingerprint 固化到 run，同一 run 不得在执行中切 provider/model/tool schema。
   *
   * ARCH-05: contextWindowTokens is configurable via
   * MOCK_CONTEXT_WINDOW_TOKENS env var.
   */
  getCapabilities(): ProviderCapability {
    // 迁移遗漏修复：config/ai-platforms.json 的 options.contextWindowTokens 优先于 env。
    const contextWindowTokens = this.platformOptions?.contextWindowTokens
      ?? (Number(process.env.MOCK_CONTEXT_WINDOW_TOKENS) || DEFAULT_CONTEXT_WINDOW_TOKENS);
    const reservedOutputTokens = 4096;
    return {
      providerId: this.id,
      modelId: this.modelId,
      visionModelId: this.visionModelId,
      toolMode: "native_tools",
      contextWindowTokens,
      reservedOutputTokens,
      maxInputTokens: contextWindowTokens - reservedOutputTokens,
      maxOutputTokens: 4096,
      // R3: fingerprint includes visionModelId to capture vision-only config drift.
fingerprint: `mock:${this.modelId}:${this.visionModelId}:native_tools`,
    };
  }

  /**
   * R5: TextGenerationCapability — mock chat completion.
   *
   * Detects the system prompt and returns an appropriate mock response:
   * - EVAL_SYSTEM_PROMPT: overlap-based evaluateValidation mock
   * - QUESTION_GENERATION_PROMPT: deterministic question generation
   * - RUBRIC_EVALUATION_PROMPT: overlap-based evaluateRubric mock
   * - Otherwise: generic mock response
   *
   * This simulates what a real API would return for each prompt type,
   * allowing business helpers (evaluateValidationViaChat, etc.) to work
   * with the MockProvider.
   */
  async chatCompletion(
    messages: ChatMessage[],
    _options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    if (signal?.aborted) throw new Error("aborted before chatCompletion");

    const systemContent = messages.find((m) => m.role === "system");
    const systemPrompt = typeof systemContent?.content === "string"
      ? systemContent.content
      : "";
    const userMessage = messages.find((m) => m.role === "user");
    const userContent = typeof userMessage?.content === "string"
      ? userMessage.content
      : "";

    let content: string;

    // Use startsWith instead of === so the mock still recognizes the prompt
    // type even if a caller appends extra context after the base prompt.
    if (systemPrompt.startsWith(EVAL_SYSTEM_PROMPT)) {
      content = JSON.stringify(mockEvaluateValidation(JSON.parse(userContent)));
    } else if (systemPrompt.startsWith(QUESTION_GENERATION_PROMPT)) {
      const input = JSON.parse(userContent) as GenerateValidationQuestionInput;
      // Try indices 0-2 to find one matching preferredType
      if (input.preferredType) {
        let output = generateDeterministicQuestion(input, 0);
        for (let i = 1; i <= 2; i++) {
          if (output.questionType === input.preferredType) break;
          output = generateDeterministicQuestion(input, i);
        }
        content = JSON.stringify(output);
      } else {
        content = JSON.stringify(generateDeterministicQuestion(input, 0));
      }
    } else if (systemPrompt.startsWith(RUBRIC_EVALUATION_PROMPT)) {
      content = JSON.stringify(mockEvaluateRubric(JSON.parse(userContent)));
    } else if (systemPrompt.startsWith(IMAGE_UNDERSTANDING_SYSTEM_PROMPT)) {
      // R5: analyzeImageViaChat builds a multimodal user message (text + image_url).
      // Mock returns a decorative insight; the text part carries the image metadata.
      const textPart = Array.isArray(userMessage?.content)
        ? userMessage!.content.find((p) => p.type === "text")?.text ?? ""
        : "";
      const meta = JSON.parse(textPart || "{}") as { userDescription?: string };
      const output: ImageInsightOutput = {
        contentType: "decorative",
        decorative: true,
        caption: meta.userDescription?.trim().slice(0, 1_000)
          || "Mock provider 已检查图片；未生成视觉事实。",
        ocr: [],
        facts: [],
        promptInjectionDetected: false,
        safetyFlags: ["mock_no_visual_inference"],
        unresolvedReason: null,
      };
      content = JSON.stringify(output);
    } else {
      content = JSON.stringify({ status: "mock", message: "Mock chat completion response" });
    }

    const usage = this.estimateUsage(userContent, content);
    return { content, usage };
  }

  /**
   * R2: EmbeddingCapability — mock embed.
   *
   * Returns null to trigger upstream fallback to lexical/sequential search,
   * matching the contract of other providers' embed() method.
   */
  async embed(_text: string, _signal?: AbortSignal): Promise<number[] | null> {
    return null;
  }

}

/**
 * BUG-10: Estimate token count for text, accounting for CJK characters.
 *
 * CJK text uses approximately 1 token per 1.5 characters (or fewer),
 * while ASCII text uses approximately 1 token per 4 characters.
 * This function counts CJK and non-CJK characters separately and
 * applies the appropriate ratio to each group.
 */
function estimateTokenCount(text: string): number {
  let cjkChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Extension A
      (code >= 0x3040 && code <= 0x30ff) ||   // Hiragana + Katakana
      (code >= 0xac00 && code <= 0xd7af)      // Hangul Syllables
    ) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  // CJK: ~1.5 chars/token; ASCII: ~4 chars/token
  return Math.ceil(cjkChars / 1.5 + otherChars / 4);
}

// ─── R2: Factory registrations for Mock ─────────────────────────────────
// Mock provider supports all capabilities for development and testing.

registerFactory("mock", "text_generation", (config) => {
  return new MockProvider({ platformOptions: config.options }) as unknown as CapabilityImpl;
});

registerFactory("mock", "vision", (config) => {
  return new MockProvider({ platformOptions: config.options }) as unknown as CapabilityImpl;
});

registerFactory("mock", "agent_turn", (config) => {
  return new MockProvider({ platformOptions: config.options }) as unknown as CapabilityImpl;
});

registerFactory("mock", "embedding", (config) => {
  return new MockProvider({ platformOptions: config.options }) as unknown as CapabilityImpl;
});

registerFactory("mock", "rerank", (config) => {
  return new MockProvider({ platformOptions: config.options }) as unknown as CapabilityImpl;
});
