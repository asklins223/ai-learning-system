/**
 * Plan 23 RL-04：历史不可变复验——backfill/reconcile 不得改写任何 Run/event/hash。
 *
 * 在纯 V2 fixture（4f825f38）：
 *  - 先快照 learning_runs 的 (id, snapshot_hash, contractHash 等价列)；
 *  - 执行 backfill + reconcile（写 learning_objective_origins_v2）；
 *  - 再次快照并逐字节比对——历史 Run/事件哈希必须完全不变（§21.1/§35 RL-04）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { learningObjectiveOriginsV2 } from "../db/schema/card-generation-v2.ts";
import { learningRuns } from "../db/schema/learning-runs.ts";

const FIXTURE_WORKSPACE = "4f825f38-1a65-492a-8dec-c82868e6ea0f";
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
const [{ withWorkspaceTransaction }, { executeObjectiveOriginBackfill }, { reconcileObjectiveOrigins }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-objectives/origin-migration.ts"),
    import("../modules/learning-objectives/origin-migration.ts"),
  ]);

after(async () => {
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

async function snapshotRuns(workspaceId: string): Promise<string> {
  return withWorkspaceTransaction(
    { workspaceId, userId: SYSTEM_USER },
    async (tx) => {
      const rows = await tx
        .select({
          id: learningRuns.id,
          // V1 keyPointId 列已退役：目标身份经 origin JSONB（alias）进入快照。
          origin: learningRuns.origin,
          phase: learningRuns.phase,
          updatedAt: learningRuns.updatedAt,
          createdAt: learningRuns.createdAt,
        })
        .from(learningRuns)
        .where(eq(learningRuns.workspaceId, workspaceId))
        .orderBy(learningRuns.createdAt);
      return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    },
  );
}

test("RL-04: backfill + reconcile 后 learning_runs 快照字节级不变", async () => {
  const before = await snapshotRuns(FIXTURE_WORKSPACE);
  assert.ok(before.length === 64, "baseline 快照必须可计算");

  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => executeObjectiveOriginBackfill(tx, FIXTURE_WORKSPACE, { dryRun: false }),
  );
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => reconcileObjectiveOrigins(tx, FIXTURE_WORKSPACE),
  );

  const after = await snapshotRuns(FIXTURE_WORKSPACE);
  assert.equal(after, before, "迁移操作不得改写 learning_runs 任何字段（含 updated_at）");

  // 清理测试 origin（不影响 runs）
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .delete(learningObjectiveOriginsV2)
        .where(eq(learningObjectiveOriginsV2.workspaceId, FIXTURE_WORKSPACE)),
  );
  const afterCleanup = await snapshotRuns(FIXTURE_WORKSPACE);
  assert.equal(afterCleanup, before, "清理 origin 也不得触碰 runs");
});
