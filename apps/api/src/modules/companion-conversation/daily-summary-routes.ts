/**
 * 桌宠日记只读 API（22-real-desktop-pet-memory-context-prd-tdd.md §15.3）。
 *
 * GET /companion/daily?date=YYYY-MM-DD
 * - 只读，不触发生成；
 * - date 缺省返回最近一次已生成日记；
 * - status = generated | not_generated | failed；
 * - 未来日期返回 not_generated，不报错。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { companionDailySummaries } from "../../db/schema/companion-memory.ts";

function isDailySummaryEnabled(): boolean {
  return process.env.COMPANION_DAILY_SUMMARY_V1 === "true"
    || process.env.COMPANION_JOURNEY_V2 === "true";
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function dailySummaryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!isDailySummaryEnabled()) {
      void req;
      return reply.code(404).send({
        error: "companion_daily_summary_disabled",
        message: "桌宠日记当前未开放",
      });
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/daily",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const rawDate = req.query?.date;
      const parsed = rawDate === undefined ? null : dateSchema.safeParse(rawDate);
      if (rawDate !== undefined && !parsed?.success) {
        throw app.httpErrors.badRequest("date 非法，应为 YYYY-MM-DD");
      }
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const result = await withWorkspaceTransaction(scope, async (tx) => {
        const conditions = [
          eq(companionDailySummaries.workspaceId, scope.workspaceId),
          eq(companionDailySummaries.userId, scope.userId),
        ];
        if (parsed?.success) {
          conditions.push(eq(companionDailySummaries.date, parsed.data));
        }
        const rows = await tx
          .select()
          .from(companionDailySummaries)
          .where(and(...conditions))
          .orderBy(desc(companionDailySummaries.date))
          .limit(1);
        return rows[0] ?? null;
      });

      if (!result) {
        return reply.header("Cache-Control", "no-store").send({
          version: 1,
          date: parsed?.success ? parsed.data : null,
          status: "not_generated",
          generatedAt: null,
          summary: "",
          facts: {},
          conversationHighlights: [],
          memory: null,
        });
      }

      // §15.3/§15.5：查找与该日记关联的候选记忆（source_event_id = daily-summary:<date>）。
      const memory = await withWorkspaceTransaction(scope, async (tx) => {
        const sourceEventId = `daily-summary:${result.date}`;
        const rows = await tx.execute<{ id: string; candidate: boolean }>(sql`
          SELECT id, candidate FROM assistant_memory_items
          WHERE workspace_id = ${scope.workspaceId}
            AND user_id = ${scope.userId}
            AND source_event_id = ${sourceEventId}
            AND deleted_at IS NULL
          LIMIT 1
        `);
        const row = (Array.isArray(rows) ? rows : [])[0];
        return row ? { memoryItemId: row.id, candidate: row.candidate } : null;
      });

      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        date: result.date,
        status: result.status,
        generatedAt: result.generatedAt.toISOString(),
        summary: result.summary,
        facts: result.facts,
        conversationHighlights: result.highlights,
        memory,
      });
    },
  );
}
