import { and, asc, desc, eq, ne, sql, inArray, lt, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningCards,
  learningCardSets,
  cardKeyPoints,
} from "../../db/schema/card.ts";
import { evidences } from "../../db/schema/evidence.ts";
import { notes, noteBlocks, sources, sourceSegments } from "../../db/schema/note.ts";
import { searchDocuments } from "../../db/schema/search.ts";
import { CardStatus, SourceStatus } from "@ailearn/shared";
import { logger } from "../../lib/logger.ts";
import { activeLearningCardConsumerPredicate } from "../card/consumer-eligibility.ts";

export interface SearchResult {
  objectType: string;
  objectId: string;
  title: string | null;
  snippet: string;
  indexedAt: string;
  href: string;
  /** 当 evidence 被按 card 聚合时，表示该 card 下有多少条 evidence 命中 */
  matchCount?: number;
  cardSetId?: string | null;
  scope?: "overview" | "section" | null;
  ordinal?: number | null;
}

/**
 * PERF-06 优化：提取为模块级 SQL 片段以便 PostgreSQL planner 缓存执行计划。
 *
 * 实现说明：使用 EXISTS 子查询 + LEFT JOIN 模式。每个 EXISTS 子查询内部
 * 通过 LEFT JOIN 关联 card_set 表，避免在 EXISTS 外部做 JOIN 产生笛卡尔积。
 * 提取为模块级常量后，PostgreSQL 可以缓存执行计划，避免每次搜索重新编译。
 * 结合 PERF-05 的 GIN trigram 索引，搜索性能在大数据量下不会线性退化。
 *
 * 语义等价规则：
 * - 非 card/card_set/evidence 类型始终通过
 * - card_set 必须为 active
 * - card 必须为 active 且（无 card_set 或 card_set 为 active）
 * - evidence 必须属于 active card 且 card 的 card_set 为 active 或 null
 */
const consumableSearchDocumentPredicate = sql<boolean>`(
  search_document.object_type NOT IN ('card', 'card_set', 'evidence')
  OR (
    search_document.object_type = 'card_set'
    AND EXISTS (
      SELECT 1
      FROM learning_card_sets AS parent_set
      WHERE parent_set.id = search_document.object_id
        AND parent_set.workspace_id = search_document.workspace_id
        AND parent_set.status = 'active'
    )
  )
  OR (
    search_document.object_type = 'card'
    AND EXISTS (
      SELECT 1
      FROM learning_cards AS consumer_card
      LEFT JOIN learning_card_sets AS parent_set
        ON parent_set.id = consumer_card.card_set_id
        AND parent_set.workspace_id = consumer_card.workspace_id
      WHERE consumer_card.id = search_document.object_id
        AND consumer_card.workspace_id = search_document.workspace_id
        AND consumer_card.status = 'active'
        AND (consumer_card.card_set_id IS NULL OR parent_set.status = 'active')
    )
  )
  OR (
    search_document.object_type = 'evidence'
    AND EXISTS (
      SELECT 1
      FROM evidences AS consumer_evidence
      JOIN card_key_points AS consumer_key_point
        ON consumer_key_point.id = consumer_evidence.key_point_id
       AND consumer_key_point.workspace_id = consumer_evidence.workspace_id
      JOIN learning_cards AS consumer_card
        ON consumer_card.id = consumer_key_point.card_id
       AND consumer_card.workspace_id = consumer_key_point.workspace_id
      LEFT JOIN learning_card_sets AS parent_set
        ON parent_set.id = consumer_card.card_set_id
        AND parent_set.workspace_id = consumer_card.workspace_id
      WHERE consumer_evidence.id = search_document.object_id
        AND consumer_evidence.workspace_id = search_document.workspace_id
        AND consumer_card.status = 'active'
        AND (consumer_card.card_set_id IS NULL OR parent_set.status = 'active')
    )
  )
)`;

// ─── PERF-B2 修复：search count 短 TTL 缓存 ───────────────────────────────
// count 用 DISTINCT ON 对 workspace 全量命中做去重计数，无法利用 LIMIT，
// 是大结果集下每次击键触发的热点。total 只是展示性数字，允许短暂过期。
// 此处用进程内短 TTL 缓存（默认 30s）+ 有界 Map（默认 500 条，超限淘汰最旧），
// 避免每个击键都全表+DISTINCT 计数。写操作后的缓存一致性可接受（total 非强一致）。
const SEARCH_COUNT_CACHE_TTL_MS = 30_000;
const SEARCH_COUNT_CACHE_MAX_ENTRIES = 500;
// N#7-18: 该缓存为进程内（无跨副本同步），无写失效。多副本部署下各实例的
// total/nextCursor 口径可能短期漂移（≤TTL 30s）。total 为展示性数字，可接受短暂不一致；
// 若未来需要强一致，应迁至副本感知的 TTL/版本号策略或移除缓存。

// N#7-1: reindex 读阶段每表的行上限，防止单工作区整表无界装载导致内存压力。
// 超出上限时记告警并截断处理（超限部分不会进入投影），避免 OOM。
const REINDEX_MAX_ROWS_PER_TABLE = 50_000;

// N#8-1: reindex 与 drift 共用同一个"前 LIMIT 子集"的截断边界，避免两路径各取任意子集。
// 关键：两处顶层表读都用完全相同的确定排序 + 同一上限。于是 reindex 建立的索引与
// drift 读取的业务表都覆盖同一确定子集（按 updatedAt DESC → 最近写入优先），
// 超出截断线的实体两侧都不会读取 → 不再被误判为 missing。cardSets 无 updatedAt 列，
// 用 createdAt DESC + id 兜底；其余三表用 updatedAt DESC + id（与 0153/索引列对齐）。
// DB 排序规则约定：notes/sources/cards 均存在 (workspace_id, updated_at desc) 或等价索引。
const reindexTopOrder: Record<string, any> = (() => {
  return {
    notes: (fields: any) => [desc(fields.updatedAt), asc(fields.id)],
    sources: (fields: any) => [desc(fields.updatedAt), asc(fields.id)],
    cardSets: (fields: any) => [desc(fields.createdAt), asc(fields.id)],
    cards: (fields: any) => [desc(fields.updatedAt), asc(fields.id)],
  };
})();

// N#8-1: 进程内记录"该工作区上一次 reindex 是否因单表行数上限被截断"。当域名表真实超过
// REINDEX_MAX_ROWS_PER_TABLE 时，reindex 必然只索引确定前 LIMIT 子集，drift 也不会读超线实体，
// 因而"超线实体不在索引中"是截断的既定结果而非漂移。auto-fix 借由此标记避免在该场景反复
// 触发 reindex（进程内无跨副本同步；与 search count 缓存同一级的声明，见下方 autoFix 注释）。
const lastReindexCapped = new Map<string, boolean>();
interface SearchCountCacheEntry {
  value: number;
  insertedAt: number;
}
const searchCountCache = new Map<string, SearchCountCacheEntry>();

/** 归一化缓存键用的小写去空格查询。 */
function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * N#7-1: 分块 IN 查询辅助函数，避免大 ID 集合突破 postgres-js ~65535 绑定参数上限。
 * 沿用项目已有 chunkedInArraySelect 模式（note/service.ts:36），默认 500/批。
 */
async function chunkedInArraySelect<T>(
  queryFn: (chunk: string[]) => Promise<T[]>,
  ids: string[],
  chunkSize = 500,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    results.push(...(await queryFn(chunk)));
  }
  return results;
}

/**
 * 分块 IN 查询（带总行数上限）。与 chunkedInArraySelect 类似，但累计结果达到
 * max 即停止，用于把派生表（如 reindex 的 evidence）投影限制为
 * REINDEX_MAX_ROWS_PER_TABLE 以内的确定性子集，避免无界内存占用。
 * 返回是否因达到上限而被截断（capped）。截断顺序为输入 id 分块的确定顺序。
 */
async function chunkedInArraySelectCapped<T>(
  queryFn: (chunk: string[]) => Promise<T[]>,
  ids: string[],
  max: number,
  chunkSize = 500,
): Promise<{ rows: T[]; capped: boolean }> {
  const results: T[] = [];
  let capped = false;
  for (let i = 0; i < ids.length; i += chunkSize) {
    if (results.length >= max) {
      capped = true;
      break;
    }
    const chunk = ids.slice(i, i + chunkSize);
    const rows = await queryFn(chunk);
    const remaining = max - results.length;
    if (rows.length > remaining) {
      results.push(...rows.slice(0, remaining));
      capped = true;
      break;
    }
    results.push(...rows);
  }
  return { rows: results, capped };
}

/**
 * 计算去重后的实体总数，优先命中短 TTL 缓存。
 * 缓存键 = workspaceId + normalizedQuery + type。
 */
async function getSearchTotal(
  executor: ApiTransaction,
  workspaceId: string,
  query: string,
  type: string | null,
): Promise<number> {
  const normalizedQuery = normalizeSearchQuery(query);
  const key = `${workspaceId}\u0000${normalizedQuery}\u0000${type ?? ""}`;

  const now = Date.now();
  const cached = searchCountCache.get(key);
  if (cached && now - cached.insertedAt < SEARCH_COUNT_CACHE_TTL_MS) {
    return cached.value;
  }

  // 惰性清理过期条目，防止过期 key 长期占位。
  // PERF: bound the sweep so a cache miss never pays a full O(cache-size) scan.
  // SEARCH_COUNT_CACHE_MAX_ENTRIES below still bounds total memory, and an
  // expired entry is simply overwritten on its next lookup.
  let evicted = 0;
  const MAX_EVICTIONS_PER_CALL = 16;
  for (const [k, v] of searchCountCache) {
    if (evicted >= MAX_EVICTIONS_PER_CALL) break;
    if (now - v.insertedAt >= SEARCH_COUNT_CACHE_TTL_MS) {
      searchCountCache.delete(k);
      evicted++;
    }
  }

  const rows = await executor.execute<{ count: string }>(sql`
    SELECT count(*) as count FROM (
      SELECT DISTINCT ON (
        CASE
          WHEN object_type = 'evidence' AND metadata->>'cardId' IS NOT NULL
          THEN 'evidence-card:' || (metadata->>'cardId')
          ELSE object_type || ':' || object_id
        END
      )
        1
      FROM search_documents AS search_document
      WHERE workspace_id = ${workspaceId}
        AND (
          body ILIKE '%' || ${searchEscapedQuery(query)} || '%' ESCAPE '\\'
          OR title ILIKE '%' || ${searchEscapedQuery(query)} || '%' ESCAPE '\\'
        )
        AND (${type}::text IS NULL OR object_type = ${type})
        AND ${consumableSearchDocumentPredicate}
    ) as distinct_entities
  `);
  const total = Number(rows[0]?.count ?? 0);

  // 有界写入：超限时淘汰最旧条目（Map 保持插入序，首个 key 即最旧）。
  if (searchCountCache.size >= SEARCH_COUNT_CACHE_MAX_ENTRIES && !searchCountCache.has(key)) {
    const oldestKey = searchCountCache.keys().next().value;
    if (oldestKey !== undefined) searchCountCache.delete(oldestKey);
  }
  searchCountCache.set(key, { value: total, insertedAt: now });
  return total;
}

/** 与 search 内联查询一致的 ILIKE 转义。 */
function searchEscapedQuery(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

/**
 * 全文搜索（pg_trgm + ILIKE，中文友好）。
 * N-012: 在 SQL 层按最终展示实体聚合去重，再计算 total 和分页。
 * 同一张 card 下的多条 evidence 只返回一条，但记录 matchCount。
 */
export async function search(
  executor: ApiTransaction,
  workspaceId: string,
  query: string,
  opts?: { type?: string; limit?: number; offset?: number },
): Promise<{ items: SearchResult[]; total: number; nextCursor: number | null }> {
  const limit = Math.min(opts?.limit ?? 20, 50);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const type = opts?.type ?? null;
  // ILIKE treats `%` and `_` as wildcards. Escape them so the public API keeps
  // literal keyword semantics and a query such as `%` cannot scan/return every
  // document in the workspace.
  const escapedQuery = query.replace(/[\\%_]/g, "\\$&");

  // N-012: 使用 DISTINCT ON 在 SQL 层聚合去重
  // evidence 按 cardId 聚合，其他类型按自身 ID 去重
  const dedupKey = sql`
    CASE
      WHEN object_type = 'evidence' AND metadata->>'cardId' IS NOT NULL
      THEN 'evidence-card:' || (metadata->>'cardId')
      ELSE object_type || ':' || object_id
    END
  `;

  // The page read and the (cached) total are independent reads; run them in
  // parallel. total 由 getSearchTotal 走短 TTL 缓存，命中时零 DB 往返。
  const [rows, total] = await Promise.all([
    executor.execute<{
      object_type: string;
      object_id: string;
      title: string | null;
      body: string | null;
      indexed_at: string | Date;
      metadata: Record<string, unknown> | null;
      match_count: string;
    }>(sql`
      WITH matching AS (
        SELECT object_type, object_id, title, body, indexed_at, metadata,
          ${dedupKey} as dedup_key
        FROM search_documents AS search_document
        WHERE workspace_id = ${workspaceId}
          AND (
            body ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
            OR title ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
          )
          AND (${type}::text IS NULL OR object_type = ${type})
          AND ${consumableSearchDocumentPredicate}
      ),
      evidence_counts AS (
        SELECT metadata->>'cardId' as card_id, count(*) as match_count
        FROM matching
        WHERE object_type = 'evidence' AND metadata->>'cardId' IS NOT NULL
        GROUP BY metadata->>'cardId'
      ),
      deduplicated AS (
        SELECT DISTINCT ON (dedup_key)
          object_type, object_id, title, body, indexed_at, metadata, dedup_key
        FROM matching
        ORDER BY dedup_key, indexed_at DESC
      )
      SELECT d.object_type, d.object_id, d.title, d.body, d.indexed_at, d.metadata,
        COALESCE(ec.match_count, 1)::text as match_count
      FROM deduplicated d
      LEFT JOIN evidence_counts ec
        ON d.object_type = 'evidence'
        AND d.metadata->>'cardId' = ec.card_id
      ORDER BY d.indexed_at DESC, d.dedup_key ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `),
    getSearchTotal(executor, workspaceId, query, type),
  ]);

  // PERF-11: Create the highlight RegExp once, not per result row.
  // BUG-04 fix: snippet 高亮也需要转义 query 中的正则特殊字符，
  // 同时去掉控制字符避免 RegExp 构建异常。
  // BUG-13 fix: 同时转义 `-` 字符。虽然 `-` 在正则字面量模式中不是元字符，
  // 但转义它是无害的，且能防止未来代码复用到字符类上下文中时产生意外匹配。
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&").replace(/[\x00-\x1F]/g, "");
  const highlightRe = safeQuery ? new RegExp(safeQuery, "gi") : null;

  const items: SearchResult[] = rows.map((row) => {
    const body = row.body ?? "";
    const idx = body.toLowerCase().indexOf(query.toLowerCase());
    let snippet = "";
    if (idx >= 0) {
      const start = Math.max(0, idx - 50);
      const end = Math.min(body.length, idx + query.length + 50);
      snippet = (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
    } else {
      snippet = body.slice(0, 100);
    }

    const highlighted = highlightRe
      ? snippet.replace(highlightRe, (match) => `«${match}»`)
      : snippet;

    const metadata = row.metadata as Record<string, unknown> | null;
    const cardSetId = typeof metadata?.cardSetId === "string"
      ? metadata.cardSetId
      : null;
    const scope = metadata?.scope === "overview" || metadata?.scope === "section"
      ? metadata.scope
      : null;
    const ordinal = typeof metadata?.ordinal === "number"
      ? metadata.ordinal
      : null;

    // 生成 href
    let href = "";
    switch (row.object_type) {
      case "note":
        href = `/notes/${row.object_id}`;
        break;
      case "card":
        href = cardSetId
          ? `/card-sets/${cardSetId}?cardId=${row.object_id}`
          : `/cards/${row.object_id}`;
        break;
      case "card_set":
        href = `/card-sets/${row.object_id}`;
        break;
      case "source":
        href = `/sources/${row.object_id}`;
        break;
      case "evidence": {
        const cardId = typeof metadata?.cardId === "string"
          ? metadata.cardId
          : null;
        href = cardSetId
          ? `/card-sets/${cardSetId}${cardId ? `?cardId=${cardId}` : ""}`
          : cardId
            ? `/cards/${cardId}`
            : "";
        break;
      }
      default:
        href = "";
    }

    return {
      objectType: row.object_type,
      objectId: row.object_id,
      title: row.title,
      snippet: highlighted,
      indexedAt: row.indexed_at instanceof Date ? row.indexed_at.toISOString() : row.indexed_at,
      href,
      matchCount: Number(row.match_count) || 1,
      cardSetId,
      scope,
      ordinal,
    };
  });

  const consumed = offset + items.length;
  return {
    items,
    total,
    nextCursor: consumed < total ? consumed : null,
  };
}

export interface SearchReindexResult {
  deleted: number;
  indexed: {
    note: number;
    source: number;
    cardSet: number;
    card: number;
    evidence: number;
  };
  /** N#8-1: 本次 reindex 是否因单表行数上限被截断（投影可能只含确定的前 LIMIT 子集） */
  capped: boolean;
}

/**
 * Workspace 级搜索投影重建（R-017: 原子化）。
 *
 * 整个 reindex 在单个事务内执行：先删除旧索引，再逐项重建。
 * 如果任何 INSERT 失败，事务回滚，旧索引保留，不会留下空/半索引。
 *
 * 只索引当前可用对象：笔记、未归档来源、active 学习卡，以及这些卡片下的 evidence。
 */
export async function reindexWorkspaceSearch(
  executor: ApiTransaction,
  workspaceId: string,
): Promise<SearchReindexResult & { errors: number }> {
  let deletedCount = 0;
  let indexed = { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0 };
  let errors = 0;
  const projectionStartedAt = new Date();

  // Collect top-level entities in parallel, then hydrate each child table in
  // one query per entity type. The old implementation issued one blocks query
  // per note, one segments query per source, and one key-point/evidence query
  // per card.
  const [noteRows, sourceRows, cardSetRows, cardRows] = await Promise.all([
    // CONC-03: 软删除的笔记不应被重新索引到搜索文档中
    executor.query.notes.findMany({
      where: and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      // N#8-1: 与 drift 用同一确定排序建立确定性截断子集（最近写入优先）。
      orderBy: reindexTopOrder.notes(notes),
    }),
    executor.query.sources.findMany({
      where: and(eq(sources.workspaceId, workspaceId), ne(sources.status, SourceStatus.ARCHIVED)),
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: reindexTopOrder.sources(sources),
    }),
    executor.query.learningCardSets.findMany({
      where: and(
        eq(learningCardSets.workspaceId, workspaceId),
        eq(learningCardSets.status, "active"),
      ),
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: reindexTopOrder.cardSets(learningCardSets),
    }),
    executor.query.learningCards.findMany({
      where: and(
        eq(learningCards.workspaceId, workspaceId),
        activeLearningCardConsumerPredicate(),
      ),
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: reindexTopOrder.cards(learningCards),
    }),
  ]);

  // N#7-1: 每表读阶段加行上限，超出记告警（超限部分不进入投影）。
  // N#8-1: 顺带记录"本次 reindex 是否截断"，供 auto-fix 判断是否应继续自动重索引。
  let wasCapped =
    noteRows.length >= REINDEX_MAX_ROWS_PER_TABLE ||
    sourceRows.length >= REINDEX_MAX_ROWS_PER_TABLE ||
    cardSetRows.length >= REINDEX_MAX_ROWS_PER_TABLE ||
    cardRows.length >= REINDEX_MAX_ROWS_PER_TABLE;
  if (wasCapped) {
    logger.warn(
      { workspaceId, limit: REINDEX_MAX_ROWS_PER_TABLE, counts: { notes: noteRows.length, sources: sourceRows.length, cardSets: cardSetRows.length, cards: cardRows.length } },
      "reindexWorkspaceSearch 达到单表行数上限，投影可能不完整",
    );
  }
  lastReindexCapped.set(workspaceId, wasCapped);
  // PERF: bound this bookkeeping map so it cannot grow without bound with the
  // number of distinct workspaces ever reindexed. The Map preserves insertion
  // order, so evicting the oldest entry when over the cap is a cheap LRU.
  const MAX_REINDEX_CAPPED_ENTRIES = 10_000;
  if (lastReindexCapped.size > MAX_REINDEX_CAPPED_ENTRIES) {
    const oldestKey = lastReindexCapped.keys().next().value;
    if (oldestKey !== undefined) lastReindexCapped.delete(oldestKey);
  }

  const currentVersionIds = noteRows.flatMap((note) =>
    note.currentVersionId ? [note.currentVersionId] : [],
  );
  const sourceIds = sourceRows.map((source) => source.id);
  const cardIds = cardRows.map((card) => card.id);
  const [blockRows, segmentRows, keyPointRows] = await Promise.all([
    currentVersionIds.length > 0
      ? chunkedInArraySelect(
          (chunk) => executor.query.noteBlocks.findMany({
            where: inArray(noteBlocks.versionId, chunk),
            orderBy: [asc(noteBlocks.versionId), asc(noteBlocks.ordinal)],
          }),
          currentVersionIds,
        )
      : Promise.resolve([]),
    sourceIds.length > 0
      ? chunkedInArraySelect(
          (chunk) => executor.query.sourceSegments.findMany({
            where: inArray(sourceSegments.sourceId, chunk),
            orderBy: [asc(sourceSegments.sourceId), asc(sourceSegments.ordinal)],
          }),
          sourceIds,
        )
      : Promise.resolve([]),
    cardIds.length > 0
      ? chunkedInArraySelect(
          (chunk) => executor.query.cardKeyPoints.findMany({
            where: and(
              eq(cardKeyPoints.workspaceId, workspaceId),
              inArray(cardKeyPoints.cardId, chunk),
            ),
            orderBy: [asc(cardKeyPoints.cardId), asc(cardKeyPoints.ordinal)],
          }),
          cardIds,
        )
      : Promise.resolve([]),
  ]);

  const keyPointIds = keyPointRows.map((keyPoint) => keyPoint.id);
  // N#7-1: evidence 为派生投影，限制为 REINDEX_MAX_ROWS_PER_TABLE 以内的
  // 确定性子集（与顶层实体的行数上限一致），避免无界内存占用。
  let wasEvidenceCapped = false;
  let evidenceRows: Array<typeof evidences.$inferSelect> = [];
  if (keyPointIds.length > 0) {
    const res = await chunkedInArraySelectCapped(
      (chunk) => executor.query.evidences.findMany({
        where: and(
          eq(evidences.workspaceId, workspaceId),
          inArray(evidences.keyPointId, chunk),
        ),
      }),
      keyPointIds,
      REINDEX_MAX_ROWS_PER_TABLE,
    );
    evidenceRows = res.rows;
    wasEvidenceCapped = res.capped;
  }
  if (wasEvidenceCapped) {
    wasCapped = true;
    lastReindexCapped.set(workspaceId, true);
    logger.warn(
      { workspaceId, limit: REINDEX_MAX_ROWS_PER_TABLE, evidences: evidenceRows.length },
      "reindexWorkspaceSearch evidence 达到派生表行数上限，投影可能不完整",
    );
  }

  const blockContentsByVersion = new Map<string, string[]>();
  for (const block of blockRows) {
    const contents = blockContentsByVersion.get(block.versionId) ?? [];
    contents.push(block.content);
    blockContentsByVersion.set(block.versionId, contents);
  }
  const segmentContentsBySource = new Map<string, string[]>();
  for (const segment of segmentRows) {
    const contents = segmentContentsBySource.get(segment.sourceId) ?? [];
    contents.push(segment.text);
    segmentContentsBySource.set(segment.sourceId, contents);
  }
  const keyPointsByCard = new Map<string, typeof keyPointRows>();
  for (const keyPoint of keyPointRows) {
    const entries = keyPointsByCard.get(keyPoint.cardId) ?? [];
    entries.push(keyPoint);
    keyPointsByCard.set(keyPoint.cardId, entries);
  }
  const evidencesByKeyPoint = new Map<string, typeof evidenceRows>();
  for (const evidence of evidenceRows) {
    const entries = evidencesByKeyPoint.get(evidence.keyPointId) ?? [];
    entries.push(evidence);
    evidencesByKeyPoint.set(evidence.keyPointId, entries);
  }

  const noteData = noteRows.flatMap((note) => note.currentVersionId
    ? [{
        id: note.id,
        title: note.title,
        body: (blockContentsByVersion.get(note.currentVersionId) ?? []).join("\n"),
      }]
    : []);
  const sourceData = sourceRows.map((source) => {
    const metadata = source.metadata as Record<string, unknown> | null;
    const fallbackBody = [
      source.origin,
      typeof metadata?.rawContent === "string" ? metadata.rawContent : "",
      typeof metadata?.url === "string" ? metadata.url : "",
    ].filter(Boolean).join("\n");
    const segmentContents = segmentContentsBySource.get(source.id) ?? [];
    return {
      id: source.id,
      title: source.title,
      body: segmentContents.length > 0 ? segmentContents.join("\n") : fallbackBody,
      type: source.type,
    };
  });
  const cardsById = new Map(cardRows.map((card) => [card.id, card]));

  // R-017: 原子事务 — 删除 + 重建在同一事务内
  try {
    await executor.transaction(async (tx) => {
      // Do not delete a projection updated after this rebuild started. On a
      // conflict below, the same timestamp fence prevents stale snapshot data
      // from overwriting a newer request-path upsert.
      const deletedRows = await tx
        .delete(searchDocuments)
        .where(and(
          eq(searchDocuments.workspaceId, workspaceId),
          lt(searchDocuments.indexedAt, projectionStartedAt),
        ))
        .returning({ id: searchDocuments.id });
      deletedCount = deletedRows.length;

      // PERF: 逐实体类型流式批量插入，而非先物化整份 documents 数组再插入。
      // 每类文档数组有界（顶层实体已受 REINDEX_MAX_ROWS_PER_TABLE 限制，
      // evidence 也按同样上限截断），避免一次性把所有文档对象放入内存。
      const INSERT_BATCH_SIZE = 500;
      const insertBatch = async (docs: Array<typeof searchDocuments.$inferInsert>): Promise<void> => {
        for (let start = 0; start < docs.length; start += INSERT_BATCH_SIZE) {
          await tx
            .insert(searchDocuments)
            .values(docs.slice(start, start + INSERT_BATCH_SIZE))
            .onConflictDoUpdate({
              target: [searchDocuments.workspaceId, searchDocuments.objectType, searchDocuments.objectId],
              set: {
                title: sql`excluded.title`,
                body: sql`excluded.body`,
                metadata: sql`excluded.metadata`,
                indexedAt: sql`excluded.indexed_at`,
              },
              // Prefer a request-path projection when both writes happen in the
              // same timestamp tick; strict comparison avoids overwriting it.
              setWhere: lt(searchDocuments.indexedAt, projectionStartedAt),
            });
        }
      };

      // notes
      await insertBatch(noteData.map((note) => ({
        workspaceId,
        objectType: "note",
        objectId: note.id,
        title: note.title,
        body: note.body,
        metadata: {},
        indexedAt: projectionStartedAt,
      })));

      // sources
      await insertBatch(sourceData.map((source) => ({
        workspaceId,
        objectType: "source",
        objectId: source.id,
        title: source.title,
        body: source.body,
        metadata: { type: source.type },
        indexedAt: projectionStartedAt,
      })));

      // card sets
      await insertBatch(cardSetRows.map((cardSet) => ({
        workspaceId,
        objectType: "card_set",
        objectId: cardSet.id,
        title: cardSet.title,
        body: cardSet.summary,
        metadata: {
          cardSetId: cardSet.id,
          noteId: cardSet.noteId,
          noteVersionId: cardSet.noteVersionId,
        },
        indexedAt: projectionStartedAt,
      })));

      // cards
      await insertBatch(cardRows.map((card) => {
        const keyPoints = keyPointsByCard.get(card.id) ?? [];
        return {
          workspaceId,
          objectType: "card",
          objectId: card.id,
          title: card.schemaJson.title,
          body: [card.schemaJson.summary, ...keyPoints.map((keyPoint) => keyPoint.claim)].join("\n"),
          metadata: {
            noteVersionId: card.noteVersionId,
            cardSetId: card.cardSetId,
            scope: card.scope,
            ordinal: card.ordinal,
          },
          indexedAt: projectionStartedAt,
        };
      }));

      // evidences
      await insertBatch(keyPointRows.flatMap((keyPoint) =>
        (evidencesByKeyPoint.get(keyPoint.id) ?? []).map((evidence) => {
          const card = cardsById.get(keyPoint.cardId);
          return {
            workspaceId,
            objectType: "evidence",
            objectId: evidence.id,
            title: keyPoint.claim,
            body: evidence.quoteText,
            metadata: {
              keyPointId: keyPoint.id,
              cardId: keyPoint.cardId,
              cardSetId: card?.cardSetId ?? null,
              scope: card?.scope ?? null,
              ordinal: card?.ordinal ?? null,
              alignment: evidence.alignment,
            },
            indexedAt: projectionStartedAt,
          };
        }),
      ));

      // A domain row can be deleted or archived after the snapshot was read
      // but before this transaction starts. Reconcile the freshly inserted
      // projection against the current domain tables so such a race cannot
      // resurrect a ghost search result. Request-path projections newer than
      // the rebuild fence remain untouched.
      //
      // PERF-08: This ghost cleanup was previously inside the transaction,
      // holding locks for a long time on large workspaces (10000+ docs).
      // Moving it after the transaction commit reduces lock duration at the
      // cost of a brief window where ghost docs may be visible. This is
      // acceptable for a manual reindex operation — the ghosts will be
      // cleaned within seconds of the commit.
    });

    // PERF-08: Post-commit ghost cleanup — runs after the transaction has
    // released its locks, reducing blocking on concurrent writes.
    indexed = {
      note: noteData.length,
      source: sourceData.length,
      cardSet: cardSetRows.length,
      card: cardRows.length,
      evidence: evidenceRows.length,
    };

    await executor.execute(sql`
        DELETE FROM search_documents AS search_document
        WHERE search_document.workspace_id = ${workspaceId}
          AND search_document.indexed_at <= ${projectionStartedAt.toISOString()}::timestamptz
          AND (
            (
              search_document.object_type = 'note'
              AND NOT EXISTS (
                SELECT 1 FROM notes AS domain_note
                WHERE domain_note.id = search_document.object_id
                  AND domain_note.workspace_id = ${workspaceId}
              )
            )
            OR (
              search_document.object_type = 'source'
              AND NOT EXISTS (
                SELECT 1 FROM sources AS domain_source
                WHERE domain_source.id = search_document.object_id
                  AND domain_source.workspace_id = ${workspaceId}
                  AND domain_source.status <> ${SourceStatus.ARCHIVED}
              )
            )
            OR (
              search_document.object_type = 'card_set'
              AND NOT EXISTS (
                SELECT 1 FROM learning_card_sets AS domain_card_set
                WHERE domain_card_set.id = search_document.object_id
                  AND domain_card_set.workspace_id = ${workspaceId}
                  AND domain_card_set.status = 'active'
              )
            )
            OR (
              search_document.object_type = 'card'
              AND NOT EXISTS (
                SELECT 1 FROM learning_cards AS domain_card
                WHERE domain_card.id = search_document.object_id
                  AND domain_card.workspace_id = ${workspaceId}
                  AND domain_card.status = ${CardStatus.ACTIVE}
                  AND (
                    domain_card.card_set_id IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM learning_card_sets AS parent_set
                      WHERE parent_set.id = domain_card.card_set_id
                        AND parent_set.workspace_id = domain_card.workspace_id
                        AND parent_set.status = 'active'
                    )
                  )
              )
            )
            OR (
              search_document.object_type = 'evidence'
              AND NOT EXISTS (
                SELECT 1
                FROM evidences AS domain_evidence
                JOIN card_key_points AS domain_key_point
                  ON domain_key_point.id = domain_evidence.key_point_id
                 AND domain_key_point.workspace_id = domain_evidence.workspace_id
                JOIN learning_cards AS domain_card
                  ON domain_card.id = domain_key_point.card_id
                 AND domain_card.workspace_id = domain_key_point.workspace_id
                WHERE domain_evidence.id = search_document.object_id
                  AND domain_evidence.workspace_id = ${workspaceId}
                  AND domain_card.status = ${CardStatus.ACTIVE}
                  AND (
                    domain_card.card_set_id IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM learning_card_sets AS parent_set
                      WHERE parent_set.id = domain_card.card_set_id
                        AND parent_set.workspace_id = domain_card.workspace_id
                        AND parent_set.status = 'active'
                    )
                  )
              )
            )
          )
      `);
  } catch (err) {
    // A rolled-back rebuild changed neither the old index nor the reported
    // counters. The old code leaked pre-rollback counts as if work succeeded.
    deletedCount = 0;
    indexed = { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0 };
    logger.error({ err, workspaceId }, "reindex transaction failed — old index preserved");
    errors = 1;
  }

  return { deleted: deletedCount, indexed, errors, capped: lastReindexCapped.get(workspaceId) ?? false };
}

/**
 * F-025: 搜索索引漂移检测。
 *
 * 对比 search_documents 投影表与业务主表，检测以下不一致：
 * - 幽灵文档：搜索索引中存在但业务表中已删除或不应索引的对象
 * - 缺失文档：业务表中存在应在搜索索引中但缺失的对象
 * - 过期标题：搜索索引中的标题与业务表当前标题不匹配
 *
 * 返回漂移详情，供前端展示和触发 reindex 补偿。
 */
export interface SearchDriftResult {
  /** 业务表应有对象数 */
  expected: {
    note: number;
    source: number;
    cardSet: number;
    card: number;
    evidence: number;
  };
  /** 搜索索引实际对象数 */
  actual: {
    note: number;
    source: number;
    cardSet: number;
    card: number;
    evidence: number;
  };
  /** 幽灵文档 ID（索引中有但业务表中不存在） */
  ghosts: { objectType: string; objectId: string }[];
  /** 缺失文档 ID（业务表中有但索引中缺失） */
  missing: { objectType: string; objectId: string }[];
  /** 标题不匹配的文档 */
  staleTitles: { objectType: string; objectId: string; indexedTitle: string | null; actualTitle: string }[];
  /** 正文不匹配的文档（R-017: 新增正文过期检测） */
  staleBodies: { objectType: string; objectId: string }[];
  /** 是否检测到漂移 */
  hasDrift: boolean;
  /** N#8-1: 各顶层业务域表读是否命中行数上限（截断）。实体超过确定截断线时两侧都不会读取，
   *  属既定截断而非漂移；auto-fix 据此避免反复重索引。
   *  evidence 记录的是证据索引读是否命中行数上限：该侧被截断时，超出窗口的证据 id
   *  不报 missing（可能是索引中存在但未进入确定读窗口，属既定截断而非漂移）。 */
  capped: Record<"note" | "source" | "cardSet" | "card" | "evidence", boolean>;
}

export async function detectSearchDrift(
  executor: ApiTransaction,
  workspaceId: string,
): Promise<SearchDriftResult> {
  const ghosts: { objectType: string; objectId: string }[] = [];
  const missing: { objectType: string; objectId: string }[] = [];
  const staleTitles: { objectType: string; objectId: string; indexedTitle: string | null; actualTitle: string }[] = [];

  // PERF-07: Parallelize queries across entity types.
  // Previously 12 serial DB round-trips; now 2 parallel batches.

  // ── Batch 1: All business table + index queries for notes, sources, card_sets, cards ──
  const [
    noteRows,
    indexedNotes,
    sourceRows,
    indexedSources,
    cardSetRows,
    indexedCardSets,
    cardRows,
    indexedCards,
  ] = await Promise.all([
    // 1a. Notes business table (CONC-03: exclude soft-deleted)
    // N#8-1: 与 reindex 用同一上限 + 同一确定排序，读取同一确定截断子集，避免把超线实体误判 missing。
    executor.query.notes.findMany({
      where: and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
      columns: { id: true, title: true, currentVersionId: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: reindexTopOrder.notes(notes),
    }),
    // 1b. Notes index (deterministic limit matches business-table cap; capped side = known truncation)
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "note")),
      columns: { objectId: true, title: true, body: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: [desc(searchDocuments.indexedAt), asc(searchDocuments.objectId)],
    }),
    // 1c. Sources business table (exclude archived)
    executor.query.sources.findMany({
      where: and(eq(sources.workspaceId, workspaceId), ne(sources.status, SourceStatus.ARCHIVED)),
      columns: { id: true, title: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: reindexTopOrder.sources(sources),
    }),
    // 1d. Sources index (deterministic limit matches business-table cap; capped side = known truncation)
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "source")),
      columns: { objectId: true, title: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: [desc(searchDocuments.indexedAt), asc(searchDocuments.objectId)],
    }),
    // 1e. Card sets business table (active only)
    executor.query.learningCardSets.findMany({
      where: and(
        eq(learningCardSets.workspaceId, workspaceId),
        eq(learningCardSets.status, "active"),
      ),
      columns: { id: true, title: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: reindexTopOrder.cardSets(learningCardSets),
    }),
    // 1f. Card sets index (deterministic limit matches business-table cap; capped side = known truncation)
    executor.query.searchDocuments.findMany({
      where: and(
        eq(searchDocuments.workspaceId, workspaceId),
        eq(searchDocuments.objectType, "card_set"),
      ),
      columns: { objectId: true, title: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: [desc(searchDocuments.indexedAt), asc(searchDocuments.objectId)],
    }),
    // 1g. Cards business table (active consumer predicate)
    executor.query.learningCards.findMany({
      where: and(
        eq(learningCards.workspaceId, workspaceId),
        activeLearningCardConsumerPredicate(),
      ),
      columns: { id: true, schemaJson: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: reindexTopOrder.cards(learningCards),
    }),
    // 1h. Cards index (deterministic limit matches business-table cap; capped side = known truncation)
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "card")),
      columns: { objectId: true, title: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: [desc(searchDocuments.indexedAt), asc(searchDocuments.objectId)],
    }),
  ]);

  // N#8-1: 记录各顶层业务域表读是否命中行数上限（截断）。截断意味着域名表真实超过
  // REINDEX_MAX_ROWS_PER_TABLE，能进入索引的只是确定的前 LIMIT 子集。此时：
  //  - missing 只对"已读入窗口内但索引缺失"的实体报告（真实窗口内漂移，保持）；
  //  - ghost 对"索引有而业务读窗口无"的实体不再报告（超线实体可能仍合法存在于业务表中，
  //    只是未进入当前确定窗口，把它们当 ghost 会误报），并记告警。
  // 这样 auto-fix 只在真实漂移时触发，截断场景不反复重索引。
  const capped: Record<"note" | "source" | "cardSet" | "card" | "evidence", boolean> = {
    note: noteRows.length >= REINDEX_MAX_ROWS_PER_TABLE,
    source: sourceRows.length >= REINDEX_MAX_ROWS_PER_TABLE,
    cardSet: cardSetRows.length >= REINDEX_MAX_ROWS_PER_TABLE,
    card: cardRows.length >= REINDEX_MAX_ROWS_PER_TABLE,
    // evidence 在 batch 2 得到 indexedEvidences 后填充（见下方证据漂移处理前）。
    evidence: false,
  };

  // Process notes drift
  const noteIds = new Set(noteRows.filter((n) => n.currentVersionId).map((n) => n.id));
  const noteTitleMap = new Map(noteRows.filter((n) => n.currentVersionId).map((n) => [n.id, n.title]));
  const indexedNoteIds = new Set(indexedNotes.map((d) => d.objectId));
  for (const doc of indexedNotes) {
    if (!noteIds.has(doc.objectId)) {
      if (!capped.note) {
        ghosts.push({ objectType: "note", objectId: doc.objectId });
      }
    } else {
      const actualTitle = noteTitleMap.get(doc.objectId);
      if (actualTitle !== undefined && actualTitle !== doc.title) {
        staleTitles.push({ objectType: "note", objectId: doc.objectId, indexedTitle: doc.title, actualTitle });
      }
    }
  }
  for (const id of noteIds) {
    if (!indexedNoteIds.has(id)) {
      missing.push({ objectType: "note", objectId: id });
    }
  }

  // Process sources drift
  const sourceIds = new Set(sourceRows.map((s) => s.id));
  const sourceTitleMap = new Map(sourceRows.map((s) => [s.id, s.title]));
  const indexedSourceIds = new Set(indexedSources.map((d) => d.objectId));
  for (const doc of indexedSources) {
    if (!sourceIds.has(doc.objectId)) {
      if (!capped.source) {
        ghosts.push({ objectType: "source", objectId: doc.objectId });
      }
    } else {
      const actualTitle = sourceTitleMap.get(doc.objectId);
      if (actualTitle !== undefined && actualTitle !== doc.title) {
        staleTitles.push({ objectType: "source", objectId: doc.objectId, indexedTitle: doc.title, actualTitle });
      }
    }
  }
  for (const id of sourceIds) {
    if (!indexedSourceIds.has(id)) {
      missing.push({ objectType: "source", objectId: id });
    }
  }

  // Process card sets drift
  const cardSetIds = new Set(cardSetRows.map((cardSet) => cardSet.id));
  const cardSetTitleMap = new Map(cardSetRows.map((cardSet) => [cardSet.id, cardSet.title]));
  const indexedCardSetIds = new Set(indexedCardSets.map((document) => document.objectId));
  for (const document of indexedCardSets) {
    if (!cardSetIds.has(document.objectId)) {
      if (!capped.cardSet) {
        ghosts.push({ objectType: "card_set", objectId: document.objectId });
      }
    } else {
      const actualTitle = cardSetTitleMap.get(document.objectId);
      if (actualTitle !== undefined && actualTitle !== document.title) {
        staleTitles.push({ objectType: "card_set", objectId: document.objectId, indexedTitle: document.title, actualTitle });
      }
    }
  }
  for (const id of cardSetIds) {
    if (!indexedCardSetIds.has(id)) {
      missing.push({ objectType: "card_set", objectId: id });
    }
  }

  // Process cards drift
  const cardIds = new Set(cardRows.map((c) => c.id));
  const cardTitleMap = new Map(
    cardRows.map((c) => [c.id, (c.schemaJson as { title?: string }).title ?? ""]),
  );
  const indexedCardIds = new Set(indexedCards.map((d) => d.objectId));
  for (const doc of indexedCards) {
    if (!cardIds.has(doc.objectId)) {
      if (!capped.card) {
        ghosts.push({ objectType: "card", objectId: doc.objectId });
      }
    } else {
      const actualTitle = cardTitleMap.get(doc.objectId);
      if (actualTitle !== undefined && actualTitle !== doc.title) {
        staleTitles.push({ objectType: "card", objectId: doc.objectId, indexedTitle: doc.title, actualTitle });
      }
    }
  }
  for (const id of cardIds) {
    if (!indexedCardIds.has(id)) {
      missing.push({ objectType: "card", objectId: id });
    }
  }

  // ── Batch 2: Evidence queries (depend on cardIds) + stale body detection (depends on noteRows) ──
  const activeCardIds = Array.from(cardIds);
  const currentVersionIds = noteRows.flatMap((note) =>
    note.currentVersionId ? [note.currentVersionId] : [],
  );

  // Run evidence and stale-body queries in parallel
  const [evidenceIds, indexedEvidences, currentBlocks] = await Promise.all([
    // Evidence: query keyPoints → evidences (chained, but parallel with other batch 2 queries)
    (async (): Promise<Set<string>> => {
      if (activeCardIds.length === 0) return new Set<string>();
      const activeKpRows = await chunkedInArraySelect(
        (chunk) => executor.query.cardKeyPoints.findMany({
          where: and(
            eq(cardKeyPoints.workspaceId, workspaceId),
            inArray(cardKeyPoints.cardId, chunk),
          ),
          columns: { id: true },
        }),
        activeCardIds,
      );
      const activeKpIds = activeKpRows.map((k) => k.id);
      if (activeKpIds.length === 0) return new Set<string>();
      const evidenceRows = await chunkedInArraySelect(
        (chunk) => executor.query.evidences.findMany({
          where: and(
            eq(evidences.workspaceId, workspaceId),
            inArray(evidences.keyPointId, chunk),
          ),
          columns: { id: true },
        }),
        activeKpIds,
      );
      return new Set(evidenceRows.map((e) => e.id));
    })(),
    // Evidence index (deterministic limit keeps drift analysis bounded; capped side = known truncation)
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "evidence")),
      columns: { objectId: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: [desc(searchDocuments.indexedAt), asc(searchDocuments.objectId)],
    }),
    // Stale body: batch-read note blocks
    currentVersionIds.length > 0
      ? chunkedInArraySelect(
          (chunk) => executor.query.noteBlocks.findMany({
            where: inArray(noteBlocks.versionId, chunk),
            orderBy: [asc(noteBlocks.versionId), asc(noteBlocks.ordinal)],
          }),
          currentVersionIds,
        )
      : Promise.resolve([]),
  ]);

  // 证据索引读同样被 REINDEX_MAX_ROWS_PER_TABLE 限行：命中上限即视为已知截断。
  capped.evidence = indexedEvidences.length >= REINDEX_MAX_ROWS_PER_TABLE;

  // Process evidence drift
  const indexedEvidenceIds = new Set(indexedEvidences.map((d) => d.objectId));
  for (const doc of indexedEvidences) {
    if (!evidenceIds.has(doc.objectId)) {
      ghosts.push({ objectType: "evidence", objectId: doc.objectId });
    }
  }
  for (const id of evidenceIds) {
    if (!indexedEvidenceIds.has(id)) {
      // 证据索引读被截断时，业务侧超线 id 可能只是尚未进入确定读窗口，
      // 而非真正缺失 —— 属既定截断，不报 missing（避免误触发 auto-fix）。
      if (!capped.evidence) {
        missing.push({ objectType: "evidence", objectId: id });
      }
    }
  }

  // Process stale bodies
  // BUG-51 修复：过滤 image block，与 upsertSearchDocument 保持一致。
  // 索引时 upsertSearchDocument 已排除 image block（type !== "image"），
  // detectSearchDrift 的 stale body 比较也必须排除 image block，
  // 否则包含图片的笔记会持续被误报为 stale。
  const staleBodies: { objectType: string; objectId: string }[] = [];
  const bodyByVersion = new Map<string, string[]>();
  for (const block of currentBlocks) {
    if (block.type === "image") continue;
    const contents = bodyByVersion.get(block.versionId) ?? [];
    contents.push(block.content);
    bodyByVersion.set(block.versionId, contents);
  }
  const indexedNoteById = new Map(indexedNotes.map((document) => [document.objectId, document]));
  for (const note of noteRows) {
    if (!note.currentVersionId) continue;
    const indexedDoc = indexedNoteById.get(note.id);
    if (!indexedDoc) continue;
    const actualBody = (bodyByVersion.get(note.currentVersionId) ?? []).join("\n");
    if (indexedDoc.body !== actualBody) {
      staleBodies.push({ objectType: "note", objectId: note.id });
    }
  }

  const expected = {
    note: noteIds.size,
    source: sourceIds.size,
    cardSet: cardSetIds.size,
    card: cardIds.size,
    evidence: evidenceIds.size,
  };
  const actual = {
    note: indexedNotes.length,
    source: indexedSources.length,
    cardSet: indexedCardSets.length,
    card: indexedCards.length,
    evidence: indexedEvidences.length,
  };

  return {
    expected,
    actual,
    ghosts,
    missing,
    staleTitles,
    staleBodies,
    capped,
    hasDrift: ghosts.length > 0 || missing.length > 0 || staleTitles.length > 0 || staleBodies.length > 0,
  };
}

// ─── ARCH-01 修复：搜索索引自动漂移补偿 ─────────────────────────────────────

/**
 * ARCH-01 修复：自动检测并修复搜索索引漂移。
 *
 * 此函数封装了 detectSearchDrift + 条件触发 reindexWorkspaceSearch 的自动化流程，
 * 可由定时任务（cron）或启动检查调用。
 *
 * 策略：
 * - 检测漂移（ghosts + missing + staleTitles + staleBodies）
 * - 如果漂移总数超过阈值（默认 50），自动触发 reindex
 * - 如果漂移总数低于阈值但大于 0，仅记录警告日志（不自动修复）
 * - 返回检测和修复结果
 *
 * @param executor 事务执行器
 * @param workspaceId 工作区 ID
 * @param autoFixThreshold 自动修复的漂移阈值，默认 50
 * @returns 检测结果和是否触发了修复
 */
export async function autoFixSearchDrift(
  executor: ApiTransaction,
  workspaceId: string,
  autoFixThreshold = 50,
): Promise<{ drift: SearchDriftResult; autoFixed: boolean }> {
  const drift = await detectSearchDrift(executor, workspaceId);

  if (!drift.hasDrift) {
    return { drift, autoFixed: false };
  }

  const totalDrift =
    drift.ghosts.length +
    drift.missing.length +
    drift.staleTitles.length +
    drift.staleBodies.length;

  // logger 已在文件顶部静态导入，直接使用
  if (totalDrift >= autoFixThreshold) {
    logger.warn(
      {
        workspaceId,
        totalDrift,
        ghosts: drift.ghosts.length,
        missing: drift.missing.length,
        staleTitles: drift.staleTitles.length,
        staleBodies: drift.staleBodies.length,
      },
      "搜索索引漂移超过阈值，自动触发 reindex 补偿（ARCH-01）",
    );
    await reindexWorkspaceSearch(executor, workspaceId);
    return { drift, autoFixed: true };
  }

  // 漂移量较小，仅记录信息日志
  logger.info(
    {
      workspaceId,
      totalDrift,
      ghosts: drift.ghosts.length,
      missing: drift.missing.length,
      staleTitles: drift.staleTitles.length,
      staleBodies: drift.staleBodies.length,
    },
    "搜索索引检测到少量漂移，未达到自动修复阈值（ARCH-01）",
  );

  return { drift, autoFixed: false };
}
