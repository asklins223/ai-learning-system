import { and, asc, eq, ne, sql, inArray } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { evidences } from "../../db/schema/evidence.ts";
import { notes, noteBlocks, sources, sourceSegments } from "../../db/schema/note.ts";
import { searchDocuments } from "../../db/schema/search.ts";
import { CardStatus, SourceStatus } from "@ailearn/shared";
import { logger } from "../../lib/logger.ts";

export interface SearchResult {
  objectType: string;
  objectId: string;
  title: string | null;
  snippet: string;
  indexedAt: string;
  href: string;
  /** 当 evidence 被按 card 聚合时，表示该 card 下有多少条 evidence 命中 */
  matchCount?: number;
}

/**
 * 全文搜索（pg_trgm + ILIKE，中文友好）。
 * N-012: 在 SQL 层按最终展示实体聚合去重，再计算 total 和分页。
 * 同一张 card 下的多条 evidence 只返回一条，但记录 matchCount。
 */
export async function search(
  workspaceId: string,
  query: string,
  opts?: { type?: string; limit?: number; offset?: number },
): Promise<{ items: SearchResult[]; total: number; nextOffset: number | null }> {
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

  const rows = await db.execute<{
    object_type: string;
    object_id: string;
    title: string | null;
    body: string | null;
    indexed_at: string;
    metadata: Record<string, unknown> | null;
    match_count: string;
  }>(sql`
    WITH matching AS (
      SELECT object_type, object_id, title, body, indexed_at, metadata,
        ${dedupKey} as dedup_key
      FROM search_documents
      WHERE workspace_id = ${workspaceId}
        AND (
          body ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
          OR title ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
        )
        AND (${type}::text IS NULL OR object_type = ${type})
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
  `);

  // N-012: total 统计去重后的实体数
  const countRows = await db.execute<{ count: string }>(sql`
    SELECT count(*) as count FROM (
      SELECT DISTINCT ON (
        CASE
          WHEN object_type = 'evidence' AND metadata->>'cardId' IS NOT NULL
          THEN 'evidence-card:' || (metadata->>'cardId')
          ELSE object_type || ':' || object_id
        END
      )
        1
      FROM search_documents
      WHERE workspace_id = ${workspaceId}
        AND (
          body ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
          OR title ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
        )
        AND (${type}::text IS NULL OR object_type = ${type})
    ) as distinct_entities
  `);
  const total = Number(countRows[0]?.count ?? 0);

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

    // 高亮关键词
    const highlighted = snippet.replace(
      new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      (match) => `«${match}»`,
    );

    // 生成 href
    let href = "";
    switch (row.object_type) {
      case "note":
        href = `/notes/${row.object_id}`;
        break;
      case "card":
        href = `/cards/${row.object_id}`;
        break;
      case "source":
        href = `/sources/${row.object_id}`;
        break;
      case "evidence": {
        const meta = row.metadata as Record<string, unknown> | null;
        const cardId = (meta?.cardId as string) ?? null;
        href = cardId ? `/cards/${cardId}` : "";
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
      indexedAt: row.indexed_at,
      href,
      matchCount: Number(row.match_count) || 1,
    };
  });

  const consumed = offset + items.length;
  return {
    items,
    total,
    nextOffset: consumed < total ? consumed : null,
  };
}

export interface SearchReindexResult {
  deleted: number;
  indexed: {
    note: number;
    source: number;
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
export async function reindexWorkspaceSearch(workspaceId: string): Promise<SearchReindexResult & { errors: number }> {
  let deletedCount = 0;
  const indexed = { note: 0, source: 0, card: 0, evidence: 0 };
  let errors = 0;

  // R-017: 在事务外预先收集所有数据，然后在事务内原子写入
  // 这样即使数据量大，事务也只包含写操作，减少锁持有时间

  // 1. 收集 notes
  const noteRows = await db.query.notes.findMany({
    where: eq(notes.workspaceId, workspaceId),
  });
  const noteData: Array<{ id: string; title: string; body: string }> = [];
  for (const note of noteRows) {
    if (!note.currentVersionId) continue;
    const blocks = await db.query.noteBlocks.findMany({
      where: eq(noteBlocks.versionId, note.currentVersionId),
      orderBy: [asc(noteBlocks.ordinal)],
    });
    noteData.push({
      id: note.id,
      title: note.title,
      body: blocks.map((block) => block.content).join("\n"),
    });
  }

  // 2. 收集 sources
  const sourceRows = await db.query.sources.findMany({
    where: and(eq(sources.workspaceId, workspaceId), ne(sources.status, SourceStatus.ARCHIVED)),
  });
  const sourceData: Array<{ id: string; title: string; body: string; type: string }> = [];
  for (const source of sourceRows) {
    const segments = await db.query.sourceSegments.findMany({
      where: eq(sourceSegments.sourceId, source.id),
      orderBy: [asc(sourceSegments.ordinal)],
    });
    const metadata = source.metadata as Record<string, unknown> | null;
    const fallbackBody = [
      source.origin,
      typeof metadata?.rawContent === "string" ? metadata.rawContent : "",
      typeof metadata?.url === "string" ? metadata.url : "",
    ].filter(Boolean).join("\n");
    sourceData.push({
      id: source.id,
      title: source.title,
      body: segments.length > 0 ? segments.map((segment) => segment.text).join("\n") : fallbackBody,
      type: source.type,
    });
  }

  // 3. 收集 cards + evidence
  const cardRows = await db.query.learningCards.findMany({
    where: and(eq(learningCards.workspaceId, workspaceId), eq(learningCards.status, CardStatus.ACTIVE)),
  });
  const cardData: Array<{
    id: string;
    title: string;
    body: string;
    noteVersionId: string;
    keyPoints: Array<{ id: string; claim: string; quoteText: string; evidences: Array<{ id: string; quoteText: string; alignment: string }> }>;
  }> = [];
  for (const card of cardRows) {
    const keyPoints = await db.query.cardKeyPoints.findMany({
      where: and(eq(cardKeyPoints.workspaceId, workspaceId), eq(cardKeyPoints.cardId, card.id)),
      orderBy: [asc(cardKeyPoints.ordinal)],
    });
    const kpData = [];
    for (const kp of keyPoints) {
      const evidenceRows = await db.query.evidences.findMany({
        where: and(eq(evidences.workspaceId, workspaceId), eq(evidences.keyPointId, kp.id)),
      });
      kpData.push({
        id: kp.id,
        claim: kp.claim,
        quoteText: kp.quoteText,
        evidences: evidenceRows.map((ev) => ({ id: ev.id, quoteText: ev.quoteText, alignment: ev.alignment })),
      });
    }
    cardData.push({
      id: card.id,
      title: card.schemaJson.title,
      body: [card.schemaJson.summary, ...keyPoints.map((kp) => kp.claim)].join("\n"),
      noteVersionId: card.noteVersionId,
      keyPoints: kpData,
    });
  }

  // R-017: 原子事务 — 删除 + 重建在同一事务内
  await db.transaction(async (tx) => {
    // 删除旧索引
    const deletedRows = await tx
      .delete(searchDocuments)
      .where(eq(searchDocuments.workspaceId, workspaceId))
      .returning({ id: searchDocuments.id });
    deletedCount = deletedRows.length;

    // 批量插入 notes
    for (const note of noteData) {
      await tx.insert(searchDocuments).values({
        workspaceId,
        objectType: "note",
        objectId: note.id,
        title: note.title,
        body: note.body,
        metadata: {},
        indexedAt: new Date(),
      }).onConflictDoUpdate({
        target: [searchDocuments.workspaceId, searchDocuments.objectType, searchDocuments.objectId],
        set: { title: note.title, body: note.body, metadata: {}, indexedAt: new Date() },
      });
      indexed.note++;
    }

    // 批量插入 sources
    for (const source of sourceData) {
      await tx.insert(searchDocuments).values({
        workspaceId,
        objectType: "source",
        objectId: source.id,
        title: source.title,
        body: source.body,
        metadata: { type: source.type },
        indexedAt: new Date(),
      }).onConflictDoUpdate({
        target: [searchDocuments.workspaceId, searchDocuments.objectType, searchDocuments.objectId],
        set: { title: source.title, body: source.body, metadata: { type: source.type }, indexedAt: new Date() },
      });
      indexed.source++;
    }

    // 批量插入 cards + evidence
    for (const card of cardData) {
      await tx.insert(searchDocuments).values({
        workspaceId,
        objectType: "card",
        objectId: card.id,
        title: card.title,
        body: card.body,
        metadata: { noteVersionId: card.noteVersionId },
        indexedAt: new Date(),
      }).onConflictDoUpdate({
        target: [searchDocuments.workspaceId, searchDocuments.objectType, searchDocuments.objectId],
        set: { title: card.title, body: card.body, metadata: { noteVersionId: card.noteVersionId }, indexedAt: new Date() },
      });
      indexed.card++;

      for (const kp of card.keyPoints) {
        for (const ev of kp.evidences) {
          await tx.insert(searchDocuments).values({
            workspaceId,
            objectType: "evidence",
            objectId: ev.id,
            title: kp.claim,
            body: ev.quoteText,
            metadata: { keyPointId: kp.id, cardId: card.id, alignment: ev.alignment },
            indexedAt: new Date(),
          }).onConflictDoUpdate({
            target: [searchDocuments.workspaceId, searchDocuments.objectType, searchDocuments.objectId],
            set: { title: kp.claim, body: ev.quoteText, metadata: { keyPointId: kp.id, cardId: card.id, alignment: ev.alignment }, indexedAt: new Date() },
          });
          indexed.evidence++;
        }
      }
    }
  }).catch((err) => {
    // R-017: 事务失败时记录错误，旧索引保留
    logger.error({ err, workspaceId }, "reindex transaction failed — old index preserved");
    errors = 1;
  });

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
    card: number;
    evidence: number;
  };
  /** 搜索索引实际对象数 */
  actual: {
    note: number;
    source: number;
    card: number;
    evidence: number;
  };
  /** 幽灵文档 ID（索引中有但业务表中不存在） */
  ghosts: { objectType: string; objectId: string }[];
  /** 缺失文档 ID（业务表中有但索引中缺失） */
  missing: { objectType: string; objectId: string }[];
  /** 标题不匹配的文档 */
  staleTitles: { objectType: string; objectId: string; indexedTitle: string; actualTitle: string }[];
  /** 正文不匹配的文档（R-017: 新增正文过期检测） */
  staleBodies: { objectType: string; objectId: string }[];
  /** 是否检测到漂移 */
  hasDrift: boolean;
}

export async function detectSearchDrift(workspaceId: string): Promise<SearchDriftResult> {
  const ghosts: { objectType: string; objectId: string }[] = [];
  const missing: { objectType: string; objectId: string }[] = [];
  const staleTitles: { objectType: string; objectId: string; indexedTitle: string; actualTitle: string }[] = [];

  // 1. Notes: 对比业务表与索引
  const noteRows = await db.query.notes.findMany({
    where: eq(notes.workspaceId, workspaceId),
    columns: { id: true, title: true, currentVersionId: true },
  });
  const noteIds = new Set(noteRows.filter((n) => n.currentVersionId).map((n) => n.id));
  const noteTitleMap = new Map(noteRows.filter((n) => n.currentVersionId).map((n) => [n.id, n.title]));

  const indexedNotes = await db.query.searchDocuments.findMany({
    where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "note")),
    columns: { objectId: true, title: true },
  });
  const indexedNoteIds = new Set(indexedNotes.map((d) => d.objectId));

  for (const doc of indexedNotes) {
    if (!noteIds.has(doc.objectId)) {
      ghosts.push({ objectType: "note", objectId: doc.objectId });
    } else {
      const actualTitle = noteTitleMap.get(doc.objectId);
      if (actualTitle && doc.title && actualTitle !== doc.title) {
        staleTitles.push({
          objectType: "note",
          objectId: doc.objectId,
          indexedTitle: doc.title,
          actualTitle,
        });
      }
    }
  }
  for (const id of noteIds) {
    if (!indexedNoteIds.has(id)) {
      missing.push({ objectType: "note", objectId: id });
    }
  }

  // 2. Sources: 对比业务表与索引（排除已归档）
  const sourceRows = await db.query.sources.findMany({
    where: and(eq(sources.workspaceId, workspaceId), ne(sources.status, SourceStatus.ARCHIVED)),
    columns: { id: true, title: true },
  });
  const sourceIds = new Set(sourceRows.map((s) => s.id));
  const sourceTitleMap = new Map(sourceRows.map((s) => [s.id, s.title]));

  const indexedSources = await db.query.searchDocuments.findMany({
    where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "source")),
    columns: { objectId: true, title: true },
  });
  const indexedSourceIds = new Set(indexedSources.map((d) => d.objectId));

  for (const doc of indexedSources) {
    if (!sourceIds.has(doc.objectId)) {
      ghosts.push({ objectType: "source", objectId: doc.objectId });
    } else {
      const actualTitle = sourceTitleMap.get(doc.objectId);
      if (actualTitle && doc.title && actualTitle !== doc.title) {
        staleTitles.push({
          objectType: "source",
          objectId: doc.objectId,
          indexedTitle: doc.title,
          actualTitle,
        });
      }
    }
  }
  for (const id of sourceIds) {
    if (!indexedSourceIds.has(id)) {
      missing.push({ objectType: "source", objectId: id });
    }
  }

  // 3. Cards: 对比业务表与索引（仅 active）
  const cardRows = await db.query.learningCards.findMany({
    where: and(eq(learningCards.workspaceId, workspaceId), eq(learningCards.status, CardStatus.ACTIVE)),
    columns: { id: true, schemaJson: true },
  });
  const cardIds = new Set(cardRows.map((c) => c.id));
  const cardTitleMap = new Map(
    cardRows.map((c) => [c.id, (c.schemaJson as { title?: string }).title ?? ""]),
  );

  const indexedCards = await db.query.searchDocuments.findMany({
    where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "card")),
    columns: { objectId: true, title: true },
  });
  const indexedCardIds = new Set(indexedCards.map((d) => d.objectId));

  for (const doc of indexedCards) {
    if (!cardIds.has(doc.objectId)) {
      ghosts.push({ objectType: "card", objectId: doc.objectId });
    } else {
      const actualTitle = cardTitleMap.get(doc.objectId);
      if (actualTitle !== undefined && doc.title && actualTitle !== doc.title) {
        staleTitles.push({
          objectType: "card",
          objectId: doc.objectId,
          indexedTitle: doc.title,
          actualTitle,
        });
      }
    }
  }
  for (const id of cardIds) {
    if (!indexedCardIds.has(id)) {
      missing.push({ objectType: "card", objectId: id });
    }
  }

  // 4. Evidence: R-017 — 只对比 active card 下的 evidence（与 reindex 逻辑一致）
  //    先查出 active card 的 keyPoint IDs，再查这些 keyPoint 下的 evidence
  const activeCardIds = Array.from(cardIds);
  let evidenceIds = new Set<string>();
  if (activeCardIds.length > 0) {
    const activeKpRows = await db.query.cardKeyPoints.findMany({
      where: and(
        eq(cardKeyPoints.workspaceId, workspaceId),
        inArray(cardKeyPoints.cardId, activeCardIds),
      ),
      columns: { id: true },
    });
    const activeKpIds = activeKpRows.map((k) => k.id);
    if (activeKpIds.length > 0) {
      const evidenceRows = await db.query.evidences.findMany({
        where: and(
          eq(evidences.workspaceId, workspaceId),
          inArray(evidences.keyPointId, activeKpIds),
        ),
        columns: { id: true },
      });
      evidenceIds = new Set(evidenceRows.map((e) => e.id));
    }
  }

  const indexedEvidences = await db.query.searchDocuments.findMany({
    where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "evidence")),
    columns: { objectId: true },
  });
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

  const expected = {
    note: noteIds.size,
    source: sourceIds.size,
    card: cardIds.size,
    evidence: evidenceIds.size,
  };
  const actual = {
    note: indexedNotes.length,
    source: indexedSources.length,
    card: indexedCards.length,
    evidence: indexedEvidences.length,
  };

  // R-017: 检测正文/metadata 过期（不只是标题）
  const staleBodies: { objectType: string; objectId: string }[] = [];

  // 检查 notes 正文是否过期
  for (const note of noteRows) {
    if (!note.currentVersionId) continue;
    const indexedDoc = indexedNotes.find((d) => d.objectId === note.id);
    if (!indexedDoc) continue;
    const blocks = await db.query.noteBlocks.findMany({
      where: eq(noteBlocks.versionId, note.currentVersionId),
      orderBy: [asc(noteBlocks.ordinal)],
    });
    const actualBody = blocks.map((b) => b.content).join("\n");
    // 获取索引中的 body
    const fullDoc = await db.query.searchDocuments.findFirst({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "note"), eq(searchDocuments.objectId, note.id)),
      columns: { body: true },
    });
    if (fullDoc && fullDoc.body !== actualBody) {
      staleBodies.push({ objectType: "note", objectId: note.id });
    }
  }

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
