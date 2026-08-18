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
import { and, eq, sql } from "drizzle-orm";
import { findPrivatePayloadLeaks } from "@ailearn/shared";
import { learningObjectivesV2 } from "../db/schema/card-generation-v2.ts";

const PURE_V2_WORKSPACE = "4f825f38-1a65-492a-8dec-c82868e6ea0f";
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
const [{ withWorkspaceTransaction }, { buildLearningDashboardV2 }, { listObjectiveSurfacesV3 }, { buildTopologySnapshotV3 }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-dashboard/service.ts"),
    import("../modules/learning-objectives/surface-service.ts"),
    import("../modules/understanding-v3/topology-repository.ts"),
  ]);

after(async () => {
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("RL-01: Home/Cards/Graph 的 active Objective 数量完全一致", async () => {
  const ctx = { workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER };
  const [dashboard, listPage, topology, objectiveCount] = await withWorkspaceTransaction(
    ctx,
    async (tx) => {
      const [d, l, t] = await Promise.all([
        buildLearningDashboardV2(tx, ctx),
        listObjectiveSurfacesV3(tx, ctx, { limit: 100 }),
        buildTopologySnapshotV3(tx, ctx),
      ]);
      const countRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, PURE_V2_WORKSPACE),
          eq(learningObjectivesV2.lifecycle, "active"),
        ));
      return [d, l, t, Number(countRows[0].n)] as const;
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

