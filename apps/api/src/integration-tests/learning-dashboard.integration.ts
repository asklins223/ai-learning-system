/**
 * Plan 23 W3-07：Dashboard 集成测试（真实 Postgres）。
 *
 * 纯 V2 fixture 工作区（4f825f38）：
 *  - 首页非空、不进入 first_use（§25.5 关键断言）；
 *  - counts 全部按 Objective 口径且与 mode 一致；
 *  - primaryFocus 存在且 action 可执行；无私有泄漏。
 * notes-only 工作区（00b679ca：1 note，无 Objective）：
 *  - mode = notes_without_objectives + suggestedNote 存在。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { findPrivatePayloadLeaks } from "@ailearn/shared";

const PURE_V2_WORKSPACE = "4f825f38-1a65-492a-8dec-c82868e6ea0f";
const NOTES_ONLY_WORKSPACE = "00b679ca-7508-49f7-a8c9-f7e86641039a";
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
const [{ withWorkspaceTransaction }, { buildLearningDashboardV2 }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-dashboard/service.ts"),
  ]);

after(async () => {
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("W3-07: 纯 V2 工作区首页非空、非 first_use、focus 可行动、无泄漏", async () => {
  const dashboard = await withWorkspaceTransaction(
    { workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER },
    (tx) => buildLearningDashboardV2(tx, { workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER }),
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
    { workspaceId: NOTES_ONLY_WORKSPACE, userId: SYSTEM_USER },
    (tx) => buildLearningDashboardV2(tx, { workspaceId: NOTES_ONLY_WORKSPACE, userId: SYSTEM_USER }),
  );
  assert.equal(dashboard.mode, "notes_without_objectives");
  assert.ok(dashboard.suggestedNote !== null, "suggestedNote 必须存在");
  assert.ok(dashboard.suggestedNote!.title.length > 0);
  assert.deepEqual(dashboard.suggestedNote!.reasonCodes, ["notes_without_objectives"]);
  assert.equal(dashboard.primaryFocus, null);
});
