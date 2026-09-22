import { and, desc, eq, gte, lt, lte, or, type SQL } from "drizzle-orm";
import { workspaceAuditLog } from "@ailearn/shared/db-schema/identity";
import type { ApiTransaction } from "../../db/client.ts";

/**
 * 高危动作的审计留痕（2026-09-20 多空间审查附录 C）。
 *
 * 审查核实到的状态是**没有留痕**：`ai_audit_log` 记的是 AI 外发，`companion_audit`
 * 记的是伴星页面动作，于是"谁在什么时候把整个空间导出去了""谁物理删掉了哪篇笔记"
 * 在库里查不到答案。
 *
 * ─── 三条设计约束 ───
 *
 * 1. **必须与动作同事务**。写入点是调用方已经开着的那个 `tx`，不是异步队列、不是
 *    日志文件：动作回滚了却留下"他导出了"是假证据，动作成功而审计丢失是缺证据。
 *    所以这个函数收 `ApiTransaction` 而不是自己开事务。
 *
 * 2. **写入失败必须让动作失败**。审计写不进去（策略没配、列不存在）时不能静默吞掉
 *    继续导出——那正好制造"有动作、没记录"的状态。所以这里不 try/catch。
 *
 * 3. **不放敏感正文**。`detail` 只放计数、字节数、标题这类可审计但不泄密的字段。
 *    导出动作尤其要克制：审计表本身不该成为第二个导出渠道。
 */
export type WorkspaceAuditAction =
  | "export.workspace"
  | "export.note"
  | "note.permanent_delete"
  | "workspace.member_removed"
  | "workspace.ownership_transferred";

export interface WorkspaceAuditEntry {
  workspaceId: string;
  actorUserId: string;
  action: WorkspaceAuditAction;
  targetKind: string;
  targetId?: string | null;
  detail?: Record<string, unknown>;
}

export async function recordWorkspaceAudit(
  tx: ApiTransaction,
  entry: WorkspaceAuditEntry,
): Promise<void> {
  await tx.insert(workspaceAuditLog).values({
    workspaceId: entry.workspaceId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetKind: entry.targetKind,
    targetId: entry.targetId ?? null,
    detail: entry.detail ?? {},
  });
}

export interface WorkspaceAuditPage {
  items: Array<{
    id: string;
    action: string;
    actorUserId: string;
    targetKind: string;
    targetId: string | null;
    detail: Record<string, unknown>;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

/**
 * 读审计行（owner-only，路由层收口）。
 *
 * 分页用 `created_at DESC, id` 的复合游标：审计行会集中在同一毫秒（一次批量动作
 * 写多行），只按时间分页会漏行或重复。上限与其它列表一致地有界。
 */
export async function listWorkspaceAudit(
  tx: ApiTransaction,
  input: {
    workspaceId: string;
    limit?: number;
    action?: string;
    since?: Date;
    until?: Date;
    cursor?: { createdAt: Date; id: string } | null;
  },
): Promise<WorkspaceAuditPage> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const conditions: SQL[] = [eq(workspaceAuditLog.workspaceId, input.workspaceId)];
  if (input.action) conditions.push(eq(workspaceAuditLog.action, input.action));
  if (input.since) conditions.push(gte(workspaceAuditLog.createdAt, input.since));
  if (input.until) conditions.push(lte(workspaceAuditLog.createdAt, input.until));
  if (input.cursor) {
    // 复合游标必须**真的**用上第二段。审计行天然会挤在同一毫秒（一次批量动作写
    // 多行），只比 `created_at` 会把同毫秒里排在游标之后的那些行整批漏掉——
    // 一个"翻页会丢记录"的审计页比没有审计页更糟。
    const sameInstant = and(
      eq(workspaceAuditLog.createdAt, input.cursor.createdAt),
      lt(workspaceAuditLog.id, input.cursor.id),
    );
    conditions.push(
      or(lt(workspaceAuditLog.createdAt, input.cursor.createdAt), sameInstant) as SQL,
    );
  }

  const rows = await tx
    .select({
      id: workspaceAuditLog.id,
      action: workspaceAuditLog.action,
      actorUserId: workspaceAuditLog.actorUserId,
      targetKind: workspaceAuditLog.targetKind,
      targetId: workspaceAuditLog.targetId,
      detail: workspaceAuditLog.detail,
      createdAt: workspaceAuditLog.createdAt,
    })
    .from(workspaceAuditLog)
    .where(and(...conditions))
    .orderBy(desc(workspaceAuditLog.createdAt), desc(workspaceAuditLog.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      action: row.action,
      actorUserId: row.actorUserId,
      targetKind: row.targetKind,
      targetId: row.targetId,
      detail: (row.detail ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit && last
      ? `${last.createdAt.toISOString()}|${last.id}`
      : null,
  };
}
