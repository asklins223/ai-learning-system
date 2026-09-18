export type JsonRecord = Record<string, unknown>;

export function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function readString(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readProviderCode(value: unknown): string | number | undefined {
  const payload = asJsonRecord(value);
  const topLevelCode = payload?.code;
  if (typeof topLevelCode === "string" || typeof topLevelCode === "number") {
    return topLevelCode;
  }
  const nestedCode = asJsonRecord(payload?.error)?.code;
  return typeof nestedCode === "string" || typeof nestedCode === "number"
    ? nestedCode
    : undefined;
}

export function readProviderErrorMessage(value: unknown): string | undefined {
  const payload = asJsonRecord(value);
  const nestedMessage = readString(asJsonRecord(payload?.error), "message");
  return nestedMessage ?? readString(payload, "message");
}

export function readChatCompletionContent(value: unknown): string | undefined {
  const choices = asJsonRecord(value)?.choices;
  if (!Array.isArray(choices)) return undefined;
  const firstChoice = asJsonRecord(choices[0]);
  return readString(asJsonRecord(firstChoice?.message), "content");
}

// ─── v0.6: Provider Usage Extraction (计划 §6.6, §10.5) ──────────────────

/**
 * Extract token usage from an OpenAI-compatible chat completion response.
 *
 * Standard response shape:
 * {
 *   "usage": {
 *     "total_tokens": 1234,
 *     "prompt_tokens": 567,
 *     "completion_tokens": 667,
 *     "prompt_tokens_details": { "cached_tokens": 400 }
 *   },
 *   "id": "chatcmpl-xxx"
 * }
 *
 * B2（计划 §2.5）：同时解析 prompt cache 相关字段：
 * - OpenAI convention: usage.prompt_tokens_details.cached_tokens
 * - DashScope convention: usage.prompt_cache_hit_tokens / usage.prompt_cache_miss_tokens
 *
 * Returns null if no usage data is present.
 */
export function readUsage(value: unknown): {
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  requestId: string | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
} | null {
  const record = asJsonRecord(value);
  if (!record) return null;

  const usage = asJsonRecord(record.usage);
  if (!usage) return null;

  // 用户可配置的 openai-compatible 端点可能返回非法 usage（Infinity、浮点、
  // 负数）；这些值会流入 cost_tokens 的整数列并可能让整个发布事务失败。
  // 只接受非负安全整数。
  const asTokenCount = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const totalTokens = asTokenCount(usage.total_tokens);
  const promptTokens = asTokenCount(usage.prompt_tokens);
  const completionTokens = asTokenCount(usage.completion_tokens);

  // If none of the token fields are present, there's no usage data
  if (totalTokens === null && promptTokens === null && completionTokens === null) {
    return null;
  }

  // Derive total if only components are present
  const derivedTotal = totalTokens
    ?? (promptTokens !== null && completionTokens !== null
      ? promptTokens + completionTokens
      : null);

  const requestId = typeof record.id === "string" ? record.id : null;

  // B2: Parse prompt cache fields.
  // OpenAI convention: usage.prompt_tokens_details.cached_tokens
  // DashScope convention: usage.prompt_cache_hit_tokens / usage.prompt_cache_miss_tokens
  // Parse failure is silent (returns null) — does not block the request.
  const promptTokensDetails = asJsonRecord(usage.prompt_tokens_details);
  const cacheHitTokens =
    asTokenCount(promptTokensDetails?.cached_tokens)
    ?? asTokenCount(usage.prompt_cache_hit_tokens);
  const cacheMissTokens =
    asTokenCount(usage.prompt_cache_miss_tokens);

  return {
    totalTokens: derivedTotal,
    promptTokens,
    completionTokens,
    requestId,
    cacheHitTokens,
    cacheMissTokens,
  };
}

// ─── Shared JSON Extraction (QUAL-18: unified parseModelJson / safeParseJson) ──

/**
 * 从 `start`（必须指向 `{`）开始找匹配的闭合 `}` 下标；找不到返回 -1。
 * 正确处理字符串字面量与转义。
 */
function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
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
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 收集文本中所有**顶层**平衡的 JSON 对象（按出现顺序，已成功解析的）。 */
function collectBalancedJsonObjects(text: string): unknown[] {
  const parsed: unknown[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("{", index);
    if (start === -1) break;
    const end = findBalancedObjectEnd(text, start);
    if (end === -1) {
      index = start + 1;
      continue;
    }
    try {
      parsed.push(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // 该块不是合法 JSON（例如示例被截断）——继续尝试后续块。
    }
    index = end + 1;
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Tolerant JSON extraction from model output.
 *
 * Even with response_format: { type: "json_object" } some models may
 * occasionally wrap output in ```json fences or prefix prose. We strip
 * fences and find the first balanced JSON object as a fallback.
 *
 * QUAL-18: Previously duplicated as `parseModelJson` in openai-compatible.ts
 * and `safeParseJson` in dashscope.ts with identical logic but different
 * variable names. Now unified here.
 *
 * 2026-09-15（管线评审 L3）：此前括号匹配**只从第一个 `{` 开始**——模型在 JSON
 * 前输出含 `{` 的说明文本（如示例片段）时会截取到错误对象，随后 schema 校验
 * 失败并被判 retryable，白烧一轮重试。现在：
 * - 收集所有顶层平衡对象；
 * - 传入 `requiredKeys`（调用方知道期望键，如 planner 的 `atoms`）时，优先
 *   返回包含全部期望键的对象；无完全匹配时取命中键数最多者（并列取更靠后
 *   的对象——模型通常先给示例、后给正式答案）；
 * - 未传 `requiredKeys` 时保持原有语义（返回第一个平衡对象），不影响其它调用方。
 */
export function extractJsonFromText(raw: string, requiredKeys?: readonly string[]): unknown {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to bracket-matching
  }
  const candidates = collectBalancedJsonObjects(stripped);
  if (candidates.length === 0) {
    if (!stripped.includes("{")) {
      throw new Error("model returned no JSON object");
    }
    throw new Error("model returned malformed JSON");
  }
  if (requiredKeys && requiredKeys.length > 0) {
    let best: Record<string, unknown> | null = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const score = requiredKeys.filter((key) => key in candidate).length;
      // `>=`：并列时取更靠后的对象（示例在前、正式答案在后）。
      if (score >= bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best) return best;
  }
  return candidates[0];
}

// ─── Shared Agent Turn Tool Calls Parsing (QUAL-19 / BUG-09) ────────────────

/**
 * Parsed tool call from an OpenAI-compatible agent turn response.
 */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * arguments 原始 JSON 字符串解析失败（如输出被截断导致的不完整 JSON）。
   * 为 true 时 arguments 为空对象，调用方必须将其视为协议错误，
   * 禁止把"空参数工具调用"当作模型真实意图执行（截断修复）。
   */
  argumentsMalformed?: boolean;
  /** 解析失败时的原始 arguments 字符串（诊断用）。 */
  rawArguments?: string;
}

/**
 * Parse tool calls from an OpenAI-compatible chat completion response body.
 *
 * QUAL-19: Previously duplicated across OpenAI-compatible provider variants
 * with identical logic. Now unified.
 *
 * BUG-09 fix: The JSON mode fallback (parsing `content` as
 * `structured_action_v1`) is only attempted when no native tool_calls are
 * present in the response. This prevents duplicate tool call execution when
 * a provider returns both `message.tool_calls` and a JSON `content` body
 * containing the same tool calls.
 *
 * @param body    The parsed response body.
 * @param hasTools Whether the request was sent with tool definitions.
 * @param requestIdKeys Optional keys to check for the provider request ID
 *                      (e.g. ["id"] for OpenAI, ["request_id", "id"] for DashScope).
 */
export function parseAgentTurnToolCalls(
  body: Record<string, unknown>,
  hasTools: boolean,
  requestIdKeys: string[] = ["id"],
): {
  content: string | null;
  toolCalls: ParsedToolCall[];
  finishReason: string;
  requestId: string | null;
} {
  const choices = (body?.choices as Array<Record<string, unknown>>) ?? [];
  const choice = choices[0] ?? {};
  const message = (choice.message as Record<string, unknown>) ?? {};
  const content = typeof message.content === "string" ? message.content : null;

  // 1. Parse native tool_calls from message.tool_calls
  const rawToolCalls = (message.tool_calls as Array<Record<string, unknown>>) ?? [];
  const toolCalls: ParsedToolCall[] = rawToolCalls.map((tc: Record<string, unknown>) => {
    const fn = (tc.function ?? tc) as Record<string, unknown>;
    const id = String(tc.id ?? "");
    const name = String(fn.name ?? "");
    let args: Record<string, unknown> = {};
    let argumentsMalformed = false;
    let rawArguments: string | undefined;
    if (typeof fn.arguments === "string") {
      rawArguments = fn.arguments;
      try {
        args = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch {
        // 截断/损坏修复：解析失败时禁止静默降级为空对象。
        // 标记 argumentsMalformed，由上层（provider 层）升级为
        // AgentOutputError("arguments_malformed")，绝不当作正常调用执行。
        argumentsMalformed = true;
      }
    } else {
      args = (fn.arguments as Record<string, unknown>) ?? {};
    }
    return { id, name, arguments: args, argumentsMalformed, rawArguments };
  });

  const finishReason = String(choice.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"));

  // 2. JSON mode fallback: only when no native tool_calls were found.
  //    BUG-09: Previously this block ran whenever `!hasTools && content`,
  //    which caused duplicate tool calls when a provider returned both
  //    `message.tool_calls` and a JSON `content` body.
  if (!hasTools && toolCalls.length === 0 && content) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.toolCalls)) {
        for (const call of parsed.toolCalls) {
          // 与 native tool_calls 路径同等的健壮性：arguments 可能是 JSON 字符串
          // （OpenAI 风格）或已解析对象。字符串解析失败必须标记 argumentsMalformed，
          // 否则字符串会被当作对象传给 zod 校验，报出误导性的 schema 错误；
          // 由 provider 层升级为确定性的 arguments_malformed 失败。
          const rawArgs = call.arguments ?? {};
          let args: Record<string, unknown> = {};
          let argumentsMalformed = false;
          let rawArguments: string | undefined;
          if (typeof rawArgs === "string") {
            rawArguments = rawArgs;
            try {
              args = JSON.parse(rawArgs) as Record<string, unknown>;
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
            argumentsMalformed,
            rawArguments,
          });
        }
      }
    } catch {
      // content 不是有效 JSON，忽略
    }
  }

  // 3. Extract request ID from configured keys
  let requestId: string | null = null;
  for (const key of requestIdKeys) {
    const val = body?.[key];
    if (typeof val === "string") {
      requestId = val;
      break;
    }
  }

  return { content, toolCalls, finishReason, requestId };
}

// ─── Shared Agent Turn Messages Builder (PERF-09) ───────────────────────────

/**
 * 构建 executeAgentTurn 的 OpenAI-compatible messages 数组。
 *
 * PERF-09: 此前各 OpenAI-compatible provider 变体的 executeAgentTurn 中
 * 各自内联了完全相同的 messages 构建逻辑
 * （systemPrompt + 历史消息 + tool_call_id 映射）。
 * 现统一提取到此处，消除代码重复。
 *
 * @param systemPrompt Agent 系统策略 prompt
 * @param messages     上下文消息数组（来自 AgentTurnRequest.messages）
 * @returns OpenAI-compatible 格式的 messages 数组
 */
export function buildAgentTurnMessages(
  systemPrompt: string,
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
    >;
    toolCallId?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  }>,
): Array<{
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  >;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}> {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls ? {
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      } : {}),
    })),
  ];
}
