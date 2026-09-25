import { randomUUID } from "node:crypto";
import type {
  AIProvider,
  ProviderUsage,
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
  PlatformOptions,
} from "@ailearn/shared";
import { registerFactory } from "../provider-factory.ts";

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

    if (role === "companion_agent") {
      const toolResult = request.messages.find((message) => message.role === "tool");
      /**
       * 开发/测试剧本：用户文本里带 `【mock:tool-after-withheld】` 时，模型在
       * **工具面已收起**的那一步仍然回 tool_calls——这是真实 provider 违约的形状
       * （方案 29 §12.8：2026-09-22 实测 3 次 INTERNAL_ERROR 里 2 次是这一条）。
       * 带这个标记时每一步都要求工具，否则 loop 第 2 步就作答了、走不到终答步；
       * 同时**照样带回文本**，因为真实那次她报错前已经说出去 82 / 149 字。
       */
      const scriptedWithheldViolation = request.messages.some((message) =>
        message.role === "user" && String(message.content ?? "").includes("【mock:tool-after-withheld】"));
      /**
       * 剧本 `【mock:fact-span】`：终答**引用读数目录**（`{{f:key}}`，39b §9.4 / 39d W2-5）。
       * 真实模型会不会这么写，只有真跑能证；但"她写了就必须被服务端换成目录里的值、
       * 标记永不下发到屏幕"这条管道要在集测里能被验——所以照 `【mock:tool-after-withheld】`
       * 的同一个办法给 mock 开一个口子。
       */
      const scriptedFactSpan = request.messages.some((message) =>
        message.role === "user" && String(message.content ?? "").includes("【mock:fact-span】"));
      /**
       * 剧本 `【mock:leak-answer】`：她**把答案原句念回给用户**（39d W2-6 要记的那件事）。
       * 记账判据是服务端算的（她这句话与本题题面/答案的连续重合），所以这里只负责
       * "复述一句夹具里那条 canonical answer"——真实模型会不会这么说是另一件事，
       * 归每波末尾那一次真跑。
       */
      const scriptedLeak = request.messages.some((message) =>
        message.role === "user" && String(message.content ?? "").includes("【mock:leak-answer】"));
      const wantsToolCall = ((scriptedWithheldViolation || !toolResult) && !scriptedFactSpan && !scriptedLeak)
        // `tool_choice:"required"` 是 provider 原生机制（39b §9.5）。mock 以前**完全不理它**，
        // 于是"required 生效了"这类断言全是空转——它按自己的偏好回话，看起来却像模型照办了。
        // 现在按真实合同走：这一档下必须回 tool_calls。
        || request.toolChoice === "required";
      if (request.toolChoice === "required" && request.tools.length === 0) {
        // 真实 provider 在这一对上直接 400（2026-09-22 那 3 次 INTERNAL_ERROR 里 2 次的成因）。
        // 让 mock 也**当场炸**，任何把这对拼出来的改法就会在测试里红，而不是变成
        // "模型自己没听话"这种归因错误的读数。
        throw new Error("mock provider: tool_choice=required 但工具面为空（真实 provider 会 400）");
      }
      const outputText = scriptedFactSpan
        ? "你今天学了 {{f:today_minutes}} 分钟，继续加油。"
        : scriptedLeak
          ? "复利效应是本金产生利息后加入本金继续生息的现象，这样说清楚了吗？"
          : toolResult
          ? `已读取伴星工具结果：${String(toolResult.content).slice(0, 400)}`
          : request.tools.length > 0
            ? "我先读取一下当前上下文。"
            : "我在这里，准备好陪你学习了。";
      if (wantsToolCall) {
        const contextTool = request.tools.find((tool) => tool.name === "companion_read_context");
        // required 这一档下"没找到那个顺手的工具"不能变成"干脆不回 tool_calls"——
        // 那正好是要被测的那个违约形状。挑工具面上第一个能点的（参数由用例自己给形状）。
        const chosen = contextTool ?? (request.toolChoice === "required" ? request.tools[0] : undefined);
        if (chosen || scriptedWithheldViolation) {
          toolCalls.push({
            // id 每步唯一：同毫秒的两次 `Date.now()` 会让"工具事件覆盖的调用集合
            // 与审计行同一批"那条断言随机变红。
            id: `call_companion_context_${randomUUID()}`,
            name: chosen?.name ?? "companion_read_context",
            arguments: {},
          });
        }
      }
      const usage = this.estimateUsage(JSON.stringify(request), outputText);
      return {
        content: toolCalls.length > 0 && !scriptedWithheldViolation ? null : outputText,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
        usage,
        providerRequestId: `mock_companion_req_${Date.now()}`,
      };
    }

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

  /** Generic mock chat completion for active worker capabilities. */
  async chatCompletion(
    messages: ChatMessage[],
    _options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    if (signal?.aborted) throw new Error("aborted before chatCompletion");

    const userMessage = messages.find((m) => m.role === "user");
    const userContent = typeof userMessage?.content === "string"
      ? userMessage.content
      : "";

    /**
     * 工具意图分类器（`companion-tool-intent.ts`）问的是"下一步是否必须调用工具"，
     * 并要求只回 `{"needsTool":true|false}`。mock 以前回的是那句 `{"status":"mock"}`
     * ——JSON 合法但没有那个键 ⇒ 分类器**恒为 null**，而 null 走的正是 fail-open 那一支。
     * 于是所有 mock 驱动的用例都悄悄站在"分类器读不到东西"这个非默认状态上。
     * 现在按合同回一个布尔（默认 false＝不需要工具，与这些用例本来的形状一致），
     * 需要"她说要做事"那一支的用例用 `【mock:wants-tool】` 点名。
     */
    const isToolIntentCall = messages.some((message) =>
      message.role === "system"
      && String(typeof message.content === "string" ? message.content : "").includes("needsTool"));
    if (isToolIntentCall) {
      const needsTool = messages.some((message) =>
        message.role === "user"
        && String(typeof message.content === "string" ? message.content : "").includes("【mock:wants-tool】"));
      const decided = JSON.stringify({ needsTool });
      return { content: decided, usage: this.estimateUsage(userContent, decided) };
    }

    const content = JSON.stringify({ status: "mock", message: "Mock chat completion response" });

    const usage = this.estimateUsage(userContent, content);
    return { content, usage };
  }

  /**
   * §8.2 mock 流式：复用 chatCompletion 的确定性输出，按小块 + 短间隔
   * 模拟真实 token 流，便于 worker 真流式路径的集成测试（delta 顺序、
   * 拼接还原、abort 中断）。
   */
  async chatCompletionStream(
    messages: ChatMessage[],
    options: ChatOptions,
    signal: AbortSignal | undefined,
    onDelta: (deltaText: string) => void,
  ): Promise<{ content: string; toolCalls?: AgentTurnResult["toolCalls"]; finishReason?: string }> {
    if (signal?.aborted) throw new Error("aborted before chatCompletionStream");
    const result = await this.chatCompletion(messages, options, signal);
    const content = result.content;
    const chunkSize = 8;
    for (let i = 0; i < content.length; i += chunkSize) {
      if (signal?.aborted) throw new Error("aborted during chatCompletionStream");
      const piece = content.slice(i, i + chunkSize);
      if (piece.length > 0) onDelta(piece);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    /**
     * 剧本 `【mock:tool-after-withheld】` 的流式那一半：伴星的**终答步**走的是这条
     * 路径（`finalAnswerOnly` 一步恒可流式），所以违约必须在这里也复现得出来。
     * 判据与 executeAgentTurn 那侧一致：这一步没给工具面（`options.tools` 空）
     * 却仍然回 tool_calls。
     */
    const withheldTools = !options.tools || options.tools.length === 0;
    const scriptedWithheldViolation = withheldTools && messages.some((message) =>
      message.role === "user"
        && String(message.content ?? "").includes("【mock:tool-after-withheld】"));
    if (!scriptedWithheldViolation) return { content };
    return {
      content,
      toolCalls: [{
        id: `call_companion_context_${randomUUID()}`,
        name: "companion_read_context",
        arguments: {},
      }],
      finishReason: "tool_calls",
    };
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
