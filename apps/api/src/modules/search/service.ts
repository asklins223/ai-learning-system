import { and, asc, eq, ne, sql, inArray, lt, isNull } from "drizzle-orm";
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

  // The page and total are independent reads; run them concurrently to avoid
  // paying two database round trips serially on every keystroke.
  const [rows, countRows] = await Promise.all([
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
    // N-012: total 统计去重后的实体数
    executor.execute<{ count: string }>(sql`
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
            body ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
            OR title ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
          )
          AND (${type}::text IS NULL OR object_type = ${type})
          AND ${consumableSearchDocumentPredicate}
      ) as distinct_entities
    `),
  ]);
  const total = Number(countRows[0]?.count ?? 0);

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
  // one query. The old implementation issued one blocks query per note, one
  // segments query per source, and one key-point/evidence query per card.
  const [noteRows, sourceRows, cardSetRows, cardRows] = await Promise.all([
    // CONC-03: 软删除的笔记不应被重新索引到搜索文档中
    executor.query.notes.findMany({ where: and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)) }),
    executor.query.sources.findMany({
      where: and(eq(sources.workspaceId, workspaceId), ne(sources.status, SourceStatus.ARCHIVED)),
    }),
    executor.query.learningCardSets.findMany({
      where: and(
        eq(learningCardSets.workspaceId, workspaceId),
        eq(learningCardSets.status, "active"),
      ),
    }),
    executor.query.learningCards.findMany({
      where: and(
        eq(learningCards.workspaceId, workspaceId),
        activeLearningCardConsumerPredicate(),
      ),
    }),
  ]);

  const currentVersionIds = noteRows.flatMap((note) =>
    note.currentVersionId ? [note.currentVersionId] : [],
  );
  const sourceIds = sourceRows.map((source) => source.id);
  const cardIds = cardRows.map((card) => card.id);
  const [blockRows, segmentRows, keyPointRows] = await Promise.all([
    currentVersionIds.length > 0
      ? executor.query.noteBlocks.findMany({
          where: inArray(noteBlocks.versionId, currentVersionIds),
          orderBy: [asc(noteBlocks.versionId), asc(noteBlocks.ordinal)],
        })
      : Promise.resolve([]),
    sourceIds.length > 0
      ? executor.query.sourceSegments.findMany({
          where: inArray(sourceSegments.sourceId, sourceIds),
          orderBy: [asc(sourceSegments.sourceId), asc(sourceSegments.ordinal)],
        })
      : Promise.resolve([]),
    cardIds.length > 0
      ? executor.query.cardKeyPoints.findMany({
          where: and(
            eq(cardKeyPoints.workspaceId, workspaceId),
            inArray(cardKeyPoints.cardId, cardIds),
          ),
          orderBy: [asc(cardKeyPoints.cardId), asc(cardKeyPoints.ordinal)],
        })
      : Promise.resolve([]),
  ]);

  const keyPointIds = keyPointRows.map((keyPoint) => keyPoint.id);
  const evidenceRows = keyPointIds.length > 0
    ? await executor.query.evidences.findMany({
        where: and(
          eq(evidences.workspaceId, workspaceId),
          inArray(evidences.keyPointId, keyPointIds),
        ),
      })
    : [];

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

  const documents: Array<typeof searchDocuments.$inferInsert> = [
    ...noteData.map((note) => ({
      workspaceId,
      objectType: "note",
      objectId: note.id,
      title: note.title,
      body: note.body,
      metadata: {},
      indexedAt: projectionStartedAt,
    })),
    ...sourceData.map((source) => ({
      workspaceId,
      objectType: "source",
      objectId: source.id,
      title: source.title,
      body: source.body,
      metadata: { type: source.type },
      indexedAt: projectionStartedAt,
    })),
    ...cardSetRows.map((cardSet) => ({
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
    })),
    ...cardRows.map((card) => {
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
    }),
    ...keyPointRows.flatMap((keyPoint) =>
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
    ),
  ];

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

      const INSERT_BATCH_SIZE = 500;
      for (let start = 0; start < documents.length; start += INSERT_BATCH_SIZE) {
        await tx
          .insert(searchDocuments)
          .values(documents.slice(start, start + INSERT_BATCH_SIZE))
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

  return { deleted: deletedCount, indexed, errors };
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
    executor.query.notes.findMany({
      where: and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
      columns: { id: true, title: true, currentVersionId: true },
    }),
    // 1b. Notes index
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "note")),
      columns: { objectId: true, title: true, body: true },
    }),
    // 1c. Sources business table (exclude archived)
    executor.query.sources.findMany({
      where: and(eq(sources.workspaceId, workspaceId), ne(sources.status, SourceStatus.ARCHIVED)),
      columns: { id: true, title: true },
    }),
    // 1d. Sources index
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "source")),
      columns: { objectId: true, title: true },
    }),
    // 1e. Card sets business table (active only)
    executor.query.learningCardSets.findMany({
      where: and(
        eq(learningCardSets.workspaceId, workspaceId),
        eq(learningCardSets.status, "active"),
      ),
      columns: { id: true, title: true },
    }),
    // 1f. Card sets index
    executor.query.searchDocuments.findMany({
      where: and(
        eq(searchDocuments.workspaceId, workspaceId),
        eq(searchDocuments.objectType, "card_set"),
      ),
      columns: { objectId: true, title: true },
    }),
    // 1g. Cards business table (active consumer predicate)
    executor.query.learningCards.findMany({
      where: and(
        eq(learningCards.workspaceId, workspaceId),
        activeLearningCardConsumerPredicate(),
      ),
      columns: { id: true, schemaJson: true },
    }),
    // 1h. Cards index
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "card")),
      columns: { objectId: true, title: true },
    }),
  ]);

  // Process notes drift
  const noteIds = new Set(noteRows.filter((n) => n.currentVersionId).map((n) => n.id));
  const noteTitleMap = new Map(noteRows.filter((n) => n.currentVersionId).map((n) => [n.id, n.title]));
  const indexedNoteIds = new Set(indexedNotes.map((d) => d.objectId));
  for (const doc of indexedNotes) {
    if (!noteIds.has(doc.objectId)) {
      ghosts.push({ objectType: "note", objectId: doc.objectId });
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
      ghosts.push({ objectType: "source", objectId: doc.objectId });
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
      ghosts.push({ objectType: "card_set", objectId: document.objectId });
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
      ghosts.push({ objectType: "card", objectId: doc.objectId });
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
      const activeKpRows = await executor.query.cardKeyPoints.findMany({
        where: and(
          eq(cardKeyPoints.workspaceId, workspaceId),
          inArray(cardKeyPoints.cardId, activeCardIds),
        ),
        columns: { id: true },
      });
      const activeKpIds = activeKpRows.map((k) => k.id);
      if (activeKpIds.length === 0) return new Set<string>();
      const evidenceRows = await executor.query.evidences.findMany({
        where: and(
          eq(evidences.workspaceId, workspaceId),
          inArray(evidences.keyPointId, activeKpIds),
        ),
        columns: { id: true },
      });
      return new Set(evidenceRows.map((e) => e.id));
    })(),
    // Evidence index
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "evidence")),
      columns: { objectId: true },
    }),
    // Stale body: batch-read note blocks
    currentVersionIds.length > 0
      ? executor.query.noteBlocks.findMany({
          where: inArray(noteBlocks.versionId, currentVersionIds),
          orderBy: [asc(noteBlocks.versionId), asc(noteBlocks.ordinal)],
        })
      : Promise.resolve([]),
  ]);

  // Process evidence drift
  const indexedEvidenceIds = new Set(indexedEvidences.map((d) => d.objectId));
  for (const doc of indexedEvidences) {
    if (!evidenceIds.has(doc.objectId)) {
      ghosts.push({ objectType: "evidence", objectId: doc.objectId });
    }
  }
  for (const id of evidenceIds) {
    if (!indexedEvidenceIds.has(id)) {
      missing.push({ objectType: "evidence", objectId: id });
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
