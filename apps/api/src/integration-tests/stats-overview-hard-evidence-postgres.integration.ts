/**
 * 首页「硬证据数」（M30 欠账）：去重必须在 SQL 里真的发生，而且要有人在断言。
 *
 * 0269 轮把这一格从"拉全部绑定行回 JS 再 `new Set(…).size`"改成
 * `COUNT(DISTINCT evidence_snapshot_id)`。当时只有 5 条构造级（mock）用例覆盖，
 * 全仓没有一条真实 Postgres 用例断言过这个用户可见的数字——也就是说把它改回
 * `COUNT(*)` 或删掉卡生命周期过滤，都不会有任何测试变红。
 *
 * 夹具刻意让"每种错各给一个不同答案"：
 *   目标 A（active 卡）：快照 S1 绑 3 次、S2 绑 2 次、S3 绑 1 次 = 6 行 / 3 个去重值
 *   目标 B（卡已 archived）：另 2 个快照各绑 1 次 = 2 行 / 2 个去重值
 *   ⇒ 正确 3；漏去重 6；漏掉 active 过滤 5。
 *
 * 运行（一次性库，见 docs/performance-scan-2026-09-22.md §9.5）：
 *   bash scripts/dev-disposable-db.sh ailearn_stats_it
 *   cd apps/api
 *   export DATABASE_URL='postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn_stats_it' \
 *          DATABASE_URL_API='postgres://ailearn_api:<API_PASSWORD>@127.0.0.1:5432/ailearn_stats_it'
 *   node --import tsx --test --test-concurrency=1 \
 *     src/integration-tests/stats-overview-hard-evidence-postgres.integration.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}

// 造数走超级用户（`ailearn` 有 BYPASSRLS）；读数走产品入口 `getStatsOverview`
// （内部 `withWorkspaceTransaction`）。注意后者**只 `set_config`、不 `SET LOCAL ROLE`**，
// RLS 有没有真的生效取决于连接角色：夹具写用 `DATABASE_URL`（超级用户），
// 读数用 `DATABASE_URL_API`（受限角色 `ailearn_api`）。两种角色本文件都实测通过。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const { getStatsOverview } = await import("../modules/stats/service.ts");

const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 2 });
const WORKSPACE = pureV2.workspaceId;
const USER = pureV2.userId;
const [objectiveA, objectiveB] = pureV2.objectiveIds;

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
  // `getStatsOverview` 内部用的是 db/client 的池；不关掉它进程不会退出
  // （表现是"用例全绿但一直挂着"，会吃掉整个 CI 超时）。
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

async function revisionIdOf(objectiveId: string): Promise<string> {
  const rows = await pgSql`
    SELECT current_objective_revision_id FROM learning_objectives_v2
    WHERE workspace_id = ${WORKSPACE} AND objective_id = ${objectiveId}
    LIMIT 1
  `;
  assert.ok(rows[0]?.current_objective_revision_id, `目标 ${objectiveId} 必须有 current revision`);
  return rows[0].current_objective_revision_id as string;
}

/** 落一个证据快照（evidence_snapshots_v2 只有 UPDATE/DELETE 不可变触发器，插入放行）。 */
async function seedSnapshot(evidenceSnapshotId: string): Promise<void> {
  await pgSql`
    INSERT INTO evidence_snapshots_v2
      (id, workspace_id, evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id,
       source_content_hash, modality)
    VALUES (
      gen_random_uuid(), ${WORKSPACE}, ${evidenceSnapshotId},
      ${"e".repeat(64)}, ${randomUUID()}, ${"f".repeat(64)}, 'text'
    )
  `;
}

async function seedBinding(objectiveRevisionId: string, evidenceSnapshotId: string): Promise<void> {
  await pgSql`
    INSERT INTO learning_objective_evidence_bindings_v2
      (id, workspace_id, binding_id, objective_revision_id, target_unit_kind, target_unit_id,
       evidence_snapshot_id, relation, support_strength, semantic_support_report_id,
       semantic_support_report_hash, binding_hash)
    VALUES (
      gen_random_uuid(), ${WORKSPACE}, ${randomUUID()}, ${objectiveRevisionId}, 'answer', 'u1',
      ${evidenceSnapshotId}, 'entails', 'direct', ${randomUUID()}, ${"a".repeat(64)}, ${"b".repeat(64)}
    )
  `;
}

test("前提：evidence_snapshot_id 必须仍是 NOT NULL（否则 COUNT(DISTINCT) 与旧的 Set 口径不同解）", async () => {
  const rows = await pgSql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'learning_objective_evidence_bindings_v2' AND column_name = 'evidence_snapshot_id'
  `;
  assert.equal(rows[0]?.is_nullable, "NO", [
    "M30 的等价性完全建立在 `evidence_snapshot_id NOT NULL` 上：",
    "旧写法 `new Set(rows.map(r => r.evidenceSnapshotId)).size` 会把 null 也算作一个成员，",
    "而 `COUNT(DISTINCT col)` 忽略 null。一旦这列允许为空，两种口径就会分叉，",
    "必须先决定「首页要不要把无证据绑定算一格」再改动本用例。",
  ].join("\n"));
});

test("没种证据时首页报 0（基线，防夹具漏数据造成假绿）", async () => {
  const overview = await getStatsOverview(WORKSPACE, USER);
  assert.equal(overview.activeCardCount, 2, "夹具应有 2 张 active 卡");
  assert.equal(overview.hardEvidenceCount, 0);
  assert.equal(overview.evidenceCount, 0);
});

test("硬证据数 = 该空间 active 卡所绑证据快照的**去重**数", async () => {
  const revA = await revisionIdOf(objectiveA);
  const revB = await revisionIdOf(objectiveB);

  const s1 = randomUUID();
  const s2 = randomUUID();
  const s3 = randomUUID();
  const s4 = randomUUID();
  const s5 = randomUUID();
  for (const snapshot of [s1, s2, s3, s4, s5]) await seedSnapshot(snapshot);

  await seedBinding(revA, s1);
  await seedBinding(revA, s1);
  await seedBinding(revA, s1);
  await seedBinding(revA, s2);
  await seedBinding(revA, s2);
  await seedBinding(revA, s3);
  // 目标 B 的卡随后被 archive：这 2 行既在计数范围内（active 过滤通过时），又各自独立。
  await seedBinding(revB, s4);
  await seedBinding(revB, s5);
  await pgSql`
    UPDATE learning_cards_v2 SET lifecycle = 'archived'
    WHERE workspace_id = ${WORKSPACE} AND objective_id = ${objectiveB}
  `;

  // 前提自检（正对照）：行确实以"能被 join 到的形状"落库了。
  const premise = await pgSql`
    SELECT count(*)::int AS n FROM learning_objective_evidence_bindings_v2 b
    JOIN learning_objective_revisions_v2 r
      ON r.objective_revision_id = b.objective_revision_id AND r.workspace_id = b.workspace_id
    WHERE b.workspace_id = ${WORKSPACE}
  `;
  assert.equal(premise[0].n, 8, "8 行绑定必须都能被 revision join 到");

  const overview = await getStatsOverview(WORKSPACE, USER);
  assert.equal(
    overview.hardEvidenceCount,
    3,
    "6 行里只有 3 个不同快照；archived 卡（B）的 2 个快照不计入",
  );
  assert.equal(overview.evidenceCount, overview.hardEvidenceCount, "两格必须同源");
});
