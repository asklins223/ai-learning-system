/**
 * 记忆 embedding 重建 worker（22-real-desktop-pet-memory-context-prd-tdd.md §12.7/§13.8）。
 *
 * 扫描 `embedding_status IN ('pending','none')` 且已确认/非候选的记忆，
 * 调用 embedding provider 生成向量并写入 assistant_memory_embeddings；
 * 成功后置 `ready`，失败置 `failed`（后续可重跑）。
 */

import { sql } from "drizzle-orm";
import { readJobPayloadString } from "@ailearn/shared";
import { MEMORY_SEMANTIC_SIMILARITY_THRESHOLD } from "@ailearn/shared/db-schema/assistant-memory";
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

  let semanticDismissedCount = 0;
  let okCount = 0;
  let failCount = 0;
  /**
   * 一行一条：embed 一次 HTTP 往返 + 一个只写这一行的小事务。
   *
   * `job.signal` 必须传下去。`embed(text, signal?)` 一直收这个参数而以前一直没人给
   * （`lib/ai-provider.ts:240`）：上游挂住时唯一的兜底是 transport 那个 300 秒总超时
   * （`packages/shared/src/public-json-http.ts`），而 handler 自己的预算只有 110 秒、
   * 租约 120 秒——于是一次挂起的 embed 会带着整批剩余行一起越过租约，被 reaper 重投后
   * 从头再烧一遍。
   */
  const embedOne = async (row: (typeof rows)[number]): Promise<void> => {
    try {
      const vector = await provider.embed(row.content.slice(0, 1000), job.signal);
      if (!vector || vector.length === 0) {
        await markMemoryEmbeddingStatus(job, userId, row.id, "failed");
        failCount += 1;
        return;
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

        // 到这一刻才有两边向量：抽取时那条候选还没 embedding，
        // 字面判据（pg_trgm）在 `companion-memory-extractor.ts` 已经先跑过一遍，
        // 这里补的是"换了措辞的同一件事"（doc 34 L14，阈值实测见常量注释）。
        // 效果与字面孪生同构：这条不再对她说话（dismissed），而不是删掉——
        // 删掉会让"她忽略过什么"少一条记录。
        if (await dismissSemanticTwin(tx, {
          workspaceId: job.workspaceId,
          userId,
          memoryId: row.id,
          embedding: queryVec,
        })) {
          semanticDismissedCount += 1;
        }
      });
      okCount += 1;
    } catch (err) {
      logger.warn({ jobId: job.id, memoryId: row.id, err }, "memory embedding failed");
      await markMemoryEmbeddingStatus(job, userId, row.id, "failed");
      failCount += 1;
    }
  };

  /**
   * 200 行**串行** embed 是这个 job 的全部墙钟（200 × ~300 ms ≈ 一分钟，正好压在
   * handler 110 秒预算上，一次网络抖动就整单超时重投）。这些行之间没有任何依赖，
   * 所以按一个小上限并行——上限取值与仓库里其它"打外部服务"的池一致（4），
   * 不追高：这个 job 是和真正在生成内容的调用抢同一个 provider 配额的。
   * 逐行提交的小事务保持原样，所以"哪些行已落库"的语义与串行版完全相同。
   */
  const EMBED_CONCURRENCY = 4;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(EMBED_CONCURRENCY, rows.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      await embedOne(rows[index]);
    }
  });
  await Promise.all(workers);

  logger.info(
    { jobId: job.id, okCount, failCount, semanticDismissedCount },
    "memory embedding rebuild completed",
  );
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

/**
 * "换了措辞的同一件事"（doc 34 L14）：这条记忆的向量若与本人某条**已忽略**的记忆
 * 语义距离近过阈值，就把它也标成已忽略——效果与抽取器的字面孪生同构（不再对她说话），
 * 但不删行，"她忽略过什么"的记录要留全。
 *
 * 判据只在两边都有向量的时候成立（这一刻刚刚落库的那条 + 已忽略的那条），
 * 阈值是共享常量，出处只有 `MEMORY_SEMANTIC_SIMILARITY_THRESHOLD` 注释里那一次实测。
 * 单独成函数是为了能被真实数据直接测到——上面那个循环要打 embedding provider。
 */
/** 与 `withJobTransaction` 回调里那个事务同一个类型（不新造一层抽象）。 */
type JobTransaction = Parameters<Parameters<typeof withJobTransaction>[1]>[0];

export async function dismissSemanticTwin(
  tx: JobTransaction,
  input: { workspaceId: string; userId: string; memoryId: string; embedding: string },
): Promise<boolean> {
  const rows = await tx.execute(sql`
    UPDATE assistant_memory_items m
       SET dismissed_at = now(), updated_at = now()
     WHERE m.id = ${input.memoryId}
       AND m.workspace_id = ${input.workspaceId}
       AND m.user_id = ${input.userId}
       AND m.dismissed_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM assistant_memory_items d
         JOIN assistant_memory_embeddings dv ON dv.memory_id = d.id
         WHERE d.user_id = ${input.userId}
           AND d.workspace_id = ${input.workspaceId}
           AND d.id <> ${input.memoryId}
           AND d.deleted_at IS NULL
           AND d.dismissed_at IS NOT NULL
           AND 1 - (dv.embedding <=> ${input.embedding}::vector) >
                 ${MEMORY_SEMANTIC_SIMILARITY_THRESHOLD}
       )
    RETURNING m.id
  `);
  return rows.length > 0;
}
