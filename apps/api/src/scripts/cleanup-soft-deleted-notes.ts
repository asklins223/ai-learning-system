/**
 * CONC-03 / §3.11: 软删除笔记清理脚本。
 *
 * 物理删除已软删除超过 30 天的笔记，并清理关联的对象存储图片。
 *
 * 用法：
 *   node --import tsx scripts/cleanup-soft-deleted-notes.ts
 *   node --import tsx scripts/cleanup-soft-deleted-notes.ts --dry-run
 *   node --import tsx scripts/cleanup-soft-deleted-notes.ts --retention-days 60
 *
 * 退出码：
 *   0 — 清理完成（或 dry-run 检查完毕）
 *   1 — 发生错误
 *
 * CI / Cron 集成：
 *   建议通过 cron 每天运行一次：
 *   0 3 * * * cd /app && node --import tsx scripts/cleanup-soft-deleted-notes.ts >> /var/log/note-cleanup.log 2>&1
 */

import { and, lt, sql } from "drizzle-orm";
import { db, closeDatabase } from "../db/client.ts";
import { notes } from "../db/schema/note.ts";
import { physicalDeleteNote } from "../modules/note/service.ts";
import { deleteObject } from "../lib/object-storage.ts";
import { logger } from "../lib/logger.ts";

const DEFAULT_RETENTION_DAYS = 30;

function parseArgs(): { dryRun: boolean; retentionDays: number } {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const retentionIdx = args.indexOf("--retention-days");
  const retentionDays = retentionIdx >= 0 && args[retentionIdx + 1]
    ? Math.max(1, parseInt(args[retentionIdx + 1], 10) || DEFAULT_RETENTION_DAYS)
    : DEFAULT_RETENTION_DAYS;
  return { dryRun, retentionDays };
}

async function main(): Promise<void> {
  const { dryRun, retentionDays } = parseArgs();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  logger.info({ cutoff: cutoff.toISOString(), retentionDays, dryRun }, "starting soft-deleted note cleanup");

  // 查找已软删除超过保留期的笔记
  const staleNotes = await db
    .select({ id: notes.id, workspaceId: notes.workspaceId, deletedAt: notes.deletedAt })
    .from(notes)
    .where(and(
      sql`${notes.deletedAt} IS NOT NULL`,
      lt(notes.deletedAt, cutoff),
    ));

  logger.info({ count: staleNotes.length }, "found soft-deleted notes past retention");

  if (dryRun) {
    for (const note of staleNotes) {
      logger.info({ noteId: note.id, workspaceId: note.workspaceId, deletedAt: note.deletedAt }, "would permanently delete (dry-run)");
    }
    return;
  }

  let deleted = 0;
  let imagesCleaned = 0;
  let failed = 0;

  for (const note of staleNotes) {
    try {
      // 在事务内执行物理删除，收集 imageObjectKeys
      const result = await db.transaction(async (tx) => {
        return physicalDeleteNote(tx, note.id, note.workspaceId);
      });

      if (!result) {
        logger.warn({ noteId: note.id }, "physicalDeleteNote returned null — note may have been already removed");
        continue;
      }

      deleted++;

      // 事务已提交，fire-and-forget 清理对象存储中的图片
      if (result.imageObjectKeys?.length > 0) {
        const results = await Promise.allSettled(
          result.imageObjectKeys.map((key) => deleteObject(key)),
        );
        const succeeded = results.filter((r) => r.status === "fulfilled").length;
        const imageFailures = results.filter((r) => r.status === "rejected").length;
        imagesCleaned += succeeded;

        if (imageFailures > 0) {
          logger.warn(
            { noteId: note.id, failed: imageFailures, total: result.imageObjectKeys.length },
            "some image objects failed to delete after note cleanup",
          );
        }
      }
    } catch (err) {
      failed++;
      logger.error({ err, noteId: note.id }, "failed to physically delete note");
    }
  }

  logger.info({ deleted, imagesCleaned, failed, total: staleNotes.length }, "soft-deleted note cleanup complete");
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "cleanup script failed");
    void closeDatabase().finally(() => process.exit(1));
  });
