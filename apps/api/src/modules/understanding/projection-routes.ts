/**
 * Understanding Projection V2 / RoutePlan / Delta API（文档 16 §15）。
 *
 * GET  /understanding/projection        checkpoint-aware（ETag）；minimumCheckpoint
 *                                       不可满足 → 202；lens=current_target。
 * POST /understanding/routes/plan       确定性选路；过期/作用域不符 → 409。
 * GET  /understanding/routes/:id        已签发 RoutePlan 只读（每次重验权限）。
 * GET  /understanding/projection/deltas/:changeSetId  一次性显影（no-store）。
 *
 * 全部 requireSession + RLS；响应不含 private solution/evidence 正文。
 *
 * V2 迁移：V1 learningCards/cardKeyPoints 已删除；本模块以 V2 的
 * learning_objectives_v2（objectiveId 作为外部 keyPointId）与
 * learning_cards_v2（cardId 作为外部 cardId）为数据源。key_point 语义单元
 * 即 V2 objective；evidence / prerequisite 数据源在 V2 无对应列，本模块不再
 * 发射 supports / prerequisite 边（edge kind 助手仍保留，保持外部形状）。
 */

import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { understandingChangeSets } from "@ailearn/shared/db-schema/understanding-projection";
import { createUnderstandingRoutePlan } from "./route-plan-service.ts";
import { understandingRoutePlanRequestV1Schema } from "@ailearn/shared";
import { parseCheckpointToken, watermarkBehind } from "./projection-checkpoint.ts";
import {
  latestProjectionWatermark,
  loadUnderstandingProjection,
  type ProjectionReadOutcome,
} from "./projection-read-service.ts";

const projectionQuerySchema = z.object({
  lens: z.enum(["current_target", "evidence", "provenance", "issues"]).optional(),
  targetKeyPointId: z.string().uuid().optional(),
  routePlanId: z.string().uuid().optional(),
  minimumCheckpoint: z.string().min(1).optional(),
  continuation: z.string().min(1).optional(),
  // §15.2 shared 平面过滤（与 RoutePlan body 的 filter 语义一致）。
  sourceId: z.string().uuid().optional(),
  cardId: z.string().uuid().optional(),
  showArchived: z.coerce.boolean().optional(),
});

// §18 工具网关与 /understanding/routes/plan 共用同一请求合同（共享侧 canonical，
// 禁止本地再复制一份）：understandingRoutePlanRequestV1Schema。
const routePlanBodySchema = understandingRoutePlanRequestV1Schema;

/** ProjectionReadOutcome → HTTP：状态码/响应体/ETag 与迁移前的 handler 逐字一致。 */
function sendProjectionOutcome(reply: FastifyReply, outcome: ProjectionReadOutcome) {
  switch (outcome.status) {
    case "pending":
      return reply.code(202).send({ status: "pending" });
    case "bad_request":
      return reply.code(400).send({ error: "bad_request", message: outcome.message });
    case "route_plan_stale":
      return reply.code(409).send({ error: "route_plan_stale", message: outcome.message });
    case "not_modified":
      return reply.header("ETag", outcome.etag).code(304).send();
    case "ok":
      return reply.header("ETag", outcome.etag).send(outcome.body);
  }
}

export async function understandingProjectionRoutes(app: FastifyInstance) {
  const scopeOf = (req: { session: { workspaceId: string; userId: string } }) => ({
    workspaceId: req.session.workspaceId,
    userId: req.session.userId,
  });

  // GET /understanding/projection — checkpoint-aware personal projection。
  // 只保留 HTTP 关注点：query 校验 → minimumCheckpoint 202 → 投影事务内调用读取
  // 服务 → outcome 映射；业务/DB 逻辑见 projection-read-service.ts。
  app.get<{ Querystring: Record<string, unknown> }>(
    "/understanding/projection",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const query = projectionQuerySchema.safeParse(req.query ?? {});
      if (!query.success) {
        return reply.code(400).send({ error: "bad_request", message: "projection query 非法" });
      }
      const scope = scopeOf(req);

      // minimumCheckpoint 语义：checkpoint 已覆盖投影的最新 source event 才可
      // 返回；否则 202（不偷偷返回旧投影）。
      const minimum = query.data.minimumCheckpoint;
      if (minimum) {
        const watermark = parseCheckpointToken(minimum);
        if (!watermark || watermark.workspaceId !== scope.workspaceId || watermark.userId !== scope.userId) {
          return sendProjectionOutcome(reply, { status: "pending" });
        }
        // 新鲜度：minimum 的 watermark 必须不落后于当前最新 watermark。
        const latestWatermark = await latestProjectionWatermark(scope);
        if (watermarkBehind(watermark, latestWatermark)) {
          return sendProjectionOutcome(reply, { status: "pending" });
        }
      }

      return sendProjectionOutcome(
        reply,
        await withWorkspaceTransaction(scope, (tx) =>
          loadUnderstandingProjection(tx, scope, {
            ...query.data,
            minimumCheckpoint: minimum ?? null,
            ifNoneMatch: req.headers["if-none-match"],
          }),
        ),
      );
    },
  );

  // POST /understanding/routes/plan — 确定性选路。
  app.post("/understanding/routes/plan", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, routePlanBodySchema, req.body);
    const scope = scopeOf(req);
    try {
      const plan = await withWorkspaceTransaction(scope, (tx) =>
        createUnderstandingRoutePlan(tx, scope, body),
      );
      if (plan.status === "stale") {
        return reply.code(409).send({ error: "route_plan_stale", message: "图状态已变化，请重新聚焦" });
      }
      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        routePlanId: plan.routePlanId,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        revision: plan.revision,
        baseCheckpoint: plan.baseCheckpoint,
        targetKeyPointId: body.targetKeyPointId ?? "",
        expiresAt: plan.expiresAt,
        steps: plan.steps,
        sourceFactHashes: plan.sourceFactHashes,
      });
    } catch (err) {
      throw err;
    }
  });

  // GET /understanding/projection/deltas/:changeSetId — 一次性显影（no-store）。
  app.get<{ Params: { changeSetId: string } }>(
    "/understanding/projection/deltas/:changeSetId",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = scopeOf(req);
      const changeSetId = String(req.params.changeSetId ?? "").slice(0, 200);
      const result = await withWorkspaceTransaction(scope, async (tx) => {
        const rows = await tx
          .select()
          .from(understandingChangeSets)
          .where(and(
            eq(understandingChangeSets.changeSetId, changeSetId),
            eq(understandingChangeSets.workspaceId, scope.workspaceId),
            eq(understandingChangeSets.userId, scope.userId),
          ))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        return {
          version: 1,
          changeSetId: row.changeSetId,
          runId: row.runId,
          runBaselineCheckpoint: null,
          fromCheckpoint: { version: 1, workspaceId: scope.workspaceId, userId: scope.userId, token: row.fromCheckpointToken, capturedAt: row.createdAt.toISOString() },
          toCheckpoint: { version: 1, workspaceId: scope.workspaceId, userId: scope.userId, token: row.toCheckpointToken, capturedAt: row.createdAt.toISOString() },
          changedEdges: [],
          ...(row.kind === "canonical"
            ? {
                kind: "canonical",
                evidence: {
                  kind: "canonical",
                  commitId: "",
                  canonicalEventId: row.sourceEventId,
                  canonicalEventHash: "",
                  factKind: (row.changedNodes as Array<{ factKind?: string }>)[0]?.factKind ?? "initial_validation",
                  factId: "",
                  taskIds: (row.changedNodes as Array<{ taskIds?: string[] }>)[0]?.taskIds ?? [],
                  artifactIds: [],
                  assessmentRefs: [],
                },
                changedNodes: row.changedNodes,
                practiceTrailChanges: [],
              }
            : {
                kind: "practice_only",
                evidence: {
                  kind: "practice_only",
                  practiceEventId: row.sourceEventId,
                  practiceEventHash: "",
                  taskIds: [],
                  artifactIds: (row.practiceTrailChanges as Array<{ artifactIds?: string[] }>)[0]?.artifactIds ?? [],
                  reasons: ["practice_task"],
                },
                changedNodes: [],
                practiceTrailChanges: row.practiceTrailChanges,
              }),
        };
      });
      if (!result) {
        return reply.code(404).send({ error: "change_set_not_found", message: "显影记录不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );
}
