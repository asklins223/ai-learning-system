import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { detectSearchDrift, reindexWorkspaceSearch, search, autoFixSearchDrift } from "./service.ts";
import { parseQuery } from "../../lib/pagination.ts";

const searchQuerySchema = z.object({
  q: z.string().optional(),
  // Plan 23 CS-03：objective 类型（conceptLabel/说明/来源可搜；answer/rubric 不进索引）
  // V1 枚举值 card_set/card/evidence 已退役，不再作为合法搜索类型。
  type: z.enum(["note", "source", "objective"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  // PERF: 深度 OFFSET 在 DISTINCT ON + ILIKE 上会退化为深扫描。把翻页上限
  // 从 100k 大幅降到 1000（50 条/页 × 20 页），超过即终止翻页并返回 nextCursor=null，
  // 防止单次请求把整个匹配集做 DISTINCT ON 后深 OFFSET。
  offset: z.coerce.number().int().min(0).max(1000).optional(),
});

export async function searchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // GET /search?q=...&type=...&limit=...&offset=...
  // R-022: 统一 Zod 校验
  app.get("/search", async (req) => {
    const q = parseQuery(app, searchQuerySchema, req.query);
    const normalizedQuery = q.q?.trim();
    return withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      async (transaction) => {
        if (!normalizedQuery) return { items: [], total: 0, nextCursor: null };
        return search(transaction, req.session.workspaceId, normalizedQuery, {
          type: q.type,
          limit: q.limit,
          offset: q.offset,
        });
      },
    );
  });

  // GET /search/drift — F-025: 检测搜索索引与业务表的漂移
  // 返回幽灵文档、缺失文档和过期标题，供前端展示和触发 reindex 补偿
  app.get("/search/drift", { preHandler: [requireOwner] }, async (req) => {
    return withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => detectSearchDrift(transaction, req.session.workspaceId),
    );
  });

  // POST /search/reindex — 重建当前 workspace 的 search_documents 派生表
  // F-011: 重建索引是管理操作，仅 owner 可执行
  // F-025: 作为补偿机制，修复漂移检测发现的不一致
  app.post("/search/reindex", { preHandler: [requireOwner] }, async (req) => {
    return withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => reindexWorkspaceSearch(transaction, req.session.workspaceId),
    );
  });

  // POST /search/auto-fix — ARCH-01 修复：自动检测并修复搜索索引漂移
  // 检测漂移量，超过阈值时自动触发 reindex。可由定时任务或手动调用。
  app.post("/search/auto-fix", { preHandler: [requireOwner] }, async (req) => {
    return withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => autoFixSearchDrift(transaction, req.session.workspaceId),
    );
  });
}
