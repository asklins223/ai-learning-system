/**
 * OpenCode Go provider — OpenAI Responses API（`/responses`）实现。
 *
 * 为什么不复用 OpenAICompatibleProvider：
 * OpenCode Go 的 muse-spark-*（含 muse-spark-1.3-contributor，1,048,576 上下文）、
 * grok-4.6、gpt-5.6-luna 只在 `/responses` 提供，走 `/chat/completions` 会稳定
 * 返回 HTTP 500。Responses API 的请求体是 `input` items（含 function_call /
 * function_call_output），响应体是 `output` items + `status`，与 chat/completions
 * 的 messages/choices 契约不同，无法靠改写 endpoint 复用同一实现。
 *
 * 端点约束（https://opencode.ai/docs/go）：
 * - 每个请求必须带 `x-opencode-session`，否则 400 `MissingSessionID`。
 *   本 provider 在构造时生成一个稳定 UUID：一个 provider 实例对应一次
 *   job/会话，满足上游「每个会话一个稳定 session」的路由与 prompt cache 要求。
 * - 客户端必须自报 user agent，不能使用通用 SDK/HTTP 库名。
 * - muse-spark-1.3-contributor 是 reasoning 模型，`reasoning.effort` 只接受
 *   minimal/low/medium/high/xhigh/max（**不接受 none**）。平台的
 *   `disableThinking` 映射为 `minimal`（能关到的最低档），`enableThinking`
 *   映射为 `high`；两者都未配置时不下发该字段，用网关默认（high）。
 *   各模型支持档位不同（deepseek 支持 none、gpt-5.6-luna 不支持 minimal），
 *   因此平台可用 `options.reasoningEffort` 显式指定，显式值优先。
 */

import { randomUUID } from "node:crypto";
import type {
  AgentTurnRequest,
  AgentTurnResult,
  CapabilityImpl,
  ChatMessage,
  ChatOptions,
  ChatResult,
  PlatformOptions,
  ProviderCapability,
  ProviderRuntimeConfig,
  ProviderUsage,
} from "@ailearn/shared";
import { resolveOpenAIResponsesUrl } from "@ailearn/shared/ai-endpoints";
import {
  postJsonToPublicEndpoint,
  postSseToPublicEndpoint,
  type PublicJsonRequester,
  type PublicStreamingRequester,
} from "@ailearn/shared/public-json-http";
import type { AIProvider } from "../ai-provider.ts";
import { registerFactory } from "../provider-factory.ts";
import { ProviderRequestError } from "../provider-request-error.ts";
import { AgentOutputError } from "../non-retryable-errors.ts";

/** OpenCode Go 默认端点（Responses API 根路径）。 */
const DEFAULT_BASE_PATH = "https://opencode.ai/zen/go/v1";

/** 客户端自报标识——端点要求非通用 SDK/HTTP 库名。 */
const USER_AGENT = "ailearn-ai-worker/1.0";

/** muse-spark-1.3-contributor 的上下文窗口（1M）。 */
const OPENCODE_GO_CONTEXT_WINDOW_TOKENS = 1_048_576;

/** muse-spark-1.3-contributor 的最大输出（128K）。 */
const OPENCODE_GO_MAX_OUTPUT_TOKENS = 131_072;

/** R1: Unified abort error helper. */
function abortError(signal: AbortSignal, phase: string): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(`AI request aborted ${phase}`);
}

/**
 * 校验 OpenCode Go baseUrl 并解析出 Responses API 端点。
 *
 * 与 dashscope 工厂同样把端点校验放在 provider 侧：registry 只保留纯数据。
 */
export function resolveOpenCodeGoEndpoint(baseUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`Invalid OpenCode Go baseUrl: ${baseUrl}`);
  }
  if (!/^(?:[a-z0-9-]+\.)*opencode\.ai$/i.test(hostname)) {
    throw new Error("OpenCode Go baseUrl must be an opencode.ai domain");
  }
  return resolveOpenAIResponsesUrl(baseUrl);
}

// ─── Responses API wire types ────────────────────────────────────────────

type ResponsesImageDetail = "auto" | "low" | "high";

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: ResponsesImageDetail };

type ResponsesInputItem =
  | { role: "user" | "assistant" | "system"; content: string | ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | ReasoningReplayItem;

/**
 * 回放的 reasoning item。
 *
 * 字段按上游要求原样保留（**muse-spark 缺 `summary` 会 400
 * `missing required field 'summary'`**），但明文思考内容 `content`
 * （`reasoning_text`）在产出句柄时已被剥离，不进入契约。
 */
type ReasoningReplayItem = { type: "reasoning" } & Record<string, unknown>;

/** Agent turn 消息（AgentTurnRequest.messages 的元素）的输入形态。 */
type AgentTurnMessage = AgentTurnRequest["messages"][number];

function toResponsesContent(
  content: string | AgentTurnMessage["content"],
): string | ResponsesContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part): ResponsesContentPart => part.type === "text"
    ? { type: "input_text", text: part.text }
    : {
        type: "input_image",
        image_url: part.image_url.url,
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
      });
}

/** ChatMessage（chatCompletion 输入）→ Responses input items。 */
function buildChatInput(messages: ChatMessage[]): {
  instructions: string | null;
  input: ResponsesInputItem[];
} {
  const systemParts: string[] = [];
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content === "string") {
        systemParts.push(message.content);
      } else {
        systemParts.push(
          message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        );
      }
      continue;
    }
    input.push({ role: message.role, content: toResponsesContent(message.content) });
  }
  const instructions = systemParts.filter((part) => part.trim()).join("\n\n");
  return { instructions: instructions || null, input };
}

/**
 * Agent turn 历史消息 → Responses input items。
 *
 * 映射规则（与 chat/completions 的 tool_calls/tool_call_id 一一对应）：
 * - assistant + reasoning 句柄 → `reasoning` items
 * - assistant + toolCalls → `function_call` items（Responses 无 assistant.tool_calls）
 * - tool + toolCallId      → `function_call_output` item
 * - tool 缺 toolCallId     → 按 user 消息回放（schema 中该字段可选，避免静默丢结果）
 *
 * **顺序必须与模型的产出顺序一致：reasoning → message → function_call。**
 * Responses API 按 items 顺序重建上游请求；把 message 排在 reasoning 之前会让
 * deepseek 思考模式直接 400「reasoning_text must be passed back」（实测：
 * 忠实顺序通过、message 前置失败），与是否携带明文 reasoning 无关。
 */
function buildAgentTurnInput(
  systemPrompt: string,
  messages: AgentTurnMessage[],
): { instructions: string | null; input: ResponsesInputItem[] } {
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const output = typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (message.toolCallId) {
        input.push({ type: "function_call_output", call_id: message.toolCallId, output });
      } else {
        input.push({ role: "user", content: output });
      }
      continue;
    }
    for (const handle of message.reasoning ?? []) {
      input.push({ type: "reasoning", ...handle } as ReasoningReplayItem);
    }
    // 空 content 的 assistant 消息只用于承载 toolCalls：Responses 的 input item
    // 要求 content 非空，因此只在其确实携带文本时才回放该条消息。
    const hasContent = typeof message.content === "string"
      ? message.content.trim().length > 0
      : message.content.length > 0;
    if (hasContent) {
      input.push({ role: message.role, content: toResponsesContent(message.content) });
    }
    for (const call of message.toolCalls ?? []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
  return { instructions: systemPrompt.trim() || null, input };
}

// ─── Responses API 响应解析（导出供单测直接覆盖） ─────────────────────────

interface ResponsesOutputItem {
  type?: unknown;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
  call_id?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readOutputItems(body: unknown): ResponsesOutputItem[] {
  const output = asRecord(body)?.output;
  return Array.isArray(output) ? output as ResponsesOutputItem[] : [];
}

/** 拼接 output 中所有 message item 的 output_text。 */
export function readResponsesText(body: unknown): string | null {
  const parts: string[] = [];
  for (const item of readOutputItems(body)) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const rawPart of item.content) {
      const part = asRecord(rawPart);
      if (part?.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  const text = parts.join("");
  return text.trim() ? text : null;
}

/**
 * Responses usage → ProviderUsage。
 *
 * Responses 用 input_tokens/output_tokens（而非 chat/completions 的
 * prompt_tokens/completion_tokens），cache 命中在
 * usage.input_tokens_details.cached_tokens。
 */
export function readResponsesUsage(body: unknown): ProviderUsage | null {
  const record = asRecord(body);
  const usage = asRecord(record?.usage);
  if (!usage) return null;
  const asTokenCount = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

  const promptTokens = asTokenCount(usage.input_tokens);
  const completionTokens = asTokenCount(usage.output_tokens);
  const totalTokens = asTokenCount(usage.total_tokens)
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;

  const cacheHitTokens = asTokenCount(asRecord(usage.input_tokens_details)?.cached_tokens);
  return {
    totalTokens,
    promptTokens,
    completionTokens,
    requestId: typeof record?.id === "string" ? record.id : null,
    ...(cacheHitTokens !== null ? { cacheHitTokens } : {}),
  };
}

/**
 * 从 output 中提取 reasoning 句柄（供下一轮工具循环回放）。
 *
 * **隐私约束**：明文思考内容 `content`（`reasoning_text`）在此剥离，只保留
 * 不透明字段（id / encrypted_content / status / summary / …）。实测剥离后
 * deepseek 与 muse-spark 的上游校验都通过，因此模型内部推理不必落库。
 * 注意其余字段必须原样保留：muse-spark 缺 `summary` 会 400
 * `missing required field 'summary'`。
 */
export function readResponsesReasoningHandles(body: unknown): Array<Record<string, unknown>> {
  const handles: Array<Record<string, unknown>> = [];
  for (const item of readOutputItems(body)) {
    if (item.type !== "reasoning") continue;
    const { content: _plaintext, ...opaque } = item as Record<string, unknown>;
    if (Object.keys(opaque).length > 0) handles.push(opaque);
  }
  return handles;
}

interface ParsedResponsesToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsMalformed?: boolean;
}

/**
 * Responses 响应体 → agent turn 结果。
 *
 * 与 chat/completions 路径保持同一套语义（见 json-response.ts
 * parseAgentTurnToolCalls）：
 * - `status: "incomplete"` + `incomplete_details.reason: "max_output_tokens"`
 *   归一为 finishReason "length"，由调用方升级为不可重试的 AgentOutputError。
 * - function_call.arguments 解析失败标记 argumentsMalformed，绝不静默降级为空对象。
 * - 无定义工具时回退解析 content 里的 structured_action JSON（与 chat/completions 一致）。
 */
export function parseResponsesAgentTurn(
  body: unknown,
  hasTools: boolean,
): {
  content: string | null;
  toolCalls: ParsedResponsesToolCall[];
  finishReason: string;
  requestId: string | null;
} {
  const record = asRecord(body);
  const content = readResponsesText(body);
  const toolCalls: ParsedResponsesToolCall[] = [];
  for (const item of readOutputItems(body)) {
    if (item.type !== "function_call") continue;
    const rawArguments = item.arguments;
    let args: Record<string, unknown> = {};
    let argumentsMalformed: boolean | undefined;
    const asObject = asRecord(rawArguments);
    if (typeof rawArguments === "string") {
      try {
        const parsed = asRecord(JSON.parse(rawArguments));
        if (parsed) {
          args = parsed;
        } else {
          argumentsMalformed = true;
        }
      } catch {
        argumentsMalformed = true;
      }
    } else if (asObject) {
      args = asObject;
    } else {
      argumentsMalformed = true;
    }
    toolCalls.push({
      id: typeof item.call_id === "string" && item.call_id ? item.call_id : "",
      name: typeof item.name === "string" ? item.name : "",
      arguments: args,
      ...(argumentsMalformed ? { argumentsMalformed } : {}),
    });
  }

  if (!hasTools && toolCalls.length === 0 && content) {
    try {
      const parsed = JSON.parse(content) as { toolCalls?: unknown };
      if (Array.isArray(parsed?.toolCalls)) {
        for (const call of parsed.toolCalls as Array<Record<string, unknown>>) {
          // AI P0-6（2026-09-15 审计）：此处此前直接
          // `arguments: (call.arguments ?? {}) as Record<string, unknown>`——字符串
          // 形态的 arguments（被截断或非 JSON）会被当成字符串塞进对象位，且没有
          // argumentsMalformed 标记，于是 provider 的 fail-closed 检查漏掉这条路径
          // （native function_call 路径与 chat/completions 路径都有标记）。
          // 现在与那两处对齐：字符串必须解析，失败即标记 → 上层升级为
          // 不可重试的 arguments_malformed。
          const rawArgs = call.arguments ?? {};
          let args: Record<string, unknown> = {};
          let argumentsMalformed: boolean | undefined;
          if (typeof rawArgs === "string") {
            try {
              const parsedArgs = asRecord(JSON.parse(rawArgs));
              if (parsedArgs) {
                args = parsedArgs;
              } else {
                argumentsMalformed = true;
              }
            } catch {
              argumentsMalformed = true;
            }
          } else {
            args = rawArgs as Record<string, unknown>;
          }
          toolCalls.push({
            id: String(call.id ?? ""),
            name: String(call.name ?? ""),
            arguments: args,
            ...(argumentsMalformed ? { argumentsMalformed } : {}),
          });
        }
      }
    } catch {
      // content 不是有效 JSON，忽略（与 chat/completions 路径一致）
    }
  }

  const status = typeof record?.status === "string" ? record.status : "";
  const incompleteReason = asRecord(record?.incomplete_details)?.reason;
  const finishReason = status === "incomplete" && incompleteReason === "max_output_tokens"
    ? "length"
    : toolCalls.length > 0
      ? "tool_calls"
      : status === "incomplete"
        ? String(incompleteReason ?? "incomplete")
        : status === "completed"
          ? "stop"
          : status || "stop";

  return {
    content,
    toolCalls,
    finishReason,
    requestId: typeof record?.id === "string" ? record.id : null,
  };
}

/** 网关错误体（{"error":{"type","message"}}）→ 隐私安全的错误码。 */
function readOpenCodeGoErrorCode(body: unknown): string | undefined {
  const error = asRecord(asRecord(body)?.error);
  const type = error?.type;
  if (typeof type === "string") return type;
  const code = error?.code ?? asRecord(body)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

// ─── Provider ────────────────────────────────────────────────────────────

export class OpenCodeGoProvider implements AIProvider {
  readonly id = "opencode_go";
  readonly promptVersion = "v6-opencode-go";
  readonly modelId: string;
  readonly visionModelId: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  /** 稳定会话 ID——端点强制要求（缺失即 400），用于路由与 prompt cache。 */
  private readonly sessionId: string;
  private readonly request: PublicJsonRequester;
  private readonly streamRequest: PublicStreamingRequester;
  private readonly platformOptions: PlatformOptions | undefined;
  /** 平台覆盖的最大输出 token（默认模型的 128K）。 */
  private readonly maxOutputTokens: number;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    visionModel?: string;
    request?: PublicJsonRequester;
    streamRequest?: PublicStreamingRequester;
    /** 显式会话 ID（默认每个实例生成一个 UUID）。 */
    sessionId?: string;
    platformOptions?: PlatformOptions;
  }) {
    this.apiKey = options.apiKey;
    this.modelId = options.model;
    this.visionModelId = options.visionModel ?? options.model;
    this.endpoint = resolveOpenCodeGoEndpoint(options.baseUrl);
    this.sessionId = options.sessionId ?? randomUUID();
    this.request = options.request ?? postJsonToPublicEndpoint;
    this.streamRequest = options.streamRequest ?? postSseToPublicEndpoint;
    this.platformOptions = options.platformOptions;
    this.maxOutputTokens = options.platformOptions?.maxOutputTokens
      ?? OPENCODE_GO_MAX_OUTPUT_TOKENS;
  }

  /**
   * reasoning 档位。
   *
   * 各模型支持范围不同（muse-spark 不支持 none、gpt-5.6-luna 不支持 minimal），
   * 因此平台显式配置的 reasoningEffort 优先于本函数的启发式映射——只有平台
   * 配置知道目标模型接受哪些档位。
   *
   * 缺省回退语义：disableThinking → minimal（该模型能关到的最低档），
   * enableThinking → high，都不设则不下发该字段用网关默认。
   */
  private reasoningField(perCallDisableThinking: boolean): Record<string, unknown> {
    const explicit = this.platformOptions?.reasoningEffort;
    if (explicit) {
      return { reasoning: { effort: explicit } };
    }
    if (perCallDisableThinking || (this.platformOptions?.disableThinking ?? false)) {
      return { reasoning: { effort: "minimal" } };
    }
    if (this.platformOptions?.enableThinking) {
      return { reasoning: { effort: "high" } };
    }
    return {};
  }

  private headers(stream: boolean): Record<string, string> {
    return {
      Accept: stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": USER_AGENT,
      "x-opencode-session": this.sessionId,
    };
  }

  /** 2xx 但 status="failed" 的响应体 → 抛错（含隐私安全的错误码）。 */
  private throwIfResponseFailed(body: unknown, model: string): void {
    const record = asRecord(body);
    if (record?.status !== "failed") return;
    const error = asRecord(record.error);
    const detail = typeof error?.message === "string"
      ? `: ${error.message.slice(0, 200)}`
      : "";
    throw new Error(`${this.id} response failed (${model})${detail}`);
  }

  async chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    if (signal?.aborted) throw abortError(signal, "before request");
    const model = options.model ?? this.modelId;
    const { instructions, input } = buildChatInput(messages);
    const body: Record<string, unknown> = {
      model,
      input,
      temperature: options.temperature ?? 0.2,
      stream: false,
      ...(instructions ? { instructions } : {}),
      ...(options.responseFormat === "text"
        ? {}
        : { text: { format: { type: "json_object" as const } } }),
      ...this.reasoningField(options.disableThinking ?? false),
    };
    if (!(this.platformOptions?.disableMaxTokens ?? false)) {
      body.max_output_tokens = Math.min(options.maxTokens ?? 4096, this.maxOutputTokens);
    }
    const response = await this.request(this.endpoint, this.headers(false), body, signal);
    if (signal?.aborted) throw abortError(signal, "after response");
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderRequestError({
        provider: this.id,
        status: response.status,
        providerCode: readOpenCodeGoErrorCode(response.body),
      });
    }
    this.throwIfResponseFailed(response.body, model);
    const content = readResponsesText(response.body);
    if (content === null) {
      throw new Error(`${this.id} returned empty output (${model})`);
    }
    return {
      content,
      usage: readResponsesUsage(response.body)
        ?? { totalTokens: null, promptTokens: null, completionTokens: null, requestId: null },
    };
  }

  /**
   * 真实流式：`stream: true` + Responses SSE。
   * 文本增量为 `response.output_text.delta`（data.delta），
   * `response.completed` 结束；reasoning 增量不下发（不进入用户可见文本）。
   */
  async chatCompletionStream(
    messages: ChatMessage[],
    options: ChatOptions,
    signal: AbortSignal | undefined,
    onDelta: (deltaText: string) => void,
  ): Promise<{ content: string }> {
    if (signal?.aborted) throw abortError(signal, "before request");
    const model = options.model ?? this.modelId;
    const { instructions, input } = buildChatInput(messages);
    const body: Record<string, unknown> = {
      model,
      input,
      temperature: options.temperature ?? 0.2,
      stream: true,
      ...(instructions ? { instructions } : {}),
      ...(options.responseFormat === "text"
        ? {}
        : { text: { format: { type: "json_object" as const } } }),
      ...this.reasoningField(options.disableThinking ?? false),
    };
    if (!(this.platformOptions?.disableMaxTokens ?? false)) {
      body.max_output_tokens = Math.min(options.maxTokens ?? 4096, this.maxOutputTokens);
    }
    const response = await this.streamRequest(this.endpoint, this.headers(true), body, signal);
    if (signal?.aborted) {
      response.cancel();
      throw abortError(signal, "after response");
    }
    if (response.status < 200 || response.status >= 300) {
      let providerCode: string | undefined;
      try {
        const raw = await readStreamingBodyText(response.body);
        providerCode = readOpenCodeGoErrorCode(raw ? JSON.parse(raw) : null);
      } catch {
        // 非 JSON 错误体：保留原始状态码即可
      }
      throw new ProviderRequestError({ provider: this.id, status: response.status, providerCode });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let responseBytes = 0;
    let providerError: string | null = null;
    /** 终止事件/断流后的统一收尾：先抛 provider 错误，再拒绝空输出。 */
    const settle = (): void => {
      response.cancel();
      if (providerError) throw new Error(`${this.id} stream failed (${model}): ${providerError}`);
      if (!content.trim()) throw new Error(`${this.id} returned empty streaming output (${model})`);
    };
    const consumeData = (data: string): boolean => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return false; // 忽略无法解析的 SSE 行（部分网关会插入空行/注释）
      }
      switch (parsed.type) {
        case "response.output_text.delta": {
          const delta = parsed.delta;
          if (typeof delta === "string" && delta.length > 0) {
            content += delta;
            onDelta(delta);
          }
          return false;
        }
        case "response.completed":
          return true;
        case "response.failed":
        case "response.incomplete": {
          const error = asRecord(asRecord(parsed.response)?.error) ?? asRecord(parsed.error);
          providerError = typeof error?.message === "string"
            ? error.message.slice(0, 200)
            : String(parsed.type);
          return true;
        }
        case "error": {
          providerError = typeof parsed.message === "string"
            ? parsed.message.slice(0, 200)
            : "stream error";
          return true;
        }
        default:
          return false;
      }
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
        // 避免每行都 slice 造成 O(n²) 复制（与 openai-compatible 流式实现一致）。
        let lineEnd: number;
        let consumed = 0;
        while ((lineEnd = buffer.indexOf("\n", consumed)) !== -1) {
          const line = buffer.slice(consumed, lineEnd).replace(/\r$/, "");
          consumed = lineEnd + 1;
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          if (consumeData(trimmed.slice(5).trim())) {
            settle();
            return { content };
          }
        }
        buffer = buffer.slice(consumed);
      }
      // 部分网关在最后一个事件后不再补换行，或用 [DONE] 直接断流：
      // flush 解码器并解析残留的完整 data 行，而不是丢掉最后一个事件。
      buffer += decoder.decode();
      const trailing = buffer.trim();
      if (trailing.startsWith("data:")) consumeData(trailing.slice(5).trim());
    } finally {
      signal?.removeEventListener("abort", abortListener);
    }
    if (signal?.aborted) throw abortError(signal, "after stream");
    // 断流（无终止事件）时以已累积文本收尾，而不是丢弃整轮输出。
    settle();
    return { content };
  }

  /**
   * Agent turn（native tools）。
   *
   * Responses API 用 `tools[].{type:"function",name,parameters}`（扁平，无
   * `function` 包装层），无工具时回退 `text.format = json_object`。
   * 一次 attempt 最多一次 provider 请求。
   */
  async executeAgentTurn(
    request: AgentTurnRequest,
    signal?: AbortSignal,
  ): Promise<AgentTurnResult> {
    if (signal?.aborted) throw abortError(signal, "before executeAgentTurn");
    const model = request.model ?? this.modelId;
    const { instructions, input } = buildAgentTurnInput(request.systemPrompt, request.messages);
    const hasTools = request.tools.length > 0;
    const body: Record<string, unknown> = {
      model,
      input,
      temperature: request.temperature,
      ...(instructions ? { instructions } : {}),
      ...this.reasoningField(false),
    };
    if (!(this.platformOptions?.disableMaxTokens ?? false)) {
      body.max_output_tokens = Math.min(request.maxTokens, this.maxOutputTokens);
    }
    if (hasTools) {
      body.tools = request.tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      body.tool_choice = "auto";
    } else {
      body.text = { format: { type: "json_object" as const } };
    }

    const response = await this.request(this.endpoint, this.headers(false), body, signal);
    if (signal?.aborted) throw abortError(signal, "after agent turn response");
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderRequestError({
        provider: this.id,
        status: response.status,
        providerCode: readOpenCodeGoErrorCode(response.body),
      });
    }
    this.throwIfResponseFailed(response.body, model);
    if (signal?.aborted) throw abortError(signal, "after agent turn body read");

    const { content, toolCalls, finishReason, requestId } =
      parseResponsesAgentTurn(response.body, hasTools);
    const reasoningHandles = readResponsesReasoningHandles(response.body);

    // 输出截断 / 参数损坏检测（与 chat/completions 路径同一套非重试语义）：
    // finish_reason="length" 与 arguments 损坏都是确定性失败，重投只会空转，
    // 必须抛 AgentOutputError 让队列直接标记 dead。
    if (finishReason === "length") {
      throw new AgentOutputError(
        "output_truncated",
        `agent output truncated at max_output_tokens `
        + `(toolCalls=${toolCalls.length}, malformed=${toolCalls.filter((tc) => tc.argumentsMalformed).length})`,
      );
    }
    const malformed = toolCalls.find((tc) => tc.argumentsMalformed);
    if (malformed) {
      throw new AgentOutputError(
        "arguments_malformed",
        `tool call "${malformed.name}" has malformed arguments JSON (id=${malformed.id || "unknown"})`,
      );
    }

    return {
      content,
      toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      finishReason,
      // 思考模式下部分模型（deepseek）要求下一轮把 reasoning 原样回传，
      // 否则工具循环第二步 400；调用方负责把它挂回 assistant 消息。
      ...(reasoningHandles.length > 0 ? { reasoning: reasoningHandles } : {}),
      usage: readResponsesUsage(response.body),
      providerRequestId: requestId,
    };
  }

  /**
   * 能力快照：muse-spark-1.3-contributor = 1,048,576 上下文 / 131,072 输出，
   * 可被平台配置的 contextWindowTokens / maxOutputTokens 覆盖。
   */
  getCapabilities(): ProviderCapability {
    const contextWindowTokens = this.platformOptions?.contextWindowTokens
      ?? OPENCODE_GO_CONTEXT_WINDOW_TOKENS;
    const reservedOutputTokens = this.maxOutputTokens;
    return {
      providerId: this.id,
      modelId: this.modelId,
      visionModelId: this.visionModelId,
      toolMode: "native_tools",
      contextWindowTokens,
      reservedOutputTokens,
      maxInputTokens: contextWindowTokens - reservedOutputTokens,
      maxOutputTokens: this.maxOutputTokens,
      fingerprint: `${this.id}:${this.modelId}:${this.visionModelId}:native_tools`,
    };
  }
}

async function readStreamingBodyText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > 1024 * 1024) throw new Error("OpenCode Go error response exceeded 1048576 bytes");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

// ─── R2: Factory registration ───────────────────────────────────────────

function createOpenCodeGoProvider(config: ProviderRuntimeConfig): OpenCodeGoProvider | null {
  const apiKey = config.apiKey;
  if (!apiKey) return null;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_PATH;
  const model = config.model ?? "muse-spark-1.3-contributor";
  return new OpenCodeGoProvider({
    apiKey,
    baseUrl,
    model,
    ...(config.visionModel ? { visionModel: config.visionModel } : {}),
    ...(config.options ? { platformOptions: config.options } : {}),
  });
}

registerFactory("opencode_go", "agent_turn", (config) => {
  const provider = createOpenCodeGoProvider(config);
  return provider ? provider as unknown as CapabilityImpl : null;
});
