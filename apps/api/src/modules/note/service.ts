import { and, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { type ApiTransaction } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks } from "../../db/schema/note.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { evidences, validationEvents, reviewSchedules, understandingEvents } from "../../db/schema/evidence.ts";
import { aiArtifacts } from "../../db/schema/ai.ts";
import { jobs } from "../../db/schema/job.ts";
import { searchDocuments } from "../../db/schema/search.ts";
import { logger } from "../../lib/logger.ts";
import { CardStatus, ReviewStatus } from "@ailearn/shared";
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";
import { extractObjectKeyFromMarkdownImage } from "../../lib/markdown-image.ts";
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
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
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
    .select({ id: noteVersions.id })
    .from(noteVersions)
    .where(eq(noteVersions.id, versionId))
    .for("update");
  if (versionRows.length === 0) return false;

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
    await tx.insert(noteBlocks).values(
      blocks.map((b, idx) => ({
        versionId,
        workspaceId,
        ordinal: idx,
        type: b.type,
        content: b.content,
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
 * Keep projection failures non-fatal without escaping the request transaction.
 * Drizzle maps this nested transaction to a savepoint on the same connection.
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
  const documentConditions = Array.from(objectIdsByType, ([objectType, objectIds]) => and(
    eq(searchDocuments.objectType, objectType),
    inArray(searchDocuments.objectId, objectIds),
  ));

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

  const note = await (async (tx: ApiTransaction) => {
    const [row] = await tx
      .insert(notes)
      .values({
        workspaceId,
        title,
        titleSource: titleWasProvided ? "manual" : "auto",
        createdBy: userId,
      })
      .returning();

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
      await tx.insert(noteBlocks).values(
        sanitizedBlocks.map((b, idx) => ({
          versionId: version.id,
          workspaceId,
          ordinal: idx,
          type: b.type,
          content: b.content,
        })),
      );
    }

    await tx
      .update(notes)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(notes.id, row.id));

    return row;
  })(executor);

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
      const cursorTs = new Date(decoded.timestamp);
      const cursorId = decoded.id;
      // (updatedAt, id) < (cursorTs, cursorId) 的等价条件
      conditions.push(
        sql`(${notes.updatedAt}, ${notes.id}) < (${cursorTs}, ${cursorId})`,
      );
    }
  }

  const rows = await executor
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
    })
    .from(notes)
    .where(and(...conditions))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(limit);

  // R-019: 服务端返回实际总数，不再依赖前端已加载数量
  // CONC-03: count 也需随 trashed 切换条件，否则回收站 total 不正确
  const countRows = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), opts?.trashed ? isNotNull(notes.deletedAt) : isNull(notes.deletedAt)));
  const total = countRows[0]?.count ?? 0;

  // R-019: 使用最后一条记录的 (updatedAt, id) 作为下一页 cursor
  const lastRow = rows[rows.length - 1];
  const nextCursor = rows.length === limit && lastRow
    ? encodeCursor(lastRow.updatedAt, lastRow.id)
    : null;

  return {
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      titleSource: r.titleSource,
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
  const result = await (async (tx: ApiTransaction) => {
    // R-008: 使用 FOR UPDATE 锁定 note 行，防止并发版本号冲突
    // CONC-03: 只锁定未软删除的笔记
    const noteRows = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)))
      .for("update");
    const note = noteRows[0];
    if (!note) return null;

    // R-008: 乐观并发控制 — blocks 更新时 baseVersionId 必须匹配（schema 层已强制必填）
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

    if (requestedManualTitle !== null && (requestedManualTitle !== note.title || note.titleSource !== "manual")) {
      await tx
        .update(notes)
        .set({ title: requestedManualTitle, titleSource: "manual", updatedAt: new Date() })
        .where(eq(notes.id, noteId));
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
      const existingVersion =
        hashMatch && hashMatch.contentJson &&
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
      } else if (input.isAutosave && note.currentVersionId) {
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
            await tx.insert(noteBlocks).values(
              sanitizedBlocks.map((b, idx) => ({
                versionId: newVersion.id,
                workspaceId,
                ordinal: idx,
                type: b.type,
                content: b.content,
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
          await tx.insert(noteBlocks).values(
            sanitizedBlocks.map((b, idx) => ({
              versionId: newVersion.id,
              workspaceId,
              ordinal: idx,
              type: b.type,
              content: b.content,
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
    return { note: uNote, version: uVer, blocks: uBlocks as NoteBlock[] };
  })(executor);

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
    await executor
      .update(learningCards)
      .set({ status: CardStatus.ARCHIVED, updatedAt: deletedAt, archivedByNoteDeletionAt: deletedAt })
      .where(and(
        inArray(learningCards.noteVersionId, versionIds),
        eq(learningCards.status, CardStatus.ACTIVE),
      ));

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
  const result = await (async (tx: ApiTransaction) => {
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

    return {
      note: { ...note, deletedAt: null },
      version,
      blocks: blocks as NoteBlock[],
      restoredCards,
    };
  })(executor);

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
  if (result?.restoredCards?.length) {
    for (const card of result.restoredCards) {
      const keyPoints = await executor.query.cardKeyPoints.findMany({
        where: eq(cardKeyPoints.cardId, card.id),
      });
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

  const cleanupIds = await (async (tx: ApiTransaction) => {
    // 1. 查出所有关联的 note_version IDs
    const versionRows = await tx
      .select({ id: noteVersions.id })
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId));
    const versionIds = versionRows.map((v) => v.id);

    // 2. 查出所有关联的 card IDs
    let cardIds: string[] = [];
    if (versionIds.length > 0) {
      const cardRows = await tx
        .select({ id: learningCards.id })
        .from(learningCards)
        .where(inArray(learningCards.noteVersionId, versionIds));
      cardIds = cardRows.map((c) => c.id);
    }

    // 3. 查出所有关联的 keyPoint IDs
    let kpIds: string[] = [];
    if (cardIds.length > 0) {
      const kpRows = await tx
        .select({ id: cardKeyPoints.id })
        .from(cardKeyPoints)
        .where(inArray(cardKeyPoints.cardId, cardIds));
      kpIds = kpRows.map((k) => k.id);
    }

    // 4. 查出所有关联的 evidence IDs（用于搜索索引清理）
    let evidenceIds: string[] = [];
    if (kpIds.length > 0) {
      const evRows = await tx
        .select({ id: evidences.id })
        .from(evidences)
        .where(inArray(evidences.keyPointId, kpIds));
      evidenceIds = evRows.map((e) => e.id);
    }

    // 5. 查出所有关联的 validation_event IDs
    let veIds: string[] = [];
    if (cardIds.length > 0) {
      const veRows = await tx
        .select({ id: validationEvents.id })
        .from(validationEvents)
        .where(inArray(validationEvents.cardId, cardIds));
      veIds = veRows.map((v) => v.id);
    }

    // 6. 删除 evidences（通过 keyPointId 关联）
    if (kpIds.length > 0) {
      await tx.delete(evidences).where(inArray(evidences.keyPointId, kpIds));
    }

    // 7. 删除 understanding_events
    if (veIds.length > 0) {
      await tx
        .delete(understandingEvents)
        .where(
          and(
            eq(understandingEvents.subjectType, "validation"),
            inArray(understandingEvents.subjectId, veIds),
          ),
        );
    }
    if (cardIds.length > 0) {
      await tx
        .delete(understandingEvents)
        .where(
          and(
            eq(understandingEvents.subjectType, "card"),
            inArray(understandingEvents.subjectId, cardIds),
          ),
        );
    }

    // 8. 删除 review_schedules
    if (veIds.length > 0) {
      await tx
        .delete(reviewSchedules)
        .where(
          and(
            eq(reviewSchedules.subjectType, "validation"),
            inArray(reviewSchedules.subjectId, veIds),
          ),
        );
    }
    if (cardIds.length > 0) {
      await tx
        .delete(reviewSchedules)
        .where(
          and(
            eq(reviewSchedules.subjectType, "card"),
            inArray(reviewSchedules.subjectId, cardIds),
          ),
        );
    }

    // 9. 删除 validation_events
    let validationArtifactIds: string[] = [];
    if (cardIds.length > 0) {
      const veArtifactRows = await tx
        .select({ artifactId: validationEvents.artifactId })
        .from(validationEvents)
        .where(inArray(validationEvents.cardId, cardIds));
      validationArtifactIds = veArtifactRows
        .map((v) => v.artifactId)
        .filter((id): id is string => id !== null);
      await tx.delete(validationEvents).where(inArray(validationEvents.cardId, cardIds));
    }

    // 10. 删除 card_key_points
    if (cardIds.length > 0) {
      await tx.delete(cardKeyPoints).where(inArray(cardKeyPoints.cardId, cardIds));
    }

    // 11. 删除 ai_artifacts
    if (cardIds.length > 0) {
      const cardRowsForArtifacts = await tx
        .select({ artifactId: learningCards.artifactId })
        .from(learningCards)
        .where(inArray(learningCards.id, cardIds));
      const cardArtifactIds = cardRowsForArtifacts
        .map((c) => c.artifactId)
        .filter((id): id is string => id !== null);
      const allArtifactIds = [...cardArtifactIds, ...validationArtifactIds];
      if (allArtifactIds.length > 0) {
        await tx.delete(aiArtifacts).where(inArray(aiArtifacts.id, allArtifactIds));
      }
    }

    // 12. 删除关联的 jobs
    if (cardIds.length > 0) {
      await tx.delete(jobs).where(and(
        eq(jobs.workspaceId, workspaceId),
        or(
          inArray(sql<string>`${jobs.payload}->>'cardId'`, cardIds),
          inArray(sql<string>`${jobs.payload}->>'oldCardId'`, cardIds),
        ),
      ));
    }
    if (versionIds.length > 0) {
      await tx.delete(jobs).where(and(
        eq(jobs.workspaceId, workspaceId),
        inArray(sql<string>`${jobs.payload}->>'noteVersionId'`, versionIds),
      ));
    }
    if (kpIds.length > 0) {
      await tx.delete(jobs).where(and(
        eq(jobs.workspaceId, workspaceId),
        inArray(sql<string>`${jobs.payload}->>'keyPointId'`, kpIds),
      ));
    }

    // 13. 删除 learning_cards
    if (versionIds.length > 0) {
      await tx.delete(learningCards).where(inArray(learningCards.noteVersionId, versionIds));
    }

    // 收集 image objectKeys 用于事务提交后清理对象存储
    const allBlocks = versionIds.length > 0
      ? await tx.query.noteBlocks.findMany({
          where: and(
            inArray(noteBlocks.versionId, versionIds),
            eq(noteBlocks.workspaceId, workspaceId),
          ),
        })
      : [];
    const imageObjectKeys = allBlocks
      .filter((b) => b.type === "image")
      .map((b) => extractObjectKeyFromMarkdownImage(b.content))
      .filter((key): key is string => key !== null);

    // 14. 物理删除 note（级联删除 note_versions + note_blocks）
    // 防御性条件：仅删除仍处于软删除状态的笔记，防止在级联清理过程中
    // 笔记被并发恢复（FOR UPDATE 已基本保证互斥，此条件为纵深防御）。
    // force=true 时不加此条件，允许删除未软删除的笔记。
    // 如果 deleted_at 已被清除（笔记被恢复），DELETE 影响行数为 0，
    // 说明不应继续物理删除，中止并返回 null 让调用方感知。
    await tx.delete(notes)
      .where(
        options?.force
          ? eq(notes.id, noteId)
          : and(eq(notes.id, noteId), isNotNull(notes.deletedAt)),
      );

    return { cardIds, evidenceIds, imageObjectKeys };
  })(executor);

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
 */
export async function listNoteVersions(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
) {
  // CONC-03: 不返回已软删除笔记的版本历史
  const note = await executor.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
  });
  if (!note) return null;

  const versions = await executor.query.noteVersions.findMany({
    where: eq(noteVersions.noteId, noteId),
    orderBy: (v, { desc: d }) => [d(v.versionNo)],
    columns: {
      id: true,
      noteId: true,
      versionNo: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return versions;
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
  const result = await (async (tx: ApiTransaction) => {
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

    return {
      note: {
        ...note,
        currentVersionId: versionId,
        ...(titleChanged ? { title: effectiveTitle } : {}),
        updatedAt: now,
      },
      version: targetVersion,
      blocks: restoredBlocks,
    };
  })(executor);

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
