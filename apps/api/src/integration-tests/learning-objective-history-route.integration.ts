/**
 * Plan 23 W2-19/W2-20/W2-23/W2-24：history reader + legacy route resolver 集成测试。
 *
 * 在纯 V2 fixture 工作区（4f825f38）验证：
 *  - history 返回公开摘要（revision>=1、无私有键泄漏）；
 *  - key_point=objectiveId → mapped；
 *  - legacy alias 父卡（kp.id=objectiveId）→ mapped；
 *  - 未知 key point → gone；
 *  - 解析结果幂等写入 legacy_route_mappings_v2。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { findPrivatePayloadLeaks } from "@ailearn/shared";
import {
  learningObjectivesV2,
  legacyRouteMappingsV2,
} from "../db/schema/card-generation-v2.ts";



if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 3 });
const FIXTURE_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;
const [{ withWorkspaceTransaction }, { readObjectiveHistoryV3, resolveLegacyRouteV3 }] =
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

test("W2-20: key_point=objectiveId → mapped；未知 key point → gone", async () => {
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
  const mapped = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => resolveLegacyRouteV3(tx, FIXTURE_WORKSPACE, { legacyKind: "key_point", legacyId: objectiveId }),
  );
  assert.equal(mapped.status, "mapped");
  assert.equal(mapped.objectiveId, objectiveId);

  const gone = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => resolveLegacyRouteV3(tx, FIXTURE_WORKSPACE, { legacyKind: "key_point", legacyId: randomUUID() }),
  );
  assert.equal(gone.status, "gone");
});

test("W2-20: V2 card → mapped（解析幂等落 mapping）；legacy 卡已退役 → gone", async () => {
  // 0176 后：V1 卡退役清空，V2 card 是唯一可 mapped 的 card 类型
  const v2CardId = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      const { learningCardsV2 } = await import("../db/schema/card-generation-v2.ts");
      const rows = await tx
        .select({ cardId: learningCardsV2.cardId, objectiveId: learningCardsV2.objectiveId })
        .from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.workspaceId, FIXTURE_WORKSPACE),
          eq(learningCardsV2.lifecycle, "active"),
        ))
        .limit(1);
      return rows[0] ?? null;
    },
  );
  assert.ok(v2CardId, "fixture 必须有 active V2 card");

  const resolution = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => resolveLegacyRouteV3(tx, FIXTURE_WORKSPACE, { legacyKind: "card", legacyId: v2CardId!.cardId }),
  );
  assert.equal(resolution.status, "mapped");
  assert.equal(resolution.objectiveId, v2CardId!.objectiveId);

  // mapping 已落库
  const rows = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .select({ status: legacyRouteMappingsV2.status })
        .from(legacyRouteMappingsV2)
        .where(and(
          eq(legacyRouteMappingsV2.workspaceId, FIXTURE_WORKSPACE),
          eq(legacyRouteMappingsV2.legacyKind, "card"),
          eq(legacyRouteMappingsV2.legacyId, v2CardId!.cardId),
        )),
  );
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].status, "mapped");

  // 未知 legacy card → gone（V1 已退役）
  const gone = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => resolveLegacyRouteV3(tx, FIXTURE_WORKSPACE, { legacyKind: "card", legacyId: randomUUID() }),
  );
  assert.equal(gone.status, "gone");
});
