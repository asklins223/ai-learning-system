/**
 * 真桌宠记忆向量检索（22-real-desktop-pet-memory-context-prd-tdd.md §9.2/§12.5）。
 *
 * - vector 模式：pgvector cosine + importance/pinned/freshness/user_confirmed 加权；
 * - keyword fallback：embedding provider 不可用/无 ready embedding 时按内容关键词 +
 *   importance/pinned/updated_at 排序；
 * - 不阻塞对话；检索失败一律回退 keyword，绝不让记忆召回拖垮回复。
 */

import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";

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

/**
 * 向量检索开关。
 *
 * 导出给编排层：调用方需要据此决定"是否值得在事务外先算查询向量"
 * （embedding 是外部 HTTP 调用，不能发生在 RLS 事务内）。
 */
export function isCompanionMemoryVectorEnabled(): boolean {
  return isMemoryVectorEnabled();
}

/**
 * §2.4.3 keyword fallback 的关键词提取。
 *
 * 之前直接把 ≤1000 字符的整段查询塞进 `content ILIKE '%<全文>%'`——模式比
 * content（≤200 字）还长，永远匹配不到，降级检索形同虚设。
 *
 * 提取策略（复审修订：中文无词边界，整段既匹配不到也粒度过粗）：
 * - 拉丁/数字子串 ≥2 字符整体保留（截断到 30），混排 token 如 "light反应" 拆开；
 * - Han 连续段 ≤4 字整体保留；>4 字切重叠 bigram（无分词器条件下召回率最高的
 *   子串单位，如"今天我们聊聊光合作用吧"→ 含"光合"/"作用"等 bigram）；
 * - bigram 超出剩余预算时做**头尾采样**（前半 + 后半）：中文句子的语义重心常在
 *   句尾宾语（"……重点突破有机化学"），按位置顺序截断会恰好丢掉它；
 * - 去重、总量封顶（默认 12），控制 ILIKE ANY 模式规模。
 */
export function extractQueryKeywords(query: string, maxKeywords = 12): string[] {
  const keywords: string[] = [];
  const push = (kw: string): boolean => {
    if (!keywords.includes(kw)) keywords.push(kw);
    return keywords.length < maxKeywords;
  };
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const raw of tokens) {
    if (keywords.length >= maxKeywords) break;
    for (const latin of raw.match(/[A-Za-z0-9]+/g) ?? []) {
      if (latin.length >= 2 && !push(latin.slice(0, 30))) break;
    }
    for (const han of raw.match(/\p{Script=Han}+/gu) ?? []) {
      let grams: string[];
      if (han.length <= 4) {
        grams = [han];
      } else {
        grams = [];
        for (let i = 0; i + 2 <= han.length; i++) grams.push(han.slice(i, i + 2));
        // 头尾采样：超预算时保前半 + 后半 bigram，避免丢句尾语义重心。
        const remaining = maxKeywords - keywords.length;
        if (remaining <= 0) break;
        if (grams.length > remaining) {
          const head = Math.ceil(remaining / 2);
          grams = [
            ...grams.slice(0, head),
            ...grams.slice(grams.length - (remaining - head)),
          ];
        }
      }
      for (const gram of grams) {
        if (!push(gram)) break;
      }
      if (keywords.length >= maxKeywords) break;
    }
  }
  return keywords;
}

/** 将已消毒的关键词数组序列化为 PostgreSQL text[] 字面量。 */
export function toTextArrayLiteral(values: string[]): string {
  const items = values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${items.join(",")}}`;
}

function mapMemoryRow(row: Record<string, unknown>): RetrievedMemory {
  return {
    memoryId: String(row.id ?? row.memory_id ?? ""),
    kind: String(row.kind ?? ""),
    // §9.4：写入端已统一限制 ≤200 字（extractor/summarizer/daily-summary）。
    // 此处保留 slice 作为防御性上限，防止历史残留数据或手动写入的超长内容进入 prompt。
    content: String(row.content ?? "").slice(0, 200),
    importance: Number(row.importance ?? 0.5),
    pinned: Boolean(row.pinned),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    userConfirmed: Boolean(row.user_confirmed),
  };
}

/** 关键词降级检索：不依赖 embedding provider。
 *  §2.4.3：按关键词匹配 + importance/pinned/updated_at 规则排序。
 *  §9.2.2：scope 过滤与向量检索一致——workspace / global / 当前 scope 均可召回。 */
export async function retrieveCompanionMemoriesKeyword(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  query: string,
  topK = 8,
  currentScope = "workspace",
): Promise<MemoryRetrievalResult> {
  const startedAt = performance.now();
  // 修复（2026-08-19 审查）：此前把 ≤1000 字符整段查询塞进 `ILIKE '%<全文>%'`，
  // 模式比 content（≤200 字）还长，几乎永远匹配不到，降级检索形同虚设。
  // 现改为提取关键词子串做 ILIKE ANY；无可用关键词时回退规则排序，保证仍有召回。
  const keywords = extractQueryKeywords(query);
  const keywordsLiteral = keywords.length > 0 ? toTextArrayLiteral(keywords) : null;
  const keywordFilter = keywordsLiteral
    ? sql` AND (content ILIKE ANY(${keywordsLiteral}::text[]) OR kind ILIKE ANY(${keywordsLiteral}::text[]))`
    : sql``;
  const result = await tx.execute(sql`
    SELECT id, kind, content, importance, pinned, last_used_at, user_confirmed
    FROM assistant_memory_items
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND deleted_at IS NULL
      AND candidate = false
      AND archived_at IS NULL
      AND (scope = 'workspace' OR scope = 'global' OR scope = ${currentScope})
      ${keywordFilter}
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
  /**
   * 事务外预计算的查询向量。缺省时本函数自行调用 provider.embed——
   * 那是外部 HTTP 往返，调用方若已持有 RLS 事务必须改用预计算值。
   */
  precomputedEmbedding?: number[] | null,
): Promise<MemoryRetrievalResult> {
  const startedAt = performance.now();
  const vector = precomputedEmbedding ?? await provider.embed(query.slice(0, 1000));
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
        AND (m.scope = 'workspace' OR m.scope = 'global' OR m.scope = ${currentScope})
        -- AI P1（2026-09-15 审计）：只比较**同一向量空间**的向量。此前不校验
        -- e.model_revision，换过 embedding 模型（如 bge-m3 1024 维 → 别的 1536 维
        -- 模型，或同维不同模型）后，旧向量会与新查询向量一起参与 <=> 计算——维度
        -- 不同时直接抛错、同维不同模型时余弦相似度毫无意义（静默给出错误召回）。
        -- 以查询向量所属模型为基准过滤，未重建的记忆不再参与相似度（其
        -- embedding_status 仍可在重建任务中被重算）。
        AND e.model_revision = ${provider.embeddingModelId}
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
    // 修复（2026-08-19 审查）：provider 可用但该用户还没有任何 ready embedding
    // 时（新确认记忆 pending→ready 窗口、embedding 任务积压），此前直接返回空集，
    // 造成"有记忆但永远召回不到"。现检测 ready embedding 是否存在，不存在则
    // 降级 keyword 规则排序；存在但相似度不足时保持空集（真正无相关记忆）。
    if (items.length === 0) {
      // 修复（2026-08-22 审查）：探测条件必须与主检索查询一致（含 scope 过滤）。
      // 此前缺 scope 条件——用户若只有其他 scope 的 ready embedding（如 task 页
      // 只写过 workspace 记忆），会误判"有 ready"而不降级 keyword，零召回窗口仍在。
      // AI P1（2026-09-15 审计）：同样必须带 model_revision 过滤，否则换过
      // embedding 模型的用户会被判成"有 ready"（其实全属旧向量空间、主查询已排除），
      // 于是既不召回也不降级 keyword —— 正是上面这条注释警告过的零召回窗口。
      const hasReady = await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1
          FROM assistant_memory_embeddings e
          JOIN assistant_memory_items m ON m.id = e.memory_id
          WHERE e.workspace_id = ${scope.workspaceId}
            AND e.user_id = ${scope.userId}
            AND m.deleted_at IS NULL
            AND m.candidate = false
            AND m.archived_at IS NULL
            AND m.embedding_status = 'ready'
            AND (m.scope = 'workspace' OR m.scope = 'global' OR m.scope = ${currentScope})
            AND e.model_revision = ${provider.embeddingModelId}
        ) AS has_ready
      `);
      const hasReadyRow = rowsOf<{ has_ready: boolean }>(hasReady)[0];
      if (!hasReadyRow || !hasReadyRow.has_ready) {
        return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, currentScope);
      }
    }
    return { items, mode: "vector", latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    // pgvector 查询失败（扩展/索引/类型问题）不阻塞对话，降级 keyword。
    logger.warn({ err: error }, "companion memory vector retrieval failed, falling back to keyword");
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
    /**
     * 事务外预计算的查询向量：
     * - `undefined`：调用方未预计算，本函数内部调用 provider.embed（不占事务）；
     * - `null`：已尝试且失败——直接降级 keyword，绝不在事务内重试外部调用。
     */
    precomputedEmbedding?: number[] | null;
  } = {},
): Promise<MemoryRetrievalResult> {
  const topK = opts.topK ?? 8;
  const currentScope = opts.currentScope ?? "workspace";
  if (!isMemoryVectorEnabled() || !opts.provider) {
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, currentScope);
  }
  if (opts.precomputedEmbedding === null) {
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
      opts.precomputedEmbedding,
    );
  } catch (error) {
    logger.warn({ err: error }, "companion memory retrieval failed, using keyword fallback");
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, currentScope);
  }
}
