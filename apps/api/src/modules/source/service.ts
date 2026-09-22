import { and, asc, desc, eq, ne, sql, count, inArray, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { sources, sourceSegments, notes, noteVersions } from "@ailearn/shared/db-schema/note";
import {
  cardGenerationRunsV2,
  learningObjectiveOriginsV2,
  learningObjectivesV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { visibleNotesCondition } from "../note/visibility.ts";
import { applyNoteDocUpdate } from "../note/document-state.ts";
import { writeFragmentBlocks } from "../note/doc-fragment.ts";
import { computeContentHash } from "../note/content-hash.ts";
import { ensureImageAssetsForBlocks } from "../note/service.ts";
import { jobs } from "@ailearn/shared/db-schema/job";
import { searchDocuments } from "@ailearn/shared/db-schema/search";
import {
  SourceStatus,
  JobStatus,
  JobType,
  MAX_PENDING_JOBS_PER_WORKSPACE,
} from "@ailearn/shared";
import { segmentsToBlocks, type ParsedSegment } from "@ailearn/shared/markdown-parser";
// 稳定 P1（2026-09-15 审计）：parse_source 的 payload 走共享精确契约——漏字段/
// 拼错字段在编译期报错，而不是运行期变成一条可重试的 "missing sourceId" 失败。
import type { ParseSourceJobPayload } from "@ailearn/shared/job-payload-contracts";
import type { SourceCreateInput, SourceUpdateInput } from "./schema.ts";
import { logger } from "../../lib/logger.ts";
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";
import { hookJourneyEntityCreated } from "../companion-journey/journey-hook.ts";

type SourceSearchDocument = {
  workspaceId: string;
  objectType: "source" | "note";
  objectId: string;
  title: string | null;
  body: string | null;
};

/** Keep best-effort projection writes on the request connection via a savepoint.
 *
 * QUAL-61 备注：此函数与 note/service.ts 中的 upsertSearchDocument 逻辑重复。
 * 理想情况下应提取到共享的 search-index.ts 模块中，但当前两个模块的
 * SearchDocument 类型定义不同（source 有自己的 SourceSearchDocument 类型），
 * 提取共享函数需要先统一类型定义，属于架构级改进，暂缓处理。
 */
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
  // 如果未传 type，前端检测为初步值；Worker 会再次检测并修正
  const detectedType = input.type ?? detectSourceType(input.content ?? "", input.url);
  // 如果未传 title，使用临时占位标题；Worker 解析后会更新
  const title = input.title?.trim() || input.url?.slice(0, 60) || input.content?.split("\n")[0]?.slice(0, 60) || "未命名来源";

  const metadata: Record<string, unknown> = { ...input.metadata };
  // 关键：原代码用 input.type（必填）判断，改成 optional 后必须用 detectedType。
  const isUrlWithoutContent = detectedType === "url" && !input.content?.trim();
  if (input.content) metadata.rawContent = input.content;
  if (input.url) metadata.url = input.url;
  // 标记 type 来源，供 Worker 判断是否可修正
  metadata.typeSource = input.type ? "manual" : "auto";

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
        type: detectedType,
        title,
        origin: input.url ?? null,
        status: SourceStatus.DRAFT,
        metadata,
        createdBy: userId,
      })
      .returning();

    // P6 Journey：source 里程碑（同事务原子；无 active Journey 零开销）。
    await hookJourneyEntityCreated(tx, { workspaceId, userId }, {
      eventType: "source.created",
      entityId: row.id,
    });

    // 同一事务内创建 parse_source job。
    // payload 由共享契约约束（ParseSourceJobPayload）：字段名/类型与 worker 侧的
    // readParseSourceJobPayload 同源。历史字段 userId 已删除——worker 从不读它
    // （actor 归属走 jobs.requested_by），jobs 查询接口本来就把它脱敏掉（R-006）。
    const parseSourcePayload: ParseSourceJobPayload = isUrlWithoutContent
      ? { sourceId: row.id, fetchUrlContent: true }
      : { sourceId: row.id };
    await tx.insert(jobs).values({
      type: JobType.PARSE_SOURCE,
      workspaceId,
      requestedBy: userId,
      payload: parseSourcePayload,
      status: JobStatus.PENDING,
      priority: 70,
      resourceClass: "card_foreground",
    });

    return row;
  })(executor);

  return getSource(executor, source.id, workspaceId);
}

export async function listSources(
  executor: ApiTransaction,
  workspaceId: string,
  opts: { userId: string; status?: string; cursor?: string; limit?: number },
) {
  // §2.6: 支持 cursor/limit 分页
  const limit = Math.max(1, Math.min(100, opts.limit ?? 100));
  let where = and(
    eq(sources.workspaceId, workspaceId),
    ne(sources.status, SourceStatus.ARCHIVED), // 默认排除已归档来源
  );
  if (opts.status) {
    where = and(eq(sources.workspaceId, workspaceId), eq(sources.status, opts.status as SourceStatus));
  }
  // R-019: 使用 cursor 分页。排序键是 (updatedAt, id)：索引页每一行展示的是
  // updatedAt，按 createdAt 排会让「刚更新但很久前采集」的材料沉到列表末尾，
  // 与行内时间自相矛盾（2026-09-16 来源库复查）。
  const conditions = [where];
  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      const cursorTs = decoded.timestamp;
      const cursorId = decoded.id;
      conditions.push(
        sql`(${sources.updatedAt}, ${sources.id}) < (${cursorTs}::timestamptz, ${cursorId}::uuid)`,
      );
    }
  }
  // PERF: The total count and the note-count GROUP BY are both independent of
  // each other once the page rows (and their source ids) are known, so run them
  // concurrently — reducing the source list from 3 sequential DB round-trips to
  // 2. The page query runs first so a malformed page row (missing cursor) still
  // fails closed before any count query issues.
  const sourceRows = await executor.query.sources.findMany({
    where: and(...conditions),
    orderBy: [desc(sources.updatedAt), desc(sources.id)],
    limit: limit + 1,
    // PERF-B11 修复：列表排除大 jsonb metadata（rawContent 可达数百 KB），
    // 仅详情接口返回。
    columns: { metadata: false },
    extras: {
      cursorTimestamp: sql<string>`to_char(${sources.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("cursor_timestamp"),
    },
  });
  const hasMore = sourceRows.length > limit;
  const itemsWithCursor = sourceRows.slice(0, limit);
  const items = itemsWithCursor.map(({ cursorTimestamp, ...source }) => {
    if (!cursorTimestamp) throw new Error("source cursor timestamp is missing");
    return source;
  });

  // 批量查询每条来源的关联笔记数量，避免 N+1 —— 与总数查询并行（2 RTT 而非 3）。
  const sourceIds = items.map((s) => s.id);
  const [countRows, noteCountRows, cardProgressRows] = await Promise.all([
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(sources)
      .where(where),
    sourceIds.length > 0
      ? executor
          .select({
            sourceId: notes.sourceId,
            count: sql<number>`count(*)::int`,
          })
          .from(notes)
          .where(and(
            inArray(notes.sourceId, sourceIds),
            eq(notes.workspaceId, workspaceId),
            visibleNotesCondition(opts.userId),
            isNull(notes.deletedAt),
          ))
          .groupBy(notes.sourceId)
      : Promise.resolve([]),
    /**
     * 学习卡进展（实走复盘 #18 后半）：来源 → 笔记 → 生成批次 / 正式目标。
     * 仍然是一次批量聚合（不按行发请求）：批次按 note_id 直接连，正式目标经
     * `learning_objective_origins_v2.note_id` 连——目标本身没有 sourceId，
     * 它的来路记在 origins 上。
     */
    sourceIds.length > 0
      ? executor
          .select({
            sourceId: notes.sourceId,
            pendingReviewRuns: sql<number>`count(DISTINCT ${cardGenerationRunsV2.id}) FILTER (WHERE ${cardGenerationRunsV2.status} IN ('queued','source_sealing','planning','authoring','checking','review_ready'))::int`,
            activeObjectives: sql<number>`count(DISTINCT ${learningObjectivesV2.objectiveId}) FILTER (WHERE ${learningObjectivesV2.lifecycle} = 'active')::int`,
          })
          .from(notes)
          .leftJoin(cardGenerationRunsV2, eq(cardGenerationRunsV2.noteId, notes.id))
          .leftJoin(learningObjectiveOriginsV2, eq(learningObjectiveOriginsV2.noteId, notes.id))
          .leftJoin(learningObjectivesV2, eq(learningObjectivesV2.objectiveId, learningObjectiveOriginsV2.objectiveId))
          .where(and(
            inArray(notes.sourceId, sourceIds),
            eq(notes.workspaceId, workspaceId),
            visibleNotesCondition(opts.userId),
            isNull(notes.deletedAt),
          ))
          .groupBy(notes.sourceId)
      : Promise.resolve([]),
  ]);
  const total = countRows[0]?.count ?? 0;
  const noteCountMap = new Map(noteCountRows.map((r) => [r.sourceId!, r.count]));
  const cardProgressMap = new Map(cardProgressRows.map((r) => [r.sourceId!, r]));
  const itemsWithCounts = items.map((s) => ({
    ...s,
    noteCount: noteCountMap.get(s.id) ?? 0,
    cardProgress: {
      pendingReviewRuns: cardProgressMap.get(s.id)?.pendingReviewRuns ?? 0,
      activeObjectives: cardProgressMap.get(s.id)?.activeObjectives ?? 0,
    },
  }));

  // R-019: 使用最后一条记录的 (updatedAt, id) 作为下一页 cursor
  const lastItem = itemsWithCursor[itemsWithCursor.length - 1];
  const nextCursor = hasMore && lastItem
    ? encodeCursor(lastItem.cursorTimestamp, lastItem.id)
    : null;
  return { items: itemsWithCounts, nextCursor, total };
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
  // F13（round-4）：metadata read-modify-write 无并发保护——并发 PATCH 读到同一
  // base 会互相覆盖字段（lost update）。执行器为事务（ApiTransaction），用
  // SELECT ... FOR UPDATE 锁定行后再读，串行化同一 source 的并发更新（最简，
  // 无新增 CAS 列）。sources.id 为固定主键排序，避免死锁。
  const sourceRows = await executor
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1)
    .for("update");
  const source = sourceRows[0] ?? null;
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
 * 根据内容特征初步检测来源类型（快速粗粒度判断）。
 * Worker 端 correctSourceType 会做更细粒度的修正。
 * 已与 detectCaptureType（today/page.tsx）取并集统一。
 */
export function detectSourceType(content: string, url?: string): "text" | "markdown" | "code" | "url" {
  // URL 检测：有 url 参数且无 content，或 content 本身就是 URL
  if (url && /^https?:\/\//.test(url) && !content.trim()) return "url";
  const text = content.trim();
  if (/^https?:\/\/\S+$/i.test(text)) return "url";

  // 代码检测：合并 detectCaptureType 和原 detectSourceType 的所有关键字（并集）
  // 注意：from 已移除——在英文文本中过于常见（"from the beginning" 等），
  // 且 ES module 导入中 from 总是与 import/export 同时出现，两者已在关键字列表中。
  // public/private/protected 已移除——作为独立关键字在英文文本中过于常见
  //（"public transport"、"private matter"、"protected species"），
  // 会导致 detectSourceType 误判为 code，且 correctSourceType 的 code→text 回退
  //（codeScore === 0 条件）被这些关键字在 codeIndicators 中的匹配所阻断。
  // 改用 "public class" 两词模式替代独立 public 关键字。
  // type 已移除——与 from/public/private/protected 同类问题，是常见英文单词
  //（"type of music"、"type your name"、"type a letter"），作为独立关键字
  // 会导致英文文本被误判为 code。TypeScript 的 type 定义通常伴随 const/import
  // 等其他关键字出现，移除 type 不影响多行代码文件的检测。
  if (
    /^(?:function|const|let|var|class|interface|enum|import|export|def|#include|package|public class|if __name__)\b/m.test(text) ||
    /^[a-zA-Z_$][\w$]*\s*[({]/m.test(text) // 函数调用或定义模式
  ) {
    return "code";
  }

  // ``` 含代码块按 markdown 处理（保留代码块结构，而非 code 整段）
  if (/```/.test(text)) return "markdown";

  // Markdown 检测：标题、列表、引用等语法
  // 正则与 today/page.tsx 的 detectCaptureType 对齐，要求标记后有空格，
  // 避免 "-5 度" 等以 - 开头的纯文本被误判为 markdown。
  if (/^(#{1,6}\s|>|[-*+]\s|\d+\.\s)/m.test(text) || /\[.+?\]\(.+?\)/.test(text)) return "markdown";
  return "text";
}

/**
 * §2.7: 查询从此来源创建的笔记列表。
 *
 * `items` 只返回最近 50 篇，`total` 是该来源的真实总数——详情页要能说
 * 「共 N 篇，这里列出最近 M 篇」，而不是把一页的长度当成来源的规模。
 */
export async function listNotesBySource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
  userId: string,
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  // 列表与 total 共用这一个 where：那个数字在界面上写的是"共 N 篇"，
  // 只筛列表不筛数字就会自相矛盾。
  const where = [
    eq(notes.sourceId, sourceId),
    eq(notes.workspaceId, workspaceId),
    isNull(notes.deletedAt),
  ];
  const [noteRows, countRows] = await Promise.all([
    executor
      .select({
        id: notes.id,
        title: notes.title,
        titleSource: notes.titleSource,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
        currentVersionId: notes.currentVersionId,
      })
      .from(notes)
      .where(and(visibleNotesCondition(userId), ...where))
      .orderBy(desc(notes.updatedAt))
      .limit(50),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(notes)
      // 列表与 total 同一条判据：那个数字在界面上写的是「共 N 篇」。
      .where(and(visibleNotesCondition(userId), ...where)),
  ]);

  return { items: noteRows, total: countRows[0]?.count ?? 0 };
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
    // PERF: push the content-hash match into SQL with LIMIT 1 so we never load
    // every non-deleted note of a source into memory just to find one hash match.
    const [duplicate] = await executor
      .select({
        noteId: notes.id,
        noteTitle: notes.title,
      })
      .from(notes)
      .innerJoin(noteVersions, eq(notes.currentVersionId, noteVersions.id))
      .where(and(
        eq(notes.sourceId, sourceId),
        eq(notes.workspaceId, workspaceId),
        visibleNotesCondition(userId),
        isNull(notes.deletedAt),
        eq(noteVersions.contentHash, newContentHash),
      ))
      .limit(1);

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

    // 创建 note_blocks，每个 block 的 source_ref 指向 source_segment。
    // 批次 4.1：来源转笔记是"整篇由这一次动作拥有"的路径，所以走文档入口——
    // 快照先落，行由文档派生；块级 sourceRef 必须进文档，否则恢复历史版本时
    // 第一个丢的就是证据链回指。
    const blocksWithAssets = await ensureImageAssetsForBlocks(tx, workspaceId, blocks, userId, note.id);
    await applyNoteDocUpdate(tx, { workspaceId, noteId: note.id, userId }, version.id, (doc) => {
      writeFragmentBlocks(
        doc,
        blocksWithAssets.map((b, idx) => ({
          type: b.type,
          content: b.content,
          ...(b.imageAssetId ? { imageAssetId: b.imageAssetId } : {}),
          sourceRef: { sourceId: source.id, segmentId: segments[idx]?.id },
        })),
      );
    });

    // 更新 note.currentVersionId
    await tx
      .update(notes)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(notes.id, note.id));

    return { note, version };
  })(executor);

  // B-NEW-1: 同步搜索索引（与 createNote / importMarkdown 保持一致）
  // BUG-69 修复：过滤 image 类型 block，与 note service 保持一致，避免 drift 检测误报
  const bodyText = blocks.filter((b) => b.type !== "image").map((b) => b.content).join("\n");
  await upsertSearchDocument(executor, {
    workspaceId,
    objectType: "note",
    objectId: result.note.id,
    title: result.note.title,
    body: bodyText,
  });

  return result;
}
