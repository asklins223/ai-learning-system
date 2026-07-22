import { and, asc, desc, eq, ne, sql, count, inArray, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { sources, sourceSegments, notes, noteVersions, noteBlocks } from "../../db/schema/note.ts";
import { computeContentHash } from "../note/service.ts";
import { jobs } from "../../db/schema/job.ts";
import { searchDocuments } from "../../db/schema/search.ts";
import {
  SourceStatus,
  JobStatus,
  JobType,
  MAX_PENDING_JOBS_PER_WORKSPACE,
} from "@ailearn/shared";
import { segmentsToBlocks, type ParsedSegment } from "../../lib/markdown-parser.ts";
import type { SourceCreateInput, SourceUpdateInput } from "./schema.ts";
import { logger } from "../../lib/logger.ts";
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";

type SourceSearchDocument = {
  workspaceId: string;
  objectType: "source" | "note";
  objectId: string;
  title: string | null;
  body: string | null;
};

/** Keep best-effort projection writes on the request connection via a savepoint. */
async function upsertSearchDocument(
  executor: ApiTransaction,
  document: SourceSearchDocument,
): Promise<boolean> {
  try {
    await executor.transaction(async (savepoint) => {
      await savepoint
        .insert(searchDocuments)
        .values({ ...document, metadata: {}, indexedAt: new Date() })
        .onConflictDoUpdate({
          target: [searchDocuments.workspaceId, searchDocuments.objectType, searchDocuments.objectId],
          set: {
            title: document.title,
            body: document.body,
            metadata: {},
            indexedAt: new Date(),
          },
        });
    });
    return true;
  } catch (err) {
    logger.error(
      { err, ...document },
      "search index upsert failed — index may be stale, run reindex to compensate",
    );
    return false;
  }
}

async function deleteSearchDocument(
  executor: ApiTransaction,
  workspaceId: string,
  objectType: SourceSearchDocument["objectType"],
  objectId: string,
): Promise<void> {
  try {
    await executor.transaction(async (savepoint) => {
      await savepoint
        .delete(searchDocuments)
        .where(and(
          eq(searchDocuments.workspaceId, workspaceId),
          eq(searchDocuments.objectType, objectType),
          eq(searchDocuments.objectId, objectId),
        ));
    });
  } catch (err) {
    logger.error(
      { err, workspaceId, objectType, objectId },
      "search index delete failed — index may have ghost document, run reindex to compensate",
    );
  }
}

export async function createSource(
  executor: ApiTransaction,
  workspaceId: string,
  userId: string,
  input: SourceCreateInput,
) {
  const metadata: Record<string, unknown> = { ...input.metadata };
  const isUrlWithoutContent = input.type === "url" && !input.content?.trim();
  if (input.content) metadata.rawContent = input.content;
  if (input.url) metadata.url = input.url;

  // R-016: source 创建和 job 入队在同一事务内，避免入队失败留下永不解析的 DRAFT
  const source = await (async (tx: ApiTransaction) => {
    // 与 createJob 使用同一 workspace advisory lock，将配额计数和插入
    // 串行化；既保持 source/job 原子性，也避免并发突破配额。
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${workspaceId}`}, 0)
      )
    `);
    const pendingRows = await tx
      .select({ count: count() })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, workspaceId),
          eq(jobs.status, JobStatus.PENDING),
        ),
      );
    const pendingCount = Number(pendingRows[0]?.count ?? 0);
    if (pendingCount >= MAX_PENDING_JOBS_PER_WORKSPACE) {
      const error = new Error(
        `workspace has ${pendingCount} pending jobs (max ${MAX_PENDING_JOBS_PER_WORKSPACE})`,
      );
      (error as Error & { statusCode: number }).statusCode = 429;
      throw error;
    }

    const [row] = await tx
      .insert(sources)
      .values({
        workspaceId,
        type: input.type,
        title: input.title,
        origin: input.url ?? null,
        status: SourceStatus.DRAFT,
        metadata,
        createdBy: userId,
      })
      .returning();

    // 同一事务内创建 parse_source job
    await tx.insert(jobs).values({
      type: JobType.PARSE_SOURCE,
      workspaceId,
      requestedBy: userId,
      payload: isUrlWithoutContent
        ? { sourceId: row.id, fetchUrlContent: true, userId }
        : { sourceId: row.id, userId },
      status: JobStatus.PENDING,
    });

    return row;
  })(executor);

  return getSource(executor, source.id, workspaceId);
}

export async function listSources(
  executor: ApiTransaction,
  workspaceId: string,
  opts?: { status?: string; cursor?: string; limit?: number },
) {
  // §2.6: 支持 cursor/limit 分页
  const limit = Math.max(1, Math.min(100, opts?.limit ?? 100));
  let where = and(
    eq(sources.workspaceId, workspaceId),
    ne(sources.status, SourceStatus.ARCHIVED), // 默认排除已归档来源
  );
  if (opts?.status) {
    where = and(eq(sources.workspaceId, workspaceId), eq(sources.status, opts.status as SourceStatus));
  }
  // R-019: 使用 cursor 分页，基于 (createdAt, id) 复合排序
  const conditions = [where];
  if (opts?.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      const cursorTs = new Date(decoded.timestamp);
      const cursorId = decoded.id;
      conditions.push(sql`(${sources.createdAt}, ${sources.id}) < (${cursorTs}, ${cursorId})`);
    }
  }
  const items = await executor.query.sources.findMany({
    where: and(...conditions),
    orderBy: [desc(sources.createdAt), desc(sources.id)],
    limit,
  });

  // 批量查询每条来源的关联笔记数量，避免 N+1
  const sourceIds = items.map((s) => s.id);
  const noteCountRows = sourceIds.length > 0
    ? await executor
        .select({
          sourceId: notes.sourceId,
          count: sql<number>`count(*)::int`,
        })
        .from(notes)
        .where(and(
          inArray(notes.sourceId, sourceIds),
          eq(notes.workspaceId, workspaceId),
          isNull(notes.deletedAt),
        ))
        .groupBy(notes.sourceId)
    : [];
  const noteCountMap = new Map(noteCountRows.map((r) => [r.sourceId!, r.count]));
  const itemsWithCounts = items.map((s) => ({
    ...s,
    noteCount: noteCountMap.get(s.id) ?? 0,
  }));

  // R-019: 服务端返回实际总数
  const countRows = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(sources)
    .where(where);
  const total = countRows[0]?.count ?? 0;
  // R-019: 使用最后一条记录的 (createdAt, id) 作为下一页 cursor
  const lastItem = items[items.length - 1];
  const nextCursor = items.length === limit && lastItem
    ? encodeCursor(lastItem.createdAt, lastItem.id)
    : null;
  return { items: itemsWithCounts, nextCursor, total };
}

export async function listSourceStatuses(
  executor: ApiTransaction,
  workspaceId: string,
  ids: string[],
) {
  if (ids.length === 0) return [];
  // Polling must not retransmit metadata.rawContent (potentially hundreds of
  // kilobytes) every few seconds. Include archived rows so another tab's
  // archive action can make the polling client remove the stale entry.
  return executor
    .select({
      id: sources.id,
      status: sources.status,
      updatedAt: sources.updatedAt,
    })
    .from(sources)
    .where(and(eq(sources.workspaceId, workspaceId), inArray(sources.id, ids)));
}

export async function getSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  const segments = await executor.query.sourceSegments.findMany({
    where: eq(sourceSegments.sourceId, sourceId),
    orderBy: [asc(sourceSegments.ordinal)],
  });

  return { source, segments };
}

export async function updateSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
  input: SourceUpdateInput,
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) updates.title = input.title;
  // F-021: status 不再由客户端直接设置，只能通过服务端状态机改变
  if (input.metadata !== undefined) {
    updates.metadata = { ...source.metadata, ...input.metadata };
  }

  await executor
    .update(sources)
    .set(updates)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)));
  return getSource(executor, sourceId, workspaceId);
}

export async function deleteSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  // 软删除：status → archived
  await executor
    .update(sources)
    .set({ status: SourceStatus.ARCHIVED, updatedAt: new Date() })
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)));

  // 清理搜索索引（P1-3）
  await deleteSearchDocument(executor, workspaceId, "source", sourceId);

  return { ok: true };
}

/**
 * §2.7: 查询从此来源创建的笔记列表。
 */
export async function listNotesBySource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  const noteRows = await executor
    .select({
      id: notes.id,
      title: notes.title,
      titleSource: notes.titleSource,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
      currentVersionId: notes.currentVersionId,
    })
    .from(notes)
    .where(and(eq(notes.sourceId, sourceId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)))
    .orderBy(desc(notes.updatedAt))
    .limit(50);

  return noteRows;
}

/**
 * 从 Source 创建笔记草稿。
 * 1. 读取 source_segments
 * 2. （可选）内容去重：若已有笔记当前版本的内容哈希一致，返回 duplicate_content
 * 3. 创建 note（title 从 source.title 继承，写入 sourceId）
 * 4. 创建 note_version + note_blocks（每个 segment 映射为一个 block）
 * 5. block 的 source_ref 指向 source_segment
 */
export async function createNoteFromSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
  userId: string,
  opts?: { force?: boolean },
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  // 只有 ready 状态才能转笔记
  if (source.status !== SourceStatus.READY) {
    return { error: "source_not_ready" as const };
  }

  const segments = await executor.query.sourceSegments.findMany({
    where: eq(sourceSegments.sourceId, sourceId),
    orderBy: [asc(sourceSegments.ordinal)],
  });

  // 如果没有 segments（如 url 无正文），不允许创建笔记
  if (segments.length === 0) {
    return { error: "no_segments" as const };
  }

  // 将 segments 转为 blocks
  const parsedSegments: ParsedSegment[] = segments.map((s) => ({
    text: s.text,
    segmentType: (s.segmentType as ParsedSegment["segmentType"]) ?? "paragraph",
    charStart: s.charStart,
    charEnd: s.charEnd,
  }));

  const blocks = segmentsToBlocks(parsedSegments, source.type as "text" | "markdown" | "code" | "url");
  const newContentHash = computeContentHash({ blocks: blocks.map((b) => ({ type: b.type, content: b.content })) });

  // 内容去重：如果该来源已有笔记的当前版本内容哈希与新内容一致，
  // 说明来源内容未变，重复创建会生成完全相同的笔记。
  // force=true 时跳过此检查（用户明确确认要再创建一篇）。
  if (!opts?.force) {
    const existingNotes = await executor
      .select({
        noteId: notes.id,
        noteTitle: notes.title,
        versionHash: noteVersions.contentHash,
      })
      .from(notes)
      .innerJoin(noteVersions, eq(notes.currentVersionId, noteVersions.id))
      .where(and(
        eq(notes.sourceId, sourceId),
        eq(notes.workspaceId, workspaceId),
        isNull(notes.deletedAt),
      ));

    const duplicate = existingNotes.find((n) => n.versionHash === newContentHash);
    if (duplicate) {
      return {
        error: "duplicate_content" as const,
        existingNoteId: duplicate.noteId,
        existingNoteTitle: duplicate.noteTitle,
      };
    }
  }

  const result = await (async (tx: ApiTransaction) => {
    // 创建 note，写入 sourceId
    const [note] = await tx
      .insert(notes)
      .values({
        workspaceId,
        title: source.title,
        titleSource: "auto",
        sourceId: source.id,
        createdBy: userId,
      })
      .returning();

    // 创建 note_version
    const [version] = await tx
      .insert(noteVersions)
      .values({
        noteId: note.id,
        workspaceId,
        versionNo: 1,
        contentJson: { blocks: blocks.map((b) => ({ type: b.type, content: b.content })) },
        contentHash: newContentHash,
        createdBy: userId,
      })
      .returning();

    // 创建 note_blocks，每个 block 的 source_ref 指向 source_segment
    await tx.insert(noteBlocks).values(
      blocks.map((b, idx) => ({
        versionId: version.id,
        workspaceId,
        ordinal: idx,
        type: b.type,
        content: b.content,
        sourceRef: { sourceId: source.id, segmentId: segments[idx]?.id },
      })),
    );

    // 更新 note.currentVersionId
    await tx
      .update(notes)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(notes.id, note.id));

    return { note, version };
  })(executor);

  // B-NEW-1: 同步搜索索引（与 createNote / importMarkdown 保持一致）
  const bodyText = blocks.map((b) => b.content).join("\n");
  await upsertSearchDocument(executor, {
    workspaceId,
    objectType: "note",
    objectId: result.note.id,
    title: result.note.title,
    body: bodyText,
  });

  return result;
}
