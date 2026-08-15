import { and, desc, eq, inArray, isNull, isNotNull, or, sql, type Column } from "drizzle-orm";
import { createHash } from "node:crypto";
import { type ApiTransaction } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks, noteImageAssets } from "../../db/schema/note.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { evidences, validationEvents, reviewSchedules, understandingEvents } from "../../db/schema/evidence.ts";
import { aiArtifacts } from "../../db/schema/ai.ts";
import { jobs } from "../../db/schema/job.ts";
import { searchDocuments } from "../../db/schema/search.ts";
import { logger } from "../../lib/logger.ts";

/**
 * PERF-10: Chunked delete helper for large IN arrays.
 *
 * PostgreSQL's IN clause degrades when parameter count exceeds ~1000.
 * This helper splits large ID arrays into batches and deletes them
 * sequentially within the same transaction.
 */
async function chunkedInArrayDelete(
  tx: ApiTransaction,
  table: Parameters<typeof tx.delete>[0],
  column: Column,
  ids: string[],
  chunkSize = 500,
): Promise<void> {
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    await tx.delete(table).where(inArray(column, chunk));
  }
}

/**
 * PERF-10: Chunked select helper for large IN arrays.
 * Returns combined results from multiple batched queries.
 */
async function chunkedInArraySelect<T>(
  queryFn: (chunk: string[]) => Promise<T[]>,
  ids: string[],
  chunkSize = 500,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    results.push(...await queryFn(chunk));
  }
  return results;
}
import { CardStatus, ReviewStatus } from "@ailearn/shared";
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";
import { extractObjectKeyFromMarkdownImage } from "../../lib/markdown-image.ts";
import { downloadAndValidateImageAsset } from "../../lib/image-asset.ts";
import { isStorageConfigured } from "../../lib/object-storage.ts";
import { hookJourneyEntityCreated } from "../companion-journey/journey-hook.ts";
import type { NoteCreateInput, NoteUpdateInput, NoteBlock } from "./schema.ts";

/**
 * Compute a stable MD5 hash of note content blocks for deduplication.
 *
 * The serialization format matches PostgreSQL's `jsonb::text` output exactly:
 *   - Object keys are sorted by length, then alphabetically (JSONB internal order)
 *   - Separators are `": "` and `", "` (with spaces, matching `jsonb::text`)
 *
 * This ensures the hash is consistent with the migration 0029 backfill
 * `md5(content_json::text)`, so deduplication works across pre-migration
 * and post-migration data.
 *
 * The integration test `content-hash-consistency-postgres.integration.ts`
 * validates this alignment across ASCII, Unicode, image, and empty-block
 * content. If this function or the migration is modified, update both
 * the migration and the integration test accordingly, and consider whether
 * existing data needs re-hashing.
 */
export function computeContentHash(contentJson: unknown): string {
  const canonical = pgJsonbSerialize(contentJson);
  return createHash("md5").update(canonical).digest("hex");
}

/**
 * Serialize a JavaScript value to text in PostgreSQL `jsonb::text` format.
 *
 * Key ordering: by length ascending, then by byte-wise comparison (matching
 * PostgreSQL's JSONB internal key ordering).  Separators: `": "` after keys,
 * `", "` between elements.  String values are JSON-encoded with `JSON.stringify`
 * to ensure correct escaping of special characters.
 */
function pgJsonbSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    // BUG-01 fix: PostgreSQL jsonb::text never uses exponential notation.
    // JavaScript's String() uses exponential notation for |value| >= 1e21
    // or |value| < 1e-6, which would cause md5(content_json::text) to
    // differ from computeContentHash. Convert exponential to fixed-point.
    // BUG-04 修复：toFixed(20) 对极大/极小数字仍会丢失精度。
    // 对于指数格式，使用 BigInt 精确转换（当数字为整数时），
    // 否则使用 toPrecision 并去除尾部零。非指数格式直接使用 String()。
    const str = String(value);
    if (/[eE]/.test(str)) {
      // 对于指数表示的数字，尝试使用更高精度转换
      // PostgreSQL jsonb::text 使用 shortest round-trip representation
      // 对于非整数的指数表示，使用 toPrecision(21) 然后去除尾部零
      if (Number.isInteger(value)) {
        // 整数使用 BigInt 精确表示
        try {
          return BigInt(value).toString();
        } catch {
          // 超出 BigInt 安全范围时回退到 toFixed
          const fixed = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
          return fixed || "0";
        }
      }
      const fixed = value.toPrecision(21).replace(/0+$/, "").replace(/\.$/, "");
      return fixed || "0";
    }
    return str;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // BUG-12: Each element is recursively serialized, so NaN/Infinity
    // inside arrays becomes "null" — matching PostgreSQL's jsonb behaviour
    // where NaN is never stored (it is silently converted to null on
    // input). This ensures md5(content_json::text) stays consistent.
    return "[" + value.map(pgJsonbSerialize).join(", ") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => {
        if (a.length !== b.length) return a.length - b.length;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    if (entries.length === 0) return "{}";
    return "{" + entries
      .map(([k, v]) => JSON.stringify(k) + ": " + pgJsonbSerialize(v))
      .join(", ") + "}";
  }
  return JSON.stringify(value);
}

/**
 * Strip image blocks that are still uploading placeholders.
 *
 * The NoteEditor inserts `![上传中…](uploading:${uuid})` as a temporary
 * placeholder while an image upload is in flight. If autosave triggers
 * before the upload completes (2.5 s interval), the placeholder would
 * be persisted as a broken image block. This function filters such
 * blocks out so they never reach the database.
 *
 * Ordinals are re-assigned by the caller after this filter, so gaps
 * are not a concern.
 */
function stripUploadingPlaceholders<T extends { type: string; content: string }>(
  blocks: T[],
): T[] {
  return blocks.filter(
    (b) => !(b.type === "image" && /^!\[[^\]]*\]\(uploading:[^)]+\)/.test(b.content.trim())),
  );
}

export async function resolveImageAssetIds<T extends { type: string; content: string }>(
  tx: ApiTransaction,
  workspaceId: string,
  blocks: T[],
): Promise<Array<T & { imageAssetId: string | null }>> {
  const objectKeys = [...new Set(blocks
    .filter((block) => block.type === "image")
    .map((block) => extractObjectKeyFromMarkdownImage(block.content))
    .filter((key): key is string => key !== null))];
  const assets = objectKeys.length > 0
    ? await tx.query.noteImageAssets.findMany({
        where: and(
          eq(noteImageAssets.workspaceId, workspaceId),
          inArray(noteImageAssets.objectKey, objectKeys),
          eq(noteImageAssets.status, "ready"),
          isNull(noteImageAssets.deletedAt),
        ),
      })
    : [];
  const assetByObjectKey = new Map(assets.map((asset) => [asset.objectKey, asset.id]));
  return blocks.map((block) => {
    const objectKey = block.type === "image"
      ? extractObjectKeyFromMarkdownImage(block.content)
      : null;
    return { ...block, imageAssetId: objectKey ? assetByObjectKey.get(objectKey) ?? null : null };
  });
}

/**
 * Ensure every image block with a /api/uploads/ object key has a registered
 * note_image_assets record. Images imported from sources (URL ingestion,
 * markdown import) are already in MinIO but lack the immutable asset row that
 * card generation requires. This function downloads those images, computes
 * their SHA-256, validates magic bytes, reads dimensions, and inserts the
 * missing asset rows, then delegates to resolveImageAssetIds to link the
 * blocks to their asset IDs.
 *
 * Blocks whose images are external URLs (not /api/uploads/) or already have
 * asset records are left untouched.
 */
export async function ensureImageAssetsForBlocks<T extends { type: string; content: string }>(
  tx: ApiTransaction,
  workspaceId: string,
  blocks: T[],
  userId: string,
  noteId?: string | null,
): Promise<Array<T & { imageAssetId: string | null }>> {
  const objectKeys = [...new Set(blocks
    .filter((block) => block.type === "image")
    .map((block) => extractObjectKeyFromMarkdownImage(block.content))
    .filter((key): key is string => key !== null))];

  if (objectKeys.length === 0) {
    return resolveImageAssetIds(tx, workspaceId, blocks);
  }

  // Check which object keys already have registered assets.
  const existing = await tx.query.noteImageAssets.findMany({
    where: and(
      eq(noteImageAssets.workspaceId, workspaceId),
      inArray(noteImageAssets.objectKey, objectKeys),
      eq(noteImageAssets.status, "ready"),
      isNull(noteImageAssets.deletedAt),
    ),
  });
  const existingKeys = new Set(existing.map((asset) => asset.objectKey));
  const missingKeys = objectKeys.filter((key) => !existingKeys.has(key));

  if (missingKeys.length === 0) {
    return resolveImageAssetIds(tx, workspaceId, blocks);
  }

  if (!isStorageConfigured()) {
    logger.warn(
      { missingCount: missingKeys.length, workspaceId },
      "object storage not configured; skipping image asset registration for source-imported images",
    );
    return resolveImageAssetIds(tx, workspaceId, blocks);
  }

  // BUG-01 fix: 逐个处理图片资产，避免多张图片 Buffer 同时驻留内存导致 OOM。
  // 每次迭代：加载 → 校验 → 计算 → 收集 → 释放，确保同一时刻最多一张图片
  // 在内存中。收集完成后单条多行 INSERT（此前逐张一次往返）。
  // 注意：下载（MinIO 网络 IO）仍在调用方事务内——连接占用时长在批量导入
  // 场景由 preRegisterImageAssetsForImport（事务外）先行化解：事务内仅剩
  // missingKeys 查询（预注册后为 0）。单篇保存等轻量路径保留此兜底。
  const assetRows: {
    workspaceId: string;
    uploadedForNoteId: string | null;
    objectKey: string;
    sha256: string;
    mimeType: string;
    byteSize: number;
    width: number;
    height: number;
    status: "ready";
    createdBy: string;
  }[] = [];
  for (const objectKey of missingKeys) {
    const validated = await downloadAndValidateImageAsset(objectKey);
    if (!validated) {
      continue;
    }
    assetRows.push({
      workspaceId,
      uploadedForNoteId: noteId ?? null,
      ...validated,
      status: "ready",
      createdBy: userId,
    });
    logger.info({ objectKey, workspaceId }, "registered source-imported image as note_image_asset");
  }
  if (assetRows.length > 0) {
    await tx
      .insert(noteImageAssets)
      .values(assetRows)
      .onConflictDoNothing();
  }

  return resolveImageAssetIds(tx, workspaceId, blocks);
}

/**
 * 乐观并发冲突：客户端提交的 baseVersionId 与服务端 currentVersionId 不一致。
 * 路由层捕获后返回 409，提示客户端重新拉取最新版本再编辑。
 */
export class RevisionConflictError extends Error {
  currentVersionId: string | null;
  constructor(currentVersionId: string | null) {
    super("note version conflict");
    this.name = "RevisionConflictError";
    this.currentVersionId = currentVersionId;
  }
}

/**
 * P2-3: 尝试恢复一篇未被软删除的笔记时抛出。
 * 路由层捕获后返回 409 而非 404，区分「笔记不存在」和「笔记未删除」。
 */
export class NoteNotDeletedError extends Error {
  constructor() {
    super("note is not deleted");
    this.name = "NoteNotDeletedError";
  }
}

export function cleanTitleCandidate(content: string): string {
  return content
    .trim()
    .replace(/^<h\d>([\s\S]+)<\/h\d>$/i, "$1")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^·\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/`{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveNoteTitle(blocks: NoteBlock[] | Array<{ type: NoteBlock["type"]; content: string }>): string {
  const heading = blocks.find((block) => block.type === "heading" && cleanTitleCandidate(block.content));
  const fallback = heading ?? blocks.find((block) => cleanTitleCandidate(block.content));
  const title = fallback ? cleanTitleCandidate(fallback.content) : "";
  return title.slice(0, 60) || "无标题笔记";
}

/**
 * 检查版本是否可被原地更新（无活跃或已替代的学习卡引用）。
 *
 * 使用 SELECT ... FOR UPDATE 锁定 note_versions 行，确保检查与后续
 * updateVersionInPlace 之间不会有并发 INSERT learning_cards。
 * PostgreSQL 外键插入会获取 FOR KEY SHARE 锁，与 FOR UPDATE 冲突，
 * 因此 AI worker 的卡片插入会阻塞直到本事务提交。
 *
 * 检查范围包括 active 和 superseded 状态的卡片：
 * - active：正在使用中的卡片，内容必须与版本一致
 * - superseded：已被新卡替代但仍引用该版本内容的旧卡，原地更新会破坏
 *   其内容与版本的引用语义
 * archived 卡片不再用于复习，无需保护。
 */
async function canUpdateVersionInPlace(
  tx: ApiTransaction,
  versionId: string,
): Promise<boolean> {
  // 锁定 note_versions 行，防止并发卡片插入
  const versionRows = await tx
    .select({ id: noteVersions.id, sealedAt: noteVersions.sealedAt })
    .from(noteVersions)
    .where(eq(noteVersions.id, versionId))
    .for("update");
  if (versionRows.length === 0) return false;
  if (versionRows[0]?.sealedAt) return false;

  const card = await tx.query.learningCards.findFirst({
    where: and(
      eq(learningCards.noteVersionId, versionId),
      inArray(learningCards.status, [CardStatus.ACTIVE, CardStatus.SUPERSEDED]),
    ),
  });
  return !card;
}

/**
 * 原地更新版本内容和 blocks。
 *
 * 这是 note_versions 不可变性的受控例外：仅在编辑会话内、且该版本尚无
 * 学习卡引用时执行。一旦生成卡片（或有其他消费者引用该版本），后续
 * 编辑必须创建新版本。长期可考虑引入独立的 note_drafts 表来彻底
 * 分离可变草稿和不可变快照（参见方案 §8）。
 */
async function updateVersionInPlace(
  tx: ApiTransaction,
  versionId: string,
  workspaceId: string,
  contentJson: { blocks: Array<{ type: NoteBlock["type"]; content: string }> },
  contentHash: string,
  blocks: Array<{ type: NoteBlock["type"]; content: string }>,
) {
  // 删除旧 blocks
  await tx.delete(noteBlocks).where(eq(noteBlocks.versionId, versionId));
  // 插入新 blocks
  if (blocks.length) {
    const blocksWithAssets = await resolveImageAssetIds(tx, workspaceId, blocks);
    await tx.insert(noteBlocks).values(
      blocksWithAssets.map((b, idx) => ({
        versionId,
        workspaceId,
        ordinal: idx,
        type: b.type,
        content: b.content,
        imageAssetId: b.imageAssetId,
      })),
    );
  }
  // 更新版本内容（含 updatedAt 追踪原地修改时间）
  await tx
    .update(noteVersions)
    .set({ contentJson, contentHash, updatedAt: new Date() })
    .where(eq(noteVersions.id, versionId));
}

type NoteSearchDocument = {
  workspaceId: string;
  objectType: "note" | "card" | "evidence";
  objectId: string;
  title: string | null;
  body: string | null;
};

/**
 * 搜索投影写入（savepoint 隔离）。
 *
 * ARCH-01 设计权衡说明：
 * 搜索投影写入失败时不中断主事务（savepoint 回滚仅影响投影部分），
 * 这意味着搜索索引可能短暂与业务数据不一致。
 * 补偿机制：
 * 1. 投影失败时记录 error 日志，提示运维运行 reindex
 * 2. /search/drift 端点可检测不一致（ghosts / missing / staleTitles / staleBodies）
 * 3. /search/reindex 端点可全量重建工作区搜索索引
 * 此设计避免了搜索索引故障阻塞核心业务写入，代价是需要运维定期检查 drift。
 */
async function upsertSearchDocument(
  executor: ApiTransaction,
  document: NoteSearchDocument,
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

async function deleteSearchDocuments(
  executor: ApiTransaction,
  workspaceId: string,
  documents: Array<Pick<NoteSearchDocument, "objectType" | "objectId">>,
): Promise<void> {
  if (documents.length === 0) return;

  const objectIdsByType = new Map<NoteSearchDocument["objectType"], string[]>();
  for (const document of documents) {
    const objectIds = objectIdsByType.get(document.objectType) ?? [];
    objectIds.push(document.objectId);
    objectIdsByType.set(document.objectType, objectIds);
  }
  // Y4（round-3 审计）：原来每 type 一条 inArray(objectId, allIds)——某类批量删除
  // （数万条）可能超 postgres-js 参数上限。现按 500/批把每类拆成多条
  // `type = ? AND objectId IN (chunk)`，OR 连接，保持单条 DELETE 语义。
  const CHUNK = 500;
  const documentConditions: ReturnType<typeof and>[] = [];
  for (const [objectType, objectIds] of objectIdsByType) {
    for (let i = 0; i < objectIds.length; i += CHUNK) {
      documentConditions.push(and(
        eq(searchDocuments.objectType, objectType),
        inArray(searchDocuments.objectId, objectIds.slice(i, i + CHUNK)),
      ));
    }
  }

  try {
    await executor.transaction(async (savepoint) => {
      await savepoint
        .delete(searchDocuments)
        .where(and(
          eq(searchDocuments.workspaceId, workspaceId),
          or(...documentConditions),
        ));
    });
  } catch (err) {
    logger.error(
      { err, workspaceId, documents },
      "search index batch delete failed — index may have ghost documents, run reindex to compensate",
    );
  }
}

/* ----------------------------- service --------------------------------- */

/**
 * QUAL-03 修复：提取命名函数替代 IIFE 模式。
 * 原 (async (tx: ApiTransaction) => { ... })(executor) 模式误导读者
 * 以为创建了新事务上下文，实际 executor 即外部事务执行器。
 */
async function createNoteTx(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  title: string,
  titleWasProvided: boolean,
  sanitizedBlocks: ReturnType<typeof stripUploadingPlaceholders>,
): Promise<typeof notes.$inferSelect> {
  const [row] = await tx
    .insert(notes)
    .values({
      workspaceId,
      title,
      titleSource: titleWasProvided ? "manual" : "auto",
      createdBy: userId,
    })
    .returning();

  // P6 Journey：note 里程碑（同事务原子；无 active Journey 零开销）。
  await hookJourneyEntityCreated(tx, { workspaceId, userId }, {
    eventType: "note.created",
    entityId: row.id,
  });

  const [version] = await tx
    .insert(noteVersions)
    .values({
      noteId: row.id,
      workspaceId,
      versionNo: 1,
      contentJson: { blocks: sanitizedBlocks },
      contentHash: computeContentHash({ blocks: sanitizedBlocks }),
      createdBy: userId,
    })
    .returning();

  if (sanitizedBlocks.length) {
    const blocksWithAssets = await resolveImageAssetIds(tx, workspaceId, sanitizedBlocks);
    await tx.insert(noteBlocks).values(
      blocksWithAssets.map((b, idx) => ({
        versionId: version.id,
        workspaceId,
        ordinal: idx,
        type: b.type,
        content: b.content,
        imageAssetId: b.imageAssetId,
      })),
    );
  }

  await tx
    .update(notes)
    .set({ currentVersionId: version.id, updatedAt: new Date() })
    .where(eq(notes.id, row.id));

  return row;
}

export async function createNote(
  executor: ApiTransaction,
  workspaceId: string,
  userId: string,
  input: NoteCreateInput,
) {
  // 自动提取标题：取 blocks 里第一个 heading 或 paragraph 的 content
  // 先过滤掉上传中的图片占位符，避免残缺的 image block 被持久化
  const sanitizedBlocks = stripUploadingPlaceholders(input.blocks ?? []);
  const titleWasProvided = Boolean(input.title?.trim());
  const title = titleWasProvided ? input.title.trim().slice(0, 200) : deriveNoteTitle(sanitizedBlocks);

  // QUAL-03 修复：移除 IIFE 模式，executor 即事务执行器，无需额外包装
  const note = await createNoteTx(executor, workspaceId, userId, title, titleWasProvided, sanitizedBlocks);

  // 同步搜索索引（note_version 创建时）
  const result = await getNoteWithVersion(executor, note.id, workspaceId);
  if (result) {
    const body = (result.blocks as NoteBlock[])
      .filter((b) => b.type !== "image")
      .map((b) => b.content)
      .join("\n");
    await upsertSearchDocument(executor, {
      workspaceId,
      objectType: "note",
      objectId: note.id,
      title: result.note.title,
      body,
    });
  }
  return result;
}

export async function listNotes(
  executor: ApiTransaction,
  workspaceId: string,
  opts?: { cursor?: string; limit?: number; trashed?: boolean },
) {
  const limit = Math.max(1, Math.min(100, opts?.limit ?? 100));
  // CONC-03: trashed=true 时查询已软删除的笔记，默认查询未删除的
  const conditions = [
    eq(notes.workspaceId, workspaceId),
    opts?.trashed ? isNotNull(notes.deletedAt) : isNull(notes.deletedAt),
  ];

  // R-019: 使用 cursor 分页，基于 (updatedAt, id) 复合排序
  // cursor 是 base64 编码的 "updatedAt:id"
  if (opts?.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      const cursorTs = decoded.timestamp;
      const cursorId = decoded.id;
      // Keep the timestamp as an ISO string and cast it explicitly. Passing a
      // JavaScript Date through a raw tuple serializes it as a locale string.
      conditions.push(
        sql`(${notes.updatedAt}, ${notes.id}) < (${cursorTs}::timestamptz, ${cursorId}::uuid)`,
      );
    }
  }

  // PERF-07 fix: Run page query and count query in parallel since they are independent.
  // The total reflects the global count (ignoring cursor), which is semantically
  // correct for cursor pagination. In high-concurrency write scenarios the total
  // may differ slightly from the actual page contents, but this is an inherent
  // trade-off of cursor pagination and acceptable for note lists.
  const countConditions = and(
    eq(notes.workspaceId, workspaceId),
    opts?.trashed ? isNotNull(notes.deletedAt) : isNull(notes.deletedAt),
  );

  const [rows, countRows] = await Promise.all([
    executor
      .select({
        id: notes.id,
        title: notes.title,
        titleSource: notes.titleSource,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
        deletedAt: notes.deletedAt,
        currentVersionId: notes.currentVersionId,
        workspaceId: notes.workspaceId,
        createdBy: notes.createdBy,
        cursorTimestamp: sql<string>`to_char(${notes.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(notes)
      .where(and(...conditions))
      .orderBy(desc(notes.updatedAt), desc(notes.id))
      .limit(limit + 1),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(notes)
      .where(countConditions),
  ]);

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const total = countRows[0]?.count ?? 0;

  // R-019: 使用最后一条记录的 (updatedAt, id) 作为下一页 cursor
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow
    ? encodeCursor(lastRow.cursorTimestamp, lastRow.id)
    : null;

  return {
    items: pageRows.map((r) => ({
      id: r.id,
      title: r.title,
      titleSource: r.titleSource,
      currentVersionId: r.currentVersionId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    nextCursor,
    total,
  };
}

export async function getNoteWithVersion(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
) {
  // CONC-03: 不返回已软删除的笔记
  const note = await executor.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
  });
  if (!note) return null;

  const versionId = note.currentVersionId;
  if (!versionId) return null;

  const version = await executor.query.noteVersions.findFirst({
    where: eq(noteVersions.id, versionId),
  });
  if (!version) return null;

  const blocks = await executor.query.noteBlocks.findMany({
    where: eq(noteBlocks.versionId, versionId),
    orderBy: (b, { asc: asc1 }) => [asc1(b.ordinal)],
  });

  return {
    note,
    version,
    blocks: blocks as NoteBlock[],
  };
}

export async function updateNote(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
  userId: string,
  input: NoteUpdateInput,
) {
  // P1-4: 业务写入和搜索投影共享 handler 事务；投影自身以 savepoint 隔离失败。
  // QUAL-03 修复：移除 IIFE 模式，executor 即事务执行器，无需额外包装
  const tx = executor;
    // R-008: 使用 FOR UPDATE 锁定 note 行，防止并发版本号冲突
    // CONC-03: 只锁定未软删除的笔记
    const noteRows = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)))
      .for("update");
    const note = noteRows[0];
    if (!note) return null;

    // R-008: 乐观并发控制 — 标题或正文更新时 baseVersionId 必须匹配。
    if (
      input.baseVersionId &&
      input.baseVersionId !== note.currentVersionId
    ) {
      throw new RevisionConflictError(note.currentVersionId);
    }

    const requestedManualTitle = typeof input.title === "string"
      ? input.title.trim().slice(0, 200) || "无标题笔记"
      : null;
    const effectiveTitleSource = requestedManualTitle !== null ? "manual" : note.titleSource;
    const effectiveTitle = requestedManualTitle ?? note.title;
    const manualTitleChanged =
      requestedManualTitle !== null &&
      (requestedManualTitle !== note.title || note.titleSource !== "manual");

    if (manualTitleChanged) {
      await tx
        .update(notes)
        .set({ title: requestedManualTitle, titleSource: "manual", updatedAt: new Date() })
        .where(eq(notes.id, noteId));
    }

    // 标题单独修改时，精确克隆当前正文为一个新版本。currentVersionId 同时
    // 是客户端 OCC 令牌；如果只改 notes.title，多标签页会持有同一令牌并
    // 静默覆盖。仅对带 baseVersionId 的新协议请求推进版本，保留 service
    // 对旧内部调用的兼容性（HTTP schema 已强制 mutation 必须携带 base）。
    if (
      !Array.isArray(input.blocks) &&
      manualTitleChanged &&
      note.currentVersionId &&
      input.baseVersionId
    ) {
      const currentVersion = await tx.query.noteVersions.findFirst({
        where: eq(noteVersions.id, note.currentVersionId),
      });
      if (currentVersion) {
        const currentBlocks = await tx.query.noteBlocks.findMany({
          where: eq(noteBlocks.versionId, note.currentVersionId),
          orderBy: (b, { asc: asc1 }) => [asc1(b.ordinal)],
        });
        const latest = await tx.query.noteVersions.findFirst({
          where: eq(noteVersions.noteId, noteId),
          orderBy: (v, { desc: desc1 }) => [desc1(v.versionNo)],
        });
        const nextVersionNo = (latest?.versionNo ?? 0) + 1;
        const [newVersion] = await tx
          .insert(noteVersions)
          .values({
            noteId,
            workspaceId,
            versionNo: nextVersionNo,
            contentJson: currentVersion.contentJson,
            contentHash: currentVersion.contentHash,
            createdBy: userId,
          })
          .returning();

        if (currentBlocks.length) {
          await tx.insert(noteBlocks).values(
            currentBlocks.map((block) => ({
              versionId: newVersion.id,
              workspaceId,
              ordinal: block.ordinal,
              type: block.type,
              content: block.content,
              imageAssetId: block.imageAssetId,
              sourceRef: block.sourceRef ?? null,
            })),
          );
        }

        await tx
          .update(notes)
          .set({
            currentVersionId: newVersion.id,
            title: requestedManualTitle,
            titleSource: "manual",
            updatedAt: new Date(),
          })
          .where(eq(notes.id, noteId));
      }
    }

    if (Array.isArray(input.blocks)) {
      // 过滤掉上传中的图片占位符，避免残缺的 image block 被持久化
      const sanitizedBlocks = stripUploadingPlaceholders(input.blocks);
      const autoTitle = deriveNoteTitle(sanitizedBlocks);
      const contentJson = { blocks: sanitizedBlocks };
      const contentHash = computeContentHash(contentJson);

      // 1. 内容去重：如果内容与某个已有版本完全一致，直接指向该版本
      //    先按 content_hash 索引快速查找候选，再用 canonical JSON 深度比对
      //    确认内容真正一致，防御极低概率的哈希碰撞。
      const hashMatch = await tx.query.noteVersions.findFirst({
        where: and(
          eq(noteVersions.noteId, noteId),
          eq(noteVersions.contentHash, contentHash),
        ),
      });
      // 二次验证：哈希匹配后确认 contentJson 实际内容一致
      // （contentJson 为 NOT NULL 列，防御性检查 undefined 仅供 mock 兼容）
      // 手动标题修改也必须推进 currentVersionId：它既是版本指针，也是
      // 编辑器的 OCC 令牌。否则同内容的标题更新会绕过去重分支静默互相覆盖。
      const existingVersion =
        !manualTitleChanged && hashMatch && hashMatch.contentJson &&
        computeContentHash(hashMatch.contentJson) === contentHash
          ? hashMatch
          : null;

      if (existingVersion) {
        // 内容匹配已有版本，不创建新版本，仅更新 currentVersionId
        const dedupTitle = effectiveTitleSource === "manual" ? effectiveTitle : autoTitle;
        const titleChanged = dedupTitle !== note.title || effectiveTitleSource !== note.titleSource;
        // 仅在 currentVersionId 或标题实际变化时才写入，避免冗余 UPDATE
        if (existingVersion.id !== note.currentVersionId || titleChanged) {
          await tx
            .update(notes)
            .set({
              currentVersionId: existingVersion.id,
              title: dedupTitle,
              titleSource: effectiveTitleSource,
              updatedAt: new Date(),
            })
            .where(eq(notes.id, noteId));
        }
      } else if (input.isAutosave && note.currentVersionId && !manualTitleChanged) {
        // 2. 自动保存模式：尝试原地更新当前版本
        const canInPlace = await canUpdateVersionInPlace(tx, note.currentVersionId);
        if (canInPlace) {
          await updateVersionInPlace(tx, note.currentVersionId, workspaceId, contentJson, contentHash, sanitizedBlocks);
          await tx
            .update(notes)
            .set({
              title: effectiveTitleSource === "manual" ? effectiveTitle : autoTitle,
              titleSource: effectiveTitleSource,
              updatedAt: new Date(),
            })
            .where(eq(notes.id, noteId));
        } else {
          // 有卡片引用，降级为创建新版本
          const latest = await tx.query.noteVersions.findFirst({
            where: eq(noteVersions.noteId, noteId),
            orderBy: (v, { desc: desc1 }) => [desc1(v.versionNo)],
          });
          const nextVersionNo = (latest?.versionNo ?? 0) + 1;
          const [newVersion] = await tx
            .insert(noteVersions)
            .values({
              noteId,
              workspaceId,
              versionNo: nextVersionNo,
              contentJson,
              contentHash,
              createdBy: userId,
            })
            .returning();

          if (sanitizedBlocks.length) {
            const blocksWithAssets = await resolveImageAssetIds(tx, workspaceId, sanitizedBlocks);
            await tx.insert(noteBlocks).values(
              blocksWithAssets.map((b, idx) => ({
                versionId: newVersion.id,
                workspaceId,
                ordinal: idx,
                type: b.type,
                content: b.content,
                imageAssetId: b.imageAssetId,
              })),
            );
          }

          await tx
            .update(notes)
            .set({
              currentVersionId: newVersion.id,
              title: effectiveTitleSource === "manual" ? effectiveTitle : autoTitle,
              titleSource: effectiveTitleSource,
              updatedAt: new Date(),
            })
            .where(eq(notes.id, noteId));
        }
      } else {
        // 3. 显式保存或无法原地更新：创建新版本
        const latest = await tx.query.noteVersions.findFirst({
          where: eq(noteVersions.noteId, noteId),
          orderBy: (v, { desc: desc1 }) => [desc1(v.versionNo)],
        });
        const nextVersionNo = (latest?.versionNo ?? 0) + 1;
        const [newVersion] = await tx
          .insert(noteVersions)
          .values({
            noteId,
            workspaceId,
            versionNo: nextVersionNo,
            contentJson,
            contentHash,
            createdBy: userId,
          })
          .returning();

        if (sanitizedBlocks.length) {
          const blocksWithAssets = await resolveImageAssetIds(tx, workspaceId, sanitizedBlocks);
          await tx.insert(noteBlocks).values(
            blocksWithAssets.map((b, idx) => ({
              versionId: newVersion.id,
              workspaceId,
              ordinal: idx,
              type: b.type,
              content: b.content,
              imageAssetId: b.imageAssetId,
            })),
          );
        }

        await tx
          .update(notes)
          .set({
            currentVersionId: newVersion.id,
            title: effectiveTitleSource === "manual" ? effectiveTitle : autoTitle,
            titleSource: effectiveTitleSource,
            updatedAt: new Date(),
          })
          .where(eq(notes.id, noteId));
      }
    }

    // F-005: tx read inside transaction
    const uNote = await tx.query.notes.findFirst({
      where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)),
    });
    if (!uNote || !uNote.currentVersionId) return null;
    const uVer = await tx.query.noteVersions.findFirst({
      where: eq(noteVersions.id, uNote.currentVersionId),
    });
    if (!uVer) return null;
    const uBlocks = await tx.query.noteBlocks.findMany({
      where: eq(noteBlocks.versionId, uNote.currentVersionId),
      orderBy: (b, { asc: a1 }) => [a1(b.ordinal)],
    });
    const result = { note: uNote, version: uVer, blocks: uBlocks as NoteBlock[] };

  // R-017: 即使只改标题也更新搜索投影（标题投影不会持续过期）。
  if (result) {
    const body = Array.isArray(input.blocks)
      ? (result.blocks as NoteBlock[])
          .filter((b) => b.type !== "image")
          .map((b) => b.content)
          .join("\n")
      : null;
    // 只改标题时，body 从已有版本获取（同样过滤 image block）
    const effectiveBody = body ?? (result.blocks as NoteBlock[])
      .filter((b) => b.type !== "image")
      .map((b) => b.content)
      .join("\n");
    await upsertSearchDocument(executor, {
      workspaceId,
      objectType: "note",
      objectId: noteId,
      title: result.note.title,
      body: effectiveBody,
    });
  }

  return result;
}

/**
 * CONC-03: 软删除笔记 — 设置 deleted_at 而非物理删除。
 *
 * 软删除后：
 * - 笔记从列表、搜索结果中消失（查询过滤 deleted_at IS NULL）
 * - 关联数据（版本、学习卡、证据等）保留，恢复时可直接还原
 * - 30 天后由定时任务调用 physicalDeleteNote 物理删除
 *
 * 仍使用 FOR UPDATE 行锁（CONC-01），与 updateNote / restoreNoteVersion 互斥。
 */
export async function deleteNote(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
) {
  // CONC-01: FOR UPDATE 锁定 note 行，防止与 updateNote / restoreNoteVersion 并发丢数据
  // CONC-03: 只处理未软删除的笔记
  const noteRows = await executor
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)))
    .for("update");
  const note = noteRows[0];
  if (!note) return null;

  // 软删除：设置 deleted_at
  // 使用单一 timestamp，供 restoreDeletedNote 精确匹配被 deleteNote 归档的卡片
  const deletedAt = new Date();
  await executor
    .update(notes)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(eq(notes.id, noteId));

  // P2-2: 归档关联的 active 卡片，取消 pending 复习计划，清理卡片搜索索引
  const versionRows = await executor
    .select({ id: noteVersions.id })
    .from(noteVersions)
    .where(eq(noteVersions.noteId, noteId));
  const versionIds = versionRows.map((v) => v.id);

  if (versionIds.length > 0) {
    // 归档 active 卡片（使用 deletedAt 时间戳，供恢复时精确匹配）
    // CONC-10-edge: 同时设置专用标记列 archivedByNoteDeletionAt，
    // 不受其他操作（如 card/service archiveCard 覆盖 updatedAt）的影响。
    // N#7-13: versionIds 分批归档，避免大数组 IN 参数越界。
    for (let i = 0; i < versionIds.length; i += 500) {
      const chunk = versionIds.slice(i, i + 500);
      await executor
        .update(learningCards)
        .set({ status: CardStatus.ARCHIVED, updatedAt: deletedAt, archivedByNoteDeletionAt: deletedAt })
        .where(and(
          inArray(learningCards.noteVersionId, chunk),
          eq(learningCards.status, CardStatus.ACTIVE),
        ));
    }

    // CONC-08: 只取消被归档卡片的 pending 复习计划，与 restoreDeletedNote
    // 的恢复范围保持对称。查询刚被归档的卡片（archivedByNoteDeletionAt === deletedAt），
    // 而非所有关联卡片，避免取消 SUPERSEDED 等卡片的计划后无法正确恢复。
    // CONC-10-edge: 使用专用标记列匹配，即使 updatedAt 被其他操作覆盖也能正确识别。
    const cardRows = await executor
      .select({ id: learningCards.id })
      .from(learningCards)
      .where(and(
        inArray(learningCards.noteVersionId, versionIds),
        eq(learningCards.status, CardStatus.ARCHIVED),
        eq(learningCards.archivedByNoteDeletionAt, deletedAt),
      ));
    const cardIds = cardRows.map((c) => c.id);

    if (cardIds.length > 0) {
      // CONC-10: 设置 updatedAt = deletedAt，供 restoreDeletedNote
      // 精确匹配被 deleteNote 取消的计划，避免误恢复之前手动取消的计划。
      await executor
        .update(reviewSchedules)
        .set({ status: ReviewStatus.CANCELLED, updatedAt: deletedAt })
        .where(and(
          eq(reviewSchedules.workspaceId, workspaceId),
          eq(reviewSchedules.status, ReviewStatus.PENDING),
          eq(reviewSchedules.subjectType, "card"),
          inArray(reviewSchedules.subjectId, cardIds),
        ));

      // 清理卡片搜索索引
      await deleteSearchDocuments(executor, workspaceId,
        cardIds.map((id) => ({ objectType: "card" as const, objectId: id })),
      );
    }
  }

  // 清理搜索索引 — 软删除后笔记不应出现在搜索结果中
  await deleteSearchDocuments(executor, workspaceId, [
    { objectType: "note", objectId: noteId },
  ]);

  return { ok: true as const };
}

/**
 * CONC-03: 恢复软删除的笔记 — 清除 deleted_at，重建搜索索引。
 */
export async function restoreDeletedNote(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
) {
  // QUAL-03 修复：移除 IIFE 模式，executor 即事务执行器，无需额外包装
  const tx = executor;
    // FOR UPDATE 锁定 note 行（包括已软删除的）
    const noteRows = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)))
      .for("update");
    const note = noteRows[0];
    if (!note) return null;

    // 只恢复已软删除的笔记
    // P2-3: 笔记未删除时抛出 NoteNotDeletedError，路由层返回 409
    if (!note.deletedAt) throw new NoteNotDeletedError();

    // 清除 deleted_at
    await tx
      .update(notes)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(notes.id, noteId));

    // P2-2: 恢复被软删除时归档的卡片和取消的复习计划
    // 只恢复被 deleteNote 归档的卡片（updatedAt 与 deletedAt 精确匹配），
    // 避免恢复用户在笔记删除前就已手动归档的卡片
    const versionRows = await tx
      .select({ id: noteVersions.id })
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId));
    const versionIds = versionRows.map((v) => v.id);

    let restoredCards: Array<{ id: string; schemaJson: { title: string; summary: string } }> = [];
    if (versionIds.length > 0 && note.deletedAt) {
      // 查找被 deleteNote 归档的卡片（archivedByNoteDeletionAt === deletedAt）
      // CONC-10-edge: 使用专用标记列匹配，即使卡片在笔记软删除后被其他操作
      // （如 card/service archiveCard）覆盖了 updatedAt，仍能正确识别并恢复。
      const archivedByDelete = await tx
        .select({
          id: learningCards.id,
          schemaJson: learningCards.schemaJson,
        })
        .from(learningCards)
        .where(and(
          inArray(learningCards.noteVersionId, versionIds),
          eq(learningCards.status, CardStatus.ARCHIVED),
          eq(learningCards.archivedByNoteDeletionAt, note.deletedAt),
        ));
      const restoredCardIds = archivedByDelete.map((c) => c.id);
      restoredCards = archivedByDelete;

      if (restoredCardIds.length > 0) {
        // 恢复被 deleteNote 归档的卡片为 active
        // CONC-10-edge: 清除专用标记列 archivedByNoteDeletionAt
        await tx
          .update(learningCards)
          .set({ status: CardStatus.ACTIVE, updatedAt: new Date(), archivedByNoteDeletionAt: null })
          .where(and(
            inArray(learningCards.id, restoredCardIds),
            eq(learningCards.status, CardStatus.ARCHIVED),
          ));

        // 恢复被 deleteNote 取消的复习计划（仅针对被恢复的卡片）。
        // CONC-08: deleteNote 只取消被归档卡片的 PENDING 计划，
        // 与此处的恢复范围对称。
        // CONC-10: 用 updatedAt = note.deletedAt 精确匹配被 deleteNote
        // 取消的计划（deleteNote 取消时将 updatedAt 设为 deletedAt），
        // 避免误恢复用户在笔记删除前就已手动取消的计划。
        //
        // SEC-01 说明：此处使用 updatedAt 时间戳匹配恢复范围，存在极端竞态窗口。
        // 卡片恢复已通过专用标记列 archivedByNoteDeletionAt 精确匹配（见上方），
        // 但复习计划仍依赖 updatedAt 精确匹配 deletedAt。
        // 风险：如果 deleteNote 和 restoreDeletedNote 之间的时间精度不一致
        //（PostgreSQL timestamptz 微秒精度 vs JS Date 毫秒精度），可能导致匹配失败。
        // 缓解措施：deleteNote 在同一事务内设置 deletedAt 和 updatedAt，
        // 使用相同的 Date 对象，确保时间戳一致。实际竞态概率极低。
        // 建议改进：未来为 reviewSchedules 添加专用标记列（如 cancelledByNoteDeletionAt），
        // 彻底消除时间戳匹配的竞态风险。
        await tx
          .update(reviewSchedules)
          .set({ status: ReviewStatus.PENDING, updatedAt: new Date() })
          .where(and(
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.status, ReviewStatus.CANCELLED),
            eq(reviewSchedules.subjectType, "card"),
            inArray(reviewSchedules.subjectId, restoredCardIds),
            eq(reviewSchedules.updatedAt, note.deletedAt),
          ));
      }
    }

    // 返回恢复后的完整数据
    const versionId = note.currentVersionId;
    if (!versionId) return { note: { ...note, deletedAt: null }, version: null, blocks: [] as NoteBlock[], restoredCards };

    const version = await tx.query.noteVersions.findFirst({
      where: eq(noteVersions.id, versionId),
    });
    if (!version) return { note: { ...note, deletedAt: null }, version: null, blocks: [] as NoteBlock[], restoredCards };

    const blocks = await tx.query.noteBlocks.findMany({
      where: eq(noteBlocks.versionId, versionId),
      orderBy: (b, { asc }) => [asc(b.ordinal)],
    });

    const result = {
      note: { ...note, deletedAt: null },
      version,
      blocks: blocks as NoteBlock[],
      restoredCards,
    };

  // 恢复后重建搜索索引
  if (result?.version) {
    const body = (result.blocks as NoteBlock[])
      .filter((b) => b.type !== "image")
      .map((b) => b.content)
      .join("\n");
    await upsertSearchDocument(executor, {
      workspaceId,
      objectType: "note",
      objectId: noteId,
      title: result.note.title,
      body,
    });
  }

  // 重建被恢复卡片的搜索索引（deleteNote 清理了卡片搜索文档）
  // BUG-02 fix: Batch query keyPoints for all restored cards instead of N+1 queries.
  if (result?.restoredCards?.length) {
    const cardIds = result.restoredCards.map((c) => c.id);
    // Batch query all keyPoints for restored cards in one query
    // Y4（round-3 审计）：批量恢复大量卡片时裸 inArray 可能超参数上限，分块查询。
    const allKeyPoints = await chunkedInArraySelect<typeof cardKeyPoints.$inferSelect>(
      (chunk) => executor.query.cardKeyPoints.findMany({
        where: inArray(cardKeyPoints.cardId, chunk),
      }),
      cardIds,
    );
    // Group keyPoints by cardId
    const keyPointsByCard = new Map<string, typeof allKeyPoints>();
    for (const kp of allKeyPoints) {
      const list = keyPointsByCard.get(kp.cardId) ?? [];
      list.push(kp);
      keyPointsByCard.set(kp.cardId, list);
    }
    for (const card of result.restoredCards) {
      const keyPoints = keyPointsByCard.get(card.id) ?? [];
      const cardBody = [
        card.schemaJson.summary,
        ...keyPoints.map((kp) => kp.claim),
      ].join("\n");
      await upsertSearchDocument(executor, {
        workspaceId,
        objectType: "card",
        objectId: card.id,
        title: card.schemaJson.title,
        body: cardBody,
      });
    }
  }

  return result;
}

/**
 * CONC-03: 物理删除笔记 — 级联清理所有关联数据。
 *
 * 由定时任务在软删除 30 天后调用，或由管理员手动触发。
 *
 * 使用 FOR UPDATE 锁定 note 行，与 restoreDeletedNote 互斥——
 * 防止「物理删除进行中，笔记被并发恢复」导致恢复的笔记被级联删除。
 *
 * @param options.force — 跳过 deletedAt 检查，允许物理删除未软删除的笔记。
 *   用于 benchmark 清理等需要强制删除 active 笔记的场景。正常定时任务和
 *   管理员手动触发不传此参数，保持 CONC-07 的安全检查。
 */

/**
 * QUAL-03 修复：提取命名函数替代 IIFE 模式。
 * 级联删除卡片关联的 AI artifacts（包括卡片 artifact 和验证 artifact）。
 * 使用分块查询和分块删除避免大数组 IN 子句性能退化。
 *
 * @param tx 事务执行器
 * @param cardIds 待删除卡片关联的 card IDs
 * @param validationArtifactIds 验证事件关联的 artifact IDs
 */
async function deleteCardArtifactsCascade(
  tx: ApiTransaction,
  cardIds: string[],
  validationArtifactIds: string[],
): Promise<void> {
  // PERF-10 补漏: 使用分块查询避免大数组 IN 子句性能退化
  const cardRowsForArtifacts = await chunkedInArraySelect<{ artifactId: string | null }>(
    (chunk) => tx.select({ artifactId: learningCards.artifactId })
      .from(learningCards)
      .where(inArray(learningCards.id, chunk)),
    cardIds,
  );
  const cardArtifactIds = cardRowsForArtifacts
    .map((c) => c.artifactId)
    .filter((id): id is string => id !== null);
  const allArtifactIds = [...cardArtifactIds, ...validationArtifactIds];
  if (allArtifactIds.length > 0) {
    // PERF-10 补漏: 使用分块删除避免大数组 IN 子句性能退化
    await chunkedInArrayDelete(tx, aiArtifacts, aiArtifacts.id, allArtifactIds);
  }
}

export async function physicalDeleteNote(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
  options?: { force?: boolean },
) {
  // 确认笔记存在（包括已软删除的），并加 FOR UPDATE 锁定行
  // 防止与 restoreDeletedNote 并发：restore 的 FOR UPDATE 会阻塞到此事务提交
  const noteRows = await executor
    .select({ id: notes.id, deletedAt: notes.deletedAt })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)))
    .for("update");
  if (!noteRows[0]) return null;

  // CONC-07: 笔记已被并发恢复（deletedAt 被清除）— 中止物理删除。
  // force=true 时跳过此检查，允许物理删除未软删除的笔记
  // （用于 benchmark 清理等需要强制删除的场景）。
  if (!options?.force && !noteRows[0].deletedAt) return null;

  // QUAL-10 fix: Replaced IIFE pattern with a named function for clarity.
  // The previous `(async (tx) => { ... })(executor)` pattern was misleading
  // because it implied a new transaction context, but `executor` was already
  // the active transaction. Named function makes the intent explicit.
  const collectAndDeleteCascade = async (tx: ApiTransaction) => {
    // 1. 查出所有关联的 note_version IDs
    const versionRows = await tx
      .select({ id: noteVersions.id })
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId));
    const versionIds = versionRows.map((v) => v.id);

    // QUAL-11 fix: Parallelize independent ID collection queries.
    // Steps 2-5 were previously serial, but 3 (kpIds) depends on 2 (cardIds),
    // and 5 (veIds) also depends on 2 (cardIds). However, 2 itself can run
    // concurrently with nothing else (it depends on 1). Steps 3 and 5 can
    // run in parallel once cardIds is known, and step 4 depends on 3.
    // 2. 查出所有关联的 card IDs
    // PERF-10 补漏: 使用分块查询避免大数组 IN 子句性能退化
    let cardIds: string[] = [];
    if (versionIds.length > 0) {
      const cardRows = await chunkedInArraySelect<{ id: string }>(
        (chunk) => tx.select({ id: learningCards.id })
          .from(learningCards)
          .where(inArray(learningCards.noteVersionId, chunk)),
        versionIds,
      );
      cardIds = cardRows.map((c) => c.id);
    }

    // 3 & 5: kpIds depends on cardIds, veIds also depends on cardIds — run in parallel.
    // PERF-10 补漏: 使用分块查询避免大数组 IN 子句性能退化
    const [kpRowsResult, veRowsResult] = await Promise.all([
      cardIds.length > 0
        ? chunkedInArraySelect<{ id: string }>(
            (chunk) => tx.select({ id: cardKeyPoints.id }).from(cardKeyPoints).where(inArray(cardKeyPoints.cardId, chunk)),
            cardIds,
          )
        : Promise.resolve([] as { id: string }[]),
      cardIds.length > 0
        ? chunkedInArraySelect<{ id: string }>(
            (chunk) => tx.select({ id: validationEvents.id }).from(validationEvents).where(inArray(validationEvents.cardId, chunk)),
            cardIds,
          )
        : Promise.resolve([] as { id: string }[]),
    ]);
    const kpIds = kpRowsResult.map((k) => k.id);
    const veIds = veRowsResult.map((v) => v.id);

    // 4. 查出所有关联的 evidence IDs（用于搜索索引清理）
    // PERF-10 补漏: 使用分块查询避免大数组 IN 子句性能退化
    let evidenceIds: string[] = [];
    if (kpIds.length > 0) {
      const evRows = await chunkedInArraySelect<{ id: string }>(
        (chunk) => tx.select({ id: evidences.id })
          .from(evidences)
          .where(inArray(evidences.keyPointId, chunk)),
        kpIds,
      );
      evidenceIds = evRows.map((e) => e.id);
    }

    // QUAL-11 优化：合并同表删除操作并并行执行，减少数据库往返次数。
    // 步骤 6-8、10 互不依赖，使用 Promise.all 并行执行；
    // 步骤 7、8 的 veIds 和 cardIds 条件合并为单次 OR 查询。

    // 7+8: 构建合并的 understanding_events 和 review_schedules 删除条件
    const understandingConditions: ReturnType<typeof and>[] = [];
    if (veIds.length > 0) {
      understandingConditions.push(and(
        eq(understandingEvents.subjectType, "validation"),
        inArray(understandingEvents.subjectId, veIds),
      ) as ReturnType<typeof and>);
    }
    if (cardIds.length > 0) {
      understandingConditions.push(and(
        eq(understandingEvents.subjectType, "card"),
        inArray(understandingEvents.subjectId, cardIds),
      ) as ReturnType<typeof and>);
    }
    const reviewConditions: ReturnType<typeof and>[] = [];
    if (veIds.length > 0) {
      reviewConditions.push(and(
        eq(reviewSchedules.subjectType, "validation"),
        inArray(reviewSchedules.subjectId, veIds),
      ) as ReturnType<typeof and>);
    }
    if (cardIds.length > 0) {
      reviewConditions.push(and(
        eq(reviewSchedules.subjectType, "card"),
        inArray(reviewSchedules.subjectId, cardIds),
      ) as ReturnType<typeof and>);
    }

    // 6+7+8+10: 并行执行不依赖彼此结果的删除操作
    await Promise.all([
      // 6. 删除 evidences（通过 keyPointId 关联）
      // PERF-10: 使用分块删除避免大数组 IN 子句性能退化
      kpIds.length > 0
        ? chunkedInArrayDelete(tx, evidences, evidences.keyPointId, kpIds)
        : Promise.resolve(),
      // 7. 删除 understanding_events（合并 veIds 和 cardIds 条件为单次查询）
      understandingConditions.length > 0
        ? tx.delete(understandingEvents).where(or(...understandingConditions))
        : Promise.resolve(),
      // 8. 删除 review_schedules（合并 veIds 和 cardIds 条件为单次查询）
      reviewConditions.length > 0
        ? tx.delete(reviewSchedules).where(or(...reviewConditions))
        : Promise.resolve(),
      // 10. 删除 card_key_points
      // PERF-10: 使用分块删除避免大数组 IN 子句性能退化
      cardIds.length > 0
        ? chunkedInArrayDelete(tx, cardKeyPoints, cardKeyPoints.cardId, cardIds)
        : Promise.resolve(),
    ]);

    // 9. 删除 validation_events（需先收集 artifactIds 供步骤 11 使用）
    let validationArtifactIds: string[] = [];
    if (cardIds.length > 0) {
      // PERF-10: 使用分块查询/删除避免大数组 IN 子句性能退化
      const veArtifactRows = await chunkedInArraySelect<{ artifactId: string | null }>(
        (chunk) => tx.select({ artifactId: validationEvents.artifactId })
          .from(validationEvents)
          .where(inArray(validationEvents.cardId, chunk)),
        cardIds,
      );
      validationArtifactIds = veArtifactRows
        .map((v) => v.artifactId)
        .filter((id): id is string => id !== null);
      await chunkedInArrayDelete(tx, validationEvents, validationEvents.cardId, cardIds);
    }

    // 11+12: 并行执行 ai_artifacts 删除（依赖步骤 9 结果）和 jobs 删除（独立）
    // 12. 删除关联的 jobs —— N#7-13：JSONB payload->>'cardId'/'oldCardId'/'noteVersionId'/
    //    'keyPointId' inArray 逐一 500/批分块，避免大工作区突破 postgres-js ~65535 绑定参数上限
    //    （同文件 deleteSearchDocuments/chunkedInArray* 均已分块）。
    const jobPayloadKeys: Array<{ ids: string[]; key: string }> = [];
    if (cardIds.length > 0) {
      const uniqCardIds = Array.from(new Set(cardIds));
      jobPayloadKeys.push({ ids: uniqCardIds, key: "cardId" });
      jobPayloadKeys.push({ ids: uniqCardIds, key: "oldCardId" });
    }
    if (versionIds.length > 0) {
      jobPayloadKeys.push({ ids: versionIds, key: "noteVersionId" });
    }
    if (kpIds.length > 0) {
      jobPayloadKeys.push({ ids: kpIds, key: "keyPointId" });
    }
    const deleteJobPromises: Promise<unknown>[] = [];
    for (const cond of jobPayloadKeys) {
      for (let i = 0; i < cond.ids.length; i += 500) {
        const chunk = cond.ids.slice(i, i + 500);
        deleteJobPromises.push(
          tx.delete(jobs).where(and(
            eq(jobs.workspaceId, workspaceId),
            inArray(sql<string>`${jobs.payload}->>'${sql.raw(cond.key)}'`, chunk),
          )),
        );
      }
    }
    if (deleteJobPromises.length === 0) {
      deleteJobPromises.push(Promise.resolve());
    }

    await Promise.all([
      // 11. 删除 ai_artifacts（依赖步骤 9 收集的 validationArtifactIds）
      // QUAL-03 修复：提取命名函数替代 IIFE 模式，提高可读性
      cardIds.length > 0
        ? deleteCardArtifactsCascade(tx, cardIds, validationArtifactIds)
        : Promise.resolve(),
      // 12. 删除关联的 jobs（分块）
      Promise.all(deleteJobPromises),
    ]);

    // 13. 删除 learning_cards
    // PERF-10 补漏: 使用分块删除避免大数组 IN 子句性能退化
    if (versionIds.length > 0) {
      await chunkedInArrayDelete(tx, learningCards, learningCards.noteVersionId, versionIds);
    }

    // 收集图片资产与旧版 Markdown object key。Typed asset 可能被同一
    // workspace 的其他笔记版本复用，必须在级联删除后重新检查引用，
    // 只有真正 orphan 的资产才允许删除对象。
    const allBlocks = versionIds.length > 0
      ? await tx.query.noteBlocks.findMany({
          where: and(
            inArray(noteBlocks.versionId, versionIds),
            eq(noteBlocks.workspaceId, workspaceId),
          ),
        })
      : [];
    const legacyImageObjectKeys = allBlocks
      .filter((b) => b.type === "image")
      .map((b) => extractObjectKeyFromMarkdownImage(b.content))
      .filter((key): key is string => key !== null);
    const blockAssetIds = [...new Set(allBlocks.flatMap((block) =>
      block.imageAssetId ? [block.imageAssetId] : []))];
    const assetConditions = [eq(noteImageAssets.uploadedForNoteId, noteId)];
    if (blockAssetIds.length > 0) {
      assetConditions.push(inArray(noteImageAssets.id, blockAssetIds));
    }
    if (legacyImageObjectKeys.length > 0) {
      assetConditions.push(inArray(noteImageAssets.objectKey, legacyImageObjectKeys));
    }
    const candidateAssets = await tx.query.noteImageAssets.findMany({
      where: and(
        eq(noteImageAssets.workspaceId, workspaceId),
        or(...assetConditions),
      ),
    });

    // 14. 物理删除 note（级联删除 note_versions + note_blocks）
    // 防御性条件：仅删除仍处于软删除状态的笔记，防止在级联清理过程中
    // 笔记被并发恢复（FOR UPDATE 已基本保证互斥，此条件为纵深防御）。
    // force=true 时不加此条件，允许删除未软删除的笔记。
    // 如果 deleted_at 已被清除（笔记被恢复），DELETE 影响行数为 0，
    // 说明不应继续物理删除，中止并返回 null 让调用方感知。
    const [deletedNote] = await tx.delete(notes)
      .where(
        options?.force
          ? eq(notes.id, noteId)
          : and(eq(notes.id, noteId), isNotNull(notes.deletedAt)),
      )
      .returning({ id: notes.id });
    if (!deletedNote) {
      throw new Error("note permanent deletion lost its locked row");
    }

    const candidateAssetIds = candidateAssets.map((asset) => asset.id);
    const remainingAssetRefs = candidateAssetIds.length > 0
      ? await tx
          .select({ imageAssetId: noteBlocks.imageAssetId })
          .from(noteBlocks)
          .where(and(
            eq(noteBlocks.workspaceId, workspaceId),
            inArray(noteBlocks.imageAssetId, candidateAssetIds),
          ))
      : [];
    const retainedAssetIds = new Set(remainingAssetRefs.flatMap((row) =>
      row.imageAssetId ? [row.imageAssetId] : []));
    const orphanAssets = candidateAssets.filter((asset) => !retainedAssetIds.has(asset.id));
    if (orphanAssets.length > 0) {
      const deletedAt = new Date();
      await tx
        .update(noteImageAssets)
        .set({ status: "deleted", deletedAt })
        .where(and(
          eq(noteImageAssets.workspaceId, workspaceId),
          inArray(noteImageAssets.id, orphanAssets.map((asset) => asset.id)),
          isNull(noteImageAssets.deletedAt),
        ));
    }
    const knownAssetObjectKeys = new Set(candidateAssets.map((asset) => asset.objectKey));
    const unmanagedLegacyKeys = legacyImageObjectKeys.filter((key) => !knownAssetObjectKeys.has(key));
    const imageObjectKeys = [...new Set([
      ...unmanagedLegacyKeys,
      ...orphanAssets.flatMap((asset) => [
        asset.objectKey,
        ...(asset.normalizedObjectKey ? [asset.normalizedObjectKey] : []),
        ...(asset.thumbnailObjectKey ? [asset.thumbnailObjectKey] : []),
      ]),
    ])];

    return { cardIds, evidenceIds, imageObjectKeys };
  };

  const cleanupIds = await collectAndDeleteCascade(executor);

  // 清理搜索索引
  await deleteSearchDocuments(executor, workspaceId, [
    { objectType: "note", objectId: noteId },
    ...cleanupIds.cardIds.map((objectId) => ({ objectType: "card" as const, objectId })),
    ...cleanupIds.evidenceIds.map((objectId) => ({ objectType: "evidence" as const, objectId })),
  ]);

  return { ok: true, imageObjectKeys: cleanupIds.imageObjectKeys };
}

/**
 * §2.5: 笔记版本历史列表（不含 blocks 详情，按需加载）。
 * 2026-08-11（性能专项）：无分页全量返回改为 limit+offset 分页——
 * 反复编辑的笔记版本数无界，全量返回随编辑次数线性膨胀。
 * 返回数组（与既有测试/调用契约一致）；"是否还有更多"由
 * items.length === limit 判定。
 */
export async function listNoteVersions(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
  limit = 100,
  offset = 0,
) {
  // CONC-03: 不返回已软删除笔记的版本历史
  const note = await executor.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
  });
  if (!note) return null;

  return executor.query.noteVersions.findMany({
    where: eq(noteVersions.noteId, noteId),
    orderBy: (v, { desc: d }) => [d(v.versionNo)],
    limit,
    offset,
    columns: {
      id: true,
      noteId: true,
      versionNo: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * 恢复笔记到指定版本（不创建新版本，仅切换 currentVersionId）
 *
 * CONC-05: 可选传入 baseVersionId 进行乐观并发检查。如果客户端持有的
 * baseVersionId 与服务端 currentVersionId 不一致，说明期间有他人编辑，
 * 抛出 RevisionConflictError（路由层返回 409），避免无条件覆盖他人最新编辑。
 */
export async function restoreNoteVersion(
  executor: ApiTransaction,
  noteId: string,
  versionId: string,
  workspaceId: string,
  _userId: string,
  baseVersionId?: string,
) {
  // QUAL-03 修复：移除 IIFE 模式，executor 即事务执行器，无需额外包装
  const tx = executor;
    // 锁定 note 行
    // CONC-03: 只锁定未软删除的笔记
    const noteRows = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)))
      .for("update");
    const note = noteRows[0];
    if (!note) return null;

    // CONC-05: 乐观并发检查 — 如果 baseVersionId 与 currentVersionId 不匹配，拒绝恢复
    if (baseVersionId && baseVersionId !== note.currentVersionId) {
      throw new RevisionConflictError(note.currentVersionId);
    }

    // 验证目标版本存在且属于此 note
    const targetVersion = await tx.query.noteVersions.findFirst({
      where: and(
        eq(noteVersions.id, versionId),
        eq(noteVersions.noteId, noteId),
      ),
    });
    if (!targetVersion) return null;

    // 返回恢复后的完整数据
    const blocks = await tx.query.noteBlocks.findMany({
      where: eq(noteBlocks.versionId, versionId),
      orderBy: (b, { asc }) => [asc(b.ordinal)],
    });

    // 当标题来源为 auto 时，从恢复后的版本内容重新推导标题，
    // 确保 title 与恢复后的内容一致；manual 标题保持用户设定不变。
    const restoredBlocks = blocks as NoteBlock[];
    const effectiveTitle = note.titleSource === "auto"
      ? deriveNoteTitle(restoredBlocks)
      : note.title;
    const titleChanged = effectiveTitle !== note.title;
    const now = new Date();

    // 将 currentVersionId 指向目标版本（不创建新版本），
    // auto 标题模式下同步更新推导标题
    await tx
      .update(notes)
      .set({
        currentVersionId: versionId,
        ...(titleChanged ? { title: effectiveTitle } : {}),
        updatedAt: now,
      })
      .where(eq(notes.id, noteId));

    const result = {
      note: {
        ...note,
        currentVersionId: versionId,
        ...(titleChanged ? { title: effectiveTitle } : {}),
        updatedAt: now,
      },
      version: targetVersion,
      blocks: restoredBlocks,
    };

  // 恢复后同步搜索索引——currentVersionId 已切换到旧版本，
  // 搜索投影需要反映恢复后的标题和正文摘要。
  if (result) {
    const body = (result.blocks as NoteBlock[])
      .filter((b) => b.type !== "image")
      .map((b) => b.content)
      .join("\n");
    await upsertSearchDocument(executor, {
      workspaceId,
      objectType: "note",
      objectId: noteId,
      title: result.note.title,
      body,
    });
  }

  return result;
}

// purgeSoftDeletedNotes 已移至 ./maintenance.ts（系统级维护函数，不遵循 API service 契约）
