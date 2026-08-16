/**
 * 投影 outbox 重放（文档 16 §15.5 一次性显影 / 运维回填）。
 *
 * 背景（2026-08-14）：PROJECTION_CHECKPOINT_SECRET 未配置期间，commit 事务
 * 先写 canonical envelope（pending）再调 materialize——checkpoint 签发
 * fail-closed 返回 null，envelope 停留在 pending、checkpoint/changeset 未落库。
 * 密钥补齐后本脚本按事件顺序重放全部 pending envelope（幂等），使投影
 * 追上已提交事实。
 *
 * 用法：
 *   DATABASE_URL=... npx tsx src/scripts/backfill-projection-outbox.ts
 */

import { eq, asc, and, or, sql } from "drizzle-orm";
import { db, withWorkspaceTransaction, closeDatabase } from "../db/client.ts";
import { canonicalLearningEventOutbox } from "../db/schema/learning-runs.ts";
import {
  materializeCanonicalChangeSet,
} from "../modules/understanding/projection-service.ts";
import type { CanonicalLearningEventEnvelopeV1 } from "@ailearn/shared";

/** 每批处理的 pending envelope 条数：约束单批内存与事务规模（keyset 游标分页）。 */
const PAGE_SIZE = 200;

type OutboxCursor = {
  workspaceId: string;
  userId: string;
  createdAt: Date;
  canonicalEventId: string;
  id: string;
};

async function main(): Promise<void> {
  let cursor: OutboxCursor | null = null;
  let published = 0;
  let failed = 0;
  let total = 0;
  let hasMore = true;

  while (hasMore) {
    const pending: typeof canonicalLearningEventOutbox.$inferSelect[] = await db
      .select()
      .from(canonicalLearningEventOutbox)
      .where(and(
        eq(canonicalLearningEventOutbox.status, "pending"),
        cursor
          ? or(
              sql`(
                ${canonicalLearningEventOutbox.workspaceId} > ${cursor.workspaceId}
                OR (${canonicalLearningEventOutbox.workspaceId} = ${cursor.workspaceId}
                    AND ${canonicalLearningEventOutbox.userId} > ${cursor.userId})
                OR (${canonicalLearningEventOutbox.workspaceId} = ${cursor.workspaceId}
                    AND ${canonicalLearningEventOutbox.userId} = ${cursor.userId}
                    AND ${canonicalLearningEventOutbox.createdAt} > ${cursor.createdAt})
                OR (${canonicalLearningEventOutbox.workspaceId} = ${cursor.workspaceId}
                    AND ${canonicalLearningEventOutbox.userId} = ${cursor.userId}
                    AND ${canonicalLearningEventOutbox.createdAt} = ${cursor.createdAt}
                    AND ${canonicalLearningEventOutbox.canonicalEventId} > ${cursor.canonicalEventId})
                OR (${canonicalLearningEventOutbox.workspaceId} = ${cursor.workspaceId}
                    AND ${canonicalLearningEventOutbox.userId} = ${cursor.userId}
                    AND ${canonicalLearningEventOutbox.createdAt} = ${cursor.createdAt}
                    AND ${canonicalLearningEventOutbox.canonicalEventId} = ${cursor.canonicalEventId}
                    AND ${canonicalLearningEventOutbox.id} > ${cursor.id})
              )`
            )
          : undefined,
      ))
      .orderBy(
        asc(canonicalLearningEventOutbox.workspaceId),
        asc(canonicalLearningEventOutbox.userId),
        asc(canonicalLearningEventOutbox.createdAt),
        asc(canonicalLearningEventOutbox.canonicalEventId),
        asc(canonicalLearningEventOutbox.id),
      )
      .limit(PAGE_SIZE);

    if (pending.length === 0) {
      // 上一批恰好是最后一批（不含游标首次查询为空）→ 结束。
      hasMore = false;
      break;
    }

    total += pending.length;
    console.log(`[projection-backfill] 本批 ${pending.length} 条 pending envelope（累计 ${total}）`);

    for (const row of pending) {
      try {
        const envelope = row.envelope as unknown as CanonicalLearningEventEnvelopeV1;
        const result = await withWorkspaceTransaction(
          { workspaceId: row.workspaceId, userId: row.userId },
          async (tx) =>
            materializeCanonicalChangeSet(
              tx,
              { workspaceId: row.workspaceId, userId: row.userId },
              envelope,
              row.runId,
              row.createdAt ?? new Date(),
            ),
        );
        if (result) {
          published += 1;
        } else {
          // checkpoint 仍不可用（密钥问题等）——保留 pending，不破坏数据。
          failed += 1;
          console.warn(
            `[projection-backfill] envelope ${row.canonicalEventId} 物化未完成（checkpoint 不可用？）`,
          );
        }
      } catch (err) {
        failed += 1;
        console.error(
          `[projection-backfill] envelope ${row.canonicalEventId} 重放失败:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // 本批不足一整页 → 已到末尾。
    if (pending.length < PAGE_SIZE) {
      hasMore = false;
      break;
    }
    const last = pending[pending.length - 1];
    cursor = {
      workspaceId: last.workspaceId,
      userId: last.userId,
      createdAt: last.createdAt ?? new Date(0),
      canonicalEventId: last.canonicalEventId,
      id: last.id,
    };
  }

  if (total === 0) {
    console.log("[projection-backfill] 没有 pending envelope，无需重放。");
  } else {
    console.log(`[projection-backfill] 完成：published=${published}, failed=${failed}（共 ${total} 条）`);
  }
}

main()
  .catch((err) => {
    console.error("[projection-backfill] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch(() => undefined);
  });
