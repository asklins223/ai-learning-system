/**
 * Plan 23 W2-19/W2-23：Objective history reader 集成测试。
 *
 * 在纯 V2 fixture 工作区（4f825f38）验证：
 *  - history 返回公开摘要（revision>=1、无私有键泄漏）；
 *  - 返回公开摘要且不泄漏私有字段。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
import { findPrivatePayloadLeaks } from "@ailearn/shared";
import { learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";



if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 3 });
const FIXTURE_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;
const [{ withWorkspaceTransaction }, { readObjectiveHistoryV3 }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-objectives/history-route-service.ts"),
  ]);

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("W2-19: history 返回公开摘要且无私有键", async () => {
  const objectiveId = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      const rows = await tx
        .select({ objectiveId: learningObjectivesV2.objectiveId })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE),
          eq(learningObjectivesV2.lifecycle, "active"),
        ))
        .limit(1);
      return rows[0].objectiveId;
    },
  );
  const history = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => readObjectiveHistoryV3(tx, FIXTURE_WORKSPACE, objectiveId, { limit: 10 }),
  );
  assert.ok(history.items.length >= 1, "history 至少 1 条");
  assert.ok(history.total >= 1);
  assert.equal(history.items[0].revision, 1);
  assert.ok(history.items[0].publicSummary.length > 0);
  assert.deepEqual(findPrivatePayloadLeaks(history.items), []);
});
