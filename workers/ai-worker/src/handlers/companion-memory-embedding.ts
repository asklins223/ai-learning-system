/**
 * 记忆 embedding 重建 worker（22-real-desktop-pet-memory-context-prd-tdd.md §12.7/§13.8）。
 *
 * 扫描 `embedding_status IN ('pending','none')` 且已确认/非候选的记忆，
 * 调用 embedding provider 生成向量并写入 assistant_memory_embeddings；
 * 成功后置 `ready`，失败置 `failed`（后续可重跑）。
 */

import { sql } from "drizzle-orm";
import { readJobPayloadString } from "@ailearn/shared";
import { logger } from "../lib/logger.ts";
import { createEmbeddingProvider } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  createGovernedEmbeddingProvider,
  resolveAIGovernanceContext,
} from "../lib/governance.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import type { JobPayload } from "./index.ts";

const BATCH_LIMIT = 200;

export async function runCompanionMemoryEmbeddingRebuild(job: JobPayload): Promise<void> {
  // 设计 P1-8（2026-09-15 审计）：字段名走共享契约（见 @ailearn/shared 的
  // companion-memory-job-payload），改名由编译器兜住。
  const userId = readJobPayloadString(job.payload, "userId");
  if (!userId) throw new Error("companion_memory_embedding_rebuild payload 缺 userId");
  await assertJobLease(job);

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) throw new AIConsentRequiredError();
  const rawProvider = await createEmbeddingProvider(govCtx);
  const provider = rawProvider
    ? createGovernedEmbeddingProvider(rawProvider, govCtx, job.workspaceId)
    : null;
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
        AND (
          embedding_status IN ('pending', 'none')
          -- AI P1（2026-09-15 审计）：此前失败行被标成 'failed' 后**永不**再被选中
          -- （只取 pending/none，且全仓没有 failed→pending 的重置）——一次瞬时
          -- embed 故障就让这条记忆永久没有向量，只能降级关键词检索，且无任何补偿
          -- 路径。这里让失败行按小时级重试：既不丢记忆，也不会形成热点循环。
          OR (embedding_status = 'failed' AND updated_at < now() - interval '1 hour')
        )
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
        // 稳定 P1-1（2026-09-15 审计）：每行提交前重新校验并续租租约。
        // 顺带充当循环期间的心跳（本循环最多 200 次 embed，总时长可达分钟级）。
        // 代价：每行多 2 次 DB 往返（FOR UPDATE + renew），相对 ~300ms 的 embed
        // HTTP 往返约 1%，可接受；换来的是"租约被 reap 后不再落库/重复计费"。
        await lockJobLease(tx, job);
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
