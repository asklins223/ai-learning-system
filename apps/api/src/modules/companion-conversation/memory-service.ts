/**
 * 分层记忆服务（文档 16 §10：有来源、可审计、可删除）。
 *
 * upsert（kind+sourceEventId 去重）、confirm（候选→确认）、softDelete
 * （审计保留）、list（active）。记忆与 canonical 学习事实解耦。
 *
 * 写函数接受 executor（事务）参数——调用方传 withWorkspaceTransaction 的
 * 事务，满足 SEC-01 跨 workspace 隔离审计。
 */

import { and, eq, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { assistantMemoryItems } from "../../db/schema/assistant-memory.ts";

// 轻微·15（round-4）：LIST 无分页时的防御性上限。
const MEMORY_LIST_LIMIT = 200;

export interface MemoryScope {
  workspaceId: string;
  userId: string;
}

export interface MemoryItemV1 {
  memoryItemId: string;
  kind: "preference" | "goal" | "learning_context" | "interaction_note";
  content: string;
  sourceEventId: string | null;
  sourceSessionId: string | null;
  userStated: boolean;
  userConfirmed: boolean;
  candidate: boolean;
  createdAt: string;
  updatedAt: string;
}

function toContract(row: typeof assistantMemoryItems.$inferSelect): MemoryItemV1 {
  return {
    memoryItemId: row.id,
    kind: row.kind as MemoryItemV1["kind"],
    content: row.content,
    sourceEventId: row.sourceEventId,
    sourceSessionId: row.sourceSessionId,
    userStated: row.userStated,
    userConfirmed: row.userConfirmed,
    candidate: row.candidate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** upsert：同 (kind, sourceEventId) 活跃记忆更新；无来源记忆靠 userStated 区分。 */
export async function upsertMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  input: {
    kind: MemoryItemV1["kind"];
    content: string;
    sourceEventId?: string;
    sourceSessionId?: string;
    userStated?: boolean;
    candidate?: boolean;
  },
  now: Date = new Date(),
): Promise<MemoryItemV1> {
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
        .set({ content: input.content, updatedAt: now })
        .where(eq(assistantMemoryItems.id, existing[0].id));
      const updated = await executor
        .select()
        .from(assistantMemoryItems)
        .where(eq(assistantMemoryItems.id, existing[0].id))
        .limit(1);
      return toContract(updated[0]);
    }
  }
  const inserted = await executor.insert(assistantMemoryItems).values({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    kind: input.kind,
    content: input.content,
    sourceEventId: input.sourceEventId ?? null,
    sourceSessionId: input.sourceSessionId ?? null,
    userStated: input.userStated ?? false,
    userConfirmed: input.userStated ?? false,
    candidate: input.candidate ?? true,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return toContract(inserted[0]);
}

/** 候选确认（用户确认后参与主动策略）。 */
export async function confirmMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV1 | null> {
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
    .set({ candidate: false, userConfirmed: true, updatedAt: now })
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

export async function listMemories(
  executor: ApiTransaction,
  scope: MemoryScope,
  input: { kind?: MemoryItemV1["kind"]; includeCandidates?: boolean },
): Promise<MemoryItemV1[]> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
      input.kind ? eq(assistantMemoryItems.kind, input.kind) : undefined,
      input.includeCandidates ? undefined : eq(assistantMemoryItems.candidate, false),
    ))
    .orderBy(assistantMemoryItems.updatedAt)
    // 轻微·15（round-4）：无分页无上限 → 接 GET /companion/memory 无界响应体。
    // 加防御性上限（默认 200，覆盖常规用户 memory 量；超出按 updatedAt 序截断最旧）。
    .limit(MEMORY_LIST_LIMIT);
  return rows.map(toContract);
}

/** 单条记忆读取（含 deleted；§18 工具网关 revision CAS 用）。 */
export async function getMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
): Promise<MemoryItemV1 | null> {
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
