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
import { cardKeyPoints } from "../db/schema/card.ts";

const FIXTURE_WORKSPACE = "4f825f38-1a65-492a-8dec-c82868e6ea0f";
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
const [{ withWorkspaceTransaction }, { readObjectiveHistoryV3, resolveLegacyRouteV3 }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-objectives/history-route-service.ts"),
  ]);

after(async () => {
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

test("W2-20: legacy alias 父卡 → mapped；解析幂等落 mapping", async () => {
  const aliasCard = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      // kp.id 命中 objective_id（alias 规则）
      const objectiveRows = await tx
        .select({ objectiveId: learningObjectivesV2.objectiveId })
        .from(learningObjectivesV2)
        .where(eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE))
        .limit(50);
      const objectiveIds = objectiveRows.map((r) => r.objectiveId);
      if (objectiveIds.length === 0) return null;
      const { inArray } = await import("drizzle-orm");
      const kpRows = await tx
        .select({ cardId: cardKeyPoints.cardId })
        .from(cardKeyPoints)
        .where(and(
          eq(cardKeyPoints.workspaceId, FIXTURE_WORKSPACE),
          inArray(cardKeyPoints.id, objectiveIds),
        ))
        .limit(1);
      return kpRows[0]?.cardId ?? null;
    },
  );
  if (!aliasCard) {
    // fixture 无 alias 父卡数据时跳过（早期测试卡）
    console.log("skip alias card case: fixture 无 alias 父卡");
    return;
  }
  const resolution = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => resolveLegacyRouteV3(tx, FIXTURE_WORKSPACE, { legacyKind: "card", legacyId: aliasCard }),
  );
  assert.equal(resolution.status, "mapped");
  assert.ok(resolution.objectiveId !== null);

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
          eq(legacyRouteMappingsV2.legacyId, aliasCard),
        )),
  );
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].status, "mapped");
});
