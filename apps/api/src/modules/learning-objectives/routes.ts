/**
 * Plan 23 W2-21/W2-22/W2-23：LearningObjective V3 API。
 *
 * GET /v2/learning-objectives              —— 列表（cursor/lifecycle filter）
 * GET /v2/learning-objectives/:objectiveId —— Surface 详情
 *
 * 全部 requireSession；读取包在 withWorkspaceTransaction（RLS FORCE）。
 * 404/410 语义：找不到 objective → 404 objective_not_found（不返回模糊 V2 404，
 * §21.4 的 route resolver 负责旧 URL 的确定性迁移）。
 */
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  assembleObjectiveSurfaceV3,
  listObjectiveSurfacesV3,
  toObjectiveListItemV3,
  ObjectiveNotFoundError,
} from "./surface-service.ts";
import {
  readObjectiveHistoryV3,
  resolveLegacyRouteV3,
} from "./history-route-service.ts";

interface ListQuery {
  lifecycle?: string;
  cursor?: string;
  limit?: string;
}

interface Params {
  objectiveId: string;
}

export async function learningObjectiveRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v2/learning-objectives", async (req) => {
    const query = req.query as ListQuery;
    const lifecycle =
      query.lifecycle === "active" || query.lifecycle === "archived" || query.lifecycle === "superseded"
        ? query.lifecycle
        : undefined;
    return withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      async (tx) => {
        const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
        const page = await listObjectiveSurfacesV3(tx, ctx, {
          lifecycle,
          cursor: query.cursor,
          limit: Number(query.limit ?? 20),
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
  app.get("/v2/learning-objectives/:objectiveId/history", async (req) => {
    const { objectiveId } = req.params as Params;
    const query = req.query as { limit?: string; cursor?: string };
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    return withWorkspaceTransaction(ctx, (tx) =>
      readObjectiveHistoryV3(tx, ctx.workspaceId, objectiveId, {
        limit: Number(query.limit ?? 20),
        cursor: query.cursor ? Number(query.cursor) : undefined,
      }),
    );
  });

  // W2-24：旧 URL 确定性解析（mapped/gone/ambiguous/forbidden；不返回模糊 404）
  app.get("/v2/route-resolution", async (req) => {
    const query = req.query as { legacyKind?: string; legacyId?: string };
    if (query.legacyKind !== "card" && query.legacyKind !== "key_point") {
      return { error: "invalid_legacy_kind" };
    }
    const legacyId = query.legacyId;
    if (!legacyId) {
      return { error: "missing_legacy_id" };
    }
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    return withWorkspaceTransaction(ctx, (tx) =>
      resolveLegacyRouteV3(tx, ctx.workspaceId, {
        legacyKind: query.legacyKind as "card" | "key_point",
        legacyId,
      }),
    );
  });
}
