import { and, asc, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { applyNoteDocUpdate, loadNoteDoc, persistNoteDoc } from "./document-state.ts";
import { visibleNotesCondition, type NoteShareScope } from "./visibility.ts";
import { deriveNoteTitle, noteDocBlocksFromRows, projectFragmentBlocks, setNoteTitle, writeFragmentBlocks, type NoteDocBlock } from "./doc-fragment.ts";
import { type ApiTransaction } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks, noteImageAssets } from "@ailearn/shared/db-schema/note";
import { searchDocuments } from "@ailearn/shared/db-schema/search";
import { learningCardsV2, learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { computeContentHash } from "./content-hash.ts";
import { upsertSearchDocument, type NoteSearchDocument } from "./search-projection.ts";
import { logger } from "../../lib/logger.ts";
import { DomainError } from "@ailearn/shared";

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

/**
 * N#7-8: Bounded-concurrency async map (same shape as image-asset.ts's private
 * helper). Used for the transaction fallback download path in
 * ensureImageAssetsForBlocks so multi-image saves don't serialize MinIO network
 * I/O one object at a time, while keeping the in-flight buffer count bounded.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";
import { extractObjectKeyFromMarkdownImage } from "../../lib/markdown-image.ts";
import { downloadAndValidateImageAsset } from "../../lib/image-asset.ts";
import { isStorageConfigured } from "../../lib/object-storage.ts";
import { hookJourneyEntityCreated } from "../companion-journey/journey-hook.ts";
import type { NoteCreateInput, NoteBlock } from "./schema.ts";


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
  // PERF: Download/validate missing image assets with bounded concurrency (4,
  // matching preRegisterImageAssetsForImport) instead of one serial await per
  // object. The 4-worker pool bounds the number of in-flight image Buffers.
  const DOWNLOAD_CONCURRENCY = 4;
  const validatedList = await mapWithConcurrency(missingKeys, DOWNLOAD_CONCURRENCY, downloadAndValidateImageAsset);
  for (const validated of validatedList) {
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
    logger.info({ objectKey: validated.objectKey, workspaceId }, "registered source-imported image as note_image_asset");
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
export class RevisionConflictError extends DomainError {
  currentVersionId: string | null;
  constructor(currentVersionId: string | null) {
    super({ name: "RevisionConflictError", code: "note_version_conflict", message: "note version conflict", statusCode: 409 });
    this.currentVersionId = currentVersionId;
  }
}

/**
 * P2-3: 尝试恢复一篇未被软删除的笔记时抛出。
 * 路由层捕获后返回 409 而非 404，区分「笔记不存在」和「笔记未删除」。
 */
export class NoteNotDeletedError extends DomainError {
  constructor() {
    super({ name: "NoteNotDeletedError", code: "note_not_deleted", message: "note is not deleted", statusCode: 409 });
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
      // 批次 4.5：从这里建的笔记一律是「仅自己可见」。共享是一个需要单独点的动作，
      // 所以它不应该是任何创建路径的副产物。导入与来源转笔记不走这里——那两条路
      // 在入口上已经明示"放进共享空间即可外发"，它们建的是 `shared`。
      shareScope: "private",
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
    const initialBlocks: NoteDocBlock[] = blocksWithAssets.map((b) => ({
      type: b.type,
      content: b.content,
      ...(b.imageAssetId ? { imageAssetId: b.imageAssetId } : {}),
    }));
    // 批次 4.1：新建笔记就是文档的第一次拥有，快照从第一行起就存在，
    // 之后所有读取都走快照而不是从关系表猜。
    await applyNoteDocUpdate(
      tx,
      { workspaceId, noteId: row.id, userId },
      version.id,
      (noteDoc) => writeFragmentBlocks(noteDoc, initialBlocks),
      initialBlocks,
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
  const result = await getNoteWithVersion(executor, note.id, workspaceId, userId);
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

/**
 * 每个版本的第一张图片块（按 ordinal 最小），一次批量取。
 *
 * 只按 `version_id / ordinal` 走 `note_blocks_version_idx`，把命中版本的全部
 * 图片块拉回来在内存里取每版第一块：一版通常 0~2 张图，比按行发 N 次请求便宜，
 * 也比在 SQL 里写 DISTINCT ON 更好读。内容原样返回（`![alt](url)`），解析留给
 * 渲染层那一份 `parseImageBlock`。
 */
async function versionFactsByVersion(
  executor: ApiTransaction,
  workspaceId: string,
  versionIds: string[],
): Promise<Map<string, { firstImageBlock: string | null; hasBody: boolean }>> {
  const facts = new Map<string, { firstImageBlock: string | null; hasBody: boolean }>();
  if (versionIds.length === 0) return facts;
  const blocks = await executor
    .select({ versionId: noteBlocks.versionId, content: noteBlocks.content, type: noteBlocks.type })
    .from(noteBlocks)
    .where(and(
      eq(noteBlocks.workspaceId, workspaceId),
      inArray(noteBlocks.versionId, versionIds),
    ))
    .orderBy(asc(noteBlocks.versionId), asc(noteBlocks.ordinal), asc(noteBlocks.id));
  for (const block of blocks) {
    const entry = facts.get(block.versionId) ?? { firstImageBlock: null, hasBody: false };
    // 封面取第一张图；正文只看"非图片且内容非空"的块——空段落是编辑器光标的落点，
    // 不算正文（与渲染层 `noteParagraphCount` 同一口径，审计 F37）。
    if (block.type === "image") {
      if (entry.firstImageBlock === null) entry.firstImageBlock = block.content;
    } else if (block.content.trim().length > 0) {
      entry.hasBody = true;
    }
    facts.set(block.versionId, entry);
  }
  return facts;
}

export async function listNotes(
  executor: ApiTransaction,
  workspaceId: string,
  opts: { userId: string; cursor?: string; limit?: number; trashed?: boolean },
) {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 100));
  // CONC-03: trashed=true 时查询已软删除的笔记，默认查询未删除的
  // 批次 4.5: 「仅自己可见」的笔记不在别人的列表里——包括空间 owner。
  const conditions = [
    eq(notes.workspaceId, workspaceId),
    opts.trashed ? isNotNull(notes.deletedAt) : isNull(notes.deletedAt),
  ];

  // R-019: 使用 cursor 分页，基于 (updatedAt, id) 复合排序
  // cursor 是 base64 编码的 "updatedAt:id"
  if (opts.cursor) {
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
  const countConditions = [
    eq(notes.workspaceId, workspaceId),
    opts.trashed ? isNotNull(notes.deletedAt) : isNull(notes.deletedAt),
  ];

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
        shareScope: notes.shareScope,
        cursorTimestamp: sql<string>`to_char(${notes.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(notes)
      .where(and(visibleNotesCondition(opts.userId), ...conditions))
      .orderBy(desc(notes.updatedAt), desc(notes.id))
      .limit(limit + 1),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(notes)
      .where(and(visibleNotesCondition(opts.userId), ...countConditions)),
  ]);

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const total = countRows[0]?.count ?? 0;

  // R-019: 使用最后一条记录的 (updatedAt, id) 作为下一页 cursor
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow
    ? encodeCursor(lastRow.cursorTimestamp, lastRow.id)
    : null;

  // 封面图：正文里第一个 image 块（ordinal 最小）。列表此前什么都不带，
  // 所以"哪篇笔记有图"只能挨篇点开看（复盘 #17）。一次批量查，不按行发请求。
  // 这里回的是那一行原文 `![alt](url)`：解析规则全仓库只有渲染层一份
  // （`note-blocks.parseImageBlock`），服务端不再写第二个 markdown 解析器。
  const versionIds = pageRows
    .map((r) => r.currentVersionId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const factsByVersion = await versionFactsByVersion(executor, workspaceId, versionIds);

  return {
    // 列表行自己带归属与"你能不能改归属"：库页的每一行都要显示「仅自己可见 /
    // 已共享给空间」并在不能改时说清原因，让界面再发一次详情请求只为拿两个布尔值
    // 是纯粹的浪费，也让那条判据在界面上有第二个来源。
    items: pageRows.map((r) => ({
      id: r.id,
      title: r.title,
      titleSource: r.titleSource,
      shareScope: r.shareScope,
      canShare: r.createdBy === opts.userId,
      firstImageBlock: r.currentVersionId ? factsByVersion.get(r.currentVersionId)?.firstImageBlock ?? null : null,
      // 空稿和写过正文的笔记在列表里必须能分开（审计 F37）：没有版本的笔记同样算空稿。
      hasBody: r.currentVersionId ? factsByVersion.get(r.currentVersionId)?.hasBody ?? false : false,
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
  userId: string,
) {
  // CONC-03: 不返回已软删除的笔记
  // 批次 4.5: 读点与写点是同一条判据。这里漏掉就等于"列表里看不见、知道 uuid 就能读"。
  const note = await executor.query.notes.findFirst({
    where: and(
      eq(notes.id, noteId),
      eq(notes.workspaceId, workspaceId),
      visibleNotesCondition(userId),
      isNull(notes.deletedAt),
    ),
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

/**
 * 「提交并确认」= 把文档此刻的内容定成一个新版本（批次 4.4 的最后一环）。
 *
 * 它**不收正文**。这正是这一批要关的那个洞的正门：原来的 `PATCH /v2/notes/:id`
 * 同时收整篇正文和一个版本指针当 OCC 令牌，两扇窗口（或两个人）拿着同一个令牌时
 * 两边都能通过检查，后写的那一次把前一次的正文原地覆盖掉，而且没有版本可恢复。
 * 现在正文只从文档来（全仓库只有 `persistNoteDoc` 那一个落盘口），这里只决定
 * "要不要把此刻定成一版"——覆盖不再可能，因为内容不是谁提交上来的，是文档本身。
 *
 * 三种情形：
 *  - 正文与某个已有版本一致、标题也没改 → 不建版本，把指针对准它
 *    （连按两次「提交并确认」不会多出两个一模一样的版本）；
 *  - 改了标题 → 标题写进文档的 `meta`（那里才是事实源，落盘口会投影回 `notes.title`），
 *    并新建一版；
 *  - 正文变了 → 新建一版。
 *
 * `baseVersionId` 留着，但语义变了：它是"我屏幕上看到的当前版是不是这一版"的确认，
 * 不再兼作正文的并发令牌。正文的并发由 CRDT 合并负责，不需要令牌。
 */
export async function checkpointNote(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
  userId: string,
  input: { title?: string; baseVersionId: string },
) {
  const tx = executor;
  const scope = { workspaceId, noteId, userId };
  const noteRows = await tx
    .select()
    .from(notes)
    .where(and(
      eq(notes.id, noteId),
      eq(notes.workspaceId, workspaceId),
      visibleNotesCondition(userId),
      isNull(notes.deletedAt),
    ))
    .for("update");
  const note = noteRows[0];
  if (!note) return null;
  if (input.baseVersionId !== note.currentVersionId) {
    throw new RevisionConflictError(note.currentVersionId);
  }
  if (!note.currentVersionId) return null;

  const requestedTitle = typeof input.title === "string"
    ? input.title.trim().slice(0, 200) || "无标题笔记"
    : null;

  const { doc } = await loadNoteDoc(tx, scope);
  try {
    if (requestedTitle !== null) setNoteTitle(doc, requestedTitle, "manual");
    const projected = projectFragmentBlocks(doc);
    const plain = projected.map(({ ordinal: _ordinal, ...block }) => block);
    const contentJson = { blocks: plain.map((block) => ({ type: block.type, content: block.content })) };
    const contentHash = computeContentHash(contentJson);

    const titleSource = requestedTitle !== null ? "manual" : note.titleSource;
    const title = titleSource === "manual"
      ? (requestedTitle ?? note.title)
      : deriveNoteTitle(plain);
    const current = await tx.query.noteVersions.findFirst({
      where: eq(noteVersions.id, note.currentVersionId),
    });
    // 内容去重：先按索引找同哈希的候选，再比一次规范化 JSON——极低概率的碰撞
    // 不能把两次不同的保存并成一个版本。
    const hashCandidate = current && current.contentHash === contentHash
      ? current
      : await tx.query.noteVersions.findFirst({
          where: and(eq(noteVersions.noteId, noteId), eq(noteVersions.contentHash, contentHash)),
        });
    const existing = hashCandidate?.contentJson
      && computeContentHash(hashCandidate.contentJson) === contentHash
      ? hashCandidate
      : null;

    // 正文与某个已有版本一致就复用那一版（连按两次「提交并确认」不会多出两个一样的
    // 版本）；否则新建一版。标题不需要单独成版——它在文档的 meta 里，落盘口会投影
    // 回 `notes.title`，而 `content_json` 只装正文。
    const targetVersion = existing ?? await (async () => {
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
          contentJson,
          contentHash,
          createdBy: userId,
        })
        .returning();
      return created;
    })();

    await persistNoteDoc(tx, scope, doc, targetVersion.id);
    if (targetVersion.id !== note.currentVersionId) {
      await tx
        .update(notes)
        .set({ currentVersionId: targetVersion.id })
        .where(eq(notes.id, noteId));
    }

    const blocks = await tx.query.noteBlocks.findMany({
      where: eq(noteBlocks.versionId, targetVersion.id),
      orderBy: (b, { asc }) => [asc(b.ordinal)],
    }) as NoteBlock[];
    return {
      note: { ...note, currentVersionId: targetVersion.id, title, titleSource },
      version: targetVersion,
      blocks,
    };
  } finally {
    doc.destroy();
  }
}

/**
 * 「共享给空间」/「取消共享」——那一个显式动作（批次 4.5）。
 *
 * 判据是**作者**，不是空间 owner：这一列说的是"我的东西要不要拿出去"，所以能不能
 * 改它跟角色无关，只跟"这篇是不是我写的"有关。今天协作空间里只有 owner 能建笔记，
 * 于是这条判据实际上只落在 owner 身上；但判据不能写成 `role === "owner"`，那样
 * 一旦哪天成员也能写笔记，边界就又靠调用方记得传对了。
 *
 * 撤回（`shared → private`）不会让已经按它生成过的卡片失效：证据链存的是生成当时
 * 抄下来的正文摘录。撤回改变的是**之后**别人还能不能读到这篇。
 */
export async function setNoteShareScope(
  executor: ApiTransaction,
  noteId: string,
  workspaceId: string,
  userId: string,
  shareScope: NoteShareScope,
): Promise<{ note: typeof notes.$inferSelect; changed: boolean } | null> {
  const tx = executor;
  const noteRows = await tx
    .select()
    .from(notes)
    .where(and(
      eq(notes.id, noteId),
      eq(notes.workspaceId, workspaceId),
      isNull(notes.deletedAt),
    ))
    .for("update");
  const note = noteRows[0];
  if (!note) return null;
  // 不是作者：给 404 而不是 403——"这篇存在但不归你改"这个信息本身就不该漏出去。
  if (note.createdBy !== userId) return null;
  if (note.shareScope === shareScope) return { note, changed: false };

  const [updated] = await tx
    .update(notes)
    .set({ shareScope, updatedAt: new Date() })
    .where(eq(notes.id, noteId))
    .returning();

  // 搜索索引里没有"可见性"这一列（一张空间级的索引表），所以共享状态变化不需要重算
  // 索引；查询侧现场 join `notes` 判可见性。反过来说，正因为索引是共享的，
  // **查询侧那道 join 不能省**——省了就是"私有笔记的正文出现在别人的搜索结果里"。
  return { note: updated, changed: true };
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
  userId: string,
) {
  // CONC-01: FOR UPDATE 锁定 note 行，防止与 updateNote / restoreNoteVersion 并发丢数据
  // CONC-03: 只处理未软删除的笔记
  const noteRows = await executor
    .select()
    .from(notes)
    .where(and(
      eq(notes.id, noteId),
      eq(notes.workspaceId, workspaceId),
      visibleNotesCondition(userId),
      isNull(notes.deletedAt),
    ))
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

  // 旧版学习卡表已删除，此处不再归档卡片 /
  // 取消卡片复习计划 / 清理卡片搜索索引。V2 卡片经 objectiveId 关联，
  // 其生命周期不在 note 模块管理。

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
  userId: string,
) {
  // QUAL-03 修复：移除 IIFE 模式，executor 即事务执行器，无需额外包装
  const tx = executor;
    // FOR UPDATE 锁定 note 行（包括已软删除的）
    const noteRows = await tx
      .select()
      .from(notes)
      .where(and(
        eq(notes.id, noteId),
        eq(notes.workspaceId, workspaceId),
        visibleNotesCondition(userId),
      ))
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

    // 旧版学习卡表已删除，此处不再恢复被
    // deleteNote 归档的卡片及其复习计划。V2 卡片经 objectiveId 关联，其
    // 生命周期不在 note 模块管理。

    // 返回恢复后的完整数据
    const versionId = note.currentVersionId;
    if (!versionId) return { note: { ...note, deletedAt: null }, version: null, blocks: [] as NoteBlock[] };

    const version = await tx.query.noteVersions.findFirst({
      where: eq(noteVersions.id, versionId),
    });
    if (!version) return { note: { ...note, deletedAt: null }, version: null, blocks: [] as NoteBlock[] };

    const blocks = await tx.query.noteBlocks.findMany({
      where: eq(noteBlocks.versionId, versionId),
      orderBy: (b, { asc }) => [asc(b.ordinal)],
    });

    const result = {
      note: { ...note, deletedAt: null },
      version,
      blocks: blocks as NoteBlock[],
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

  // 卡片搜索索引由 card 模块自行维护。

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
  options?: { force?: boolean; userId?: string },
) {
  // 确认笔记存在（包括已软删除的），并加 FOR UPDATE 锁定行
  // 防止与 restoreDeletedNote 并发：restore 的 FOR UPDATE 会阻塞到此事务提交
  const noteRows = await executor
    .select({ id: notes.id, deletedAt: notes.deletedAt })
    .from(notes)
    .where(and(
      eq(notes.id, noteId),
      eq(notes.workspaceId, workspaceId),
      // 定时清理任务没有"查看者"，所以它按空间清；走路由的那次必须带 userId，否则
      // 一个成员能把别人仅自己可见的笔记物理删掉。
      ...(options?.userId ? [visibleNotesCondition(options.userId)] : []),
    ))
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

    /**
     * L17（用户口径：卡留着但退役）：删这篇笔记之前，先把**由它的版本产出的卡与目标**退役。
     *
     * 顺序是硬的，不是风格：外键 `learning_cards_v2.note_version_id` 自 0274 起是 SET NULL，
     * 而 `visibleCardsCondition` 的第一支是 `note_version_id IS NULL`（"没有可追溯来源的卡
     * 不受这条约束"）。先断线后退役 = 那张卡在笔记消失后**回到复习队列**；
     * 先退役后断线 = 它 lifecycle 已经不是 active，队列与卡列表两条判据都进不来。
     * 卡的正文与发布版本、她练过的 exposure 全部保留（"留着"那半句话）。
     *
     * 目标一起退役：一个目标最多一张 active 卡（`lc_v2_ws_obj_active_idx` 是部分唯一索引），
     * 所以这里不存在"连带打死另一篇来源的活卡"；epoch 前移与 archiveCardV2 同形。
     */
    if (versionIds.length > 0) {
      const retiredCards = await tx
        .update(learningCardsV2)
        .set({ lifecycle: "archived", updatedAt: new Date() })
        .where(and(
          inArray(learningCardsV2.noteVersionId, versionIds),
          eq(learningCardsV2.lifecycle, "active"),
        ))
        .returning({ objectiveId: learningCardsV2.objectiveId });
      const objectiveIds = [...new Set(retiredCards.map((c) => c.objectiveId))];
      if (objectiveIds.length > 0) {
        await tx
          .update(learningObjectivesV2)
          .set({
            lifecycle: "archived",
            lifecycleEpoch: sql`${learningObjectivesV2.lifecycleEpoch} + 1`,
            updatedAt: new Date(),
          })
          .where(and(
            inArray(learningObjectivesV2.objectiveId, objectiveIds),
            eq(learningObjectivesV2.lifecycle, "active"),
          ));
      }
      if (retiredCards.length > 0) {
        logger.info(
          { noteId, retiredCards: retiredCards.length },
          "cards retired before physical note deletion (doc 34 L17)",
        );
      }
    }

    // 收集图片资产与旧版 Markdown object key。Typed asset 可能被同一
    // workspace 的其他笔记版本复用，必须在级联删除后重新检查引用，
    // 只有真正 orphan 的资产才允许删除对象。
    const allBlocks = versionIds.length > 0
      ? await chunkedInArraySelect(
          (chunk) => tx.query.noteBlocks.findMany({
            where: and(
              inArray(noteBlocks.versionId, chunk),
              eq(noteBlocks.workspaceId, workspaceId),
            ),
          }),
          versionIds,
        )
      : [];
    const legacyImageObjectKeys = allBlocks
      .filter((b) => b.type === "image")
      .map((b) => extractObjectKeyFromMarkdownImage(b.content))
      .filter((key): key is string => key !== null);
    const blockAssetIds = [...new Set(allBlocks.flatMap((block) =>
      block.imageAssetId ? [block.imageAssetId] : []))];
    // N#7-13: blockAssetIds/legacyImageObjectKeys 可能很大，将 or(...) 分解为
    // 若干分块查询后按 id 去重合并，避免大数组 IN 参数越界。
    const candidateAssetsById = new Map<string, typeof noteImageAssets.$inferSelect>();
    const collectAssets = (rows: typeof noteImageAssets.$inferSelect[]) => {
      for (const row of rows) candidateAssetsById.set(row.id, row);
    };
    // 1) 归属本笔记的资产（uploaded_for_note_id，单值条件）
    await tx.query.noteImageAssets.findMany({
      where: and(
        eq(noteImageAssets.workspaceId, workspaceId),
        eq(noteImageAssets.uploadedForNoteId, noteId),
      ),
    }).then(collectAssets);
    // 2) blockAssetIds —— 分块
    await chunkedInArraySelect(
      (chunk) => tx.query.noteImageAssets.findMany({
        where: and(
          eq(noteImageAssets.workspaceId, workspaceId),
          inArray(noteImageAssets.id, chunk),
        ),
      }),
      blockAssetIds,
    ).then(collectAssets);
    // 3) legacyImageObjectKeys —— 分块
    await chunkedInArraySelect(
      (chunk) => tx.query.noteImageAssets.findMany({
        where: and(
          eq(noteImageAssets.workspaceId, workspaceId),
          inArray(noteImageAssets.objectKey, chunk),
        ),
      }),
      legacyImageObjectKeys,
    ).then(collectAssets);
    const candidateAssets = Array.from(candidateAssetsById.values());

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
    // SEC 修复（2026-09 后端审查）：legacy markdown 图片键来自**客户端可控**的
    // 笔记正文（extractObjectKeyFromMarkdownImage 取 /api/uploads/ 之后的任意串），
    // 且 deleteObject 无命名空间校验。此前任何能被命名的桶内对象（例如
    // `avatars/<victimId>/<uuid>.png`）都会进 unmanagedLegacyKeys，随后在
    // DELETE /notes/:id/permanent 与 6h 清理任务中被真实删除（跨租户破坏性写）。
    // 这里把 legacy 键收窄到本 workspace 的 notes/sources 命名空间。
    const workspaceKeyPrefixes = [`${workspaceId}/notes/`, `${workspaceId}/sources/`];
    const unmanagedLegacyKeys = legacyImageObjectKeys.filter(
      (key) => !knownAssetObjectKeys.has(key)
        && !key.includes("..")
        && workspaceKeyPrefixes.some((prefix) => key.startsWith(prefix)),
    );
    const imageObjectKeys = [...new Set([
      ...unmanagedLegacyKeys,
      ...orphanAssets.flatMap((asset) => [
        asset.objectKey,
        ...(asset.normalizedObjectKey ? [asset.normalizedObjectKey] : []),
        ...(asset.thumbnailObjectKey ? [asset.thumbnailObjectKey] : []),
      ]),
    ])];

    return { imageObjectKeys };
  };

  const cleanupIds = await collectAndDeleteCascade(executor);

  // 清理搜索索引（仅 note；卡片/evidence 搜索文档已随卡片级联移除）
  await deleteSearchDocuments(executor, workspaceId, [
    { objectType: "note", objectId: noteId },
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
  userId: string,
  limit = 100,
  offset = 0,
) {
  // CONC-03: 不返回已软删除笔记的版本历史
  // 批次 4.5: 版本历史里能看到每一版的正文，所以它与笔记本身共用同一条判据。
  const note = await executor.query.notes.findFirst({
    where: and(
      eq(notes.id, noteId),
      eq(notes.workspaceId, workspaceId),
      visibleNotesCondition(userId),
      isNull(notes.deletedAt),
    ),
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
  userId: string,
  baseVersionId?: string,
) {
  // QUAL-03 修复：移除 IIFE 模式，executor 即事务执行器，无需额外包装
  const tx = executor;
    // 锁定 note 行
    // CONC-03: 只锁定未软删除的笔记
    const noteRows = await tx
      .select()
      .from(notes)
      .where(and(
        eq(notes.id, noteId),
        eq(notes.workspaceId, workspaceId),
        visibleNotesCondition(userId),
        isNull(notes.deletedAt),
      ))
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

    // 批次 4.1：恢复本身只是把 `currentVersionId` 指回旧版本，但文档必须跟着走。
    // 否则快照仍是恢复前的正文，而接口已经报"这一版才是当前版"——之后有快照时
    // `loadNoteDoc` 不再从行补齐，读到的就是两套内容里的另一套。
    // 用 drizzle 的行类型而不是 NoteDocBlock：后者没有 sourceRef / imageAssetId，
    // 而这两个字段正是证据链要在恢复后继续活着的东西。
    const restoredDocBlocks = noteDocBlocksFromRows(blocks as Array<typeof noteBlocks.$inferSelect>);
    await applyNoteDocUpdate(
      tx,
      { workspaceId, noteId, userId },
      versionId,
      (noteDoc) => writeFragmentBlocks(noteDoc, restoredDocBlocks),
      restoredDocBlocks,
    );

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
