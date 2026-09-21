import { searchDocuments } from "@ailearn/shared/db-schema/search";
import type { ApiTransaction } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";

export type NoteSearchDocument = {
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
 *
 * 为什么单独一个文件而不是留在 `service.ts`：正文的落盘口现在也在这里
 * （`document-state.ts` 的那一个），而它必须顺带把搜索投影刷新——自动保存以前是
 * 走 `service.updateNote` 的，那里顺手写了索引；写入改走增量之后，不跟着搬就会出现
 * "列表预览是新的、搜索里还是旧正文"，而且不报错。`service.ts` 反过来 import
 * `document-state.ts`，所以这个函数不能留在那边，否则成环。
 */
export async function upsertSearchDocument(
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
