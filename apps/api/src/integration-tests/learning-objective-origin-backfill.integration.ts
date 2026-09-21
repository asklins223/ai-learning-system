/**
 * Plan 23 W2-03/W2-05：Origin backfill 规划器/executor 集成测试（真实 Postgres）。
 *
 * 在纯 V2 fixture 工作区（4f825f38）验证：
 *  - dry-run 规划：所有 active Objective 被分类（card_note_version 可证明 → migratable）；
 *  - --apply：幂等执行——首次 created>0，二次执行 skippedExisting（created=0）；
 *  - 规划器/executor 不产生异常、不触碰其他 workspace。
 */
import { test, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { learningObjectiveOriginsV2 } from "@ailearn/shared/db-schema/card-generation-v2";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 3 });
const FIXTURE_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;
const [{ withWorkspaceTransaction }, { planObjectiveOriginBackfill, executeObjectiveOriginBackfill }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-objectives/origin-migration.ts"),
  ]);

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
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

// ─── 生产入口：POST /v2/learning-objectives/origins/backfill ────────────
//
// 上面那些用例直接调 service，所以这个执行器**没有任何生产调用方**也能全绿
// ——那正是 171 条历史目标一直没人修的原因（09-17 之后建的目标一条不缺，缺的全在
// 更早：那条写入路径上线之前的存量）。这一组因此走真实 HTTP：路由存在、能修、
// 幂等、且只对 owner 开放。

const { default: Fastify } = await import("fastify");
const { default: sensible } = await import("@fastify/sensible");
const { authRoutes } = await import("../modules/identity/routes.ts");
const { learningObjectiveRoutes } = await import("../modules/learning-objectives/routes.ts");
const { issueSession } = await import("../modules/identity/service.ts");
const { addV2ObjectiveToWorkspace } = await import("./helpers/v2-card-fixture.ts");

test("backfill 有一个 owner-only 的 HTTP 入口，跑一次补上、再跑一次不重复写", async () => {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(learningObjectiveRoutes);
  await app.ready();

  // 造一条"缺来源绑定"的目标（与 09-15 之前那批同样的形状：有卡、卡有 note_version_id，
  // 但没有 origins 行）。不靠调整用例顺序来制造这个状态。
  const seeded = await addV2ObjectiveToWorkspace(pgSql, FIXTURE_WORKSPACE, SYSTEM_USER, {
    publicSummary: "缺来源绑定的那条",
  });
  const owner = await issueSession(SYSTEM_USER, FIXTURE_WORKSPACE);
  const first = await app.inject({
    method: "POST",
    url: "/v2/learning-objectives/origins/backfill",
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(first.statusCode, 200, `owner 调用必须成功：${first.statusCode} ${first.body}`);
  assert.ok(first.json().created >= 1, "至少补上刚造的那一条");
  const origins = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => tx
      .select({ objectiveId: learningObjectiveOriginsV2.objectiveId })
      .from(learningObjectiveOriginsV2)
      .where(eq(learningObjectiveOriginsV2.objectiveId, seeded.objectiveId)),
  );
  assert.equal(origins.length >= 1, true, "回执说补了，库里却没有那一行");

  // 幂等：同一条再跑一次不该重复写（executor 是 ON CONFLICT DO NOTHING）。
  const second = await app.inject({
    method: "POST",
    url: "/v2/learning-objectives/origins/backfill",
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().created, 0, "第二次跑又写了行——幂等只在 service 层成立不算过");

  // owner 判据：同一个空间的成员不该能改整个空间的谱系。
  const memberUser = randomUUID();
  await pgSql`INSERT INTO users (id, email, password_hash, role)
    VALUES (${memberUser}, ${`origin-gate-${memberUser.slice(0, 8)}@example.test`}, 'h', 'owner')`;
  await pgSql`INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${FIXTURE_WORKSPACE}, ${memberUser}, 'member')`;
  const member = await issueSession(memberUser, FIXTURE_WORKSPACE);
  const denied = await app.inject({
    method: "POST",
    url: "/v2/learning-objectives/origins/backfill",
    headers: { authorization: `Bearer ${member.token}` },
  });
  assert.equal(denied.statusCode, 403, `成员也能跑这条：${denied.statusCode} ${denied.body}`);

  await pgSql`DELETE FROM sessions WHERE user_id = ${memberUser}`;
  await pgSql`DELETE FROM workspace_members WHERE user_id = ${memberUser}`;
  await pgSql`DELETE FROM users WHERE id = ${memberUser}`;
  await app.close();
});
