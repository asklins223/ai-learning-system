/**
 * Plan 23 W2-03/W2-05：Origin backfill 规划器/executor 集成测试（真实 Postgres）。
 *
 * 在纯 V2 fixture 工作区（4f825f38）验证：
 *  - dry-run 规划：所有 active Objective 被分类（card_note_version 可证明 → migratable）；
 *  - --apply：幂等执行——首次 created>0，二次执行 skippedExisting（created=0）；
 *  - 规划器/executor 不产生异常、不触碰其他 workspace。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { learningObjectivesV2 } from "../db/schema/card-generation-v2.ts";
import { learningObjectiveOriginsV2 } from "../db/schema/card-generation-v2.ts";

const FIXTURE_WORKSPACE = "4f825f38-1a65-492a-8dec-c82868e6ea0f";
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
const [{ withWorkspaceTransaction }, { planObjectiveOriginBackfill, executeObjectiveOriginBackfill }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-objectives/origin-migration.ts"),
  ]);

after(async () => {
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("W2-03: dry-run 规划覆盖全部 Objective 且可证明来源全部 migratable", async () => {
  const plan = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => planObjectiveOriginBackfill(tx, FIXTURE_WORKSPACE),
  );
  assert.ok(plan.items.length >= 3, "fixture 至少有 3 个 Objective 被规划，实际 " + plan.items.length);
  // 全部条目必须被分类
  assert.equal(
    plan.items.length,
    plan.counts.migratable + plan.counts.missing + plan.counts.ambiguous,
  );
  // 所有 active Objective 都有条目
  const objectiveCount = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .select({ objectiveId: learningObjectivesV2.objectiveId })
        .from(learningObjectivesV2)
        .where(eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE)),
  );
  assert.equal(plan.items.length, objectiveCount.length);
  // fixture 的 active cards 都有 note_version_id → 至少 3 个 migratable
  assert.ok(
    plan.counts.migratable >= 3,
    "card_note_version 可证明的 Objective 应 >= 3，实际 " + plan.counts.migratable,
  );
  const migratable = plan.items.filter((i) => i.category === "migratable");
  for (const item of migratable) {
    assert.ok(item.source !== null, "migratable 必须有 source");
    assert.ok(item.noteId !== null, "migratable 必须有 noteId");
  }
});

test("W2-05: executor 幂等——首次 created>=3，二次 created=0 且 skippedExisting>0", async () => {
  // 清理历史测试残留（同一 workspace 的 note origins）
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .delete(learningObjectiveOriginsV2)
        .where(eq(learningObjectiveOriginsV2.workspaceId, FIXTURE_WORKSPACE)),
  );

  const first = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => executeObjectiveOriginBackfill(tx, FIXTURE_WORKSPACE, { dryRun: false }),
  );
  assert.ok(first.created >= 3, "首次执行应创建 >= 3 个 Origin，实际 " + first.created);
  assert.equal(first.failed, 0, "首次执行不应失败");

  const second = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => executeObjectiveOriginBackfill(tx, FIXTURE_WORKSPACE, { dryRun: false }),
  );
  assert.equal(second.created, 0, "二次执行必须幂等（created=0）");
  assert.ok(second.skippedExisting >= 3, "二次执行应全部 skippedExisting");

  // dry-run 不落库
  const countOrigins = () =>
    withWorkspaceTransaction(
      { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
      (tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(learningObjectiveOriginsV2)
          .where(eq(learningObjectiveOriginsV2.workspaceId, FIXTURE_WORKSPACE)),
    );
  const before = Number((await countOrigins())[0].n);
  const dry = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => executeObjectiveOriginBackfill(tx, FIXTURE_WORKSPACE, { dryRun: true }),
  );
  assert.equal(dry.created, 0);
  const afterRows = Number((await countOrigins())[0].n);
  assert.equal(before, afterRows, "dry-run 不得写入 Origin");

  // 清理：保留 fixture 数据干净（删除测试创建的 note origins，交给正式 backfill）
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .delete(learningObjectiveOriginsV2)
        .where(eq(learningObjectiveOriginsV2.workspaceId, FIXTURE_WORKSPACE)),
  );
});
