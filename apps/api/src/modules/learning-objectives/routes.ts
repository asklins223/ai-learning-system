/**
 * Plan 23 W2-21/W2-22/W2-23：LearningObjective V3 API。
 *
 * GET /v2/learning-objectives              —— 列表（cursor/lifecycle filter）
 * GET /v2/learning-objectives/:objectiveId —— Surface 详情
 *
 * 全部 requireSession；读取包在 withWorkspaceTransaction（RLS FORCE）。
 * 404 语义：找不到 objective → 404 objective_not_found。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  assembleObjectiveSurfaceV3,
  listObjectiveSurfacesV3,
  toObjectiveListItemV3,
  ObjectiveNotFoundError,
} from "./surface-service.ts";
import { readObjectiveHistoryV3 } from "./history-route-service.ts";

/**
 * 2026-09 后端审查修复：`?limit=abc` 此前经 Number() 变成 NaN，下游
 * Math.min(Math.max(NaN,1),100) 仍是 NaN，drizzle 对非数值 limit 不渲染 LIMIT
 * → 全 workspace 扫描，且 rows.slice(0, NaN) = [] 返回一个「成功但永远翻不动」
 * 的空页；`?cursor=abc` 则直达 int4 转换报错 22P02 → 500。
 * 统一用 zod 校验，非法输入 400；clamp 作为纵深防御保留在 service 内。
 */
const listQuerySchema = z.object({
  lifecycle: z.enum(["active", "archived", "superseded"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
});

interface Params {
  objectiveId: string;
}

export async function learningObjectiveRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v2/learning-objectives", async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", message: "查询参数非法" });
    }
    const query = parsed.data;
    const lifecycle = query.lifecycle;
    return withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      async (tx) => {
        const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
        const page = await listObjectiveSurfacesV3(tx, ctx, {
          lifecycle,
          cursor: query.cursor,
          limit: query.limit ?? 20,
        });
        return {
          version: 3,
          items: page.items.map(toObjectiveListItemV3),
          total: page.total,
          nextCursor: page.nextCursor,
          snapshotAt: new Date().toISOString(),
        };
      },
    );
  });

  app.get("/v2/learning-objectives/:objectiveId", async (req, reply) => {
    const { objectiveId } = req.params as Params;
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    try {
      return await withWorkspaceTransaction(ctx, (tx) =>
        assembleObjectiveSurfaceV3(tx, ctx, objectiveId),
      );
    } catch (err) {
      if (err instanceof ObjectiveNotFoundError) {
        return reply.code(404).send({ error: "objective_not_found", objectiveId });
      }
      throw err;
    }
  });

  // W2-23：目标历史（公开摘要；无 private assessment）
  app.get("/v2/learning-objectives/:objectiveId/history", async (req, reply) => {
    const { objectiveId } = req.params as Params;
    const parsed = historyQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", message: "查询参数非法" });
    }
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    return withWorkspaceTransaction(ctx, (tx) =>
      readObjectiveHistoryV3(tx, ctx.workspaceId, objectiveId, {
        limit: parsed.data.limit ?? 20,
        cursor: parsed.data.cursor,
      }),
    );
  });
}
