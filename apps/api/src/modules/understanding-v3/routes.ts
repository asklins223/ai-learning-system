/**
 * Plan 23 TP-08：Understanding Topology V3 routes。
 *
 * GET /v3/understanding/topology —— V3 snapshot（ETag / If-None-Match → 304）
 */
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { buildTopologySnapshotV3Cached, readTopologySnapshotCache } from "./topology-repository.ts";

export async function understandingTopologyV3Routes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v3/understanding/topology", async (req, reply) => {
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    // AI-perf #4（2026-09-15 审计）：先查 TTL 缓存——命中时**完全不开启事务**，
    // 于是 304 路径零 DB 成本。此前每次请求都重建整份快照（15 个串行 await /
    // 16 条语句 / 无 LIMIT 全量读）之后才比较 If-None-Match，ETag 协商只省带宽、
    // 省不下 DB。缓存语义与陈旧上界见 topology-repository.ts 的 TTL 说明。
    const cached = readTopologySnapshotCache(ctx);
    const snapshot = cached ?? await withWorkspaceTransaction(ctx, (tx) =>
      buildTopologySnapshotV3Cached(tx, ctx),
    );
    const etag = '"' + snapshot.topologyRevision + '"';
    if (req.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }
    reply.header("etag", etag);
    // no-cache（而非 no-store）：每次协商，304 可达；topologyRevision 是
    // 确定性内容哈希（见 topology-repository.ts），内容不变时返回 304。
    // 与 learning-dashboard/routes.ts 同一策略；缺此头时协商缓存依赖
    // 客户端启发式刷新，304 不可靠。
    reply.header("cache-control", "private, no-cache");
    return snapshot;
  });
}
