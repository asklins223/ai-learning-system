/**
 * CONC-03: 笔记维护函数——物理清除已软删除超过保留期的笔记。
 *
 * 此文件独立于 service.ts，因为 purgeSoftDeletedNotes 是系统级维护函数，
 * 直接使用 db 而非 ApiTransaction，不遵循 API service 契约。
 */
import { and, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { notes } from "../../db/schema/note.ts";
import { logger } from "../../lib/logger.ts";
import { deleteObject } from "../../lib/object-storage.ts";
import { physicalDeleteNote } from "./service.ts";

/**
 * CONC-03: 物理清除已软删除超过保留期的笔记。
 *
 * 由 server 启动时定时调用（每 6 小时一次）。每次最多处理 50 篇，
 * 避免单次事务过长。每篇笔记在独立事务中物理删除，一篇失败不影响其他。
 *
 * @param retentionDays 保留天数，默认 30 天
 * @returns 本次实际物理删除的笔记数量
 */
export async function purgeSoftDeletedNotes(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // 查找超过保留期的软删除笔记
  const staleNotes = await db
    .select({ id: notes.id, workspaceId: notes.workspaceId })
    .from(notes)
    .where(and(
      isNotNull(notes.deletedAt),
      sql`${notes.deletedAt} < ${cutoff}`,
    ))
    .limit(50);

  let purged = 0;
  for (const note of staleNotes) {
    try {
      const result = await db.transaction(async (tx) => {
        return physicalDeleteNote(tx, note.id, note.workspaceId);
      });
      if (result) {
        purged++;
        // §3.11: 事务已提交，fire-and-forget 清理对象存储中的图片
        if (result.imageObjectKeys?.length > 0) {
          void Promise.allSettled(
            result.imageObjectKeys.map((key) => deleteObject(key)),
          ).then((results) => {
            const failed = results.filter((r) => r.status === "rejected").length;
            if (failed > 0) {
              logger.warn(
                { failed, total: result.imageObjectKeys.length, noteId: note.id },
                "some image objects failed to delete during purge",
              );
            }
          });
        }
      }
    } catch (err) {
      logger.error({ err, noteId: note.id }, "failed to purge soft-deleted note");
    }
  }

  if (purged > 0) {
    logger.info({ purged, total: staleNotes.length }, "soft-deleted notes purged");
  }

  return purged;
}
