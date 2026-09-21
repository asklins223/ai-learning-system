/**
 * Plan 23 CS-03：Objective 搜索索引集成测试。
 *
 * 在纯 V2 fixture（4f825f38）验证：
 *  - reindex 后 search_documents 含 objective 文档（conceptLabel/publicSummary）；
 *  - search() 能命中 Objective（conceptLabel 关键词）；
 *  - objective 文档 body 不含 canonicalAnswer / rubric / learningSupport；
 *  - 数量：objective 文档数 = 全量 Objective 数。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { searchDocuments } from "@ailearn/shared/db-schema/search";

const pgSql = (await import("postgres")).default(process.env.DATABASE_URL ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn", { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 3 });
const FIXTURE_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
const [{ withWorkspaceTransaction }, { reindexWorkspaceSearch, search }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/search/service.ts"),
  ]);

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("CS-03: reindex 写入 objective 文档且可被搜索命中、无私有载荷", async () => {
  const result = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => reindexWorkspaceSearch(tx, FIXTURE_WORKSPACE),
  );
  assert.ok(result.indexed.objective >= 3, "objective 文档 >= 3，实际 " + result.indexed.objective);
  assert.equal(result.errors, 0);

  // objective 文档数 = 全量 Objective 数
  const docCount = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(searchDocuments)
        .where(and(
          eq(searchDocuments.workspaceId, FIXTURE_WORKSPACE),
          eq(searchDocuments.objectType, "objective"),
        )),
  );
  const objectiveCount = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(learningObjectivesV2)
        .where(eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE)),
  );
  assert.equal(Number(docCount[0].n), Number(objectiveCount[0].n), "objective 文档必须与 Objective 一一对应");

  // 私有载荷永不进入搜索文档
  const privateHits = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(searchDocuments)
        .where(and(
          eq(searchDocuments.workspaceId, FIXTURE_WORKSPACE),
          eq(searchDocuments.objectType, "objective"),
          sql`(body LIKE '%canonicalAnswer%' OR body LIKE '%scoringRubric%' OR body LIKE '%learningSupport%' OR title LIKE '%canonicalAnswer%')`,
        )),
  );
  assert.equal(Number(privateHits[0].n), 0, "objective 文档不得含 answer/rubric/support");

  // 搜索命中（用 fixture 目标的一个公开词）
  const surface = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      const rows = await tx
        .select({ objectiveId: learningObjectivesV2.objectiveId })
        .from(learningObjectivesV2)
        .where(eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE))
        .limit(1);
      const { assembleObjectiveSurfaceV3 } = await import("../modules/learning-objectives/surface-service.ts");
      return assembleObjectiveSurfaceV3(
        tx,
        { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
        rows[0].objectiveId,
      );
    },
  );
  const keyword = surface.content.publicSummary.slice(0, 6);
  const searchResult = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => search(tx, FIXTURE_WORKSPACE, keyword, { userId: SYSTEM_USER, limit: 20 }),
  );
  const objectiveHit = searchResult.items.find((item) => item.objectType === "objective");
  assert.ok(objectiveHit, "搜索必须命中 objective 文档（关键词：" + keyword + "）");

  // type=objective 过滤 + href 直达档案路由
  const typed = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => search(tx, FIXTURE_WORKSPACE, keyword, { userId: SYSTEM_USER, type: "objective", limit: 20 }),
  );
  assert.ok(typed.total >= 1, "type=objective 过滤必须有命中");
  for (const item of typed.items) {
    assert.equal(item.objectType, "objective");
    assert.ok(item.href.startsWith("/learning-objectives/"), "objective 命中 href 必须直达档案");
  }
});
