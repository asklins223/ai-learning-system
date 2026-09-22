import type { FastifyInstance } from "fastify";
import { allWorkspacesStatsOverviewSchema } from "@ailearn/shared";
import { requireSession } from "../identity/middleware.ts";
import { getAllWorkspacesStatsOverview, getStatsOverview } from "./service.ts";

/**
 * 统计路由。
 *
 * 两条路的分工（这是这次改动的全部要点）：
 * - `GET /stats/overview`     —— **当前空间**的数字，形状不变（桌面端在读它）。
 *   界面上它必须带"当前空间"这层限定，不能再冒充"我的"。
 * - `GET /stats/overview/all` —— **我**在每个活跃空间里的同一份数字 + 合计。
 *
 * 命名理由：`/stats/overview/all` 是同一份资源（overview）的"全空间"读法，
 * 直接长在既有前缀下，客户端看 `/stats/overview*` 就知道两条路是一家人；
 * 换成像 `/stats/all-workspaces` 那样另起一个名词，会让"这两个数是不是同一
 * 口径"变成需要读文档才知道的事。Fastify 的静态路由让 `overview` 与
 * `overview/all` 各自精确匹配，不存在抢路由。
 */
export async function statsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/stats/overview", async (req) => {
    // R-006: 按 userId 隔离，成员只能看到自己的验证和复习统计
    const overview = await getStatsOverview(req.session.workspaceId, req.session.userId);
    return overview;
  });

  app.get("/stats/overview/all", async (req) => {
    const overview = await getAllWorkspacesStatsOverview(req.session.userId, req.session.workspaceId);
    // 与邻近路由同一套做法：出口过一遍合同，形状漂移在服务端就炸掉，
    // 而不是让桌面端拿到一份解析不了的 body 再报"unsupported_contract"。
    return allWorkspacesStatsOverviewSchema.parse(overview);
  });
}
