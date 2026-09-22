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
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { companionDailySummaries } from "@ailearn/shared/db-schema/companion-memory";

function isDailySummaryEnabled(): boolean {
  // §15.3：该 flag 独立于 COMPANION_JOURNEY_V2，默认关闭，.env 显式开启。
  return process.env.COMPANION_DAILY_SUMMARY_V1 === "true";
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);

/**
 * 月历标记要的那个月的第一天/最后一天。
 *
 * 自己拼日期而不是 `date BETWEEN month || '-01' AND month || '-31'`：
 * 2 月没有 31 日，字符串区间会把别的月份漏进来或漏出去。
 */
function monthRange(month: string): { readonly from: string; readonly to: string } {
  const [year, number] = month.split("-").map(Number);
  const last = new Date(year, number, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export async function dailySummaryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    if (!isDailySummaryEnabled()) {
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
          failureReason: null,
          blocks: [],
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

      // 0252 之前的历史行只有 `summary`（`blocks='[]'`）。在这里投影成一个 text 块，
      // 而不是让渲染层为"旧日子没有块"写分支——用户裁定旧日子不重写，但它们照常显示。
      const storedBlocks = Array.isArray(result.blocks) ? result.blocks : [];
      const blocks = storedBlocks.length > 0
        ? storedBlocks
        : result.summary ? [{ type: "text", text: result.summary }] : [];

      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        date: result.date,
        status: result.status,
        generatedAt: result.generatedAt.toISOString(),
        failureReason: result.failureReason,
        blocks,
        memory,
      });
    },
  );

  /**
   * 月历标记：这个月里她写过（或试过）哪几天。
   *
   * 表上没有 (workspace, user, date) 的唯一约束，重跑一天可以留下两行，所以这里
   * 按天聚合：**只要有一天写成过，那一天就是写过**，否则算她试过没写成。
   * 没写的日子根本不出现在结果里——「缺席」不是这里的一种状态。
   */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/daily/month",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const parsed = monthSchema.safeParse(req.query?.month);
      if (!parsed.success) {
        throw app.httpErrors.badRequest("month 非法，应为 YYYY-MM");
      }
      const { from, to } = monthRange(parsed.data);
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const rows = await withWorkspaceTransaction(scope, async (tx) => tx
        .select({
          date: companionDailySummaries.date,
          written: sql<boolean>`bool_or(${companionDailySummaries.status} = 'generated')`,
        })
        .from(companionDailySummaries)
        .where(and(
          eq(companionDailySummaries.workspaceId, scope.workspaceId),
          eq(companionDailySummaries.userId, scope.userId),
          gte(companionDailySummaries.date, from),
          lte(companionDailySummaries.date, to),
        ))
        .groupBy(companionDailySummaries.date)
        .orderBy(companionDailySummaries.date));

      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        month: parsed.data,
        days: rows.map((row) => ({ date: row.date, status: row.written ? "generated" as const : "failed" as const })),
      });
    },
  );
}
