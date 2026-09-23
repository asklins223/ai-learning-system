/**
 * CONC-03: 笔记维护函数——物理清除已软删除超过保留期的笔记。
 *
 * 此文件独立于 service.ts，因为 purgeSoftDeletedNotes 是系统级维护函数，
 * 直接使用 db 而非 ApiTransaction，不遵循 API service 契约。
 */
import { and, asc, isNotNull, sql } from "drizzle-orm";
import { db, withWorkspaceTransaction, SYSTEM_USER_ID } from "../../db/client.ts";
import { notes } from "@ailearn/shared/db-schema/note";
import { workspaces } from "@ailearn/shared/db-schema/identity";
import { logger } from "../../lib/logger.ts";
import { deleteObject } from "../../lib/object-storage.ts";
import { physicalDeleteNote } from "./service.ts";

/**
 * CONC-03: 物理清除已软删除超过保留期的笔记。
 *
 * 由 server 启动时定时调用（每 6 小时一次）。每次最多处理 50 篇，
 * 避免单次事务过长。每篇笔记在独立事务中物理删除，一篇失败不影响其他。
 *
 * RLS 修复（2026-09 后端审查）：physicalDeleteNote 会读写 note_image_assets
 * ——该表 ENABLE+FORCE RLS（0046），策略要求 workspace_id =
 * current_setting('app.workspace_id')。此前用裸 db.transaction（无事务级 GUC），
 * 在 ailearn_api（NOBYPASSRLS）下资产查询恒为 0 行：图片资产永不标记 deleted、
 * MinIO 对象永不回收（与手动 DELETE /notes/:id/permanent 行为分叉）。改为
 * withWorkspaceTransaction，actor 用 SYSTEM_USER_ID（系统级维护无具体用户）。
 *
 * @param retentionDays 保留天数，默认 30 天
 * @returns 本次实际物理删除的笔记数量
 */
export async function purgeSoftDeletedNotes(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // 查找超过保留期的软删除笔记。
  //
  // 为什么必须**按空间一个个扫**：`notes` 在 0257 里是 `ENABLE + FORCE ROW LEVEL SECURITY`，
  // 它的 RESTRICTIVE 守卫没有"没设上下文就放行"那一支，所以这一句用裸 `db` 扫，
  // 在生产形状（`ailearn_api`，NOBYPASSRLS）下恒 0 行——30 天清除**从来没有清过任何东西**
  // （dev 因为 API 连的是 BYPASSRLS 的 `ailearn` 而看不出来，doc 34 L37 症状 A）。
  // `workspaces` 那张表的守卫有 NULL 分支（0257 专门为登录路径开的），所以枚举空间是安全的；
  // 真正读笔记的每一步都回到带上下文的事务里。
  const workspaceRows = await db.select({ id: workspaces.id }).from(workspaces);
  const candidates: Array<{ id: string; workspaceId: string }> = [];
  for (const workspace of workspaceRows) {
    if (candidates.length >= 50) break;
    const found = await withWorkspaceTransaction(
      { workspaceId: workspace.id, userId: SYSTEM_USER_ID },
      (tx) => tx
        .select({ id: notes.id, workspaceId: notes.workspaceId })
        .from(notes)
        .where(and(
          isNotNull(notes.deletedAt),
          sql`${notes.deletedAt} < ${cutoff.toISOString()}`,
        ))
        // 最老的先清。没有 ORDER BY 的 `LIMIT 50` 会反复选中同一批"清不掉"的行
        // （被卡的 RESTRICT 外键挡住的那些，L17），把每轮配额占满，饿死后面的笔记。
        .orderBy(asc(notes.deletedAt), asc(notes.id))
        .limit(50 - candidates.length),
    );
    candidates.push(...found);
  }
  const staleNotes = candidates;

  let purged = 0;
  let blockedByCardReference = 0;
  for (const note of staleNotes) {
    try {
      const result = await withWorkspaceTransaction(
        { workspaceId: note.workspaceId, userId: SYSTEM_USER_ID },
        (tx) => physicalDeleteNote(tx, note.id, note.workspaceId),
      );
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
      // 23503 = foreign_key_violation。今天它只有一个来源：`learning_cards_v2.note_version_id`
      // 对 `note_versions` 是 ON DELETE RESTRICT（doc 34 L17），也就是"这篇笔记生成过卡"。
      // 单独计数而不是和别的失败混成一行 error：这一类不是偶发故障，是**永远删不掉**，
      // 而"清道夫在跑"和"清道夫删不动"在日志里必须区分得开。
      if ((err as { code?: string }).code === "23503") {
        blockedByCardReference++;
        logger.warn(
          { noteId: note.id, workspaceId: note.workspaceId },
          "stale note cannot be purged: a learning card still references its version",
        );
      } else {
        logger.error({ err, noteId: note.id }, "failed to purge soft-deleted note");
      }
    }
  }

  if (purged > 0) {
    logger.info({ purged, total: staleNotes.length }, "soft-deleted notes purged");
  }
  if (blockedByCardReference > 0) {
    logger.warn(
      { blockedByCardReference, total: staleNotes.length },
      "purge pass left soft-deleted notes undeletable (card -> note_version RESTRICT, doc 34 L17)",
    );
  }

  return purged;
}
