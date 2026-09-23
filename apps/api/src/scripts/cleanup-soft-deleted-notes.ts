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

import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import { db, closeDatabase, withWorkspaceTransaction, SYSTEM_USER_ID } from "../db/client.ts";
import { notes } from "@ailearn/shared/db-schema/note";
import { workspaces } from "@ailearn/shared/db-schema/identity";
import { physicalDeleteNote } from "../modules/note/service.ts";
import { deleteObject } from "../lib/object-storage.ts";
import { logger } from "../lib/logger.ts";

const DEFAULT_RETENTION_DAYS = 30;
// PERF-WN: 分批 keyset 游标，避免一次把全表过期笔记载入内存、并缩短每批的
// 锁窗/事务链长度（每笔记仍各占一个事务，physicalDeleteNote 的级联删除语义不变）。
const BATCH_SIZE = 200;

interface StaleNoteCursor {
  deletedAt: Date;
  id: string;
}

interface StaleNoteRow {
  id: string;
  workspaceId: string;
  deletedAt: Date;
}

function parseArgs(): { dryRun: boolean; retentionDays: number } {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const retentionIdx = args.indexOf("--retention-days");
  const retentionDays = retentionIdx >= 0 && args[retentionIdx + 1]
    ? Math.max(1, parseInt(args[retentionIdx + 1], 10) || DEFAULT_RETENTION_DAYS)
    : DEFAULT_RETENTION_DAYS;
  return { dryRun, retentionDays };
}

/**
 * 按 (deletedAt, id) 键序取**一个空间内**一批过期笔记；返回空数组表示这一空间已取尽。
 *
 * 为什么按空间而不是全库一把扫：`notes` 是 `ENABLE + FORCE ROW LEVEL SECURITY` 的表，
 * 它的 RESTRICTIVE 守卫没有"没设上下文就放行"那一支，裸 `db` 扫在生产角色
 * （`ailearn_api`，NOBYPASSRLS）下恒 0 行——这份 CLI 的上下两半曾经都瞎
 * （doc 34 L37 症状 A；`maintenance.ts` 那条 6 小时的同型问题已单独修）。
 * 键集分页的语义一条没改：只是"每个空间各有一条自己的游标"。
 */
async function loadStaleNoteBatch(
  cutoff: Date,
  cursor: StaleNoteCursor | null,
  workspaceId: string,
): Promise<StaleNoteRow[]> {
  const stale = and(
    sql`${notes.deletedAt} IS NOT NULL`,
    lt(notes.deletedAt, cutoff),
    eq(notes.workspaceId, workspaceId),
  );
  const where = cursor
    ? and(
        stale,
        or(
          gt(notes.deletedAt, cursor.deletedAt),
          and(
            sql`${notes.deletedAt} = ${cursor.deletedAt}`,
            gt(notes.id, cursor.id),
          ),
        ),
      )
    : stale;
  const rows = await withWorkspaceTransaction(
    { workspaceId, userId: SYSTEM_USER_ID },
    (tx) => tx
      .select({ id: notes.id, workspaceId: notes.workspaceId, deletedAt: notes.deletedAt })
      .from(notes)
      .where(where)
      .orderBy(asc(notes.deletedAt), asc(notes.id))
      .limit(BATCH_SIZE),
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    deletedAt: row.deletedAt!,
  }));
}

async function main(): Promise<void> {
  const { dryRun, retentionDays } = parseArgs();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  logger.info({ cutoff: cutoff.toISOString(), retentionDays, dryRun }, "starting soft-deleted note cleanup");

  let total = 0;
  let deleted = 0;
  let imagesCleaned = 0;
  let failed = 0;

  // 逐个空间各跑一条自己的键集游标。`workspaces` 的守卫有 NULL 放行支
  // （0257 专门为登录/选空间那两条路开的），所以这一句裸枚举是安全的；
  // 读笔记的每一步都回到带上下文的事务里。
  const workspaceRows = await db.select({ id: workspaces.id }).from(workspaces);

  for (const workspace of workspaceRows) {
    let cursor: StaleNoteCursor | null = null;

    // keyset 分批：每批最多 BATCH_SIZE 条，边界内存受限；dry-run 同样分批。
    while (true) {
      const batch = await loadStaleNoteBatch(cutoff, cursor, workspace.id);
      if (batch.length === 0) break;
      total += batch.length;
      // 推进游标到本批末条（deletedAt,id 键序严格递增，避免重复/遗漏）。
      const last = batch[batch.length - 1];
      cursor = { deletedAt: last.deletedAt, id: last.id };

      if (dryRun) {
        for (const note of batch) {
          logger.info({ noteId: note.id, workspaceId: note.workspaceId, deletedAt: note.deletedAt }, "would permanently delete (dry-run)");
        }
        continue;
      }

      for (const note of batch) {
        try {
          // 在事务内执行物理删除，收集 imageObjectKeys
          const result = await withWorkspaceTransaction(
            { workspaceId: note.workspaceId, userId: SYSTEM_USER_ID },
            (tx) => physicalDeleteNote(tx, note.id, note.workspaceId),
          );

          if (!result) {
            logger.warn({ noteId: note.id }, "physicalDeleteNote returned null — note may have been already removed");
            continue;
          }

          deleted++;

          // 事务已提交，再清对象存储里的图片
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
    }
  }

  logger.info({ deleted, imagesCleaned, failed, total }, "soft-deleted note cleanup complete");
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "cleanup script failed");
    void closeDatabase().finally(() => process.exit(1));
  });
