/**
 * POST /import/markdown 的业务实现（批量导入 Markdown 笔记，F-033/G-006）。
 *
 * 路由只保留 HTTP 关注点（schema 校验、事务边界、事务后投影刷新）；本模块负责
 * itemKey 计算、图片资产预注册、advisory lock + 幂等去重、逐篇写入与响应整形。
 * 预处理（解析/itemKey/图片预注册）在业务事务外完成，避免网络 IO 占持事务连接；
 * 搜索索引在业务事务提交后刷新（可重建投影，索引失败不回滚业务写入）。
 */

import { createHash } from "node:crypto";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { notes, noteVersions } from "@ailearn/shared/db-schema/note";
import { computeContentHash, ensureImageAssetsForBlocks } from "../note/service.ts";
import { applyNoteDocUpdate } from "../note/document-state.ts";
import { writeNoteBlocks } from "../note/doc.ts";
import { preRegisterImageAssetsForImport } from "../../lib/image-asset.ts";
import { markdownToBlocks, extractTitleFromBlocks, type ParsedBlock } from "@ailearn/shared/markdown-parser";
import { extractObjectKeyFromMarkdownImage } from "../../lib/markdown-image.ts";
import { upsertSearchDocument } from "../../lib/search-index.ts";
import { logger } from "../../lib/logger.ts";

export interface MarkdownImportScope {
  workspaceId: string;
  userId: string;
}

/** 请求体 item（与 importMarkdownSchema 的解析结果一致）。 */
export interface MarkdownImportItem {
  title: string;
  content: string;
}

/** 事务内导入的输入：items 已由 prepareMarkdownImport 预解析并计算 itemKey。 */
export interface MarkdownImportInput {
  items: PreparedMarkdownImportItem[];
  /** F-033 幂等键；缺省（null/空串）表示不做幂等检查。 */
  importId: string | null;
}

export interface MarkdownImportNoteEntry {
  note: { id: string; title: string };
  version: { id: string; versionNo: number };
}

export interface MarkdownImportItemError {
  index: number;
  title: string;
  error: string;
}

/** 路由响应体：字段与抽取前 /import/markdown 的返回逐字段一致。 */
export interface MarkdownImportResponse {
  imported: number;
  notes: MarkdownImportNoteEntry[];
  idempotent?: boolean;
  errors?: MarkdownImportItemError[];
}

/** 事务内产出：响应体 + 待事务提交后刷新的搜索索引文档。 */
export interface MarkdownImportOutcome {
  response: MarkdownImportResponse;
  searchDocuments: PendingSearchDocument[];
}

/** G-006: 计算稳定的 item key，用于幂等去重 */
function computeItemKey(title: string, content: string): string {
  return createHash("sha256").update(`${title}\0${content}`).digest("hex").slice(0, 16);
}

export interface PreparedMarkdownImportItem {
  title: string;
  content: string;
  originalIndex: number;
  itemKey: string;
  /** Pre-parsed blocks, computed once per item to avoid double-parsing on import. */
  blocks?: ParsedBlock[];
}

type ImportTransaction = ApiTransaction;

interface ImportedItem extends MarkdownImportNoteEntry {
  itemKey: string;
}

interface PendingSearchDocument {
  workspaceId: string;
  objectType: "note";
  objectId: string;
  title: string;
  body: string;
}

/**
 * 业务事务外的预处理：解析 blocks、计算 itemKey，并预注册内嵌图片资产。
 * 返回的 item 在同一批导入的主事务内复用（每篇只解析一次，不重复解析 500KB 字符串）。
 */
export async function prepareMarkdownImport(
  scope: MarkdownImportScope,
  items: MarkdownImportItem[],
): Promise<PreparedMarkdownImportItem[]> {
  const requestedItems: PreparedMarkdownImportItem[] = items.map((item, originalIndex) => ({
    ...item,
    originalIndex,
    itemKey: computeItemKey(item.title, item.content),
    // PERF: Parse each item exactly once here; importItems and the image
    // pre-registration pass reuse these blocks instead of re-parsing up to
    // 100 × 500KB strings twice per batch.
    blocks: markdownToBlocks(item.content),
  }));

  // PERF 专项遗留修复：图片资产预注册移到业务事务外——
  // MinIO 下载/校验/入库不再占持导入主事务连接（批量导入 100 篇时
  // 每篇内嵌事务中的网络 IO 全部消除）。事务内 ensureImageAssetsForBlocks
  // 退化为纯查询（预注册后 missingKeys=0）。
  {
    const imageKeys = new Set<string>();
    for (const item of requestedItems) {
      for (const block of item.blocks ?? markdownToBlocks(item.content)) {
        if (block.type !== "image") {
          continue;
        }
        const key = extractObjectKeyFromMarkdownImage(block.content);
        if (key) {
          imageKeys.add(key);
        }
      }
    }
    if (imageKeys.size > 0) {
      await preRegisterImageAssetsForImport(scope.workspaceId, [...imageKeys], scope.userId);
    }
  }

  return requestedItems;
}

/**
 * 在导入主事务中逐篇创建笔记。nested transaction 在 postgres-js 中使用 SAVEPOINT，
 * 因此单篇失败只回滚当前 item，不会污染同批其他笔记。
 */
async function importItems(
  tx: ImportTransaction,
  items: PreparedMarkdownImportItem[],
  workspaceId: string,
  userId: string,
  importId: string | null,
): Promise<{
  records: ImportedItem[];
  searchDocuments: PendingSearchDocument[];
  errors?: Array<{ index: number; title: string; error: string }>;
}> {
  const records: ImportedItem[] = [];
  const searchDocuments: PendingSearchDocument[] = [];
  const errors: Array<{ index: number; title: string; error: string }> = [];

  // F16·③（round-4）：保持逐篇串行。每一项是外层主事务内的 SAVEPOINT
  // （nested transaction），且幂等去重依赖同一连接上前序 item 的 insert 结果；
  // postgres-js 在同一连接上本就串行排队，异步并行不会带来 RTT 收益，反而会破坏
  // SAVEPOINT 顺序与逐篇原子回滚语义——故维持串行（100 项 ~500 顺序往返可接受，
  // 属低频一次性批量导入路径）。
  for (const item of items) {
    try {
      // 解析 Markdown 为 blocks（复用预解析结果，避免同一 item 二次解析）
      const blocks = item.blocks ?? markdownToBlocks(item.content);

      // 自动提取标题
      const titleWasProvided = Boolean(item.title?.trim());
      const title = titleWasProvided
        ? item.title.trim().slice(0, 200)
        : extractTitleFromBlocks(blocks);

      // F-033: 每篇笔记独立事务，单篇失败不阻塞其他笔记
      // 事务保证 note + version + blocks 原子写入
      const result = await tx.transaction(async (itemTx) => {
        const [note] = await itemTx
          .insert(notes)
          .values({
            workspaceId,
            title,
            titleSource: titleWasProvided ? "manual" : "auto",
            createdBy: userId,
          })
          .returning();

        // G-006: 存储 importId 和 itemKey 用于幂等去重
        const contentJson: Record<string, unknown> = {
          blocks: blocks.map((b) => ({ type: b.type, content: b.content })),
        };
        if (importId) {
          contentJson.importId = importId;
          contentJson.itemKey = item.itemKey;
        }

        const [version] = await itemTx
          .insert(noteVersions)
          .values({
            noteId: note.id,
            workspaceId,
            versionNo: 1,
            contentJson,
            contentHash: computeContentHash(contentJson),
            createdBy: userId,
          })
          .returning();

        if (blocks.length) {
          const blocksWithAssets = await ensureImageAssetsForBlocks(
            itemTx as Parameters<typeof ensureImageAssetsForBlocks>[0],
            workspaceId,
            blocks,
            userId,
            note.id,
          );
          // 批次 4.1：导入"确实拥有整篇"，所以走文档而不是直接插行。
          // 快照落盘 + 投影成这个版本的 note_blocks 都在同一个入口里完成。
          await applyNoteDocUpdate(
            itemTx as Parameters<typeof applyNoteDocUpdate>[0],
            { workspaceId, noteId: note.id },
            version.id,
            (doc) => {
              writeNoteBlocks(
                doc,
                blocksWithAssets.map((b) => ({
                  type: b.type,
                  content: b.content,
                  ...(b.imageAssetId ? { imageAssetId: b.imageAssetId } : {}),
                })),
              );
            },
          );
        }

        await itemTx
          .update(notes)
          .set({ currentVersionId: version.id, updatedAt: new Date() })
          .where(eq(notes.id, note.id));

        return { note, version };
      });

      records.push({
        itemKey: item.itemKey,
        note: { id: result.note.id, title: result.note.title },
        version: { id: result.version.id, versionNo: result.version.versionNo },
      });

      // BUG-69 修复：过滤 image 类型 block，与 note service 保持一致，避免 drift 检测误报
      const bodyText = blocks.filter((b) => b.type !== "image").map((b) => b.content).join("\n");
      searchDocuments.push({
        workspaceId,
        objectType: "note",
        objectId: result.note.id,
        title: result.note.title,
        body: bodyText,
      });
    } catch (err) {
      // F-033: 记录失败项，继续处理后续笔记
      logger.error(
        { err, index: item.originalIndex, title: item.title || "(auto)" },
        "import markdown item failed",
      );
      errors.push({
        index: item.originalIndex,
        title: item.title || "(auto)",
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return {
    records,
    searchDocuments,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function updateImportedNoteSearchIndexes(documents: PendingSearchDocument[]) {
  // 搜索索引是可重建投影：必须等业务事务提交后再更新，失败仅记录日志。
  // BUG-47/PERF-20/PERF-39 修复：原代码使用串行 for 循环逐个更新搜索索引，
  // 对于 100 篇笔记的批量导入会产生 100 次串行 DB 往返。
  // PERF-BN5 修复：原并发版本用 Promise.allSettled 一次性并发 100 篇 upsert，
  // 压 max:10 连接池。现改为按 25/批分批，每批内并行、批间顺序等待，
  // 既保留一定并行度又避免 100 并发尖峰。单篇失败仍隔离，不影响其他笔记。
  const BATCH_SIZE = 25;
  for (let start = 0; start < documents.length; start += BATCH_SIZE) {
    const batch = documents.slice(start, start + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((doc) => upsertSearchDocument(doc)),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "rejected") {
        logger.error(
          { err: result.reason, objectId: batch[i]!.objectId, title: batch[i]!.title },
          "import: 搜索索引更新失败（单篇隔离，不影响其他笔记）",
        );
      }
    }
  }
}

/**
 * 导入主流程（必须由路由在 withWorkspaceTransaction 内调用）：
 * advisory lock → 幂等查询 → 逐篇写入 → 响应整形。返回值需再交给
 * finalizeMarkdownImport 在事务提交后刷新搜索索引。
 */
export async function importMarkdownNotes(
  tx: ApiTransaction,
  scope: MarkdownImportScope,
  input: MarkdownImportInput,
): Promise<MarkdownImportOutcome> {
  const { workspaceId, userId } = scope;
  const requestedItems = input.items;

  // G-006: 无 importId 时不做幂等检查，直接导入
  // BUG-70 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）
  if (!input.importId) {
    const imported = await importItems(tx, requestedItems, workspaceId, userId, null);
    return {
      response: {
        imported: imported.records.length,
        notes: imported.records.map(({ note, version }) => ({ note, version })),
        ...(imported.errors && imported.errors.length > 0 ? { errors: imported.errors } : {}),
      },
      searchDocuments: imported.searchDocuments,
    };
  }
  const importId = input.importId;

  // 同一事务持有 transaction-scoped advisory lock，保证检查与新增使用同一连接，
  // 并在提交/回滚时由 PostgreSQL 自动释放，避免连接池中的 session lock 泄漏。
  // BUG-70 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）
  const lockKey = `${workspaceId}:${importId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

  // G-006: 查询已存在的版本，确定哪些 items 已经导入。
  // PERF: 只投影轻量字段，itemKey 在 SQL 侧用 content_json->>'itemKey' 提取，
  // 不把整个 contentJson（单条可到 ~500KB）拉进内存。该 importId 下没有
  // 安全的上限（需要全量 itemKey 才能正确幂等），故不做 LIMIT；
  // 去掉 jsonb 载荷后每行只有几十字节，内存占用得到控制。
  const existingVersions = await tx
    .select({
      noteId: noteVersions.noteId,
      versionId: noteVersions.id,
      versionNo: noteVersions.versionNo,
      itemKey: sql<string | null>`content_json->>'itemKey'`,
    })
    .from(noteVersions)
    .where(
      and(
        eq(noteVersions.workspaceId, workspaceId),
        sql`content_json->>'importId' = ${importId}`,
      ),
    );

  // 收集当前幂等格式写入的 itemKey。
  const existingByKey = new Map<string, { noteId: string; versionId: string; versionNo: number }>();

  for (const v of existingVersions) {
    if (v.itemKey) {
      existingByKey.set(v.itemKey, { noteId: v.noteId, versionId: v.versionId, versionNo: v.versionNo });
    }
  }

  const requestedKeys = new Set(requestedItems.map((item) => item.itemKey));
  const requestedExistingEntries = Array.from(existingByKey.entries()).filter(([itemKey]) =>
    requestedKeys.has(itemKey),
  );
  const existingNoteIds = Array.from(
    new Set(requestedExistingEntries.map(([, value]) => value.noteId)),
  );
  // CONC-03: 幂等检查时排除已软删除的笔记，
  // 避免笔记被删除后用相同 importId 重新导入时误判为已存在
  const existingNotes = existingNoteIds.length > 0
    ? await tx.query.notes.findMany({
        where: and(inArray(notes.id, existingNoteIds), isNull(notes.deletedAt)),
      })
    : [];
  const noteMap = new Map(existingNotes.map((n) => [n.id, n]));

  // 结果表只放当前 body 请求过的 itemKey，不返回同 importId 的历史无关项。
  const resultByKey = new Map<string, ImportedItem>();
  for (const [itemKey, v] of requestedExistingEntries) {
    const note = noteMap.get(v.noteId);
    if (note) {
      resultByKey.set(itemKey, {
        itemKey,
        note: { id: note.id, title: note.title },
        version: { id: v.versionId, versionNo: v.versionNo },
      });
    }
  }

  // 同一请求内相同 itemKey 也只创建一次，使首次调用与幂等重试保持一致。
  const seenKeys = new Set(existingByKey.keys());
  const itemsToImport: PreparedMarkdownImportItem[] = [];
  for (const item of requestedItems) {
    if (seenKeys.has(item.itemKey)) continue;
    seenKeys.add(item.itemKey);
    itemsToImport.push(item);
  }

  let importedErrors: Array<{ index: number; title: string; error: string }> | undefined;
  const searchDocuments: PendingSearchDocument[] = [];

  if (itemsToImport.length > 0) {
    const importResult = await importItems(
      tx,
      itemsToImport,
      workspaceId,
      userId,
      importId,
    );
    for (const record of importResult.records) resultByKey.set(record.itemKey, record);
    searchDocuments.push(...importResult.searchDocuments);
    importedErrors = importResult.errors;

    logger.info(
      {
        workspaceId,
        importId,
        requestedExisting: requestedExistingEntries.length,
        newlyImported: importResult.records.length,
      },
      "import partial retry — supplemented missing items",
    );
  }

  // 按当前 body 的首次出现顺序返回，且同一个 itemKey 仅出现一次。
  const orderedResults: ImportedItem[] = [];
  const returnedKeys = new Set<string>();
  for (const item of requestedItems) {
    if (returnedKeys.has(item.itemKey)) continue;
    const record = resultByKey.get(item.itemKey);
    if (!record) continue;
    returnedKeys.add(item.itemKey);
    orderedResults.push(record);
  }

  const hadRequestedExisting = requestedExistingEntries.length > 0;
  return {
    response: {
      imported: orderedResults.length,
      notes: orderedResults.map(({ note, version }) => ({ note, version })),
      idempotent: hadRequestedExisting,
      ...(importedErrors && importedErrors.length > 0 ? { errors: importedErrors } : {}),
    },
    searchDocuments,
  };
}

/**
 * 业务事务提交后调用：刷新搜索索引投影，并返回路由响应体。
 * 索引是可重建投影，写入失败只记录日志，不影响已提交的导入结果。
 */
export async function finalizeMarkdownImport(
  outcome: MarkdownImportOutcome,
): Promise<MarkdownImportResponse> {
  await updateImportedNoteSearchIndexes(outcome.searchDocuments);
  return outcome.response;
}
