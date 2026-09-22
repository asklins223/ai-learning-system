import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { visibleNotesCondition } from "./visibility.ts";
import type { ApiTransaction } from "../../db/client.ts";
import { noteBlocks, noteDocumentStates, noteVersions, notes } from "@ailearn/shared/db-schema/note";
import { computeContentHash } from "./content-hash.ts";
import { upsertSearchDocument } from "./search-projection.ts";
import {
  deriveNoteTitle,
  docFromSnapshot,
  emptyFragmentNoteDoc,
  projectFragmentBlocks,
  readNoteTitle,
  setNoteTitle,
  snapshotOf,
  writeFragmentBlocks,
  type NoteDocBlock,
  type ProjectedNoteBlock,
} from "./doc-fragment.ts";

/**
 * `note_document_states` 的读写与投影（批次 4.1）。
 *
 * 一注一篇一文档：Y.Doc 是正文的**事实源**，`note_blocks` 是它在某个版本上的投影。
 * 文档挂在 note 上而不是挂在 version 上，因为版本是历史刻度，协同发生在"当前"。
 *
 * 一条硬约束（批次 C 换了形状之后仍然成立）：**整篇写入只留给"确实拥有整篇"的路径**——
 * 导入、来源转笔记、版本创建、恢复历史版本。交互编辑不再走这里：编辑器直接写那份共享
 * 文档（字符级合并），落盘口只负责把文档投影回关系表。旧形状下"自动保存提交整篇"
 * 会增殖块，那条实测记录搬到了 `doc-fragment.ts` 文件头；新形状下整篇写入虽然不增殖，
 * 它仍然是"以我这一版为准"的语义，用它做交互编辑就会把对端落在改动中段里的字删掉。
 */

export type NoteDocScope = { workspaceId: string; noteId: string };

/** 带查看者的作用域：读正文的入口必须是它，否则"仅自己可见"在取快照这一层就漏了。 */
export type NoteDocReadScope = NoteDocScope & { userId: string };

type NoteDoc = ReturnType<typeof emptyFragmentNoteDoc>;

/**
 * 读正文文档。没有快照时从当前版本的 note_blocks 反向补齐（这就是迁移接缝）。
 *
 * 判据在**这里**而不是只放在路由上：有快照的那条分支原本一个 `notes` 行都不读，
 * 于是"这篇是不是你的"完全取决于调用方有没有先查过——协同落盘口 `onStoreDocument`
 * 就是那样一个调用方。把判据放到加载处，任何一条按 noteId 取正文的路径都过同一道门。
 *
 * 换形状这一步带来一条一次性事实，写在这里而不是藏在迁移脚本里：批次 C 之前落库的
 * `state` 是 `Y.Array<Y.Map>` 那套编码，用 fragment 内核解它会投影出 **0 块**（实测），
 * 而下一次落盘就把那 0 行写回 `note_blocks`——静默清空正文。所以库里已有的
 * `note_document_states` 行必须清掉，让下面这条补齐路从 `note_blocks` 的行重建。
 * 本项目未上线、没有真实用户数据，这是开发库重建的一次成本，不是要写兼容分支的理由。
 */
export async function loadNoteDoc(
  tx: ApiTransaction,
  scope: NoteDocReadScope,
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
    where: and(
      eq(notes.id, scope.noteId),
      eq(notes.workspaceId, scope.workspaceId),
      visibleNotesCondition(scope.userId),
    ),
    columns: { currentVersionId: true, title: true, titleSource: true },
  });
  if (!note) throw new Error("note_doc_not_visible");
  const rows = note?.currentVersionId
    ? await tx.query.noteBlocks.findMany({
        where: and(
          eq(noteBlocks.versionId, note.currentVersionId),
          eq(noteBlocks.workspaceId, scope.workspaceId),
        ),
        orderBy: (b, { asc }) => [asc(b.ordinal)],
      })
    : [];

  const doc = emptyFragmentNoteDoc();
  setNoteTitle(doc, note?.title ?? "", note?.titleSource ?? "auto");
  // 零行的笔记会写出一块空段落，而不是零块：schema 的 `doc: block+` 不接受零子节点的
  // doc，编辑端要的是"光标的落点"。`doc-fragment.test.ts` 钉住了同一件事。
  writeFragmentBlocks(
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
 * 落盘一次 = 投影全套。**这是全仓库唯一一处把文档写回关系表的地方**。
 *
 * 要投影的东西比"正文"多，少任何一样都是一个**不报错的**错位：
 *
 *  1. `note_document_states` —— 文档本身；
 *  2. `note_blocks` —— 目标版本的行（搜索索引、卡片证据链、导出、列表预览读它）；
 *  3. **不碰** `note_versions.content_json` / `content_hash`。一个版本的快照记的是
 *     "提交当时那一版长什么样"，从建出来就不动；只有它的 `note_blocks` 行随文档移动
 *     （下游四个消费方读的是行）。这里去刷快照会连带弄坏另一件事：`checkpointNote`
 *     靠"文档与最新一版的快照不同"决定要不要建新版本，刷了就永远相同，
 *     「提交并确认」再也产不出历史；
 *  4. `notes.title` / `title_source` —— 标题的事实源是文档的 `meta`。之前它是自动保存
 *     那条按行写的路顺手更新的；那条路一停，不在这里补就会出现"正文已经变了、列表里
 *     还是旧标题"；`auto` 的时候标题是正文的函数，所以每次落盘都重算一遍；
 *  5. `notes.updated_at` —— 笔记列表按它排序，也进游标；不跟新的话"改过的笔记排在后面"；
 *  6. 搜索投影 —— 同理，否则搜索里留着旧正文。
 *
 * 一条前置：调用方给的 `versionId` **必须是没被 seal 过的**。`note_blocks` 上有个
 * `note_blocks_sealed_guard` 触发器，往被 seal 的版本里改行会直接 RAISE(55000)。
 * 协同那一路由 `resolveFlushTarget` 负责挑一个能写的版本，其余调用方给的都是自己刚
 * 建出来的那一版，天然没被 seal 过。
 */
export async function persistNoteDoc(
  tx: ApiTransaction,
  scope: NoteDocReadScope,
  doc: NoteDoc,
  versionId: string,
): Promise<{ blocks: ProjectedNoteBlock[]; versionId: string }> {
  const { workspaceId, noteId } = scope;
  const projected = projectFragmentBlocks(doc);
  const plain = projected.map(({ ordinal: _ordinal, ...block }) => block);

  await saveNoteDoc(tx, { workspaceId, noteId }, doc);
  await projectBlocksIntoVersion(tx, workspaceId, versionId, projected);

  const meta = readNoteTitle(doc);
  const titleSource = meta?.titleSource === "manual" ? "manual" : "auto";
  const title = titleSource === "manual"
    ? (meta?.title?.trim() || "无标题笔记")
    : deriveNoteTitle(plain);
  await tx
    .update(notes)
    .set({ title, titleSource, updatedAt: new Date() })
    .where(eq(notes.id, noteId));

  await upsertSearchDocument(tx, {
    workspaceId,
    objectType: "note",
    objectId: noteId,
    title,
    body: plain.filter((block) => block.type !== "image").map((block) => block.content).join("\n"),
  });

  return { blocks: projected, versionId };
}

/**
 * 协同落盘该投到哪一个版本（批次 4.4）。
 *
 * 落盘口自己不能改指针，所以"当前版本还能不能写"这个问题在这里答一次：
 * 没有当前版本（建得比第一个版本还早）或它已经被 seal（`note_blocks_sealed_guard`
 * 会拒绝改它的行）时另起一版并把指针推过来。不这么做的话这篇笔记从此落不了盘——
 * Hocuspocus 在落盘抛错时**故意**把文档留在内存里，症状是不丢内容也不报错地卡死。
 */
export async function resolveNoteDocFlushTarget(
  tx: ApiTransaction,
  scope: NoteDocReadScope,
  doc: NoteDoc,
): Promise<string> {
  const { workspaceId, noteId, userId } = scope;
  const note = await tx.query.notes.findFirst({
    where: and(
      eq(notes.id, noteId),
      eq(notes.workspaceId, workspaceId),
      visibleNotesCondition(userId),
    ),
    columns: { currentVersionId: true },
  });
  if (!note) throw new Error("note_doc_not_visible");
  const current = note.currentVersionId
    ? await tx.query.noteVersions.findFirst({
        where: eq(noteVersions.id, note.currentVersionId),
        columns: { id: true, sealedAt: true },
      })
    : null;
  if (current && !current.sealedAt) return current.id;

  const snapshot = versionSnapshotOf(
    projectFragmentBlocks(doc).map(({ ordinal: _ordinal, ...block }) => block),
  );
  return insertVersionFromSnapshot(tx, workspaceId, noteId, userId, snapshot);
}

/**
 * 快照的正文形状：只存 `{type, content}`。
 *
 * `note_versions.content_json` 从建表起就是这个形状，而 `content_hash` 按它的规范
 * 序列化算——多存一个字段等于换一套哈希，历史版本的去重与"库内外一致"那条集成用例
 * 都会错位。`sourceRef` / `imageAssetId` 是 `note_blocks` 列上的事，不属于快照。
 */
function versionSnapshotOf(blocks: readonly NoteDocBlock[]) {
  const contentJson = {
    blocks: blocks.map((block) => ({ type: block.type, content: block.content })),
  };
  return { contentJson, contentHash: computeContentHash(contentJson) };
}

/** 另起一个版本并把当前指针推过来，返回新版本的 id。 */
async function insertVersionFromSnapshot(
  tx: ApiTransaction,
  workspaceId: string,
  noteId: string,
  userId: string,
  snapshot: ReturnType<typeof versionSnapshotOf>,
): Promise<string> {
  const [latest] = await tx
    .select({ versionNo: noteVersions.versionNo })
    .from(noteVersions)
    .where(eq(noteVersions.noteId, noteId))
    .orderBy(desc(noteVersions.versionNo))
    .limit(1);
  const [created] = await tx
    .insert(noteVersions)
    .values({
      noteId,
      workspaceId,
      versionNo: (latest?.versionNo ?? 0) + 1,
      contentJson: snapshot.contentJson,
      contentHash: snapshot.contentHash,
      createdBy: userId,
    })
    .returning();
  await tx
    .update(notes)
    .set({ currentVersionId: created.id })
    .where(eq(notes.id, noteId));
  return created.id;
}

/**
 * 服务端唯一的正文写入口：加载文档 → 一次事务内改 → 交给 `persistNoteDoc` 落盘并投影。
 *
 * `mutate` 拿到活的 Y.Doc：整篇替换用 `writeFragmentBlocks`，恢复版本用
 * `restoreFragmentBlocksFrom`。除这里之外不该再有第二条改正文的路。
 */
export async function applyNoteDocUpdate(
  tx: ApiTransaction,
  scope: NoteDocReadScope,
  versionId: string,
  mutate: (doc: NoteDoc) => void,
  /**
   * 调用方已经握着目标内容时传进来（恢复历史版本就是这种）：省掉一次读，也避免
   * 在已经持锁的事务里再绕回去读 `notes`。
   */
  preload?: NoteDocBlock[],
): Promise<{ blocks: NoteDocBlock[]; doc: NoteDoc }> {
  const doc = preload ? emptyFragmentNoteDoc() : (await loadNoteDoc(tx, scope)).doc;
  if (preload) writeFragmentBlocks(doc, preload);
  doc.transact(() => mutate(doc));
  const { blocks } = await persistNoteDoc(tx, scope, doc, versionId);
  return {
    blocks: blocks.map(({ ordinal: _ordinal, ...block }) => block),
    doc,
  };
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
  scope: NoteDocReadScope,
): Promise<
    { update: Uint8Array; revision: number; backfilled: boolean; savedAt: string; shareScope: "private" | "shared" } | null
  > {
  const note = await tx.query.notes.findFirst({
    where: and(
      eq(notes.id, scope.noteId),
      eq(notes.workspaceId, scope.workspaceId),
      visibleNotesCondition(scope.userId),
    ),
    columns: { deletedAt: true, shareScope: true, updatedAt: true },
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
  return {
    update,
    revision: Number(stored?.revision ?? 0),
    backfilled,
    savedAt: note.updatedAt.toISOString(),
    // 归属随起点一起回来：客户端"要不要为这篇建长连接"的判据因此来自服务端，
    // 不是界面传进来的说法。
    shareScope: note.shareScope === "shared" ? "shared" as const : "private" as const,
  };
}

/**
 * 投影成某个版本的 `note_blocks` 行。
 *
 * 按 ordinal 对齐做增量（改变化的、补缺的、删多的），**不**删重插。两个理由：
 *  - 卡片证据链锚在块上，行 id 一旦被换掉，指向它的证据就成了悬空引用；
 *  - 自动保存是热路径，删重插会把之前专门修掉的写放大再引回来。
 * 现在文档是事实源，所以这里不再需要"猜上一版残留了什么"：读出来什么，就和文档对齐什么。
 *
 * ⚠️ 被删掉的 ordinal 行会留下**悬空的块引用**：卡片证据链把 `block_id` 存成没有外键的
 * uuid（`card_generation_v2` 里那条是 nullable），所以删行不会报错，只会让那张卡片的锚
 * 指到一个不存在的块。改成增量之前这里更糟——整篇删重插会给**每一个**块换 id。彻底收口
 * 需要一次有意识的决定（按 ordinal+hash 重新锚定，还是给证据链加真实外键并级联标记），
 * 不属于这一批；这里至少保证"改一段不会把全篇的锚都换掉"。
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
