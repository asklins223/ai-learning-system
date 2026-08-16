/**
 * 真桌宠上下文装配（22-real-desktop-pet-memory-context-prd-tdd.md §3.4/§9.4）。
 *
 * Worker 侧在生成前调用：检索相关长期记忆 → 组装 memory_data 数据块 →
 * 记录 memory_usage_log / 更新 last_used_at。
 *
 * grounded_tutor 分支不注入任何长期记忆/人格闲聊内容（§11.1），防止污染正式学习。
 */

import { sql } from "drizzle-orm";
import type { EmbeddingProviderLike } from "./companion-memory-vector.ts";
import { retrieveCompanionMemories } from "./companion-memory-vector.ts";

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

const MEMORY_DATA_MAX_CHARS = 1000;
const EPISODIC_MAX_CHARS = 600;
const MEMORY_REF_MAX = 3;
const MEMORY_REF_CONTENT_MAX = 80;

function trimMemoryData(items: ContextMemoryItem[]): ContextMemoryItem[] {
  const semantic: ContextMemoryItem[] = [];
  const episodic: ContextMemoryItem[] = [];
  let semanticChars = 0;
  let episodicChars = 0;
  for (const item of items) {
    const budget = item.kind === "episodic" ? EPISODIC_MAX_CHARS : MEMORY_DATA_MAX_CHARS;
    const target = item.kind === "episodic" ? episodic : semantic;
    const used = item.kind === "episodic" ? episodicChars : semanticChars;
    if (used + item.content.length > budget) continue;
    target.push(item);
    if (item.kind === "episodic") episodicChars += item.content.length;
    else semanticChars += item.content.length;
  }
  return [...semantic, ...episodic];
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

  const recentText = input.recentMessages
    .slice(-4)
    .map((m) => m.text)
    .join(" ")
    .slice(0, 500);
  const query = `${input.userText} ${recentText}`.trim().slice(0, 1000);

  const result = await retrieveCompanionMemories(
    tx,
    scope,
    query,
    {
      topK: 8,
      provider: input.provider ?? null,
      currentScope: "workspace",
    },
  );

  const items: ContextMemoryItem[] = result.items.map((item) => ({
    memoryId: item.memoryId,
    kind: item.kind,
    content: item.content,
    importance: item.importance,
    pinned: item.pinned,
    lastUsedAt: item.lastUsedAt,
    userConfirmed: item.userConfirmed,
  }));
  const trimmed = trimMemoryData(items);

  const activeMemories = trimmed.map((item) => ({
    kind: item.kind,
    content: item.content.slice(0, 500),
  }));
  const memoryRefs = trimmed.slice(0, MEMORY_REF_MAX).map((item) => ({
    memoryId: item.memoryId,
    kind: item.kind,
    content: item.content.slice(0, MEMORY_REF_CONTENT_MAX),
  }));

  // 记录检索日志 + 更新 last_used_at（幂等，失败不阻断对话）。
  if (trimmed.length > 0) {
    try {
      const ids = trimmed.map((item) => item.memoryId);
      // R29/R32：drizzle+postgres-js 数组参数序列化不可靠，使用显式 uuid[] 字面量。
      const idsLiteral = `{${ids.join(",")}}`;
      await tx.execute(sql`
        UPDATE assistant_memory_items
        SET last_used_at = now(), updated_at = now()
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
      console.warn("companion memory usage log write failed", error);
    }
  }

  return {
    activeMemories,
    memoryRefs,
    retrievalMode: result.mode,
    usedMemoryIds: trimmed.map((item) => item.memoryId),
  };
}
