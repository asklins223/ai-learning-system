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
import { assistantMemoryItems } from "../../db/schema/assistant-memory.ts";

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
  | "summary"
  | "legacy";
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

/** 简单冲突检测：与新记忆相似度 > 0.85 的活跃记忆归入同一 conflict_group。 */
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
      AND similarity(content, ${content}) > 0.85
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
  const inserted = await executor.insert(assistantMemoryItems).values({
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
    scope: input.scope ?? "workspace",
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

/** 忽略：气泡内 30 天不重复弹出；管理页仍可见。 */
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
