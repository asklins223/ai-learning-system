/**
 * Plan 23 W2-21/W2-22/W2-23：LearningObjective V3 API。
 *
 * GET /v2/learning-objectives              —— 列表（cursor/lifecycle filter）
 * GET /v2/learning-objectives/:objectiveId —— Surface 详情
 * POST /v2/learning-objectives/origins/backfill —— 补历史目标的来源绑定（owner）
 *
 * 全部 requireSession；读取包在 withWorkspaceTransaction（RLS FORCE）。
 * 404 语义：找不到 objective → 404 objective_not_found。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner, requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  assembleObjectiveSurfaceV3,
  listObjectiveSurfacesV3,
  toObjectiveListItemV3,
  ObjectiveNotFoundError,
} from "./surface-service.ts";
import { readObjectiveHistoryV3 } from "./history-route-service.ts";
import { executeObjectiveOriginBackfill } from "./origin-migration.ts";

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
  /** 只取这一篇笔记名下的目标（39d W4-2：笔记页要报"这一篇的主要动作"）。 */
  noteId: z.string().uuid().optional(),
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
          noteId: query.noteId,
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

  /**
   * 补历史目标的来源绑定（Plan 23 W2-05 的执行器，此前**只有测试在调**）。
   *
   * 为什么必须有这个入口：2026-09-22 查隔离判据时量到 dev 库 214 条 active 目标里
   * **171 条没有 `learning_objective_origins_v2` 行**，而它们 171/171 都有带
   * `note_version_id` 的卡。按天看不是坏数据：09-17 之后建的 66 条一条不缺，缺的全在
   * 09-15 及更早——是那条写入路径上线之前的存量。执行器（幂等、`ON CONFLICT DO NOTHING`、
   * 带审计 receipt）就是为这批写的，但没有任何生产调用方，所以这批永远躺着：
   * 用户在目标详情页看不到「来源笔记」那一格，`checkSourceOutdated` 也永远不会把它们
   * 判成「来源已过期」。按 AGENTS.md，没有调用方的链路不算交付完。
   *
   * 只给 owner：这一条写的是整个空间的谱系，不是某个人的草稿。回执里的
   * `missing` / `ambiguous` 就是"证明不了来源"的那部分，交给操作者看，不猜。
   */
  app.post(
    "/v2/learning-objectives/origins/backfill",
    { preHandler: [requireOwner] },
    async (req) =>
      withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        (tx) => executeObjectiveOriginBackfill(tx, req.session.workspaceId),
      ),
  );

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
