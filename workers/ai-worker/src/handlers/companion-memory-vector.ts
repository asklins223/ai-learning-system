/**
 * 真桌宠记忆向量检索（22-real-desktop-pet-memory-context-prd-tdd.md §9.2/§12.5）。
 *
 * - vector 模式：pgvector cosine + importance/pinned/freshness/user_confirmed 加权；
 * - keyword fallback：embedding provider 不可用/无 ready embedding 时按内容关键词 +
 *   importance/pinned/updated_at 排序；
 * - 不阻塞对话；检索失败一律回退 keyword，绝不让记忆召回拖垮回复。
 */

import { sql } from "drizzle-orm";

export interface RetrievedMemory {
  memoryId: string;
  kind: string;
  content: string;
  importance: number;
  pinned: boolean;
  lastUsedAt: string | null;
  userConfirmed: boolean;
}

export interface MemoryRetrievalResult {
  items: RetrievedMemory[];
  mode: "vector" | "keyword_fallback";
  latencyMs: number;
}

export interface EmbeddingProviderLike {
  readonly id: string;
  readonly embeddingModelId: string;
  embed(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

type Executor = { execute(query: unknown): Promise<unknown> };

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function isMemoryVectorEnabled(): boolean {
  return process.env.COMPANION_MEMORY_VECTOR_V1 === "true";
}

function mapMemoryRow(row: Record<string, unknown>): RetrievedMemory {
  return {
    memoryId: String(row.id ?? row.memory_id ?? ""),
    kind: String(row.kind ?? ""),
    content: String(row.content ?? "").slice(0, 500),
    importance: Number(row.importance ?? 0.5),
    pinned: Boolean(row.pinned),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    userConfirmed: Boolean(row.user_confirmed),
  };
}

/** 关键词降级检索：不依赖 embedding provider，只过滤 active/confirmed。
 *  §9.2.2：scope 过滤与向量检索一致——只返回 workspace 或当前 scope 的记忆。 */
export async function retrieveCompanionMemoriesKeyword(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  query: string,
  topK = 8,
  currentScope = "workspace",
): Promise<MemoryRetrievalResult> {
  const startedAt = performance.now();
  const result = await tx.execute(sql`
    SELECT id, kind, content, importance, pinned, last_used_at, user_confirmed
    FROM assistant_memory_items
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND deleted_at IS NULL
      AND candidate = false
      AND archived_at IS NULL
      AND (scope = 'workspace' OR scope = ${currentScope})
      AND (content ILIKE ${`%${query}%`} OR kind ILIKE ${`%${query}%`})
    ORDER BY pinned DESC, importance DESC, updated_at DESC
    LIMIT ${topK}
  `);
  const items = rowsOf<Record<string, unknown>>(result).map(mapMemoryRow);
  return { items, mode: "keyword_fallback", latencyMs: Math.round(performance.now() - startedAt) };
}

/** 向量检索：pgvector cosine + 排序公式（§9.2.2/§12.5）。 */
export async function retrieveCompanionMemoriesVector(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  query: string,
  provider: EmbeddingProviderLike,
  topK = 8,
  currentScope = "workspace",
): Promise<MemoryRetrievalResult> {
  const startedAt = performance.now();
  const vector = await provider.embed(query.slice(0, 1000));
  if (!vector || vector.length === 0) {
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, currentScope);
  }
  const queryVec = JSON.stringify(vector);
  try {
    const result = await tx.execute(sql`
      SELECT m.id, m.kind, m.content, m.importance, m.pinned, m.last_used_at, m.user_confirmed,
             1 - (e.embedding <=> ${queryVec}::vector) AS similarity,
             CASE
               WHEN m.last_used_at IS NULL THEN 0.5
               WHEN m.last_used_at > now() - interval '1 day' THEN 1.0
               WHEN m.last_used_at > now() - interval '7 days' THEN 0.8
               WHEN m.last_used_at > now() - interval '30 days' THEN 0.6
               WHEN m.last_used_at > now() - interval '90 days' THEN 0.4
               ELSE 0.2
             END AS freshness
      FROM assistant_memory_items m
      JOIN assistant_memory_embeddings e ON e.memory_id = m.id
      WHERE m.workspace_id = ${scope.workspaceId}
        AND m.user_id = ${scope.userId}
        AND m.deleted_at IS NULL
        AND m.candidate = false
        AND m.archived_at IS NULL
        AND m.embedding_status = 'ready'
        AND (m.scope = 'workspace' OR m.scope = ${currentScope})
      ORDER BY
        (1 - (e.embedding <=> ${queryVec}::vector))
        * (0.4 + 0.6 * m.importance)
        * CASE WHEN m.pinned THEN 1.2 ELSE 1 END
        * CASE WHEN m.user_confirmed THEN 1 ELSE 0.8 END
        * CASE
            WHEN m.last_used_at IS NULL THEN 0.5
            WHEN m.last_used_at > now() - interval '1 day' THEN 1.0
            WHEN m.last_used_at > now() - interval '7 days' THEN 0.8
            WHEN m.last_used_at > now() - interval '30 days' THEN 0.6
            WHEN m.last_used_at > now() - interval '90 days' THEN 0.4
            ELSE 0.2
          END DESC
      LIMIT ${topK}
    `);
    const items = rowsOf<Record<string, unknown>>(result).map(mapMemoryRow);
    return { items, mode: "vector", latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    // pgvector 查询失败（扩展/索引/类型问题）不阻塞对话，降级 keyword。
    console.warn("companion memory vector retrieval failed, falling back to keyword", error);
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, currentScope);
  }
}

/** 统一入口：优先向量，失败/未开启降级 keyword。 */
export async function retrieveCompanionMemories(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  query: string,
  opts: {
    topK?: number;
    provider?: EmbeddingProviderLike | null;
    currentScope?: string;
    signal?: AbortSignal;
  } = {},
): Promise<MemoryRetrievalResult> {
  const topK = opts.topK ?? 8;
  const currentScope = opts.currentScope ?? "workspace";
  if (!isMemoryVectorEnabled() || !opts.provider) {
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, currentScope);
  }
  try {
    return await retrieveCompanionMemoriesVector(
      tx,
      scope,
      query,
      opts.provider,
      topK,
      currentScope,
    );
  } catch (error) {
    console.warn("companion memory retrieval failed, using keyword fallback", error);
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, currentScope);
  }
}
