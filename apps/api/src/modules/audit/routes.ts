import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { parseQuery } from "../../lib/pagination.ts";
import { listWorkspaceAudit } from "./service.ts";

/**
 * 高危动作审计的读接口（2026-09-20 多空间审查附录 C）。
 *
 * 只有 owner 读得到：审计行里是"谁做了什么"，member 没有立场看别人的动作——
 * 与 `ai_audit_log` 的 `api_owner_read` 同一判据，数据库层的策略也这么收（0263）。
 *
 * 写入没有对应的 HTTP 接口：审计由动作本身在同一事务里写（导出、物理删除），
 * 客户端不该有"补一条审计"的能力。
 */
export async function auditRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  const auditQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    /** 按动作名过滤，例如 `export.workspace`。 */
    action: z.string().trim().min(1).max(120).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    /** `createdAt|id` 复合游标，由上一页的 nextCursor 原样带回。 */
    cursor: z.string().trim().min(1).max(120).optional(),
  });

  app.get(
    "/workspace/audit-log",
    { preHandler: [requireOwner] },
    async (req) => {
      const q = parseQuery(app, auditQuerySchema, req.query);
      return withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        async (tx) => {
          const cursor = q.cursor ? parseCursor(q.cursor) : null;
          return listWorkspaceAudit(tx, {
            workspaceId: req.session.workspaceId,
            limit: q.limit,
            action: q.action,
            since: q.since ? new Date(q.since) : undefined,
            until: q.until ? new Date(q.until) : undefined,
            cursor,
          });
        },
      );
    },
  );
}

/**
 * 游标格式 `<iso>|<uuid>`。
 *
 * 解不开时**不报错**，退回第一页：游标是客户端原样带回来的不透明串，一个被截断的
 * 值不该让审计页整页 500——那恰好是最需要它可读的时刻。形状不对就当没给。
 */
function parseCursor(raw: string): { createdAt: Date; id: string } | null {
  const [iso, id] = raw.split("|");
  if (!iso || !id) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { createdAt, id };
}
