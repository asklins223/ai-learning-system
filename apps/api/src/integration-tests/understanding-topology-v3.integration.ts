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
import { learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { learningObjectiveOriginsV2 } from "@ailearn/shared/db-schema/card-generation-v2";

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

/**
 * 稳定 P0-2（2026-09-15 审计）：单集合上限护栏。
 *
 * 此前 truncated 硬编码 false 且所有读都没有 LIMIT——workspace 一大就无上界地
 * 把整张图搬进内存。本用例把上限压到 2、用 5 个 objective 的 workspace 验证：
 *  1. 真的截断了（节点数 = 上限，integrity.truncated = true）；
 *  2. 截断是**确定**的（连续两次构建得到同一 topologyRevision），否则 ETag
 *     协商会在截断点上永远失配；
 *  3. 上限放开后同一 workspace 不再截断（护栏不是把数据永久丢掉）。
 */
test("TP-10: 单集合上限护栏如实回报截断且保持 revision 确定", async () => {
  const fixture = await seedPureV2Workspace(sql, { objectiveCount: 5 });
  const ctx = { workspaceId: fixture.workspaceId, userId: fixture.userId };
  const build = () =>
    withWorkspaceTransaction(ctx, (tx) => buildTopologySnapshotV3(tx, ctx));
  const previousLimit = process.env.TOPOLOGY_SNAPSHOT_COLLECTION_LIMIT;
  try {
    process.env.TOPOLOGY_SNAPSHOT_COLLECTION_LIMIT = "2";
    const first = await build();
    const second = await build();
    assert.equal(first.integrity.truncated, true, "超过上限必须如实回报 truncated");
    assert.equal(
      first.nodes.filter((n) => n.nodeRef.kind === "objective").length,
      2,
      "objective 节点数必须恰好等于上限",
    );
    assert.equal(
      first.topologyRevision,
      second.topologyRevision,
      "截断点上的行集合必须是确定的，否则 ETag 永远 304 不命中",
    );

    process.env.TOPOLOGY_SNAPSHOT_COLLECTION_LIMIT = "100";
    const unbounded = await build();
    assert.equal(unbounded.integrity.truncated, false, "上限足够大时不得误报截断");
    assert.equal(
      unbounded.nodes.filter((n) => n.nodeRef.kind === "objective").length,
      5,
      "放开上限后必须看到全部 objective（护栏不丢数据）",
    );
  } finally {
    if (previousLimit === undefined) delete process.env.TOPOLOGY_SNAPSHOT_COLLECTION_LIMIT;
    else process.env.TOPOLOGY_SNAPSHOT_COLLECTION_LIMIT = previousLimit;
    await fixture.cleanup();
  }
});
