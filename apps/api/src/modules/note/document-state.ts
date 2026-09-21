import { and, eq, inArray, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { noteBlocks, noteDocumentStates, notes } from "@ailearn/shared/db-schema/note";
import {
  docFromSnapshot,
  emptyNoteDoc,
  projectNoteBlocks,
  setNoteTitle,
  snapshotOf,
  writeNoteBlocks,
  type NoteDocBlock,
} from "./doc.ts";

/**
 * `note_document_states` 的读写与投影（批次 4.1）。
 *
 * 一注一篇一文档：Y.Doc 是正文的**事实源**，`note_blocks` 是它在某个版本上的投影。
 * 文档挂在 note 上而不是挂在 version 上，因为版本是历史刻度，协同发生在"当前"。
 *
 * 一条硬约束（4.0 实测决定，见 `doc.ts` 文件头）：**只有"确实拥有整篇"的路径能走
 * 这里的整篇写入**——导入、来源转笔记、版本创建、恢复历史版本。交互自动保存不能
 * 用整篇写入（并发下块数会增殖），它要等 4.3 客户端改成上送增量之后再接进来；
 * 在那之前自动保存仍走原路，本模块只负责让事实源先统一。
 */

export type NoteDocScope = { workspaceId: string; noteId: string };

type NoteDoc = ReturnType<typeof emptyNoteDoc>;

/** 读正文文档。没有快照时从当前版本的 note_blocks 反向补齐（这就是迁移接缝）。 */
export async function loadNoteDoc(
  tx: ApiTransaction,
  scope: NoteDocScope,
): Promise<{ doc: NoteDoc; backfilled: boolean }> {
  // 快照查询也必须带 workspace_id。这张表的 RLS 会挡，但代码不能把隔离**寄托**在
  // 连接角色上：dev 全程用 superuser，策略对它不存在（实测就是这条断言先红的）。
  const stored = await tx.query.noteDocumentStates.findFirst({
    where: and(
      eq(noteDocumentStates.noteId, scope.noteId),
      eq(noteDocumentStates.workspaceId, scope.workspaceId),
    ),
  });
  if (stored) {
    return { doc: docFromSnapshot(Uint8Array.from(stored.state)), backfilled: false };
  }

  // notes / note_blocks 的 RLS 还关着（这次审查的既有事实），所以这里必须自己带上
  // workspace_id：只按 noteId 查会让陌生空间的事务读出别人的正文。实测过——不带时
  // 集成用例第 4 条读到 6 行。
  const note = await tx.query.notes.findFirst({
    where: and(eq(notes.id, scope.noteId), eq(notes.workspaceId, scope.workspaceId)),
    columns: { currentVersionId: true, title: true, titleSource: true },
  });
  const rows = note?.currentVersionId
    ? await tx.query.noteBlocks.findMany({
        where: and(
          eq(noteBlocks.versionId, note.currentVersionId),
          eq(noteBlocks.workspaceId, scope.workspaceId),
        ),
        orderBy: (b, { asc }) => [asc(b.ordinal)],
      })
    : [];

  const doc = emptyNoteDoc();
  setNoteTitle(doc, note?.title ?? "", note?.titleSource ?? "auto");
  writeNoteBlocks(
    doc,
    rows.map((row) => ({
      type: row.type,
      content: row.content,
      ...(row.sourceRef ? { sourceRef: row.sourceRef } : {}),
      ...(row.imageAssetId ? { imageAssetId: row.imageAssetId } : {}),
    })),
  );
  return { doc, backfilled: true };
}

/**
 * 落盘快照。`revision` 单调 +1，客户端用它判断本机状态落后多少。
 *
 * `state` 可以由调用方传进来（协同侧落盘时要先拿它跟库里那份比过一遍），避免
 * 一次写入编两遍码。
 */
export async function saveNoteDoc(
  tx: ApiTransaction,
  scope: NoteDocScope,
  doc: NoteDoc,
  state: Uint8Array = snapshotOf(doc),
): Promise<void> {
  await tx
    .insert(noteDocumentStates)
    .values({ noteId: scope.noteId, workspaceId: scope.workspaceId, state, revision: 1 })
    .onConflictDoUpdate({
      target: noteDocumentStates.noteId,
      set: { state, revision: sql`${noteDocumentStates.revision} + 1`, updatedAt: new Date() },
    });
}

/**
 * 服务端唯一的正文写入口：加载文档 → 一次事务内改 → 落盘 → 投影成该版本的 note_blocks。
 *
 * `mutate` 拿到活的 Y.Doc：整篇替换用 `writeNoteBlocks`，恢复版本用
 * `restoreNoteBlocksFrom`。除这里之外不该再有第二条改正文的路。
 */
export async function applyNoteDocUpdate(
  tx: ApiTransaction,
  scope: NoteDocScope,
  versionId: string,
  mutate: (doc: NoteDoc) => void,
  /**
   * 调用方已经握着目标内容时传进来（恢复历史版本就是这种）：省掉一次读，也避免
   * 在已经持锁的事务里再绕回去读 `notes`。
   */
  preload?: NoteDocBlock[],
): Promise<{ blocks: NoteDocBlock[]; doc: NoteDoc }> {
  const doc = preload ? emptyNoteDoc() : (await loadNoteDoc(tx, scope)).doc;
  if (preload) writeNoteBlocks(doc, preload);
  doc.transact(() => mutate(doc));
  await saveNoteDoc(tx, scope, doc);
  const projected = projectNoteBlocks(doc);
  await projectBlocksIntoVersion(tx, scope.workspaceId, versionId, projected);
  return { blocks: projected.map(({ ordinal: _ordinal, ...block }) => block), doc };
}

/**
 * 读"能直接喂给 Y.Doc 的那份状态"，给客户端做编辑起点（批次 4.3）。
 *
 * 为什么不能拿 `GET /v2/notes/:id` 的 blocks 自己拼一棵文档树：CRDT 的合并靠**同源
 * 历史**，从行重建出来的文档与库里那份没有共同祖先，两边一改就是 4.0 实测的块增殖。
 * 所以"要编辑就必须先拿到那份编码"，personal 空间（不建长连接）尤其需要这个口。
 *
 * 没有快照的历史笔记走 `loadNoteDoc` 的补齐路：返回的是补齐后的编码，客户端拿到的
 * 仍然是"与服务端同源的一份状态"。
 */
export async function readNoteDocState(
  tx: ApiTransaction,
  scope: NoteDocScope,
): Promise<{ update: Uint8Array; revision: number; backfilled: boolean } | null> {
  const note = await tx.query.notes.findFirst({
    where: and(eq(notes.id, scope.noteId), eq(notes.workspaceId, scope.workspaceId)),
    columns: { deletedAt: true },
  });
  if (!note || note.deletedAt !== null) return null;
  const { doc, backfilled } = await loadNoteDoc(tx, scope);
  const stored = backfilled
    ? null
    : await tx.query.noteDocumentStates.findFirst({
        where: and(
          eq(noteDocumentStates.noteId, scope.noteId),
          eq(noteDocumentStates.workspaceId, scope.workspaceId),
        ),
        columns: { revision: true },
      });
  const update = snapshotOf(doc);
  doc.destroy();
  return { update, revision: Number(stored?.revision ?? 0), backfilled };
}

/**
 * 投影成某个版本的 `note_blocks` 行。
 *
 * 按 ordinal 对齐做增量（改变化的、补缺的、删多的），**不**删重插。两个理由：
 *  - 卡片证据链锚在块上，行 id 一旦被换掉，指向它的证据就成了悬空引用；
 *  - 自动保存是热路径，删重插会把之前专门修掉的写放大再引回来。
 * 现在文档是事实源，所以这里不再需要"猜上一版残留了什么"：读出来什么，就和文档对齐什么。
 */
export async function projectBlocksIntoVersion(
  tx: ApiTransaction,
  workspaceId: string,
  versionId: string,
  blocks: Array<{ ordinal: number } & NoteDocBlock>,
): Promise<void> {
  const existing = await tx.query.noteBlocks.findMany({
    where: and(eq(noteBlocks.versionId, versionId), eq(noteBlocks.workspaceId, workspaceId)),
    columns: { id: true, ordinal: true, type: true, content: true, imageAssetId: true, sourceRef: true },
  });
  const byOrdinal = new Map(existing.map((row) => [row.ordinal, row]));
  const kept = new Set<number>();

  const toInsert: Array<typeof noteBlocks.$inferInsert> = [];
  const toUpdate: Array<typeof noteBlocks.$inferInsert & { id: string }> = [];

  for (const block of blocks) {
    kept.add(block.ordinal);
    const values = {
      versionId,
      workspaceId,
      ordinal: block.ordinal,
      type: block.type,
      content: block.content,
      imageAssetId: block.imageAssetId ?? null,
      sourceRef: block.sourceRef ?? null,
    };
    const row = byOrdinal.get(block.ordinal);
    if (!row) {
      toInsert.push(values);
    } else if (
      row.type !== block.type
      || row.content !== block.content
      || (row.imageAssetId ?? null) !== (block.imageAssetId ?? null)
      || JSON.stringify(row.sourceRef ?? null) !== JSON.stringify(block.sourceRef ?? null)
    ) {
      toUpdate.push({ id: row.id, ...values });
    }
  }

  const stale = existing.filter((row) => !kept.has(row.ordinal)).map((row) => row.id);
  if (stale.length > 0) {
    await tx.delete(noteBlocks).where(inArray(noteBlocks.id, stale));
  }
  if (toInsert.length > 0) {
    await tx.insert(noteBlocks).values(toInsert);
  }
  for (const update of toUpdate) {
    await tx.update(noteBlocks).set({
      type: update.type,
      content: update.content,
      imageAssetId: update.imageAssetId,
      sourceRef: update.sourceRef,
    }).where(eq(noteBlocks.id, update.id));
  }
}
