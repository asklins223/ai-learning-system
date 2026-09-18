import {
  type AgentTurnRequest,
  type AgentTurnResult,
  type ProviderCapability,
} from "@ailearn/shared";
import { createHash } from "node:crypto";
import { resolveOpenAIChatCompletionsUrl, resolveOpenAIEmbeddingsUrl } from "@ailearn/shared/ai-endpoints";
import {
  postSseToPublicEndpoint,
  postJsonToPublicEndpoint,
  type PublicJsonRequester,
  type PublicStreamingRequester,
} from "@ailearn/shared/public-json-http";
import { shouldUsePromptCache } from "@ailearn/shared";
import type { AIProvider, ProviderUsage } from "../ai-provider.ts";
import {
  readChatCompletionContent,
  readProviderCode,
  readUsage,
  parseAgentTurnToolCalls,
  buildAgentTurnMessages,
} from "./json-response.ts";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  CapabilityImpl,
  ProviderRuntimeConfig,
  PlatformOptions,
} from "@ailearn/shared";
import { registerFactory } from "../provider-factory.ts";
import { ProviderRequestError } from "../provider-request-error.ts";
import { AgentOutputError } from "../non-retryable-errors.ts";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../provider-constants.ts";

/** R1: Unified abort error helper. */
function abortError(signal: AbortSignal, phase: string): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(`AI request aborted ${phase}`);
}

/**
 * 采样参数的出口夹取（AI P2 #25，2026-09-15 审计）。
 *
 * 上游 zod 合同已经约束了主要调用方（AgentTurnRequest.temperature 0..2、
 * V2 stage runtime 0..2），但 provider 是被多个入口复用的**最后一层**：
 * `request.temperature` / `request.maxTokens` 此前原样透传，任何新增的或绕过
 * 合同的调用方都能把 temperature=99、max_tokens=-1 送到服务端（前者被拒或产出
 * 无意义结果，后者在部分 OpenAI 兼容实现里会被当作"不限制"）。
 *
 * 这里只做保守夹取，不改变合同内的合法值（0..2 / 正整数）。非法值（NaN、负数）
 * 直接**省略字段**，让 provider 用自身默认值，而不是把垃圾值发出去。
 */
const MAX_REQUEST_TEMPERATURE = 2;
const MAX_REQUEST_MAX_TOKENS = 65_536;

function clampTemperature(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_REQUEST_TEMPERATURE, Math.max(0, value));
}

function clampMaxTokens(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(MAX_REQUEST_MAX_TOKENS, Math.floor(value));
}

async function readStreamingBodyText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error("AI endpoint error response exceeded 2097152 bytes");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly promptVersion: string;
  readonly modelId: string;
  readonly visionModelId: string;
  readonly embeddingModelId: string;
  private readonly endpoint: string;
  private readonly embeddingEndpoint: string;
  private readonly apiKey: string;
  private readonly request: PublicJsonRequester;
  private readonly streamRequest: PublicStreamingRequester;
  private readonly extraRequestParams: Record<string, unknown> | undefined;
  private readonly extraHeaders: Record<string, string> | undefined;
  private readonly maxTokensStrategy: "always" | "env-gated";
  /** Platform config options (from config file, overrides env vars). */
  private readonly platformOptions: PlatformOptions | undefined;

  /**
   * R2: TextGenerationCapability — generic chat completion.
   *
   * The provider only performs transport; prompt selection and output
   * validation belong to the active caller.
   */
  async chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const { content, usage } = await this.call(
      messages as Array<{
        role: "system" | "user";
        content: string | Array<
          | { type: "text"; text: string }
          | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
        >;
      }>,
      signal,
      options.maxTokens ?? 4096,
      options.temperature ?? 0.2,
      options.model ?? this.modelId,
      options.responseFormat,
      options.disableThinking ?? false,
    );
    return {
      content,
      usage: usage ?? { totalTokens: null, promptTokens: null, completionTokens: null, requestId: null },
    };
  }

  /**
   * §8.2 真实流式：`stream: true` + OpenAI-compatible SSE（`data: {...}` 行、
   * `data: [DONE]` 结束、`choices[0].delta.content` 增量）。与 call() 相同的
   * body/headers 构造，但走独立的 HTTPS streaming requester（PublicJsonRequester
   * 只能整包读 JSON，无法承载流式）。abort 时立刻中断读取并抛 abortError。
   */
  async chatCompletionStream(
    messages: ChatMessage[],
    options: ChatOptions,
    signal: AbortSignal | undefined,
    onDelta: (deltaText: string) => void,
  ): Promise<{ content: string }> {
    if (signal?.aborted) throw abortError(signal, "before request");
    const maxTokens = options.maxTokens ?? 4096;
    const temperature = options.temperature ?? 0.2;
    const model = options.model ?? this.modelId;
    const disableMaxTokens = this.platformOptions?.disableMaxTokens ?? false;
    const shouldSetMaxTokens = this.maxTokensStrategy === "always" || !disableMaxTokens;
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      stream: true,
      // Companion dialogue explicitly requests natural text. Keep the
      // JSON default for structured callers that omit the
      // option, but never force JSON mode onto a text dialogue stream.
      ...(options.responseFormat === "text"
        ? {}
        : { response_format: { type: "json_object" as const } }),
      ...((options.disableThinking
        || this.platformOptions?.disableThinking)
        ? { enable_thinking: false }
        : this.platformOptions?.enableThinking
          ? { enable_thinking: true }
          : {}),
      ...this.extraRequestParams,
    };
    if (shouldSetMaxTokens) body.max_tokens = maxTokens;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
    const response = await this.streamRequest(this.endpoint, headers, body, signal);
    if (signal?.aborted) {
      response.cancel();
      throw abortError(signal, "after response");
    }
    if (response.status < 200 || response.status >= 300) {
      let providerCode: string | number | undefined;
      try {
        const raw = await readStreamingBodyText(response.body);
        const parsed = raw ? JSON.parse(raw) : null;
        providerCode = readProviderCode(parsed);
      } catch {
        // 非 JSON 错误体：保留原始状态码即可
      }
      throw new ProviderRequestError({
        provider: this.id,
        status: response.status,
        providerCode,
      });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let responseBytes = 0;
    const consumeData = (data: string): boolean => {
      if (data === "[DONE]") return true;
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: unknown } }>
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          content += delta;
          onDelta(delta);
        }
      } catch {
        // 忽略无法解析的 SSE 行（部分网关会插入空行/注释）
      }
      return false;
    };
    const abortListener = () => {
      response.cancel();
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    try {
      for await (const value of response.body) {
        responseBytes += value.byteLength;
        if (responseBytes > 8 * 1024 * 1024) {
          response.cancel();
          throw new Error(`${this.id} streaming response exceeded 8388608 bytes (${model})`);
        }
        buffer += decoder.decode(value, { stream: true });
        // PERF: 用 consumed 游标扫描本 chunk 内完整行，仅在末尾一次性截取未处理尾部，
        // 避免每个 line 都执行 buffer.slice() 造成 O(n²) 复制。
        let lineEnd: number;
        let consumed = 0;
        while ((lineEnd = buffer.indexOf("\n", consumed)) !== -1) {
          const line = buffer.slice(consumed, lineEnd).replace(/\r$/, "");
          consumed = lineEnd + 1;
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (consumeData(data)) {
            response.cancel();
            if (!content.trim()) {
              throw new Error(`${this.id} returned empty streaming output (${model})`);
            }
            return { content };
          }
        }
        // 保留未处理的尾部（可能包含不完整的行），等待下个 chunk 补全。
        buffer = buffer.slice(consumed);
      }
      // Some compatible gateways close without a final newline or [DONE].
      // Flush the decoder and parse that last complete data line instead of
      // silently dropping the final token.
      buffer += decoder.decode();
      const trailing = buffer.trim();
      if (trailing.startsWith("data:") && consumeData(trailing.slice(5).trim())) {
        if (!content.trim()) {
          throw new Error(`${this.id} returned empty streaming output (${model})`);
        }
        return { content };
      }
    } finally {
      signal?.removeEventListener("abort", abortListener);
    }
    if (signal?.aborted) throw abortError(signal, "after stream");
    if (!content.trim()) {
      throw new Error(`${this.id} returned empty streaming output (${model})`);
    }
    return { content };
  }

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    visionModel?: string;
    embeddingModel?: string;
    request?: PublicJsonRequester;
    streamRequest?: PublicStreamingRequester;
    // ── R1: Preset configuration for DashScope compatibility ──
    resolveEndpoint?: (baseUrl: string) => string;
    resolveEmbeddingEndpoint?: (baseUrl: string) => string;
    extraRequestParams?: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
    maxTokensStrategy?: "always" | "env-gated";
    providerId?: string;
    promptVersionOverride?: string;
    /** Platform config options (from config/ai-platforms.json). */
    platformOptions?: PlatformOptions;
  }) {
    this.apiKey = options.apiKey;
    this.modelId = options.model;
    this.visionModelId = options.visionModel ?? options.model;
    this.embeddingModelId = options.embeddingModel ?? options.model;
    // R1: Use resolveEndpoint if provided (e.g., DashScope URL rewriting)
    const resolveFn = options.resolveEndpoint ?? resolveOpenAIChatCompletionsUrl;
    this.endpoint = resolveFn(options.baseUrl);
  // Use a provider-specific embedding resolver when the provider needs one.
    const resolveEmbeddingFn = options.resolveEmbeddingEndpoint ?? resolveOpenAIEmbeddingsUrl;
    this.embeddingEndpoint = resolveEmbeddingFn(options.baseUrl);
    this.request = options.request ?? postJsonToPublicEndpoint;
    this.streamRequest = options.streamRequest ?? postSseToPublicEndpoint;
    this.extraRequestParams = options.extraRequestParams;
    this.extraHeaders = options.extraHeaders;
    this.maxTokensStrategy = options.maxTokensStrategy ?? "env-gated";
    this.platformOptions = options.platformOptions;
    this.id = options.providerId ?? "openai_compatible";
    this.promptVersion = options.promptVersionOverride ?? "v6-openai-compatible";
  }

  /**
   * Call the OpenAI-compatible embeddings endpoint.
   *
   * Returns null when no embedding model is configured or the request fails,
   * matching the embedding contract expected by upstream callers, which fall
   * back to lexical/sequential search automatically.
   */
  async embed(text: string, signal?: AbortSignal): Promise<number[] | null> {
    if (!this.embeddingModelId) return null;
    try {
      const response = await this.request(
        this.embeddingEndpoint,
        { Accept: "application/json", Authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
        {
          model: this.embeddingModelId,
          input: [text.slice(0, 1500)],
          encoding_format: "float",
        },
        signal,
      );
      if (response.status < 200 || response.status >= 300) {
        return null;
      }
      const body = response.body as Record<string, unknown>;
      const data = (body?.data as Array<Record<string, unknown>>) ?? [];
      const embedding = data[0]?.embedding;
      if (!Array.isArray(embedding)) return null;
      return embedding as number[];
    } catch {
      return null;
    }
  }

  // ─── Supervisor Agent v1: executeAgentTurn + getCapabilities (计划 §8.1, §8.2) ──

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
    temperature = 0.2,
    model = this.modelId,
    responseFormat: ChatOptions["responseFormat"] = "json_object",
    /** 2026-08-12+（15a 新反馈）：显式关闭思考模式（enable_thinking: false）。 */
    disableThinking = false,
  ): Promise<{ content: string; usage: ProviderUsage | null }> {
    if (signal?.aborted) throw abortError(signal, "before request");
    // R1: maxTokensStrategy controls max_tokens ("always" for DashScope, "env-gated" for OpenAI-compatible)
    const disableMaxTokens = this.platformOptions?.disableMaxTokens ?? false;
    const shouldSetMaxTokens = this.maxTokensStrategy === "always" || !disableMaxTokens;
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      stream: false,
      // Keep structured JSON as the default for structured callers, while
      // allowing companion dialogue to request natural text explicitly.
      ...(responseFormat === "text"
        ? {}
        : { response_format: { type: "json_object" as const } }),
      // Platform config options control thinking mode:
      //   disableThinking: explicitly disable (enable_thinking: false)
      //   enableThinking:  explicitly enable  (enable_thinking: true)
      //   neither:          use model/API default (no field)
      // 2026-08-12+（15a 新反馈）：call 的 disableThinking 参数优先级最高
      //（companion 日常对话用它显式关闭思考模式，换首 token 速度）。
      ...((disableThinking
        || this.platformOptions?.disableThinking)
        ? { enable_thinking: false }
        : this.platformOptions?.enableThinking
          ? { enable_thinking: true }
          : {}),
      // R1: DashScope preset overrides (e.g., enable_thinking: false)
      ...this.extraRequestParams,
    };
    if (shouldSetMaxTokens) {
      body.max_tokens = maxTokens;
    }
    // R1: Merge extra headers (e.g., X-DashScope-WorkSpace)
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
    // 2026-08-16（实机验证）：thinking 模式（enable_thinking: true）下部分
    // provider（如 tokenrhythm deepseek-v4-flash）偶发返回空 content（内容
    // 全部落入 reasoning_content 或输出被截断）。空输出重试同一请求（最多
    // 3 次总尝试），外层 AbortSignal（75s 单调用预算）仍会中止悬挂调用，
    // 不改变超时语义。每次尝试都是独立 HTTP 请求（幂等：chat completion
    // 无副作用）。
    const MAX_EMPTY_OUTPUT_ATTEMPTS = 3;
    let content: string | null = null;
    let usage: ProviderUsage | null = null;
    for (let attempt = 1; attempt <= MAX_EMPTY_OUTPUT_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw abortError(signal, "before request");
      const response = await this.request(
        this.endpoint,
        headers,
        body,
        signal,
      );
      // R1: Post-response abort check (matching DashScope's behavior)
      if (signal?.aborted) throw abortError(signal, "after response");
      if (response.status < 200 || response.status >= 300) {
        throw new ProviderRequestError({
          provider: this.id,
          status: response.status,
          providerCode: readProviderCode(response.body),
        });
      }
      // R1: Post-body-read abort check
      if (signal?.aborted) throw abortError(signal, "after body read");
      const candidate = readChatCompletionContent(response.body);
      if (typeof candidate === "string" && candidate.trim()) {
        content = candidate;
        // v0.6: Extract usage from API response (计划 §6.6, §10.5)
        usage = readUsage(response.body);
        break;
      }
      if (attempt < MAX_EMPTY_OUTPUT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    if (content === null) {
      throw new Error(`${this.id} returned empty output (${model})`);
    }
    return { content, usage };
  }

  // ─── Supervisor Agent v1: executeAgentTurn + getCapabilities (计划 §8.1, §8.2) ──

  /**
   * 通用 Agent turn 执行（计划 §8.1）。
   *
   * OpenAI-compatible endpoint 支持 native tool calls。
   * 当 tool schema 非空时，使用 native tools 模式；
   * 当 tool schema 为空时，回退到 JSON mode（structured_action_v1）。
   *
   * 一次 attempt 最多一次 provider 请求（计划 §5.2, §5.3）。
   * usage/requestId 随响应返回，不依赖可变的 getLastUsage()。
   */
  async executeAgentTurn(
    request: AgentTurnRequest,
    signal?: AbortSignal,
  ): Promise<AgentTurnResult> {
    if (signal?.aborted) throw abortError(signal, "before executeAgentTurn");

    // PERF-09: 使用共享的 messages 构建函数
    const messages = buildAgentTurnMessages(request.systemPrompt, request.messages);

    const hasTools = request.tools.length > 0;
    const tools = hasTools
      ? request.tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;

    const requestBody: Record<string, unknown> = {
      model: request.model ?? this.modelId,
      messages,
      temperature: clampTemperature(request.temperature),
      stream: false,
      // Platform config options control thinking mode:
      //   disableThinking: explicitly disable (enable_thinking: false)
      //   enableThinking:  explicitly enable  (enable_thinking: true)
      //   neither:          use model/API default (no field)
      ...((this.platformOptions?.disableThinking ?? false)
        ? { enable_thinking: false }
        : this.platformOptions?.enableThinking
          ? { enable_thinking: true }
          : {}),
      // R1: DashScope preset overrides (e.g., enable_thinking: false)
      ...this.extraRequestParams,
    };

    // R1: maxTokensStrategy controls max_tokens
    const disableMaxTokens = this.platformOptions?.disableMaxTokens ?? false;
    const shouldSetMaxTokens = this.maxTokensStrategy === "always" || !disableMaxTokens;
    if (shouldSetMaxTokens) {
      // AI P2 #25：出口夹取；非法/缺失即省略字段（用 provider 默认），不发垃圾值。
      const maxTokens = clampMaxTokens(request.maxTokens);
      if (maxTokens !== undefined) requestBody.max_tokens = maxTokens;
    }

    if (hasTools) {
      requestBody.tools = tools;
      requestBody.tool_choice = "auto";
    } else {
      requestBody.response_format = { type: "json_object" as const };
    }

    // B2（计划 §2.5）：prompt cache 控制。
    // 当 feature flag 开启且 provider 在白名单中时，添加缓存标记。
    // DashScope 支持 enable_cache 参数；其他 OpenAI-compatible 端点
    // 可能在 messages 上使用 cache_control 标记。此处统一用 enable_cache
    // （DashScope 扩展），不支持的端点会静默忽略。
    if (shouldUsePromptCache(this.id)) {
      requestBody.enable_cache = true;
    }

    // R1: Merge extra headers
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
    // Merge platform options extra headers
    if (this.platformOptions?.extraHeaders) {
      Object.assign(headers, this.platformOptions.extraHeaders);
    }
    // 2026-08-11：REPRO-LOG 加开关——此前无条件打印（含 RESPONSE 400 字符
    // 内容预览）到 stderr，生产日志持续输出模型往返细节。仅当显式设置
    // AI_PROVIDER_REPRO_LOG=1 时启用（调试复现用）。
    const reproLogEnabled = process.env.AI_PROVIDER_REPRO_LOG === "1";
    if (reproLogEnabled) {
      const firstUserContent = (requestBody.messages as Array<{ content?: string }>).find(m => m.content)?.content ?? "";
      // 2026-08-12（模型调用面审计）：不再打印用户内容原文——误开开关即泄漏
      // 笔记/消息内容。只记录长度 + sha256 前缀指纹（可对照，不可还原）。
      console.error("[REPRO-LOG] REQUEST", JSON.stringify({
        model: requestBody.model,
        toolNames: (requestBody.tools as Array<{function:{name:string}}> | undefined)?.map(t => t.function.name),
        toolChoice: requestBody.tool_choice,
        maxTokens: requestBody.max_tokens,
        msgCount: (requestBody.messages as Array<{role:string}>).length,
        userMsgLen: (requestBody.messages as Array<{content:string}>).map(m => (m.content ?? "").length),
        systemLen: ((requestBody.messages as Array<{role:string,content:string}>).find(m=>m.role==="system")?.content ?? "").length,
        userContentSha256: createHash("sha256").update(firstUserContent).digest("hex").slice(0, 16),
      }));
    }
    const response = await this.request(
      this.endpoint,
      headers,
      requestBody,
      signal,
    );

    if (signal?.aborted) throw abortError(signal, "after agent turn response");

    if (response.status < 200 || response.status >= 300) {
      throw new ProviderRequestError({
        provider: this.id,
        status: response.status,
        providerCode: readProviderCode(response.body),
      });
    }

    const body = response.body as Record<string, unknown>;
    if (reproLogEnabled) {
      console.error("[REPRO-LOG] RESPONSE", JSON.stringify({
        status: response.status,
        finish: (body.choices as Array<{finish_reason:string}> | undefined)?.[0]?.finish_reason,
        toolCalls: (body.choices as Array<{message:{tool_calls?: Array<{function:{name:string}}>}}> | undefined)?.[0]?.message?.tool_calls?.map(tc => tc.function.name),
        contentPreview: ((body.choices as Array<{message:{content?:string}}> | undefined)?.[0]?.message?.content ?? "").slice(0, 400),
      }));
    }
    const usage = readUsage(response.body);

    // R1: Post-body-read abort check
    if (signal?.aborted) throw abortError(signal, "after agent turn body read");

    // QUAL-19 / BUG-09: Use shared tool calls parser. The JSON mode fallback
    // is only attempted when no native tool_calls are present, preventing
    // duplicate tool call execution when a provider returns both
    // `message.tool_calls` and a JSON `content` body.
    const { content, toolCalls, finishReason, requestId } =
      parseAgentTurnToolCalls(body, hasTools, ["id", "request_id"]);

    // 输出截断 / 参数损坏检测（截断空转修复）：
    // - finish_reason="length"：输出达到 token 上限被截断，arguments 可能不完整。
    //   截断是确定性的——相同输出预算下重试必然再次截断——必须归类为
    //   AgentOutputError（isNonRetryableError 命中），队列标记 dead，不再无限空转。
    // - 存在 argumentsMalformed 工具调用：输出损坏（不完整 JSON），同样确定性失败。
    // 修复前：截断被静默降级为空对象 arguments，工具"看似成功"执行，
    // 提取结果为空 → 协议失败 → unit retryable_failed → 队列重投 → 再次截断 → 空转。
    if (finishReason === "length") {
      throw new AgentOutputError(
        "output_truncated",
        `agent output truncated at finish_reason="length" ` +
          `(toolCalls=${toolCalls.length}, malformed=${toolCalls.filter((tc) => tc.argumentsMalformed).length})`,
      );
    }
    const malformed = toolCalls.find((tc) => tc.argumentsMalformed);
    if (malformed) {
      throw new AgentOutputError(
        "arguments_malformed",
        `tool call "${malformed.name}" has malformed arguments JSON (id=${malformed.id ?? "unknown"})`,
      );
    }

    return {
      content,
      toolCalls,
      finishReason,
      usage,
      providerRequestId: requestId,
    };
  }

  /**
   * 返回 OpenAI-compatible Provider 能力快照（计划 §8.2）。
   *
   * Context window and output limits are configured through PlatformOptions.
   */
  getCapabilities(): ProviderCapability {
    const contextWindowTokens = this.platformOptions?.contextWindowTokens
      ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    // 输出预算：允许平台配置覆盖。默认 16384——这是对 openai_compatible 模型实际输出能力的
    // 校准值（实测 deepseek-v4-flash-0731 在 max_tokens=32768 时输出过 15442 token 后自停；
    // 而 provider 在「不传 max_tokens」时的默认上限仅为 8192，会截断大输出）。
    // 使 ContextPacker.getMaxOutputTokens() = min(maxOutputTokens, reserved) = 16384，
    // 避免 request.maxTokens=4096 或 8192 与真实输出上限不符、导致 agent turn 被截断。
    const maxOutputTokens = this.platformOptions?.maxOutputTokens ?? 16384;
    const reservedOutputTokens = maxOutputTokens;
    return {
      providerId: this.id,
      modelId: this.modelId,
      visionModelId: this.visionModelId,
      toolMode: "native_tools",
      contextWindowTokens,
      reservedOutputTokens,
      maxInputTokens: contextWindowTokens - reservedOutputTokens,
      maxOutputTokens,
      // R3: fingerprint includes visionModelId to capture vision-only config drift.
fingerprint: `${this.id}:${this.modelId}:${this.visionModelId}:native_tools`,
    };
  }
}

// ─── R2: Factory registrations ──────────────────────────────────────────
// Register OpenAI-compatible provider for each capability it supports.
// The factory creates a provider instance from runtime config, returning null
// when required config (apiKey, baseUrl, model) is missing.

function resolveOpenAICompatConfig(config: ProviderRuntimeConfig): {
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel?: string;
  platformOptions?: PlatformOptions;
} | null {
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl;
  const model = config.model;
  if (!apiKey || !baseUrl || !model) return null;
  return {
    apiKey,
    baseUrl,
    model,
    ...(config.visionModel ? { visionModel: config.visionModel } : {}),
    ...(config.options ? { platformOptions: config.options } : {}),
  };
}

registerFactory("openai_compatible", "text_generation", (config) => {
  const resolved = resolveOpenAICompatConfig(config);
  if (!resolved) return null;
  return new OpenAICompatibleProvider(resolved) as unknown as CapabilityImpl;
});

registerFactory("openai_compatible", "vision", (config) => {
  const resolved = resolveOpenAICompatConfig(config);
  if (!resolved) return null;
  return new OpenAICompatibleProvider(resolved) as unknown as CapabilityImpl;
});

registerFactory("openai_compatible", "agent_turn", (config) => {
  const resolved = resolveOpenAICompatConfig(config);
  if (!resolved) return null;
  return new OpenAICompatibleProvider(resolved) as unknown as CapabilityImpl;
});

registerFactory("openai_compatible", "embedding", (config) => {
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl;
  const model = config.model;
  if (!apiKey || !baseUrl || !model) return null;
  const embeddingModel = model;
  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl,
    model,
    embeddingModel,
  }) as unknown as CapabilityImpl;
});
