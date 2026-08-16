/**
 * 记忆 embedding 重建 worker（22-real-desktop-pet-memory-context-prd-tdd.md §12.7/§13.8）。
 *
 * 扫描 `embedding_status IN ('pending','none')` 且已确认/非候选的记忆，
 * 调用 embedding provider 生成向量并写入 assistant_memory_embeddings；
 * 成功后置 `ready`，失败置 `failed`（后续可重跑）。
 */

import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { createEmbeddingProvider } from "../lib/ai-provider.ts";
import { resolveAIGovernanceContext } from "../lib/governance.ts";
import { assertJobLease, withJobTransaction } from "../lib/job-lease.ts";
import type { JobPayload } from "./index.ts";

const BATCH_LIMIT = 200;

export async function runCompanionMemoryEmbeddingRebuild(job: JobPayload): Promise<void> {
  const userId = job.payload.userId as string | undefined;
  if (!userId) throw new Error("companion_memory_embedding_rebuild payload 缺 userId");
  await assertJobLease(job);

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  const provider = await createEmbeddingProvider(userId, govCtx);
  if (!provider) {
    logger.info({ jobId: job.id }, "memory embedding rebuild skipped: no embedding provider");
    return;
  }

  const rows = await withJobTransaction(job, async (tx) => {
    const result = await tx.execute<{
      id: string;
      content: string;
      embedding_profile_version: string | null;
    }>(sql`
      SELECT id, content, embedding_profile_version
      FROM assistant_memory_items
      WHERE workspace_id = ${job.workspaceId}
        AND user_id = ${userId}
        AND deleted_at IS NULL
        AND candidate = false
        AND embedding_status IN ('pending', 'none')
      ORDER BY updated_at ASC
      LIMIT ${BATCH_LIMIT}
    `);
    return Array.isArray(result) ? result : [];
  });

  if (rows.length === 0) {
    logger.info({ jobId: job.id }, "memory embedding rebuild: nothing to do");
    return;
  }

  let okCount = 0;
  let failCount = 0;
  for (const row of rows) {
    try {
      const vector = await provider.embed(row.content.slice(0, 1000));
      if (!vector || vector.length === 0) {
        await markMemoryEmbeddingStatus(job, userId, row.id, "failed");
        failCount += 1;
        continue;
      }
      const queryVec = JSON.stringify(vector);
      const modelRevision = provider.embeddingModelId;
      await withJobTransaction(job, async (tx) => {
        await tx.execute(sql`
          INSERT INTO assistant_memory_embeddings
            (memory_id, workspace_id, user_id, embedding, model_revision, updated_at)
          VALUES
            (${row.id}, ${job.workspaceId}, ${userId}, ${queryVec}::vector, ${modelRevision}, now())
          ON CONFLICT (memory_id)
          DO UPDATE SET embedding = EXCLUDED.embedding, model_revision = EXCLUDED.model_revision, updated_at = now()
        `);
        await tx.execute(sql`
          UPDATE assistant_memory_items
          SET embedding_status = 'ready',
              embedding_profile_version = ${modelRevision},
              updated_at = now()
          WHERE id = ${row.id} AND workspace_id = ${job.workspaceId} AND user_id = ${userId}
        `);
      });
      okCount += 1;
    } catch (err) {
      logger.warn({ jobId: job.id, memoryId: row.id, err }, "memory embedding generation failed");
      await markMemoryEmbeddingStatus(job, userId, row.id, "failed");
      failCount += 1;
    }
  }

  logger.info({ jobId: job.id, okCount, failCount }, "memory embedding rebuild completed");
}

async function markMemoryEmbeddingStatus(
  job: JobPayload,
  userId: string,
  memoryId: string,
  status: "ready" | "failed" | "pending",
): Promise<void> {
  try {
    await withJobTransaction(job, async (tx) => {
      await tx.execute(sql`
        UPDATE assistant_memory_items
        SET embedding_status = ${status}, updated_at = now()
        WHERE id = ${memoryId} AND workspace_id = ${job.workspaceId} AND user_id = ${userId}
      `);
    });
  } catch (err) {
    logger.warn({ jobId: job.id, memoryId, err }, "memory embedding status update failed");
  }
}
