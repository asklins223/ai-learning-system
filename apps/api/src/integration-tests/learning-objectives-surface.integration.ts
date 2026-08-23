/**
 * Plan 23 W2-01/W2-02/W2-09/W2-10/W2-17：Origin 写/读 + Surface 装配集成测试。
 *
 * 在纯 V2 fixture 工作区（4f825f38-…）上验证：
 *  - Surface 可读、可行动、无私有泄漏（findPrivatePayloadLeaks=0）；
 *  - Origin 幂等创建（第二次 created=false）；
 *  - Origin 写入后 Surface 的 sources 立即反映（missingOrigin=false）；
 *  - 不存在的 objective revision 被拒绝（跨 workspace/幽灵绑定防护）。
 *
 * 运行：DATABASE_URL=postgres://ailearn:ailearn_dev@localhost:5432/ailearn
 *   node --import tsx --test src/integration-tests/learning-objectives-surface.integration.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { findPrivatePayloadLeaks } from "@ailearn/shared";
import { eq, and } from "drizzle-orm";
import { learningObjectivesV2, learningObjectiveOriginsV2 } from "../db/schema/card-generation-v2.ts";

// db client 在 import 时读取 DATABASE_URL；必须先设置再动态 import。
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 3 });
const FIXTURE_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;
const [{ withWorkspaceTransaction }, { assembleObjectiveSurfaceV3 }, { createObjectiveOrigin, listOriginsByObjective }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-objectives/surface-service.ts"),
    import("../modules/learning-objectives/origin-service.ts"),
  ]);

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

async function firstActiveObjectiveId(): Promise<string> {
  return withWorkspaceTransaction(
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
      assert.ok(rows[0], "fixture 工作区必须有 active Objective");
      return rows[0].objectiveId;
    },
  );
}

test("W2-17: 纯 V2 fixture 的 active Objective 可装配为可行动、无泄漏 Surface", async () => {
  const objectiveId = await firstActiveObjectiveId();
  const assembled = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      assembleObjectiveSurfaceV3(
        tx,
        { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER, origin: "home" },
        objectiveId,
      ),
  );
  assert.equal(assembled.objectiveId, objectiveId);
  assert.equal(assembled.version, 3);
  assert.ok(assembled.content.publicSummary.length > 0, "publicSummary 必须非空");
  assert.equal(assembled.content.lifecycle, "active");
  // 尚无 Origin backfill → missingOrigin=true；action 必须可行动
  assert.equal(assembled.sources.missingOrigin, true);
  assert.ok(
    assembled.primaryAction.kind === "create_run" || assembled.primaryAction.kind === "resume_run",
    "纯 V2 fixture 主行动必须可执行（create/resume），实际 " + assembled.primaryAction.kind,
  );
  assert.deepEqual(findPrivatePayloadLeaks(assembled), []);
  const serialized = JSON.stringify(assembled);
  assert.ok(!serialized.includes("canonicalAnswer"));
  assert.ok(!serialized.includes("scoringRubric"));
});

test("W2-01/W2-02: Origin 幂等创建 + Surface sources 立即反映 + revision 校验", async () => {
  const objectiveId = await firstActiveObjectiveId();
  const revisionId = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      const rows = await tx
        .select({ revisionId: learningObjectivesV2.currentObjectiveRevisionId })
        .from(learningObjectivesV2)
        .where(eq(learningObjectivesV2.objectiveId, objectiveId))
        .limit(1);
      assert.ok(rows[0].revisionId, "fixture objective 必须有 current revision");
      return rows[0].revisionId!;
    },
  );

  const originId = randomUUID();
  const first = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      createObjectiveOrigin(tx, FIXTURE_WORKSPACE, {
        originId,
        objectiveId,
        objectiveRevisionId: revisionId,
        kind: "manual",
      }),
  );
  assert.equal(first.created, true);
  assert.equal(first.origin.kind, "manual");

  // 幂等：同一 originId 再次创建 → created=false
  const second = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      createObjectiveOrigin(tx, FIXTURE_WORKSPACE, {
        originId,
        objectiveId,
        objectiveRevisionId: revisionId,
        kind: "manual",
      }),
  );
  assert.equal(second.created, false);
  assert.equal(second.origin.originId, originId);

  // 不存在的 revision → 拒绝（防跨 workspace/幽灵绑定）
  await assert.rejects(
    withWorkspaceTransaction(
      { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
      (tx) =>
        createObjectiveOrigin(tx, FIXTURE_WORKSPACE, {
          originId: randomUUID(),
          objectiveId,
          objectiveRevisionId: randomUUID(),
          kind: "manual",
        }),
    ),
    /does not exist in workspace/,
  );

  // Surface sources 立即反映
  const assembled = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      assembleObjectiveSurfaceV3(
        tx,
        { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
        objectiveId,
      ),
  );
  assert.equal(assembled.sources.missingOrigin, false);
  assert.equal(assembled.sources.origins.length, 1);
  assert.equal(assembled.sources.origins[0].kind, "manual");

  // 按 objective 读
  const byObjective = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => listOriginsByObjective(tx, FIXTURE_WORKSPACE, objectiveId),
  );
  assert.equal(byObjective.length, 1);

  // 清理测试数据
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .delete(learningObjectiveOriginsV2)
        .where(and(
          eq(learningObjectiveOriginsV2.workspaceId, FIXTURE_WORKSPACE),
          eq(learningObjectiveOriginsV2.originId, originId),
        )),
  );
});
