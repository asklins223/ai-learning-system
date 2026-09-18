import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { getTodayActivity } from "./service.ts";

const DAY_WINDOW_MAX_MS = 62 * 60 * 60 * 1000;

/**
 * 「今日学习」操作日志（页 14 重构）。只读投影：不写任何表。
 * 窗口由客户端本地日历日决定；非法或超宽（>62h）的窗口直接 400。
 */
export async function activityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/activity/today", async (req, reply) => {
    const query = req.query as { from?: string; to?: string };
    let window: { from: string; to: string } | undefined;
    if (query.from !== undefined || query.to !== undefined) {
      const from = new Date(query.from ?? "");
      const to = new Date(query.to ?? "");
      if (
        query.from === undefined || query.to === undefined
        || Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())
        || to.valueOf() - from.valueOf() <= 0
        || to.valueOf() - from.valueOf() > DAY_WINDOW_MAX_MS
      ) {
        return reply.code(400).send({ error: "activity_window_invalid" });
      }
      window = { from: from.toISOString(), to: to.toISOString() };
    }

    const activity = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      async (tx) => getTodayActivity(tx, { workspaceId: req.session.workspaceId, userId: req.session.userId }, window),
    );
    return activity;
  });
}
