/**
 * 真桌宠记忆服务（22-real-desktop-pet-memory-context-prd-tdd.md）。
 *
 * 在原有分层记忆（文档 16 §10）基础上扩展 V2 字段：
 * importance / confidence / scope / pinned / archived / dismissed /
 * embedding_status / source_type / episodic kind。
 *
 * 写函数接受 executor（事务）参数——调用方传 withWorkspaceTransaction 的
 * 事务，满足 SEC-01 跨 workspace 隔离审计。
 */

import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import { assistantMemoryItems, MEMORY_CONTENT_SIMILARITY_THRESHOLD, MEMORY_SEMANTIC_SIMILARITY_THRESHOLD } from "@ailearn/shared/db-schema/assistant-memory";
import { closeDeliveriesForMemoryItem } from "./delivery-service.ts";

// 轻微·15（round-4）：LIST 无分页时的防御性上限。
const MEMORY_LIST_LIMIT = 200;

export interface MemoryScope {
  workspaceId: string;
  userId: string;
}

export type MemoryKindV2 =
  | "preference"
  | "goal"
  | "learning_context"
  | "interaction_note"
  | "episodic";

export type MemoryScopeV2 = "global" | "workspace" | "task";
export type MemorySourceTypeV2 =
  | "user_stated"
  | "model_inferred"
  | "confirmed"
  | "summary";
export type MemoryEmbeddingStatusV2 = "none" | "pending" | "ready" | "failed";

export interface MemoryItemV2 {
  memoryItemId: string;
  kind: MemoryKindV2;
  content: string;
  sourceEventId: string | null;
  sourceSessionId: string | null;
  userStated: boolean;
  userConfirmed: boolean;
  candidate: boolean;
  importance: number;
  confidence: number;
  scope: MemoryScopeV2;
  pinned: boolean;
  archived: boolean;
  dismissedAt: string | null;
  conflictGroup: string | null;
  embeddingStatus: MemoryEmbeddingStatusV2;
  sourceType: MemorySourceTypeV2;
  createdAt: string;
  updatedAt: string;
}

/** 简单冲突检测：与新记忆相似度超过共用判据的活跃记忆归入同一 conflict_group。 */
async function markMemoryConflictIfSimilar(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryId: string,
  content: string,
): Promise<void> {
  const rows = await executor.execute<{ id: string }>(sql`
    SELECT id FROM assistant_memory_items
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND deleted_at IS NULL
      AND id <> ${memoryId}
      AND similarity(content, ${content}) > ${MEMORY_CONTENT_SIMILARITY_THRESHOLD}
    LIMIT 1
  `);
  const other = (Array.isArray(rows) ? rows : [])[0]?.id;
  if (!other) return;
  const group = randomUUID();
  await executor.update(assistantMemoryItems)
    .set({ conflictGroup: group, updatedAt: new Date() })
    .where(eq(assistantMemoryItems.id, memoryId));
  await executor.update(assistantMemoryItems)
    .set({ conflictGroup: group, updatedAt: new Date() })
    .where(eq(assistantMemoryItems.id, other));
}

function toContract(row: typeof assistantMemoryItems.$inferSelect): MemoryItemV2 {
  return {
    memoryItemId: row.id,
    kind: row.kind as MemoryKindV2,
    content: row.content,
    sourceEventId: row.sourceEventId,
    sourceSessionId: row.sourceSessionId,
    userStated: row.userStated,
    userConfirmed: row.userConfirmed,
    candidate: row.candidate,
    importance: row.importance,
    confidence: row.confidence,
    scope: row.scope as MemoryScopeV2,
    pinned: row.pinned,
    archived: row.archivedAt !== null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    conflictGroup: row.conflictGroup ?? null,
    embeddingStatus: row.embeddingStatus as MemoryEmbeddingStatusV2,
    sourceType: row.sourceType as MemorySourceTypeV2,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** upsert：同 (kind, sourceEventId) 活跃记忆更新；无来源记忆靠 userStated 区分。 */
export async function upsertMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  input: {
    kind: MemoryKindV2;
    content: string;
    sourceEventId?: string;
    sourceSessionId?: string;
    userStated?: boolean;
    candidate?: boolean;
    importance?: number;
    confidence?: number;
    scope?: MemoryScopeV2;
    sourceType?: MemorySourceTypeV2;
    pinned?: boolean;
    /**
     * 继承哪一行的跨空间身份（纠正路径用）。不传时：global 行认领自己的 id，其余 NULL。
     * **必须继承而不是换新 key**——换了 key，其他空间里那几份副本就和这条脱钩，
     * 0268 的同步触发器再也找不到彼此（doc 34 L9）。
     */
    globalKeyFrom?: string | null;
  },
  now: Date = new Date(),
): Promise<MemoryItemV2> {
  // §9.4/§25：写入端统一限制 ≤200 字。upsertMemory 是所有写入路径的统一入口，
  // 在此做防御性截断，确保无论调用方是否已截断，写入数据库的内容都不超过 200 字。
  const content = input.content.slice(0, 200);
  if (input.sourceEventId) {
    const existing = await executor
      .select()
      .from(assistantMemoryItems)
      .where(and(
        eq(assistantMemoryItems.workspaceId, scope.workspaceId),
        eq(assistantMemoryItems.userId, scope.userId),
        eq(assistantMemoryItems.kind, input.kind),
        eq(assistantMemoryItems.sourceEventId, input.sourceEventId),
        isNull(assistantMemoryItems.deletedAt),
      ))
      .limit(1);
    if (existing[0]) {
      await executor.update(assistantMemoryItems)
        .set({
          content,
          importance: input.importance ?? existing[0].importance,
          confidence: input.confidence ?? existing[0].confidence,
          scope: input.scope ?? existing[0].scope,
          // 改成 global 时这一行必须认领自己的 key：0268 的两支同步触发器按
          // `global_key IS NOT NULL` 挑行，"加入/重新加入空间时补铺"也只挑带 key 的。
          // 留 NULL 就等于这条 global 记忆哪里都不去（doc 34 L9）。
          globalKey: existing[0].globalKey
            ?? ((input.scope ?? existing[0].scope) === "global" ? existing[0].id : null),
          sourceType: input.sourceType ?? existing[0].sourceType,
          pinned: input.pinned ?? existing[0].pinned,
          // 内容变化后需要重新生成 embedding。
          embeddingStatus: existing[0].embeddingStatus === "ready"
            ? "pending"
            : existing[0].embeddingStatus,
          updatedAt: now,
        })
        .where(eq(assistantMemoryItems.id, existing[0].id));
      const updated = await executor
        .select()
        .from(assistantMemoryItems)
        .where(eq(assistantMemoryItems.id, existing[0].id))
        .limit(1);
      await markMemoryConflictIfSimilar(executor, scope, updated[0].id, content);
      return toContract(updated[0]);
    }
  }
  // id 在这里先生成而不是交给 `defaultRandom()`：global 记忆的 `global_key` 约定是
  // "源行认领自己的 id"（与 `ailearn_fanout_global_companion_memory` 同一句话），
  // 拿不到 id 就写不出这个 key——而没有 key 的 global 行，0268 的触发器永远不认。
  const memoryId = randomUUID();
  const memoryScope = input.scope ?? "workspace";
  const inserted = await executor.insert(assistantMemoryItems).values({
    id: memoryId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    kind: input.kind,
    content,
    sourceEventId: input.sourceEventId ?? null,
    sourceSessionId: input.sourceSessionId ?? null,
    userStated: input.userStated ?? false,
    userConfirmed: input.userStated ?? false,
    candidate: input.candidate ?? true,
    importance: input.importance ?? (input.userStated ? 0.8 : 0.5),
    confidence: input.confidence ?? 0.5,
    scope: memoryScope,
    globalKey: input.globalKeyFrom ?? (memoryScope === "global" ? memoryId : null),
    sourceType: input.sourceType ?? (input.userStated ? "user_stated" : "model_inferred"),
    pinned: input.pinned ?? false,
    embeddingStatus: input.candidate === false ? "pending" : "none",
    createdAt: now,
    updatedAt: now,
  }).returning();
  await markMemoryConflictIfSimilar(executor, scope, inserted[0].id, content);
  return toContract(inserted[0]);
}

/** 候选确认（用户确认后参与主动策略；确认后需要生成 embedding）。 */
export async function confirmMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .limit(1);
  if (!rows[0]) return null;
  await executor.update(assistantMemoryItems)
    .set({
      candidate: false,
      userConfirmed: true,
      sourceType: rows[0].sourceType === "model_inferred" ? "confirmed" : rows[0].sourceType,
      embeddingStatus: rows[0].embeddingStatus === "none" ? "pending" : rows[0].embeddingStatus,
      updatedAt: now,
    })
    .where(eq(assistantMemoryItems.id, memoryItemId));
  const updated = await executor
    .select()
    .from(assistantMemoryItems)
    .where(eq(assistantMemoryItems.id, memoryItemId))
    .limit(1);
  // 结账那条候选交付：用户已经对它表过态了（doc 34 L42）。不接这一步，
  // 活动条里那一行会永远停在 displayed，而 acted 这个终态整库 0 行。
  await closeDeliveriesForMemoryItem(executor, scope, { memoryItemId, transition: "acted" }, now);
  return toContract(updated[0]);
}

/** soft delete（审计保留；canonical 学习事实不受影响）。 */
export async function deleteMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning({ id: assistantMemoryItems.id });
  if (updated.length > 0) {
    // 删掉候选也算对它表了态：那条交付不能继续排着（`correctMemory` 走这里，一起结账）。
    await closeDeliveriesForMemoryItem(executor, scope, { memoryItemId, transition: "dismissed" }, now);
  }
  return updated.length > 0;
}

/** 固定：高优先级、不参与衰减。 */
export async function pinMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ pinned: true, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  return updated[0] ? toContract(updated[0]) : null;
}

/** 取消固定：恢复参与正常衰减与排序（与 pinMemory 对偶；pin 非.toggle）。 */
export async function unpinMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ pinned: false, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  return updated[0] ? toContract(updated[0]) : null;
}

/** 归档：不参与检索，可恢复。 */
export async function archiveMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  return updated[0] ? toContract(updated[0]) : null;
}

/** 恢复归档。 */
export async function restoreMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ archivedAt: null, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  return updated[0] ? toContract(updated[0]) : null;
}

/** 忽略：写 `dismissed_at`，并把那条候选交付结账成 `dismissed`（doc 34 L42）。
 * 到活动条的下一次拉取就不再含它；`expires_at` 那道 30 天窗口只是兜底，不是这条判据。 */
export async function dismissMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ dismissedAt: now, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  if (updated[0]) {
    await closeDeliveriesForMemoryItem(executor, scope, { memoryItemId, transition: "dismissed" }, now);
    // 反方向那一半（doc 34 L14）：worker 那条只在"新向量刚落库"时比对，
    // 而"她刚刚忽略的这条"对应的**老**候选可能早就有向量了，永远等不到那次比对。
    // 判据表达式来自共享的 semanticTwinPredicateSql，这里不重写阈值。
    await executor.execute(sql`
      UPDATE assistant_memory_items m
         SET dismissed_at = now(), updated_at = now()
        FROM assistant_memory_embeddings av
       WHERE av.memory_id = ${memoryItemId}
         AND m.workspace_id = ${scope.workspaceId}
         AND m.user_id = ${scope.userId}
         AND m.id <> ${memoryItemId}
         AND m.dismissed_at IS NULL
         AND m.deleted_at IS NULL
         AND m.embedding_status = 'ready'
         AND EXISTS (
           SELECT 1 FROM assistant_memory_embeddings mv
           WHERE mv.memory_id = m.id
             AND 1 - (mv.embedding <=> av.embedding) > ${MEMORY_SEMANTIC_SIMILARITY_THRESHOLD}
         )
    `);
  }
  return updated[0] ? toContract(updated[0]) : null;
}

/** 纠正：旧记忆 soft delete，新内容生成候选（等待再次确认）。 */
export async function correctMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  input: { content: string; reason?: string },
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const existing = await getMemory(executor, scope, memoryItemId);
  if (!existing) return null;
  // 跨空间身份要在删除之前取出来：删完再问就只有一行 `deleted_at` 不为空的旧行了，
  // 而契约里没有这一位（它是库内的对齐键，不是给用户看的内容）。
  const [priorKey] = await executor
    .select({ globalKey: assistantMemoryItems.globalKey })
    .from(assistantMemoryItems)
    .where(eq(assistantMemoryItems.id, memoryItemId))
    .limit(1);
  await deleteMemory(executor, scope, memoryItemId, now);
  const inserted = await upsertMemory(executor, scope, {
    kind: existing.kind,
    content: input.content,
    sourceEventId: existing.sourceEventId ? `${existing.sourceEventId}:corrected:${now.toISOString()}` : undefined,
    sourceSessionId: existing.sourceSessionId ?? undefined,
    userStated: existing.userStated,
    candidate: true,
    importance: existing.importance,
    confidence: existing.confidence,
    scope: existing.scope,
    globalKeyFrom: priorKey?.globalKey ?? null,
    sourceType: existing.sourceType,
  }, now);
  return inserted;
}

export async function listMemories(
  executor: ApiTransaction,
  scope: MemoryScope,
  input: {
    kind?: MemoryKindV2;
    q?: string;
    scope?: MemoryScopeV2;
    includeCandidates?: boolean;
    includeArchived?: boolean;
  } = {},
): Promise<MemoryItemV2[]> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
      input.kind ? eq(assistantMemoryItems.kind, input.kind) : undefined,
      input.scope ? eq(assistantMemoryItems.scope, input.scope) : undefined,
      input.includeArchived ? undefined : isNull(assistantMemoryItems.archivedAt),
      input.includeCandidates ? undefined : eq(assistantMemoryItems.candidate, false),
      input.q ? ilike(assistantMemoryItems.content, `%${input.q}%`) : undefined,
    ))
    .orderBy(desc(assistantMemoryItems.pinned), desc(assistantMemoryItems.updatedAt))
    .limit(MEMORY_LIST_LIMIT);
  return rows.map(toContract);
}

/** 一键清空：soft delete 当前用户全部记忆（审计保留，不影响学习真相）。 */
export async function clearMemories(
  executor: ApiTransaction,
  scope: MemoryScope,
  now: Date = new Date(),
): Promise<number> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning({ id: assistantMemoryItems.id });
  return updated.length;
}

/** 冲突列表：返回所有带 conflict_group 的未删除记忆。 */
export async function listMemoryConflicts(
  executor: ApiTransaction,
  scope: MemoryScope,
): Promise<MemoryItemV2[]> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
      sql`${assistantMemoryItems.conflictGroup} IS NOT NULL`,
    ))
    .orderBy(assistantMemoryItems.conflictGroup, assistantMemoryItems.updatedAt)
    .limit(MEMORY_LIST_LIMIT);
  return rows.map(toContract);
}

/** 冲突裁决：保留 keepId，soft delete removeId，并清除该冲突组标记。 */
export async function resolveMemoryConflict(
  executor: ApiTransaction,
  scope: MemoryScope,
  keepId: string,
  removeId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const kept = await getMemory(executor, scope, keepId);
  const removed = await getMemory(executor, scope, removeId);
  if (!kept || !removed) return false;
  if (kept.conflictGroup !== removed.conflictGroup) return false;
  await executor.update(assistantMemoryItems)
    .set({ conflictGroup: null, updatedAt: now })
    .where(eq(assistantMemoryItems.id, keepId));
  await deleteMemory(executor, scope, removeId, now);
  return true;
}

/** 单条记忆读取（不含已删除；§18 工具网关 revision CAS 用）。 */
export async function getMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
): Promise<MemoryItemV2 | null> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .limit(1);
  return rows[0] ? toContract(rows[0]) : null;
}

/**
 * 导出当前用户全部记忆（§13.2）。
 * 包含状态、来源、时间、关联实体；不含 embedding。
 * 含已归档记忆，不含已删除记忆。
 */
export async function exportMemories(
  executor: ApiTransaction,
  scope: MemoryScope,
): Promise<{
  version: 1;
  exportedAt: string;
  items: MemoryItemV2[];
}> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .orderBy(desc(assistantMemoryItems.pinned), desc(assistantMemoryItems.updatedAt))
    .limit(10000);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    items: rows.map(toContract),
  };
}
