/**
 * Plan 23 RL-01/RL-02：Cross-surface identity & count parity 集成测试。
 *
 * §25.3 同一 fixture 断言：
 *   Dashboard.activeObjectives
 *   = Objective list total
 *   = Topology objective node 数
 *   = learning_objectives_v2 active 计数
 *   = 详情可读（每个 objectiveId 都能装配 Surface）
 *
 * 隐藏 alias 永不进入正式计数（legacy active 卡不参与以上任何查询；§2.5/§21.5）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { findPrivatePayloadLeaks } from "@ailearn/shared";
import { learningObjectivesV2 } from "../db/schema/card-generation-v2.ts";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 3 });
const PURE_V2_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;
const [{ withWorkspaceTransaction }, { buildLearningDashboardV2 }, { listObjectiveSurfacesV3 }, { buildTopologySnapshotV3 }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-dashboard/service.ts"),
    import("../modules/learning-objectives/surface-service.ts"),
    import("../modules/understanding-v3/topology-repository.ts"),
  ]);

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("RL-01: Home/Cards/Graph 的 active Objective 数量完全一致", async () => {
  const ctx = { workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER };
  const [dashboard, listPage, topology, objectiveCount] = await withWorkspaceTransaction(
    ctx,
    async (tx) => {
      // 注意：postgres.js 的事务连接不允许多条查询流并发交错（会导致
      // drizzle 构建器状态损坏 → orderSelectedFields 无限递归），必须顺序执行。
      const d = await buildLearningDashboardV2(tx, ctx);
      const l = await listObjectiveSurfacesV3(tx, ctx, { limit: 100 });
      const t = await buildTopologySnapshotV3(tx, ctx);
      // 独立对账计数：走 postgres-js 客户端而非本文件的 drizzle `sql` 标签
      // （tsx 模块图下该文件静态解析到的 drizzle 实例与 db/client 的不一致，
      // 其 SQL 对象传入事务会触发 getSQL 缺失/orderSelectedFields 无限递归，
      // 2026-08-23 审查；服务内部与同文件普通列查询不受影响）。
      const cntRows = await pgSql`
        SELECT count(*)::int AS n FROM learning_objectives_v2
        WHERE workspace_id = ${PURE_V2_WORKSPACE} AND lifecycle = 'active'
      `;
      const objectiveCountN = Number(cntRows[0]?.n ?? 0);
      return [d, l, t, objectiveCountN] as const;
    },
  );

  const dashboardCount = dashboard.counts.activeObjectives;
  const listTotal = listPage.total;
  // Graph 含 archived/superseded 历史节点（§36.5 可选历史层）——parity 只对账 active
  const graphActiveNodes = topology.nodes.filter(
    (n) =>
      n.nodeRef.kind === "objective" &&
      (n as { lifecycle?: string }).lifecycle === "active",
  ).length;
  assert.equal(
    dashboardCount,
    listTotal,
    "Dashboard.activeObjectives 必须等于 Cards list total",
  );
  assert.equal(listTotal, graphActiveNodes, "Cards list total 必须等于 Graph active objective 节点数");
  assert.equal(graphActiveNodes, objectiveCount, "Graph active 节点数必须等于 objectives 表 active 计数");
  assert.ok(dashboardCount >= 3, "纯 V2 fixture 至少有 3 个 active Objective");
});

test("RL-01: 每个 active Objective 都能装配可行动、无泄漏 Surface", async () => {
  const ctx = { workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER };
  const { assembleObjectiveSurfaceV3 } = await import("../modules/learning-objectives/surface-service.ts");
  await withWorkspaceTransaction(ctx, async (tx) => {
    const rows = await tx
      .select({ objectiveId: learningObjectivesV2.objectiveId })
      .from(learningObjectivesV2)
      .where(and(
        eq(learningObjectivesV2.workspaceId, PURE_V2_WORKSPACE),
        eq(learningObjectivesV2.lifecycle, "active"),
      ));
    for (const row of rows) {
      const surface = await assembleObjectiveSurfaceV3(tx, ctx, row.objectiveId);
      assert.equal(surface.objectiveId, row.objectiveId, "Surface objectiveId 必须与 inventory 一致");
      assert.ok(
        surface.primaryAction.kind === "create_run" || surface.primaryAction.kind === "resume_run" || surface.primaryAction.kind === "refresh",
        "active Objective 主行动必须可执行，实际 " + surface.primaryAction.kind,
      );
      assert.deepEqual(findPrivatePayloadLeaks(surface), [], "Surface 不得泄漏私有载荷");
    }
  });
});

