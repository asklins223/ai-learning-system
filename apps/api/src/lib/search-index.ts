import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { searchDocuments } from "../db/schema/search.ts";
import { logger } from "./logger.ts";

/**
 * 数据库接口类型——仅选取 upsert/delete 所需的方法。
 * 测试时可注入 mock 实现以验证真实函数逻辑。
 */
type SearchDatabase = Pick<typeof db, "insert" | "delete">;

/**
 * 搜索索引同步统一入口。
 * 各模块只调用此函数，不内联写 upsert SQL。
 *
 * V0.3 用同步写入，不引入 domain event。
 * 后续如需改为异步（domain event 驱动），只需修改此函数内部实现。
 *
 * F-025: 索引写入失败不中断主流程，记录日志供补偿。
 * 搜索索引是派生投影，业务事务成功后索引写入失败不应回滚业务操作。
 * 调用方可通过 GET /search/drift 检测漂移，并通过 POST /search/reindex 补偿。
 */
export async function upsertSearchDocument(
  params: {
    workspaceId: string;
    objectType: "note" | "card_set" | "card" | "source" | "evidence";
    objectId: string;
    title: string | null;
    body: string | null;
    metadata?: Record<string, unknown>;
  },
  database: SearchDatabase = db,
): Promise<boolean> {
  const { workspaceId, objectType, objectId, title, body, metadata } = params;

  try {
    await database
      .insert(searchDocuments)
      .values({
        workspaceId,
        objectType,
        objectId,
        title: title ?? null,
        body: body ?? null,
        metadata: metadata ?? {},
        indexedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [searchDocuments.workspaceId, searchDocuments.objectType, searchDocuments.objectId],
        set: {
          title: title ?? null,
          body: body ?? null,
          metadata: metadata ?? {},
          indexedAt: new Date(),
        },
      });
    return true;
  } catch (err) {
    // F-025: 索引写入失败不中断主流程，记录日志供补偿
    logger.error(
      {
        err,
        workspaceId,
        objectType,
        objectId,
      },
      "search index upsert failed — index may be stale, run reindex to compensate",
    );
    return false;
  }
}

/**
 * 删除搜索索引。
 *
 * F-025: 同上，删除失败也只记录日志，不中断主流程。
 */
export async function deleteSearchDocument(
  workspaceId: string,
  objectType: string,
  objectId: string,
  database: SearchDatabase = db,
): Promise<void> {
  try {
    await database
      .delete(searchDocuments)
      .where(
        and(
          eq(searchDocuments.workspaceId, workspaceId),
          eq(searchDocuments.objectType, objectType),
          eq(searchDocuments.objectId, objectId),
        ),
      );
  } catch (err) {
    // F-025: 索引删除失败不中断主流程，记录日志供补偿
    logger.error(
      {
        err,
        workspaceId,
        objectType,
        objectId,
      },
      "search index delete failed — index may have ghost document, run reindex to compensate",
    );
  }
}
