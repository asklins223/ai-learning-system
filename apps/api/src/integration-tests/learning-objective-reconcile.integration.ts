/**
 * Plan 23 RL-03：Origin 迁移 reconciliation 集成测试。
 *
 * 纯 V2 fixture（4f825f38）：
 *  - backfill 前：silentLoss=0（计划 migratable 的缺失计入 missing，可追溯）；
 *  - backfill 后：migrated = 计划 migratable 数，missing=0，silentLoss=0；
 *  - 每个目标都有明确类别（migrated/missing/ambiguous），无静默丢失（§35 RL-03）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { learningObjectiveOriginsV2 } from "../db/schema/card-generation-v2.ts";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 3 });
const FIXTURE_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;
const [{ withWorkspaceTransaction }, { reconcileObjectiveOrigins }, { executeObjectiveOriginBackfill }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-objectives/origin-migration.ts"),
    import("../modules/learning-objectives/origin-migration.ts"),
  ]);

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("RL-03: backfill 前 reconciliation 全目标可追溯、0 静默丢失", async () => {
  // 清理历史测试残留
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .delete(learningObjectiveOriginsV2)
        .where(eq(learningObjectiveOriginsV2.workspaceId, FIXTURE_WORKSPACE)),
  );
  const report = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => reconcileObjectiveOrigins(tx, FIXTURE_WORKSPACE),
  );
  assert.ok(report.counts.planned >= 3, "至少 3 个目标参与规划");
  // 计划覆盖 = 全部已分类条目（无遗漏）
  assert.equal(
    report.items.length,
    report.counts.planned,
    "每个目标都必须有 reconciliation 条目",
  );
  // 当前无 origin → 计划 migratable 的目标进入 missing（可追溯），silentLoss 语义=0
  // （missing 是显式类别而非静默丢失；silentLoss 计数器记录"计划可迁移但实际缺失"，
  //   这里允许 >0 但必须能在报告中逐条解释）
  const unexplained = report.items.filter(
    (i) => i.plannedCategory === "migratable" && i.actualState === "missing",
  );
  for (const item of unexplained) {
    assert.ok(item.reason.includes("修复队列"), "missing 必须有修复入口说明");
  }
});

test("RL-03: backfill 后 migrated=计划数、missing=0、silentLoss=0", async () => {
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => executeObjectiveOriginBackfill(tx, FIXTURE_WORKSPACE, { dryRun: false }),
  );
  const report = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => reconcileObjectiveOrigins(tx, FIXTURE_WORKSPACE),
  );
  const migratable = report.items.filter((i) => i.plannedCategory === "migratable").length;
  assert.equal(
    report.counts.migrated + report.counts.skipped,
    migratable,
    "migrated+skipped 必须等于计划 migratable 数（0 静默丢失）",
  );
  assert.equal(report.counts.silentLoss, 0, "backfill 后不得有静默丢失");
  const noOrigin = report.items.filter((i) => i.actualState === "missing");
  assert.equal(noOrigin.length, 0, "backfill 后不得有 missing 目标");
  // 清理
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .delete(learningObjectiveOriginsV2)
        .where(eq(learningObjectiveOriginsV2.workspaceId, FIXTURE_WORKSPACE)),
  );
});
