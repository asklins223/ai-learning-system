/**
 * 完整请求预算打包器（计划 §8.3, §W3）
 *
 * 职责：
 * - 计算每次 Agent turn 调用的完整 token 预算
 * - 超 context 时自动分页、压缩或拆 task
 * - 不只统计 source text，也不等 Provider 报错后再补救
 *
 * 完整请求预算（计划 §8.3）：
 *   system prompt
 *   + role policy
 *   + tool schemas
 *   + manifest/ledger/task summary
 *   + selected evidence/candidates
 *   + reserved output
 *
 * 不变量（§8.3）：
 * - 超 context 必须在调用前分页、压缩或拆 task
 * - 不能只统计 source text
 * - 不能等 Provider 报错后再补救
 */

import type { AgentTurnRequest } from "@ailearn/shared";
import { logger } from "../lib/logger.ts";

// ─── P1-08/09: 请求级 Token Hard Check ──────────────────────────────────

/**
 * 输入超出上下文窗口错误。
 *
 * P1-08 解决方案 #3：禁止截断 primary evidence 或 JSON；
 * 无法装入时返回 `input_over_context`。
 *
 * P1-09 解决方案 #1：在 provider 调用前按最终序列化 request 重新计数，
 * `inputTokens + maxTokens > contextWindow - safety` 时禁止发送。
 *
 * 此错误在 AgentRuntime.executeTurn 中抛出，
 * 由上层 handler 捕获并转换为 `needs_attention` 状态。
 */
export class InputOverContextError extends Error {
  readonly code = "input_over_context" as const;
  readonly contextWindowTokens: number;
  readonly safetyMarginTokens: number;
  readonly maxOutputTokens: number;
  readonly serializedInputTokens: number;
  readonly totalRequestTokens: number;
  readonly role: string;

  constructor(params: {
    role: string;
    contextWindowTokens: number;
    safetyMarginTokens: number;
    maxOutputTokens: number;
    serializedInputTokens: number;
  }) {
    const total = params.serializedInputTokens + params.maxOutputTokens;
    const limit = params.contextWindowTokens - params.safetyMarginTokens;
    super(
      `input_over_context: ${params.role} 请求总 token (${total}) `
      + `超出 contextWindow - safety (${limit})。`
      + ` input=${params.serializedInputTokens},`
      + ` maxOutput=${params.maxOutputTokens},`
      + ` contextWindow=${params.contextWindowTokens},`
      + ` safety=${params.safetyMarginTokens}`,
    );
    this.name = "InputOverContextError";
    this.role = params.role;
    this.contextWindowTokens = params.contextWindowTokens;
    this.safetyMarginTokens = params.safetyMarginTokens;
    this.maxOutputTokens = params.maxOutputTokens;
    this.serializedInputTokens = params.serializedInputTokens;
    this.totalRequestTokens = total;
  }
}

/**
 * 请求级 Token Hard Check 结果。
 */
export interface RequestTokenCheckResult {
  /** 是否通过（true = 可以发送，false = 超限） */
  passed: boolean;
  /** 序列化后的 system prompt token 估算 */
  systemPromptTokens: number;
  /** 序列化后的 messages token 估算 */
  messagesTokens: number;
  /** 序列化后的 tool schemas token 估算 */
  toolSchemaTokens: number;
  /** 序列化后的总输入 token */
  serializedInputTokens: number;
  /** 请求的 maxOutputTokens */
  maxOutputTokens: number;
  /** 总请求 token（input + maxOutput） */
  totalRequestTokens: number;
  /** 允许的最大 token（contextWindow - safety） */
  allowedTotal: number;
}

/**
 * 对最终序列化的 Agent turn 请求执行 Token Hard Check。
 *
 * P1-09 解决方案 #1（计划 §8.3）：
 *   在 provider 调用前按最终序列化 request 重新计数，
 *   `inputTokens + maxTokens > contextWindow - safety` 时禁止发送。
 *
 * 统一公式：
 *   usableInput = contextWindow - safetyMargin - actualRequestedMaxOutput
 *   serializedInput = systemPrompt + messages + toolSchemas
 *   通过条件：serializedInput <= usableInput
 *
 * @param request    最终的 AgentTurnRequest
 * @param capability Provider 能力快照（contextWindow, safetyMargin）
 * @returns 检查结果。passed=false 时应抛出 InputOverContextError。
 */

/**
 * 将 ChatMessage.content（string 或 text/image_url 内容块数组）规整为用于 token 估算的文本。
 * 图片块只计入 URL 长度（不含实际图像内容），与现有估算口径一致。
 */
function contentToText(content: string | Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
>): string {
  if (typeof content === "string") return content;
  return content.map((block) => block.type === "text" ? block.text : `[image:${block.image_url.url}]`).join(" ");
}

export function checkRequestTokenBudget(
  request: AgentTurnRequest,
  capability: {
    contextWindowTokens: number;
    safetyMarginTokens: number;
  },
): RequestTokenCheckResult {
  // 序列化 system prompt
  const systemPromptTokens = estimateTokens(request.systemPrompt);

  // 序列化 messages
  // 迁移遗漏修复：msg.content 可能是 text/image_url 内容块数组，需先规整为文本再估算。
  const messagesTokens = request.messages.reduce(
    (sum, msg) => sum + estimateTokens(contentToText(msg.content)) + 4, // +4 per message for role/structure overhead
    0,
  );

  // 序列化 tool schemas
  const toolSchemaTokens = Math.max(
    1_024,
    estimateJsonTokens(request.tools),
  );

  const serializedInputTokens = systemPromptTokens + messagesTokens + toolSchemaTokens;
  const maxOutputTokens = request.maxTokens;
  const totalRequestTokens = serializedInputTokens + maxOutputTokens;
  const allowedTotal = capability.contextWindowTokens - capability.safetyMarginTokens;

  const passed = totalRequestTokens <= allowedTotal;

  return {
    passed,
    systemPromptTokens,
    messagesTokens,
    toolSchemaTokens,
    serializedInputTokens,
    maxOutputTokens,
    totalRequestTokens,
    allowedTotal,
  };
}

/**
 * 执行请求级 Token Hard Check，超限时抛出 InputOverContextError。
 *
 * P1-09：在 AgentRuntime.executeTurn 中调用，
 * 确保不会向 Provider 发送超出 context window 的请求。
 *
 * 不变量：
 * - over-context provider request = 0
 * - 不等 Provider 报错后再补救
 * - 在 provider 调用前执行
 */
export function enforceRequestTokenBudget(
  request: AgentTurnRequest,
  capability: {
    contextWindowTokens: number;
    safetyMarginTokens: number;
  },
): void {
  const result = checkRequestTokenBudget(request, capability);

  if (!result.passed) {
    logger.warn(
      {
        role: request.role,
        serializedInputTokens: result.serializedInputTokens,
        maxOutputTokens: result.maxOutputTokens,
        totalRequestTokens: result.totalRequestTokens,
        allowedTotal: result.allowedTotal,
        contextWindowTokens: capability.contextWindowTokens,
        safetyMarginTokens: capability.safetyMarginTokens,
        systemPromptTokens: result.systemPromptTokens,
        messagesTokens: result.messagesTokens,
        toolSchemaTokens: result.toolSchemaTokens,
      },
      "请求级 Token Hard Check 失败：请求超出 context window",
    );

    throw new InputOverContextError({
      role: request.role,
      contextWindowTokens: capability.contextWindowTokens,
      safetyMarginTokens: capability.safetyMarginTokens,
      maxOutputTokens: result.maxOutputTokens,
      serializedInputTokens: result.serializedInputTokens,
    });
  }
}

/** 请求预算估算结果 */
export interface RequestBudgetEstimate {
  /** system prompt token 估算 */
  systemPromptTokens: number;
  /** role policy token 估算 */
  rolePolicyTokens: number;
  /** tool schemas token 估算 */
  toolSchemaTokens: number;
  /** manifest/ledger/task summary token 估算 */
  contextSummaryTokens: number;
  /** selected evidence/candidates token 估算 */
  evidenceTokens: number;
  /** reserved output token */
  reservedOutputTokens: number;
  /** 总 token 估算 */
  totalTokens: number;
  /** provider context window */
  contextWindowTokens: number;
  /** 安全余量 */
  safetyMarginTokens: number;
  /** 可用 token（context - safety - reserved output） */
  availableTokens: number;
  /** 是否超出 context window */
  exceedsContext: boolean;
  /** 建议的分页/拆分策略 */
  packingStrategy: PackingStrategy;
}

/** 分页/拆分策略 */
export type PackingStrategy =
  | "fits"         // 完全放入
  | "paginate"     // 需要分页
  | "compress"     // 需要压缩上下文
  | "split_task";  // 需要拆分 task

/** 请求打包器配置 */
export interface RequestPackerConfig {
  /** Provider context window */
  contextWindowTokens: number;
  /** reserved output tokens */
  reservedOutputTokens: number;
  /** tool schema 开销估算 */
  schemaOverheadTokens: number;
  /** 安全余量 */
  safetyMarginTokens: number;
}

/** 默认配置 */
export const DEFAULT_PACKER_CONFIG: RequestPackerConfig = {
  contextWindowTokens: 32_768,
  reservedOutputTokens: 4_096,
  schemaOverheadTokens: 1_024,
  safetyMarginTokens: 2_048,
};

/**
 * 保守 token 估算：CJK 表意文字按 1.5 token/字，其他非 ASCII 按 1 token/字，ASCII 按 4 字符/token。
 *
 * 改进：
 * - CJK 统一字符表意文字（U+4E00-U+9FFF, U+3400-U+4DBF, U+20000-U+2A6DF）
 *   按每字符 1.5 token 估算（cl100k_base 通常 1-2 token/字，取偏保守值）
 * - 其他非 ASCII（emoji、组合字符等）按 1 token/字
 * - ASCII 按约 4 字符/token 估算
 * - JSON 结构字符（{}[],:" ）按更高密度估算（约 2 字符/token）
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  let nonAscii = 0;
  let jsonStruct = 0;

  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp <= 0x7f) {
      // ASCII: JSON 结构字符密度更高
      if (char === "{" || char === "}" || char === "[" || char === "]"
        || char === "," || char === ":" || char === '"') {
        jsonStruct += 1;
      } else {
        ascii += 1;
      }
    } else if (
      (cp >= 0x4e00 && cp <= 0x9fff)       // CJK 统一表意文字
      || (cp >= 0x3400 && cp <= 0x4dbf)    // CJK 扩展 A
      || (cp >= 0x20000 && cp <= 0x2a6df)  // CJK 扩展 B
      || (cp >= 0xf900 && cp <= 0xfaff)    // CJK 兼容表意文字
    ) {
      cjk += 1;
    } else {
      nonAscii += 1;
    }
  }

  return Math.max(
    1,
    Math.ceil(ascii / 4) + Math.ceil(cjk * 1.5) + nonAscii + Math.ceil(jsonStruct / 2),
  );
}

/**
 * 估算 JSON 序列化后的 token 数。
 */
export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value));
}

/**
 * 估算一次 Agent turn 的完整请求预算。
 *
 * 计算公式（计划 §8.3）：
 *   total = system + role_policy + tool_schemas + context_summary + evidence + reserved_output
 *
 * 如果 total > context_window - safety_margin，则需要分页、压缩或拆 task。
 */
export function estimateRequestBudget(params: {
  systemPrompt: string;
  rolePolicy: string;
  toolSchemas: AgentTurnRequest["tools"];
  contextSummary: string;
  evidenceContent: string;
  config: RequestPackerConfig;
}): RequestBudgetEstimate {
  const { systemPrompt, rolePolicy, toolSchemas, contextSummary, evidenceContent, config } = params;

  const systemPromptTokens = estimateTokens(systemPrompt);
  const rolePolicyTokens = estimateTokens(rolePolicy);
  const toolSchemaTokens = Math.max(
    config.schemaOverheadTokens,
    estimateJsonTokens(toolSchemas),
  );
  const contextSummaryTokens = estimateTokens(contextSummary);
  const evidenceTokens = estimateTokens(evidenceContent);
  const reservedOutputTokens = config.reservedOutputTokens;

  const totalTokens =
    systemPromptTokens +
    rolePolicyTokens +
    toolSchemaTokens +
    contextSummaryTokens +
    evidenceTokens +
    reservedOutputTokens;

  const availableTokens =
    config.contextWindowTokens - config.safetyMarginTokens - reservedOutputTokens;

  const exceedsContext = totalTokens > config.contextWindowTokens - config.safetyMarginTokens;

  // 确定打包策略
  let packingStrategy: PackingStrategy = "fits";
  if (exceedsContext) {
    // 如果是 evidence 太多，优先分页
    if (evidenceTokens > availableTokens * 0.5) {
      packingStrategy = "paginate";
    }
    // 如果是 context summary 太大，压缩
    else if (contextSummaryTokens > availableTokens * 0.3) {
      packingStrategy = "compress";
    }
    // 如果整体都太大，拆 task
    else {
      packingStrategy = "split_task";
    }
  }

  return {
    systemPromptTokens,
    rolePolicyTokens,
    toolSchemaTokens,
    contextSummaryTokens,
    evidenceTokens,
    reservedOutputTokens,
    totalTokens,
    contextWindowTokens: config.contextWindowTokens,
    safetyMarginTokens: config.safetyMarginTokens,
    availableTokens,
    exceedsContext,
    packingStrategy,
  };
}

/**
 * 将 evidence 列表分页，使每页 fit 在可用 token 预算内。
 *
 * 用于 Extractor 读取 assigned bundles 时的分页。
 */
export function paginateEvidence(
  evidence: Array<{ refId: string; content: string; tokenEstimate: number }>,
  availableTokens: number,
  overheadTokens: number = 0,
): Array<{
  page: number;
  items: Array<{ refId: string; content: string; tokenEstimate: number }>;
  tokenEstimate: number;
}> {
  const pages: Array<{
    page: number;
    items: Array<{ refId: string; content: string; tokenEstimate: number }>;
    tokenEstimate: number;
  }> = [];

  let currentItems: Array<{ refId: string; content: string; tokenEstimate: number }> = [];
  let currentTokens = overheadTokens;

  for (const ev of evidence) {
    if (
      currentItems.length > 0 &&
      currentTokens + ev.tokenEstimate > availableTokens
    ) {
      pages.push({
        page: pages.length,
        items: currentItems,
        tokenEstimate: currentTokens,
      });
      currentItems = [];
      currentTokens = overheadTokens;
    }
    currentItems.push(ev);
    currentTokens += ev.tokenEstimate;
  }

  if (currentItems.length > 0) {
    pages.push({
      page: pages.length,
      items: currentItems,
      tokenEstimate: currentTokens,
    });
  }

  return pages;
}

/**
 * 压缩上下文摘要：只保留 hash 和计数，不包含全文。
 *
 * 计划 §5.4：上下文压缩只允许删除已经持久化且可由 hash 重新读取的信息。
 * 系统 prompt、预算、未完成任务和 hard issues 永远保留。
 */
export function compressContextSummary(
  fullSummary: Record<string, unknown>,
  protectedKeys: string[] = ["budget", "pendingTasks", "hardIssues"],
): Record<string, unknown> {
  const compressed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fullSummary)) {
    if (protectedKeys.includes(key)) {
      compressed[key] = value;
    } else if (Array.isArray(value)) {
      // 只保留长度和 hash
      compressed[key] = {
        __compressed: true,
        count: value.length,
        hash: simpleHash(JSON.stringify(value)),
      };
    } else if (typeof value === "object" && value !== null) {
      compressed[key] = {
        __compressed: true,
        keys: Object.keys(value),
      };
    } else {
      compressed[key] = value;
    }
  }

  return compressed;
}

/**
 * 简单 hash 函数（非加密用途）。
 *
 * BUG-41 修复：原实现使用 `(hash << 5) - hash + char) | 0`，
 * 位或 `| 0` 将结果截断为 32 位有符号整数，可能产生负值。
 * 负数的 `toString(36)` 包含 `-` 前缀，导致哈希值不稳定且可能碰撞。
 * 修复：使用 `>>> 0` 无符号右移将结果转换为非负 32 位整数。
 */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 构建分页后的 Agent turn 请求。
 *
 * 当 evidence 超出单页预算时，生成多页请求序列。
 */
export function buildPaginatedRequests(
  baseRequest: Omit<AgentTurnRequest, "messages">,
  pages: Array<{
    items: Array<{ refId: string; content: string }>;
    tokenEstimate: number;
  }>,
): AgentTurnRequest[] {
  return pages.map((page, index) => ({
    ...baseRequest,
    messages: [
      {
        role: "user" as const,
        content: index === 0
          ? `分页 ${index + 1}/${pages.length}：\n${JSON.stringify(page.items)}`
          : `继续处理（分页 ${index + 1}/${pages.length}）：\n${JSON.stringify(page.items)}`,
      },
    ],
  }));
}
