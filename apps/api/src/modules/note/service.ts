import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks } from "../../db/schema/note.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { evidences, validationEvents, reviewSchedules, understandingEvents } from "../../db/schema/evidence.ts";
import { aiArtifacts } from "../../db/schema/ai.ts";
import { jobs } from "../../db/schema/job.ts";
import { searchDocuments } from "../../db/schema/search.ts";
import { logger } from "../../lib/logger.ts";
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";
import type { NoteCreateInput, NoteUpdateInput, NoteBlock } from "./schema.ts";

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

function cleanTitleCandidate(content: string): string {
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

function deriveNoteTitle(blocks: NoteBlock[] | Array<{ type: NoteBlock["type"]; content: string }>): string {
  const heading = blocks.find((block) => block.type === "heading" && cleanTitleCandidate(block.content));
  const fallback = heading ?? blocks.find((block) => cleanTitleCandidate(block.content));
  const title = fallback ? cleanTitleCandidate(fallback.content) : "";
  return title.slice(0, 60) || "无标题笔记";
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
  const titleWasProvided = Boolean(input.title?.trim());
  const title = titleWasProvided ? input.title.trim().slice(0, 200) : deriveNoteTitle(input.blocks ?? []);

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
        contentJson: { blocks: input.blocks ?? [] },
        createdBy: userId,
      })
      .returning();

    if (input.blocks?.length) {
      await tx.insert(noteBlocks).values(
        input.blocks.map((b, idx) => ({
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
    const body = (result.blocks as NoteBlock[]).map((b) => b.content).join("\n");
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
  opts?: { cursor?: string; limit?: number },
) {
  const limit = Math.max(1, Math.min(100, opts?.limit ?? 100));
  const conditions = [eq(notes.workspaceId, workspaceId)];

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
      currentVersionId: notes.currentVersionId,
      workspaceId: notes.workspaceId,
      createdBy: notes.createdBy,
    })
    .from(notes)
    .where(and(...conditions))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(limit);

  // R-019: 服务端返回实际总数，不再依赖前端已加载数量
  const countRows = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(notes)
    .where(eq(notes.workspaceId, workspaceId));
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
  const note = await executor.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)),
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
    const noteRows = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)))
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
      const autoTitle = deriveNoteTitle(input.blocks);

      // F-006: autosave and explicit save both create new immutable note_version
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
          contentJson: { blocks: input.blocks },
          createdBy: userId,
        })
        .returning();

      if (input.blocks.length) {
        await tx.insert(noteBlocks).values(
          input.blocks.map((b, idx) => ({
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
      ? (result.blocks as NoteBlock[]).map((b) => b.content).join("\n")
      : null;
    // 只改标题时，body 从已有版本获取
    const effectiveBody = body ?? (result.blocks as NoteBlock[]).map((b) => b.content).join("\n");
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

export async function deleteNote(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
) {
  const note = await executor.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)),
  });
  if (!note) return null;

  // P1-1: 级联清理所有关联数据，避免孤儿数据
  // 收集需要清理搜索索引的 ID。
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

    // 7. 删除 understanding_events（通过 subjectId 关联 validation_events 或 cardIds）
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
    // F-033: 也清理 subjectType="card" 的 understanding_events（evidence override 等写入）
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

    // 8. 删除 review_schedules（通过 subjectId 关联 validation_events 或 cardIds）
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

    // 9. 删除 validation_events（通过 cardId 关联）
    //    R-023: 先收集 validation feedback artifact IDs，避免孤儿
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

    // 10. 删除 card_key_points（通过 cardId 关联）
    if (cardIds.length > 0) {
      await tx.delete(cardKeyPoints).where(inArray(cardKeyPoints.cardId, cardIds));
    }

    // 11. 删除 ai_artifacts（学习卡 artifact + validation feedback artifact）
    //    R-023: 同时清理 validation feedback artifacts，避免孤儿
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

    // R-023: 删除关联的 jobs（包含 userAnswer 等敏感 payload）
    //    通过 JSONB payload 中的 cardId/noteVersionId/keyPointId 关联
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

    // 12. 删除 learning_cards（通过 noteVersionId 关联）
    if (versionIds.length > 0) {
      await tx.delete(learningCards).where(inArray(learningCards.noteVersionId, versionIds));
    }

    // 13. 删除 note（级联删除 note_versions + note_blocks）
    await tx.delete(notes).where(eq(notes.id, noteId));

    return { cardIds, evidenceIds };
  })(executor);

  // 同一 handler 事务内清理搜索索引；每次投影写使用 savepoint 保留补偿语义。
  await deleteSearchDocuments(executor, workspaceId, [
    { objectType: "note", objectId: noteId },
    ...cleanupIds.cardIds.map((objectId) => ({ objectType: "card" as const, objectId })),
    ...cleanupIds.evidenceIds.map((objectId) => ({ objectType: "evidence" as const, objectId })),
  ]);

  return { ok: true };
}

/**
 * §2.5: 笔记版本历史列表（不含 blocks 详情，按需加载）。
 */
export async function listNoteVersions(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
) {
  const note = await executor.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)),
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
    },
  });

  return versions;
}
