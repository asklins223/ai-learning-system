import { and, asc, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { applyNoteDocUpdate } from "./document-state.ts";
import { writeNoteBlocks, type NoteDocBlock } from "./doc.ts";
import { createHash } from "node:crypto";
import { type ApiTransaction } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks, noteImageAssets } from "@ailearn/shared/db-schema/note";
import { searchDocuments } from "@ailearn/shared/db-schema/search";
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

type NoteUpdateInput = {
  title?: string;
  blocks?: Array<{ type: NoteBlock["type"]; content: string }>;
  baseVersionId: string;
  isAutosave: boolean;
};

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
    // PERF: Fast path — the overwhelming majority of JSON numbers (integers and
    // in-range decimals) have no exponent, so avoid the regex engine on the
    // content-hash hot path. Only fall into the expensive BigInt/toPrecision
    // path for exponential edge cases (|value| >= 1e21 or < 1e-6).
    if (str.indexOf("e") === -1 && str.indexOf("E") === -1) {
      return str;
    }
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
 * updateVersionInPlace 之间不会有并发插入历史卡片引用。
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
    // active/superseded 的 V1 卡引用该版本以决定不可原地更新；V2 卡片通过
  // objectiveId 关联、不直接引用 note_version，此处仅保留 sealed 版本保护。
  return !versionRows[0].sealedAt;
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
): Promise<Array<NoteBlock & { imageAssetId: string | null; sourceRef?: unknown }>> {
  // PERF: diff-based in-place update. Previously this path DELETE-all'd and
  // re-INSERT-all'd note_blocks on every 2.5s autosave, causing constant write
  // amplification / index churn / table bloat on large notes. Now we read the
  // existing rows once and only UPDATE changed rows, INSERT new ordinals, and
  // DELETE removed ordinals. An autosave where nothing changed becomes a single
  // read + the note_versions row update instead of DELETE-all + INSERT-all.
  const existingBlocks = await tx.query.noteBlocks.findMany({
    where: eq(noteBlocks.versionId, versionId),
    orderBy: (b, { asc }) => [asc(b.ordinal)],
  });

  const blocksWithAssets = await resolveImageAssetIds(tx, workspaceId, blocks);
  const existingByOrdinal = new Map(existingBlocks.map((b) => [b.ordinal, b]));

  const submitted = blocksWithAssets.map((b, idx) => {
    const existing = existingByOrdinal.get(idx);
    return {
      versionId,
      workspaceId,
      ordinal: idx,
      type: b.type,
      content: b.content,
      imageAssetId: b.imageAssetId,
      // Preserve provenance on in-place edits instead of dropping sourceRef.
      sourceRef: existing?.sourceRef ?? null,
    };
  });

  const submittedByIdentity = new Map(submitted.map((b) => [b.ordinal, b]));
  const toInsert: typeof submitted = [];
  const toUpdate: Array<{ id: string; patch: (typeof submitted)[number] }> = [];
  const toDelete: string[] = [];

  for (const sub of submitted) {
    const existing = existingByOrdinal.get(sub.ordinal);
    if (!existing) {
      toInsert.push(sub);
    } else if (
      existing.type !== sub.type ||
      existing.content !== sub.content ||
      existing.imageAssetId !== sub.imageAssetId
    ) {
      toUpdate.push({ id: existing.id, patch: sub });
    }
  }
  for (const existing of existingBlocks) {
    if (!submittedByIdentity.has(existing.ordinal)) {
      toDelete.push(existing.id);
    }
  }

  if (toDelete.length > 0) {
    await tx.delete(noteBlocks).where(inArray(noteBlocks.id, toDelete));
  }
  if (toInsert.length > 0) {
    await tx.insert(noteBlocks).values(toInsert);
  }
  if (toUpdate.length > 0) {
    // PERF: batch all changed blocks into a single multi-row UPDATE instead of
    // issuing one serialized UPDATE per row on the 2.5s autosave hot path.
    // The FROM (unnest(...)) form keeps PostgreSQL's query planner on one scan
    // and avoids N serial DB round-trips. `ordinal`/`versionId`/`sourceRef` are
    // unchanged (they equal the existing row values in `patch`), so they are
    // deliberately not rewritten.
    // ⚠️ `AS ord(...)` 只能是**裸列名列表**，绝不能写成带类型的列定义列表
    // （`AS ord(id uuid, type text, ...)`）。PostgreSQL 不允许「多参数 unnest()
    // + 列定义列表」，会直接抛
    //   `UNNEST() with multiple arguments cannot have a column definition list`
    // （PG 16.15 实测同样如此）。此前那版带类型的写法让**每一次改动既有块的
    // 自动保存**都变成 500 —— 而这条路只在“顺序号已存在的块内容变了”时才走到，
    // 因此表现为“平时能存、一改旧段落就挂”。
    // 列类型由下面 ARRAY[...] 里的元素 cast 决定（uuid[]/text[]/text[]/uuid[]），
    // 不依赖这里的标注；`ord.id`/`ord.image_asset_id` 实测解析为 uuid。
    const ids = sql.join(toUpdate.map((u) => sql`${u.id}::uuid`), sql`, `);
    const types = sql.join(toUpdate.map((u) => sql`${u.patch.type}::text`), sql`, `);
    const contents = sql.join(toUpdate.map((u) => sql`${u.patch.content}::text`), sql`, `);
    const imageIds = sql.join(toUpdate.map((u) => sql`${u.patch.imageAssetId}::uuid`), sql`, `);
    await tx.execute(sql`
      UPDATE note_blocks
      SET type = u.type,
          content = u.content,
          image_asset_id = u.image_asset_id
      FROM (
        SELECT ord.id, ord.type, ord.content, ord.image_asset_id
        FROM unnest(
          ARRAY[${ids}],
          ARRAY[${types}],
          ARRAY[${contents}],
          ARRAY[${imageIds}]
        ) AS ord(id, type, content, image_asset_id)
      ) AS u
      WHERE note_blocks.id = u.id
    `);
  }

  // 更新版本内容（含 updatedAt 追踪原地修改时间）
  await tx
    .update(noteVersions)
    .set({ contentJson, contentHash, updatedAt: new Date() })
    .where(eq(noteVersions.id, versionId));

  // Return the submitted blocks (preserving row metadata where the row already
  // existed) so the caller can build the response without re-reading note_blocks.
  return submitted.map((sub) => {
    const existing = existingByOrdinal.get(sub.ordinal);
    return existing ? { ...existing, ...sub } : sub;
  }) as Array<NoteBlock & { imageAssetId: string | null; sourceRef?: unknown }>;
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
    const initialBlocks: NoteDocBlock[] = blocksWithAssets.map((b) => ({
      type: b.type,
      content: b.content,
      ...(b.imageAssetId ? { imageAssetId: b.imageAssetId } : {}),
    }));
    // 批次 4.1：新建笔记就是文档的第一次拥有，快照从第一行起就存在，
    // 之后所有读取都走快照而不是从关系表猜。
    await applyNoteDocUpdate(
      tx,
      { workspaceId, noteId: row.id },
      version.id,
      (noteDoc) => writeNoteBlocks(noteDoc, initialBlocks),
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

/**
 * 每个版本的第一张图片块（按 ordinal 最小），一次批量取。
 *
 * 只按 `version_id / ordinal` 走 `note_blocks_version_idx`，把命中版本的全部
 * 图片块拉回来在内存里取每版第一块：一版通常 0~2 张图，比按行发 N 次请求便宜，
 * 也比在 SQL 里写 DISTINCT ON 更好读。内容原样返回（`![alt](url)`），解析留给
 * 渲染层那一份 `parseImageBlock`。
 */
async function firstImageBlockByVersion(
  executor: ApiTransaction,
  workspaceId: string,
  versionIds: string[],
): Promise<Map<string, string>> {
  const firstBy = new Map<string, string>();
  if (versionIds.length === 0) return firstBy;
  const blocks = await executor
    .select({ versionId: noteBlocks.versionId, content: noteBlocks.content })
    .from(noteBlocks)
    .where(and(
      eq(noteBlocks.workspaceId, workspaceId),
      inArray(noteBlocks.versionId, versionIds),
      eq(noteBlocks.type, "image"),
    ))
    .orderBy(asc(noteBlocks.versionId), asc(noteBlocks.ordinal), asc(noteBlocks.id));
  for (const block of blocks) {
    if (!firstBy.has(block.versionId)) firstBy.set(block.versionId, block.content);
  }
  return firstBy;
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

  // 封面图：正文里第一个 image 块（ordinal 最小）。列表此前什么都不带，
  // 所以"哪篇笔记有图"只能挨篇点开看（复盘 #17）。一次批量查，不按行发请求。
  // 这里回的是那一行原文 `![alt](url)`：解析规则全仓库只有渲染层一份
  // （`note-blocks.parseImageBlock`），服务端不再写第二个 markdown 解析器。
  const versionIds = pageRows
    .map((r) => r.currentVersionId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const coverByVersion = await firstImageBlockByVersion(executor, workspaceId, versionIds);

  return {
    items: pageRows.map((r) => ({
      id: r.id,
      title: r.title,
      titleSource: r.titleSource,
      firstImageBlock: r.currentVersionId ? coverByVersion.get(r.currentVersionId) ?? null : null,
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
    if (input.baseVersionId !== note.currentVersionId) {
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

    // PERF: Build the response from data already in scope from the write branch
    // instead of re-reading note/version/blocks after every content write
    // (incl. the 2.5s autosave tick). Fields left null are re-read at the end —
    // only for paths that genuinely lacked the data (e.g. title-only / no-op).
    let resultNote: typeof note | null = null;
    let resultVersion: typeof noteVersions.$inferSelect | null = null;
    let resultBlocks: NoteBlock[] | null = null;

    // 标题单独修改时，精确克隆当前正文为一个新版本。currentVersionId 同时
    // 是客户端 OCC 令牌；如果只改 notes.title，多标签页会持有同一令牌并
    // 标题更新同样推进版本，避免多标签页使用同一 OCC 令牌时静默覆盖。
    if (
      !Array.isArray(input.blocks) &&
      manualTitleChanged &&
      note.currentVersionId
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

        resultNote = {
          ...note,
          currentVersionId: newVersion.id,
          title: requestedManualTitle as string,
          titleSource: "manual",
          updatedAt: new Date(),
        };
        resultVersion = newVersion;
        resultBlocks = currentBlocks.map((block) => ({
          ...block,
          versionId: newVersion.id,
        })) as NoteBlock[];
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
        resultNote = {
          ...note,
          currentVersionId: existingVersion.id,
          title: dedupTitle,
          titleSource: effectiveTitleSource,
          ...(existingVersion.id !== note.currentVersionId || titleChanged
            ? { updatedAt: new Date() }
            : {}),
        };
        resultVersion = existingVersion;
        resultBlocks = sanitizedBlocks.map((b, i) => ({
          ...b,
          ordinal: i,
          imageAssetId: null,
        })) as NoteBlock[];
      } else if (input.isAutosave && note.currentVersionId && !manualTitleChanged) {
        // 2. 自动保存模式：尝试原地更新当前版本
        const canInPlace = await canUpdateVersionInPlace(tx, note.currentVersionId);
        if (canInPlace) {
          const inPlaceBlocks = await updateVersionInPlace(tx, note.currentVersionId, workspaceId, contentJson, contentHash, sanitizedBlocks);
          await tx
            .update(notes)
            .set({
              title: effectiveTitleSource === "manual" ? effectiveTitle : autoTitle,
              titleSource: effectiveTitleSource,
              updatedAt: new Date(),
            })
            .where(eq(notes.id, noteId));
          resultNote = {
            ...note,
            title: effectiveTitleSource === "manual" ? effectiveTitle : autoTitle,
            titleSource: effectiveTitleSource,
            updatedAt: new Date(),
          };
          // currentVersionId is unchanged by an in-place update; the version row
          // itself is not in scope here (only id/sealedAt were locked), so it is
          // re-read below — note/blocks no longer are.
          resultBlocks = inPlaceBlocks as NoteBlock[];
        } else {
          // 无法原地更新（版本被 sealed 或缺失），降级为创建新版本。
          // note_version 不再直接引用卡片，仅 sealed 保护触发此分支。
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

          let blocksWithAssets: Array<{ type: NoteBlock["type"]; content: string; imageAssetId: string | null }> = [];
          if (sanitizedBlocks.length) {
            blocksWithAssets = await resolveImageAssetIds(tx, workspaceId, sanitizedBlocks);
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
          resultNote = {
            ...note,
            currentVersionId: newVersion.id,
            title: effectiveTitleSource === "manual" ? effectiveTitle : autoTitle,
            titleSource: effectiveTitleSource,
            updatedAt: new Date(),
          };
          resultVersion = newVersion;
          resultBlocks = blocksWithAssets.map((b, idx) => ({
            ...b,
            ordinal: idx,
          })) as NoteBlock[];
        }
      } else {
        // 3. 显式保存或无法原地更新：创建新版本
        //
        // AI-perf #14（2026-09-15 审计）：此前用 `findFirst` 且**无列投影**，为了拿
        // 一个 versionNo 会把最新版本的整份 `content_json`（整篇文档的 blocks）
        // 读回应用层——每次显式保存都白搬一次全文。改为只投影 versionNo + LIMIT 1。
        const [latest] = await tx
          .select({ versionNo: noteVersions.versionNo })
          .from(noteVersions)
          .where(eq(noteVersions.noteId, noteId))
          .orderBy(desc(noteVersions.versionNo))
          .limit(1);
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

        let blocksWithAssets: Array<{ type: NoteBlock["type"]; content: string; imageAssetId: string | null }> = [];
        if (sanitizedBlocks.length) {
          blocksWithAssets = await resolveImageAssetIds(tx, workspaceId, sanitizedBlocks);
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
        resultNote = {
          ...note,
          currentVersionId: newVersion.id,
          title: effectiveTitleSource === "manual" ? effectiveTitle : autoTitle,
          titleSource: effectiveTitleSource,
          updatedAt: new Date(),
        };
        resultVersion = newVersion;
        resultBlocks = blocksWithAssets.map((b, idx) => ({
          ...b,
          ordinal: idx,
        })) as NoteBlock[];
      }
    }

    // F-005: tx read inside transaction — only re-read the fields the write
    // branch did not already have in scope (PERF: avoids 3 redundant round-trips
    // on every content write, incl. the 2.5s autosave tick).
    if (!resultNote || !resultVersion || !resultBlocks) {
      const uNote = resultNote ?? await tx.query.notes.findFirst({
        where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)),
      });
      if (!uNote || !uNote.currentVersionId) return null;
      const uVer = resultVersion ?? await tx.query.noteVersions.findFirst({
        where: eq(noteVersions.id, uNote.currentVersionId),
      });
      if (!uVer) return null;
      const uBlocks = resultBlocks ?? (await tx.query.noteBlocks.findMany({
        where: eq(noteBlocks.versionId, uNote.currentVersionId),
        orderBy: (b, { asc: a1 }) => [a1(b.ordinal)],
      })) as NoteBlock[];
      resultNote = uNote;
      resultVersion = uVer;
      resultBlocks = uBlocks;
    }
    const result = { note: resultNote, version: resultVersion, blocks: resultBlocks as NoteBlock[] };

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

    // 原物理删除的历史卡片级联清理已整体移除。V2 卡片/客观对象的清理由各自模块负责。
    // 以下仅保留 note 自身的级联（image asset 收集与 note 删除）。

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

    // 批次 4.1：恢复本身只是把 `currentVersionId` 指回旧版本，但文档必须跟着走。
    // 否则快照仍是恢复前的正文，而接口已经报"这一版才是当前版"——之后有快照时
    // `loadNoteDoc` 不再从行补齐，读到的就是两套内容里的另一套。
    // 用 drizzle 的行类型而不是 NoteBlock：后者没有 sourceRef / imageAssetId，
    // 而这两个字段正是证据链要在恢复后继续活着的东西。
    const restoredDocBlocks: NoteDocBlock[] = (blocks as Array<typeof noteBlocks.$inferSelect>).map((b) => ({
      type: b.type,
      content: b.content,
      ...(b.sourceRef ? { sourceRef: b.sourceRef as NoteDocBlock["sourceRef"] } : {}),
      ...(b.imageAssetId ? { imageAssetId: b.imageAssetId } : {}),
    }));
    await applyNoteDocUpdate(
      tx,
      { workspaceId, noteId },
      versionId,
      (noteDoc) => writeNoteBlocks(noteDoc, restoredDocBlocks),
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
