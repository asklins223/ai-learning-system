/**
 * Plan 23 TP-10：Topology V3 repository 集成测试（真实 Postgres）。
 *
 * 纯 V2 fixture（4f825f38）验证：
 *  - 节点只含 source/note/objective/evidence（assertNoCardOrKeyPointNode=0）；
 *  - Note 节点在 0-card 情况仍存在；Objective 节点数 = 全量 Objective；
 *  - backfill 后 Note → Objective sourced_from 边存在（multi-origin 可表达）；
 *  - 无 origin 的 active Objective 进入 integrity.missingOriginObjectiveIds；
 *  - snapshot 无私有泄漏。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { findPrivatePayloadLeaks, assertNoCardOrKeyPointNode } from "@ailearn/shared";
import { learningObjectivesV2 } from "../db/schema/card-generation-v2.ts";
import { learningObjectiveOriginsV2 } from "../db/schema/card-generation-v2.ts";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
const sql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const pureV2 = await seedPureV2Workspace(sql, { objectiveCount: 3 });
const FIXTURE_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;
const [{ withWorkspaceTransaction }, { buildTopologySnapshotV3 }, { executeObjectiveOriginBackfill }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/understanding-v3/topology-repository.ts"),
    import("../modules/learning-objectives/origin-migration.ts"),
  ]);

after(async () => {
  await pureV2.cleanup();
  await sql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("TP-10: Topology V3 无 card/key_point 节点、无泄漏、Note/Objective 节点存在", async () => {
  const snapshot = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => buildTopologySnapshotV3(tx, { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER }),
  );
  assert.equal(snapshot.version, 3);
  assert.deepEqual(assertNoCardOrKeyPointNode(snapshot.nodes).violations, []);
  assert.deepEqual(findPrivatePayloadLeaks(snapshot), []);

  const noteNodes = snapshot.nodes.filter((n) => n.nodeRef.kind === "note");
  const objectiveNodes = snapshot.nodes.filter((n) => n.nodeRef.kind === "objective");
  assert.ok(noteNodes.length >= 1, "Note 节点必须存在（0-card Note 也是合法节点）");
  assert.ok(objectiveNodes.length >= 3, "Objective 节点 >= 3（fixture active objectives）");

  // 尚无 origin（测试数据已清理）→ active objective 进入 missing_origin
  const objectiveCount = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .select({ objectiveId: learningObjectivesV2.objectiveId })
        .from(learningObjectivesV2)
        .where(eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE)),
  );
  assert.equal(objectiveNodes.length, objectiveCount.length, "每 objective 恰好一个节点");
  assert.ok(
    snapshot.integrity.missingOriginObjectiveIds.length >= 3,
    "无 origin 的 active Objective 必须进入 integrity 列表（§19.3）",
  );
  // 边结构合法：所有边端点都在节点集合内
  const nodeKeys = new Set(
    snapshot.nodes.map((n) => n.nodeRef.kind + ":" + ("objectiveId" in n.nodeRef ? n.nodeRef.objectiveId : "noteId" in n.nodeRef ? n.nodeRef.noteId : "sourceId" in n.nodeRef ? n.nodeRef.sourceId : n.nodeRef.evidenceSnapshotId)),
  );
  for (const edge of snapshot.edges) {
    assert.ok(nodeKeys.has(edge.from.kind + ":" + edge.from.id), "edge from 必须指向存在节点");
    assert.ok(nodeKeys.has(edge.to.kind + ":" + edge.to.id), "edge to 必须指向存在节点");
  }
});

test("TP-10: backfill 后 Note → Objective sourced_from 边出现（TP-03）", async () => {
  // 先 backfill 创建 note origins（幂等；结束后清理）
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => executeObjectiveOriginBackfill(tx, FIXTURE_WORKSPACE, { dryRun: false }),
  );
  const snapshot = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => buildTopologySnapshotV3(tx, { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER }),
  );
  const sourcedFrom = snapshot.edges.filter((e) => e.kind === "sourced_from");
  assert.ok(sourcedFrom.length >= 3, "backfill 后必须有 Note→Objective sourced_from 边");
  assert.equal(
    snapshot.integrity.missingOriginObjectiveIds.length,
    0,
    "backfill 后不得有 missing origin",
  );
  // 清理
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .delete(learningObjectiveOriginsV2)
        .where(eq(learningObjectiveOriginsV2.workspaceId, FIXTURE_WORKSPACE)),
  );
});
