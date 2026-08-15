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

import { eq, asc } from "drizzle-orm";
import { db, withWorkspaceTransaction, closeDatabase } from "../db/client.ts";
import { canonicalLearningEventOutbox } from "../db/schema/learning-runs.ts";
import {
  materializeCanonicalChangeSet,
} from "../modules/understanding/projection-service.ts";
import type { CanonicalLearningEventEnvelopeV1 } from "@ailearn/shared";

async function main(): Promise<void> {
  const pending = await db
    .select()
    .from(canonicalLearningEventOutbox)
    .where(eq(canonicalLearningEventOutbox.status, "pending"))
    .orderBy(
      asc(canonicalLearningEventOutbox.workspaceId),
      asc(canonicalLearningEventOutbox.userId),
      asc(canonicalLearningEventOutbox.createdAt),
      asc(canonicalLearningEventOutbox.canonicalEventId),
    );

  if (pending.length === 0) {
    console.log("[projection-backfill] 没有 pending envelope，无需重放。");
    return;
  }

  console.log(`[projection-backfill] 待重放 ${pending.length} 条 pending envelope`);
  let published = 0;
  let failed = 0;

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

  console.log(`[projection-backfill] 完成：published=${published}, failed=${failed}`);
}

main()
  .catch((err) => {
    console.error("[projection-backfill] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch(() => undefined);
  });
