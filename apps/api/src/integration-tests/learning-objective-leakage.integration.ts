/**
 * Plan 23 RL-05：Surface 公共泄漏 mutation 测试（服务层）。
 *
 * 对 fixture 工作区全部 Objective 装配 Surface 后：
 *  - 任意注入 canonicalAnswer/scoringRubric/fullQuote/privateReport 到任意层级
 *    → zod strict schema 必须拒绝（§20.1/§35 RL-05）；
 *  - 正常装配结果递归扫描零私有键。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { findPrivatePayloadLeaks, learningObjectiveSurfaceV3Schema } from "@ailearn/shared";
import { learningObjectivesV2 } from "../db/schema/card-generation-v2.ts";

const FIXTURE_WORKSPACE = "4f825f38-1a65-492a-8dec-c82868e6ea0f";
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
const [{ withWorkspaceTransaction }, { assembleObjectiveSurfaceV3 }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-objectives/surface-service.ts"),
  ]);

after(async () => {
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

function injectDeep(value: unknown, key: string, payload: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => injectDeep(item, key, payload));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = injectDeep(v, key, payload);
    }
    (out as Record<string, unknown>)[key] = payload;
    return out;
  }
  return value;
}

test("RL-05: 正常 Surface 递归零私有键（全量 Objective）", async () => {
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      const rows = await tx
        .select({ objectiveId: learningObjectivesV2.objectiveId })
        .from(learningObjectivesV2)
        .where(eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE));
      for (const row of rows) {
        const surface = await assembleObjectiveSurfaceV3(
          tx,
          { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
          row.objectiveId,
        );
        assert.deepEqual(findPrivatePayloadLeaks(surface), [], "objective " + row.objectiveId);
      }
    },
  );
});

test("RL-05: 任意注入私有键 → schema 拒绝（根层与深层）", async () => {
  const objectiveId = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      const rows = await tx
        .select({ objectiveId: learningObjectivesV2.objectiveId })
        .from(learningObjectivesV2)
        .where(eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE))
        .limit(1);
      return rows[0].objectiveId;
    },
  );
  const surface = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      assembleObjectiveSurfaceV3(
        tx,
        { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
        objectiveId,
      ),
  );

  for (const key of ["canonicalAnswer", "scoringRubric", "fullQuote", "protectedQuote", "privateReport"]) {
    const injectedRoot = injectDeep(surface, key, "SECRET");
    assert.equal(
      learningObjectiveSurfaceV3Schema.safeParse(injectedRoot).success,
      false,
      "根层注入 " + key + " 必须被拒绝",
    );
    const injectedDeep = injectDeep(surface, key, "SECRET");
    assert.equal(
      learningObjectiveSurfaceV3Schema.safeParse(injectedDeep).success,
      false,
      "深层注入 " + key + " 必须被拒绝",
    );
  }
});
