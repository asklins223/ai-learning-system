/**
 * Plan 23 TP-08：Understanding Topology V3 routes。
 *
 * GET /v3/understanding/topology —— V3 snapshot（ETag / If-None-Match → 304）
 * GET /v3/understanding/topology/deltas/:changeSetId —— 预留（当前 501，
 *   由 W4 后续 change set 物化后实现；显式失败不伪装空结果）
 */
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { buildTopologySnapshotV3 } from "./topology-repository.ts";

export async function understandingTopologyV3Routes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v3/understanding/topology", async (req, reply) => {
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    const snapshot = await withWorkspaceTransaction(ctx, (tx) =>
      buildTopologySnapshotV3(tx, ctx),
    );
    const etag = '"' + snapshot.topologyRevision + '"';
    if (req.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }
    reply.header("etag", etag);
    return snapshot;
  });

  app.get("/v3/understanding/topology/deltas/:changeSetId", async (_req, reply) => {
    return reply.code(501).send({
      error: "change_set_deltas_not_implemented",
      note: "W4 后续：基于 change set 物化的增量拓扑（不伪造空结果）",
    });
  });
}
