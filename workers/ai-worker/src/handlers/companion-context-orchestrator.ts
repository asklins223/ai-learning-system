/**
 * 真桌宠上下文装配（22-real-desktop-pet-memory-context-prd-tdd.md §3.4/§9.4）。
 *
 * Worker 侧在生成前调用：检索相关长期记忆 → 组装 memory_data 数据块 →
 * 记录 memory_usage_log / 更新 last_used_at。
 *
 * grounded_tutor 分支不注入任何长期记忆/人格闲聊内容（§11.1），防止污染正式学习。
 */

import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import type { EmbeddingProviderLike } from "./companion-memory-vector.ts";
import { retrieveCompanionMemories } from "./companion-memory-vector.ts";
import {
  companionMemoryRetrievalModeTotal,
  companionMemoryUsedCount,
} from "../lib/metrics.ts";

export interface ContextMemoryItem {
  memoryId: string;
  kind: string;
  content: string;
  importance: number;
  pinned: boolean;
  lastUsedAt: string | null;
  userConfirmed: boolean;
}

export interface ContextAssemblyResult {
  activeMemories: { kind: string; content: string }[];
  memoryRefs: { memoryId: string; kind: string; content: string }[];
  retrievalMode: "vector" | "keyword_fallback";
  usedMemoryIds: string[];
}

type Executor = { execute(query: unknown): Promise<unknown> };

const MEMORY_REF_MAX = 3;
const MEMORY_REF_CONTENT_MAX = 80;
// §9.4：Semantic Memory 每条 ≤200 字，总预算 ≤1000 字符。
// 写入端（extractor/summarizer/daily-summary）已统一限制 ≤200 字；
// 此处保留作为防御性上限，防止历史残留或手动写入的超长内容进入 prompt。
const MEMORY_CONTENT_MAX = 200;
const MEMORY_BUDGET_MAX = 1000;

/** 学习任务类页面 → 记忆检索使用 task scope；其余页面用 workspace。 */
const TASK_SCOPE_PAGE_KINDS = new Set(["card", "learning_run", "review"]);

/**
 * 从 Bridge page context 推导记忆检索的 currentScope（§9.2.2）。
 *
 * 修复（2026-08-19 审查）：此前硬编码 currentScope='workspace'，导致 extractor
 * 允许写入的 scope='task' 记忆永远召回不到、scope 维度形同虚设。现按页面类型
 * 推导：学习卡/学习运行/复习页 → 'task'，其余 → 'workspace'。
 * （scope='global' 的记忆在 SQL 中始终参与召回，无需在此传递。）
 */
export function deriveMemoryScope(pageContext: unknown): "workspace" | "task" {
  if (pageContext == null) return "workspace";
  let parsed: unknown = pageContext;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return "workspace";
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "workspace";
  const container = parsed as { context?: unknown };
  const context = (
    container.context && typeof container.context === "object" && !Array.isArray(container.context)
      ? container.context
      : parsed
  ) as { pageKind?: unknown };
  return typeof context.pageKind === "string" && TASK_SCOPE_PAGE_KINDS.has(context.pageKind)
    ? "task"
    : "workspace";
}

/**
 * 检索查询文本（向量检索与 keyword fallback 共用同一份）。
 *
 * 导出给编排层：查询向量必须在 RLS 事务之外计算，而事务内外的查询文本
 * 必须逐字一致，否则"事务外算向量"会静默改变召回语义。
 */
export function buildCompanionMemoryQuery(input: {
  userText: string;
  recentMessages: { role: "user" | "assistant"; text: string }[];
}): string {
  const recentText = input.recentMessages
    .slice(-4)
    .map((m) => m.text)
    .join(" ")
    .slice(0, 500);
  return `${input.userText} ${recentText}`.trim().slice(0, 1000);
}

/**
 * 检索并组装上下文。
 *
 * @param tx 已处于 workspace/user RLS 上下文的 worker 事务
 * @param scope 当前 workspace/user
 * @param input 本次对话输入（用于生成查询）
 * @param opts.runId 用于 memory_usage_log
 */
export async function assembleCompanionContext(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  input: {
    userText: string;
    recentMessages: { role: "user" | "assistant"; text: string }[];
    provider?: EmbeddingProviderLike | null;
    runId: string;
    groundedTutorContext?: unknown;
    /** Bridge page context（对象或 JSON 字符串），用于推导 currentScope。 */
    pageContext?: unknown;
    /**
     * 事务外预计算的查询向量（见 buildCompanionMemoryQuery）：
     * `undefined` = 未预计算（由检索层内部计算），`null` = 已失败 → 直接 keyword。
     */
    queryEmbedding?: number[] | null;
  },
): Promise<ContextAssemblyResult> {
  // 正式学习 grounded_tutor 不注入记忆/人格（§11.1）。
  if (input.groundedTutorContext) {
    return {
      activeMemories: [],
      memoryRefs: [],
      retrievalMode: "keyword_fallback",
      usedMemoryIds: [],
    };
  }

  const query = buildCompanionMemoryQuery(input);

  const result = await retrieveCompanionMemories(
    tx,
    scope,
    query,
    {
      topK: 8,
      provider: input.provider ?? null,
      currentScope: deriveMemoryScope(input.pageContext),
      precomputedEmbedding: input.queryEmbedding,
    },
  );

  // §9.4：Semantic Memory 每条 ≤200 字，总预算 ≤1000 字符。
  // 检索阶段已在 mapMemoryRow 中截断到 200 字；此处按总预算截断条数。
  const items: ContextMemoryItem[] = result.items.map((item) => ({
    memoryId: item.memoryId,
    kind: item.kind,
    content: item.content.slice(0, MEMORY_CONTENT_MAX),
    importance: item.importance,
    pinned: item.pinned,
    lastUsedAt: item.lastUsedAt,
    userConfirmed: item.userConfirmed,
  }));

  // §9.4：按总预算 ≤1000 字符截断——超出时按排序（已是相关度排序）截断条数。
  let budgetUsed = 0;
  const budgetedItems: typeof items = [];
  for (const item of items) {
    if (budgetUsed + item.content.length > MEMORY_BUDGET_MAX) break;
    budgetedItems.push(item);
    budgetUsed += item.content.length;
  }

  const activeMemories = budgetedItems.map((item) => ({
    kind: item.kind,
    content: item.content,
  }));
  // memoryRefs 仅用于 UI 展示"我记得你说过"（§14.5：≤3 条，每条 ≤80 字），
  // 不影响注入 prompt 的完整记忆内容。仅从实际使用的记忆中取前 3 条。
  const memoryRefs = budgetedItems.slice(0, MEMORY_REF_MAX).map((item) => ({
    memoryId: item.memoryId,
    kind: item.kind,
    content: item.content.slice(0, MEMORY_REF_CONTENT_MAX),
  }));

  // 记录检索日志 + 更新 last_used_at（幂等，失败不阻断对话）。
  if (budgetedItems.length > 0) {
    try {
      const ids = budgetedItems.map((item) => item.memoryId);
      // R29/R32：drizzle+postgres-js 数组参数序列化不可靠，使用显式 uuid[] 字面量。
      const idsLiteral = `{${ids.join(",")}}`;
      // 只更新 last_used_at，绝不 bump updated_at：updated_at 是内容修改时间戳，
      // keyword fallback 的排序键为 pinned DESC, importance DESC, updated_at DESC
      // （companion-memory-vector.ts retrieveCompanionMemoriesKeyword）。若在召回时
      // 刷新 updated_at，每被召回一次该记忆就在降级检索中永久置顶，排序与内容新旧脱钩。
      await tx.execute(sql`
        UPDATE assistant_memory_items
        SET last_used_at = now()
        WHERE workspace_id = ${scope.workspaceId}
          AND user_id = ${scope.userId}
          AND id = ANY(${idsLiteral}::uuid[])
      `);
      await tx.execute(sql`
        INSERT INTO memory_usage_log
          (workspace_id, user_id, run_id, memory_ids, retrieval_mode, latency_ms)
        VALUES
          (${scope.workspaceId}, ${scope.userId}, ${input.runId},
           ${idsLiteral}::uuid[], ${result.mode}, ${result.latencyMs})
      `);
    } catch (error) {
      // 结构化日志（err 走 safeErrorSerializer 脱敏）：console.warn 直接打印
      // 原始 error 会把 postgres 驱动的 message/绑定值带进日志。
      logger.warn({ err: error, runId: input.runId }, "companion memory usage log write failed");
    }
  }

  // §9.9：记录检索模式与使用记忆数指标（失败不阻断对话）。
  try {
    companionMemoryRetrievalModeTotal.labels(result.mode).inc();
    companionMemoryUsedCount.observe(budgetedItems.length);
  } catch {
    // metrics 记录失败不影响对话。
  }

  // §9.9：结构化日志字段——memoryIds / retrievalLatencyMs / contextBudgetUsed
  logger.debug(
    {
      runId: input.runId,
      memoryIds: budgetedItems.map((item) => item.memoryId),
      retrievalLatencyMs: result.latencyMs,
      retrievalMode: result.mode,
      contextBudgetUsed: activeMemories.reduce((sum, m) => sum + m.content.length, 0),
    },
    "companion context assembled",
  );

  return {
    activeMemories,
    memoryRefs,
    retrievalMode: result.mode,
    usedMemoryIds: budgetedItems.map((item) => item.memoryId),
  };
}
