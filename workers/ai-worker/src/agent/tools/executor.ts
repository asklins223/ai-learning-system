/**
 * Tool 执行器核心（计划 §6, §16.1）
 *
 * 统一分发 Agent tool calls 到对应工具模块。
 * 幂等执行，权限校验，事件记录。
 *
 * 不变量（§5.3, §6.4, §6.5）：
 * - 一次 toolCallId 最多执行一次副作用
 * - 按 role allowlist 验证权限
 * - 禁止任意 SQL/HTTP/shell/文件系统
 */

import { and, eq } from "drizzle-orm";
import type { AgentRole } from "@ailearn/shared";
import { toolRegistry, computeToolIdempotencyKey, computeArgsHash, getToolZodSchema } from "../tool-registry.ts";
import { db } from "../../db.ts";
import * as schema from "../../schema/index.ts";
import { logger } from "../../lib/logger.ts";
import type { BudgetTracker } from "../budget.ts";
import type { CoverageLedger } from "../coverage-ledger.ts";
import type { CandidateLedger } from "../candidate-ledger.ts";
import { executeManifestTool } from "./manifest.ts";
import { executeDelegationTool } from "./delegation.ts";
import { executeEvidenceTool, type EvidenceEmbeddingProvider } from "./evidence.ts";
import type { RerankProvider } from "../reranker.ts";
import { executeCandidateLedgerTool } from "./candidate-ledger.ts";
import { executeDeckDraftTool } from "./deck-draft.ts";
import { executeQualityTool } from "./quality.ts";

/**
 * PERF-10 修复：进程级幂等缓存。
 *
 * 原代码每次工具调用都查询 DB 检查幂等性，即使该工具在本进程内刚执行过。
 * 此 Set 缓存本进程已执行过的 idempotencyKey，命中时跳过 DB 查询。
 *
 * 安全性说明：
 * - 缓存仅作为性能优化，不替代 DB 幂等检查
 * - 进程重启后缓存为空，自动回退到 DB 查询（支持崩溃恢复）
 * - onConflictDoNothing 保证 DB 层面的幂等性不受影响
 * - 缓存大小有限（最多 5000 条），防止内存无限增长
 */
const executedToolCache = new Set<string>();
const EXECUTED_TOOL_CACHE_MAX = 5000;

/** 将已执行的 key 加入缓存，在缓存满时淘汰旧数据 */
function markExecuted(key: string): void {
  if (executedToolCache.size >= EXECUTED_TOOL_CACHE_MAX) {
    // 简单淘汰策略：清空一半缓存。仅在极端情况（单进程执行 5000+ 工具调用）触发。
    const halfSize = Math.floor(EXECUTED_TOOL_CACHE_MAX / 2);
    let count = 0;
    for (const k of executedToolCache) {
      executedToolCache.delete(k);
      if (++count >= halfSize) break;
    }
  }
  executedToolCache.add(key);
}

/** 工具执行上下文 */
export interface ToolExecutionContext {
  runId: string;
  workspaceId: string;
  noteVersionId: string;
  noteId: string;
  agentUnitId: string;
  turnNo: number;
  role: AgentRole;
  budgetTracker: BudgetTracker;
  coverageLedger: CoverageLedger;
  candidateLedger: CandidateLedger;
  requestedBy: string;
  signal?: AbortSignal;
  /** 可选：向量模型，用于生成查询向量进行语义搜索（§W3） */
  embeddingProvider?: EvidenceEmbeddingProvider;
  /** 可选：重排序模型（BAAI/bge-reranker-v2-m3），用于精排检索候选 */
  rerankProvider?: RerankProvider;
}

/** 工具调用请求 */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 工具执行结果 */
export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  result: unknown;
  error?: string;
}

/**
 * 执行一个工具调用。
 *
 * 1. 验证权限（role allowlist）
 * 2. 检查幂等（是否已执行过）
 * 3. 预留 tool call 预算
 * 4. 分发到对应工具模块
 * 5. 记录事件
 * 6. 返回结果
 */
export async function executeToolCall(
  call: ToolCallRequest,
  ctx: ToolExecutionContext,
): Promise<ToolCallResult> {
  const { role, runId, agentUnitId, turnNo } = ctx;

  // 1. 权限验证
  if (!toolRegistry.isToolAllowed(role, call.name)) {
    logger.warn(
      { runId, role, toolName: call.name, toolCallId: call.id },
      "Tool 权限拒绝：角色不允许使用此工具",
    );
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `permission_denied: role ${role} cannot use tool ${call.name}`,
    };
  }

  // 2. 参数 schema 校验（P1-07 修复：副作用前 safeParse）
  // 从 tool-registry 获取 Zod schema 并验证参数
  const zodSchema = getToolZodSchema(call.name);
  if (zodSchema) {
    const parseResult = zodSchema.safeParse(call.arguments);
    if (!parseResult.success) {
      const errorDetails = parseResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      logger.warn(
        { runId, role, toolName: call.name, toolCallId: call.id, error: errorDetails },
        "Tool 参数 schema 校验失败",
      );
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `protocol_validation_error: ${errorDetails}`,
      };
    }
    // 使用校验后的参数（含默认值填充）替换原始参数
    call = { ...call, arguments: parseResult.data as Record<string, unknown> };
  }

  // 3. 幂等检查
  // PERF-53 设计说明：幂等检查需要 1 次 DB SELECT 查询（tool_result 存在性检查）。
  // 后续的 tool_request INSERT 是审计事件记录，不是幂等检查的一部分。
  // 合并 SELECT 和 INSERT 为单次操作（如 INSERT...ON CONFLICT DO NOTHING...RETURNING）
  // 理论上可行，但会改变语义：tool_request 存在但 tool_result 不存在时（前次中断），
  // 当前设计允许重新执行工具，合并后则需要额外查询区分"已完成"和"已中断"。
  // 考虑到 PERF-10 内存缓存已覆盖常见路径（同进程内重复调用跳过 DB 查询），
  // 此处的 DB SELECT 仅在进程重启/崩溃恢复时执行，频率极低，优化收益有限。
  const argsHash = computeArgsHash(call.arguments);
  const idempotencyKey = computeToolIdempotencyKey({
    runId,
    agentUnitId,
    turnNo,
    toolCallId: call.id,
    toolName: call.name,
    argsHash,
  });

  // 4. 幂等检查：先查内存缓存，命中则跳过 DB 查询
  if (executedToolCache.has(idempotencyKey)) {
    logger.debug(
      { runId, toolName: call.name, toolCallId: call.id },
      "Tool 幂等命中（内存缓存），跳过执行",
    );
    // P1-12 修复：幂等命中时重放原始 typed result，而非返回通用 message。
    // 从 DB 加载原始 tool_result 事件中的完整结果。
    const [cachedResult] = await db
      .select({ safePayload: schema.cardGenerationAgentEvents.safePayload })
      .from(schema.cardGenerationAgentEvents)
      .where(and(
        eq(schema.cardGenerationAgentEvents.runId, runId),
        eq(schema.cardGenerationAgentEvents.eventKey, `tool_result:${idempotencyKey}`),
      ))
      .limit(1);

    if (cachedResult?.safePayload) {
      const payload = cachedResult.safePayload as Record<string, unknown>;
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: payload.success === true,
        result: payload.result ?? null,
        error: payload.error as string | undefined,
      };
    }
    // 如果 DB 中没有找到结果（极端情况），回退到通用 message
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: true,
      result: { idempotent: true, message: "tool already executed" },
    };
  }

  // 5. 内存缓存未命中，查询 DB（支持崩溃恢复场景）
  // P1-12 修复：加载完整的 tool_result safePayload，用于重放原始 typed result。
  const [existing] = await db
    .select({
      eventKey: schema.cardGenerationAgentEvents.eventKey,
      safePayload: schema.cardGenerationAgentEvents.safePayload,
    })
    .from(schema.cardGenerationAgentEvents)
    .where(and(
      eq(schema.cardGenerationAgentEvents.runId, runId),
      eq(schema.cardGenerationAgentEvents.eventKey, `tool_result:${idempotencyKey}`),
    ))
    .limit(1);

  if (existing) {
    logger.debug(
      { runId, toolName: call.name, toolCallId: call.id },
      "Tool 幂等命中，重放原始结果",
    );
    // P1-12 修复：重放原始 typed result 及成功/失败状态。
    // 原代码只返回 { idempotent: true, message: "tool already executed" }，
    // 导致崩溃恢复后重放的工具调用无法获得原始结果数据，
    // Supervisor 可能做出错误决策。
    const payload = (existing.safePayload as Record<string, unknown>) ?? {};
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: payload.success === true,
      result: payload.result ?? null,
      error: payload.error as string | undefined,
    };
  }

  // 6. 预留 tool call 预算
  try {
    ctx.budgetTracker.reserveToolCall(role);
  } catch (err) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 7. 记录 tool request 事件
  await db.insert(schema.cardGenerationAgentEvents).values({
    workspaceId: ctx.workspaceId,
    runId,
    unitId: agentUnitId,
    eventKey: `tool_request:${idempotencyKey}`,
    eventType: "tool_request",
    agentRole: role,
    turnNo,
    toolName: call.name,
    inputHash: argsHash,
    safePayload: { args: sanitizeArgs(call.arguments) },
  }).onConflictDoNothing();

  // 8. 分发到对应工具模块
  let result: ToolCallResult;
  try {
    const toolCtx = {
      ...ctx,
      idempotencyKey,
    };

    if (isManifestTool(call.name)) {
      result = await executeManifestTool(call, toolCtx);
    } else if (isDelegationTool(call.name)) {
      result = await executeDelegationTool(call, toolCtx);
    } else if (isEvidenceTool(call.name)) {
      result = await executeEvidenceTool(call, toolCtx);
    } else if (isCandidateLedgerTool(call.name)) {
      result = await executeCandidateLedgerTool(call, toolCtx);
    } else if (isDeckDraftTool(call.name)) {
      result = await executeDeckDraftTool(call, toolCtx);
    } else if (isQualityTool(call.name)) {
      result = await executeQualityTool(call, toolCtx);
    } else {
      result = {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `unknown_tool: ${call.name}`,
      };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { runId, toolName: call.name, toolCallId: call.id, error: errorMsg },
      "Tool 执行失败",
    );
    result = {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: errorMsg,
    };
  }

  // 9. 记录 tool result 事件
  // BUG-57/86 修复：outputHash 应基于 sanitized 数据计算，
  // 与 safePayload 中存储的数据保持一致，确保审计事件的哈希
  // 可用于验证 safePayload 的完整性。
  const sanitizedResult = result.success ? sanitizeArgs(result.result) : null;
  await db.insert(schema.cardGenerationAgentEvents).values({
    workspaceId: ctx.workspaceId,
    runId,
    unitId: agentUnitId,
    eventKey: `tool_result:${idempotencyKey}`,
    eventType: "tool_result",
    agentRole: role,
    turnNo,
    toolName: call.name,
    inputHash: argsHash,
    outputHash: result.success ? computeArgsHash(sanitizedResult) : null,
    safePayload: {
      success: result.success,
      result: sanitizedResult,
      error: result.error ?? null,
    },
    errorCode: result.success ? null : (result.error ?? "tool_error"),
  }).onConflictDoNothing();

  // PERF-10 优化：将已执行的 key 加入内存缓存
  markExecuted(idempotencyKey);

  return result;
}

/** 批量执行工具调用 */
export async function executeToolCalls(
  calls: ToolCallRequest[],
  ctx: ToolExecutionContext,
): Promise<ToolCallResult[]> {
  // PERF-09: 原代码对所有工具调用串行 await，导致 N 个独立调用延迟线性叠加。
  // 优化策略：如果所有调用都是只读工具（hasSideEffect: false），则并行执行。
  // 如果有任何带副作用的工具，保持串行执行以保留顺序语义。
  const allReadOnly = calls.every(
    (call) => toolRegistry.getToolDefinition(ctx.role, call.name)?.hasSideEffect === false,
  );

  if (allReadOnly && calls.length > 1) {
    // 并行执行只读工具调用
    return Promise.all(calls.map((call) => executeToolCall(call, ctx)));
  }

  // 串行执行（有副作用或只有一个调用）
  const results: ToolCallResult[] = [];
  for (const call of calls) {
    const result = await executeToolCall(call, ctx);
    results.push(result);
  }
  return results;
}

// ─── 工具分类辅助 ──────────────────────────────────────────────────────────

function isManifestTool(name: string): boolean {
  return ["get_run_manifest", "get_next_unassigned_bundles"].includes(name);
}

function isDelegationTool(name: string): boolean {
  return ["delegate_specialist", "read_agent_task_results"].includes(name);
}

function isEvidenceTool(name: string): boolean {
  return ["ensure_semantic_index", "search_related_evidence"].includes(name);
}

function isCandidateLedgerTool(name: string): boolean {
  return ["read_candidate_ledger", "apply_candidate_operations"].includes(name);
}

function isDeckDraftTool(name: string): boolean {
  return ["submit_deck_draft", "apply_draft_patch", "validate_draft"].includes(name);
}

function isQualityTool(name: string): boolean {
  return [
    "request_grounding_review",
    "read_quality_report",
    "request_repair",
    "request_verification",
  ].includes(name);
}

/**
 * 清理工具参数，去除敏感信息。
 * QUAL-52/64 修复：原代码只截断顶层字符串值，嵌套对象/数组中的长字符串不会被截断。
 * 现在递归遍历嵌套结构，对所有层级的字符串值进行截断。
 * P1-13 修复：增加 PII/secret/content redaction。
 */
function sanitizeArgs(args: unknown): Record<string, unknown> {
  return sanitizeValue(args) as Record<string, unknown>;
}

/** 需要脱敏的 key 模式（不区分大小写） */
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /credential/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /authorization/i,
  /cookie/i,
  /session[_-]?id/i,
];

/** 检查 key 是否敏感 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** 递归清理值：截断长字符串，递归处理对象和数组，脱敏敏感字段 */
function sanitizeValue(value: unknown, key?: string): unknown {
  // P1-13 修复：敏感 key 的值直接脱敏
  if (key && isSensitiveKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    // QUAL-52/64: 对所有层级的字符串进行截断，防止审计事件中包含过长的文本
    return value.length > 500
      ? `${value.slice(0, 100)}...(truncated, len=${value.length})`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, key));
  }
  if (value !== null && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value)) {
      safe[k] = sanitizeValue(val, k);
    }
    return safe;
  }
  return value;
}
