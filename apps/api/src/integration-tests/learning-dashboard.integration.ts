/**
 * Plan 23 W3-07：Dashboard 集成测试（真实 Postgres）。
 *
 * 自播种纯 V2 工作区（2026-08-23 起，替代被 0176 清库抹掉的手工工作区
 * 4f825f38-…）：首页非空、不进入 first_use（§25.5 关键断言）、counts 全部
 * 按 Objective 口径且与 mode 一致、primaryFocus 存在且 action 可执行、无私有泄漏。
 * 自播种 notes-only 工作区：mode = notes_without_objectives + suggestedNote 存在。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { findPrivatePayloadLeaks } from "@ailearn/shared";
import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [{ withWorkspaceTransaction }, { buildLearningDashboardV2 }, { seedPureV2Workspace, seedNotesOnlyWorkspace }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-dashboard/service.ts"),
    import("./helpers/pure-v2-workspace-fixture.ts"),
  ]);

const pureV2 = await seedPureV2Workspace(sql, { objectiveCount: 3 });
const notesOnly = await seedNotesOnlyWorkspace(sql, { noteCount: 1 });

after(async () => {
  await pureV2.cleanup();
  await notesOnly.cleanup();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
  await sql.end({ timeout: 2 });
});

test("W3-07: 纯 V2 工作区首页非空、非 first_use、focus 可行动、无泄漏", async () => {
  const dashboard = await withWorkspaceTransaction(
    { workspaceId: pureV2.workspaceId, userId: pureV2.userId },
    (tx) => buildLearningDashboardV2(tx, { workspaceId: pureV2.workspaceId, userId: pureV2.userId }),
  );
  assert.equal(dashboard.version, 2);
  assert.ok(dashboard.counts.activeObjectives >= 3, "activeObjectives >= 3");
  assert.notEqual(dashboard.mode, "first_use", "纯 V2 工作区不得进入 first_use");
  assert.ok(
    dashboard.mode === "objectives_ready" ||
      dashboard.mode === "run_in_progress" ||
      dashboard.mode === "review_due" ||
      dashboard.mode === "degraded",
    "mode 必须为 Objective 相关模式，实际 " + dashboard.mode,
  );
  assert.ok(dashboard.primaryFocus !== null, "primaryFocus 必须存在");
  const action = dashboard.primaryFocus!.action.kind;
  assert.ok(
    action === "resume_run" || action === "create_run" || action === "create_review_run",
    "primaryFocus action 必须可执行，实际 " + action,
  );
  assert.ok(dashboard.primaryFocus!.reasonCodes.length >= 1);
  assert.deepEqual(findPrivatePayloadLeaks(dashboard), []);
  const serialized = JSON.stringify(dashboard);
  assert.ok(!serialized.includes("canonicalAnswer"));
  assert.ok(!serialized.includes("scoringRubric"));
  // 数量对账：recent 不重复展示 primary item
  const recentIds = dashboard.recentObjectives.map((o) => o.objectiveId);
  if (dashboard.primaryFocus) {
    assert.ok(!recentIds.includes(dashboard.primaryFocus.objective.objectiveId), "recent 不得重复展示 primary");
  }
});

test("W3-07: notes-only 工作区 → notes_without_objectives + suggestedNote", async () => {
  const dashboard = await withWorkspaceTransaction(
    { workspaceId: notesOnly.workspaceId, userId: notesOnly.userId },
    (tx) => buildLearningDashboardV2(tx, { workspaceId: notesOnly.workspaceId, userId: notesOnly.userId }),
  );
  assert.equal(dashboard.mode, "notes_without_objectives");
  assert.ok(dashboard.suggestedNote !== null, "suggestedNote 必须存在");
  assert.ok(dashboard.suggestedNote!.title.length > 0);
  assert.deepEqual(dashboard.suggestedNote!.reasonCodes, ["notes_without_objectives"]);
  assert.equal(dashboard.primaryFocus, null);
});
