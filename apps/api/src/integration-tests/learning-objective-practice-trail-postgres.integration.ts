/**
 * 目标详情/列表的「练过 N 次」与「最近一次巩固时间」必须有断言（0269 轮 M32 欠账）。
 *
 * 这两个数字是用户可见的（`WorkspaceLibrarySurface` 的「N 次练习」、
 * `objective-state-copy` 的「练过 N 次」），而详情页与列表页走的是**两套不同实现**：
 *   - 详情：一条 SQL 里两个标量子查询（M32 改后的形状，经 learning_runs join）；
 *  - 列表：先取该空间全部 run，再两个 `inArray` 聚合 + JS 建映射。
 * 改动前全仓没有任何用例断言过这两个值——把 `status='published'` 删掉、把 objective
 * 谓词删掉、把 `ORDER BY created_at DESC` 写成 ASC，都不会有任何测试变红。
 *
 * 本夹具刻意让"错一个条件就换一个答案"：
 *  - 3 条 published practice trail 分布在 3 个 run 上（`practice_trail_event_outbox`
 *    的 (run_id, scope) 唯一，所以"多次练习"必然是多 run）；
 *  - 第 4 条 practice trail 时间**更新**但是 pending → 计数必须仍是 3；
 *  - 同空间另一个目标的 run 上挂 published practice/trail → 计数不能串目标；
 *  - canonical：最新的是 pending，次新的 published 才是答案；另一个目标上有一条
 *    比谁都新的 published → 时间戳不能串目标。
 *
 * 运行（一次性库，见 docs/performance-scan-2026-09-22.md §9.5；两个 URL 分别给，
 * 理由见下面 RLS 那段——`scripts/dev-disposable-db.sh` 末尾会打印这两种配方）：
 *   bash scripts/dev-disposable-db.sh ailearn_trail_it
 *   cd apps/api
 *   export DATABASE_URL='postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn_trail_it' \
 *          DATABASE_URL_API='postgres://ailearn_api:<API_PASSWORD>@127.0.0.1:5432/ailearn_trail_it'
 *   node --import tsx --test --test-concurrency=1 \
 *     src/integration-tests/learning-objective-practice-trail-postgres.integration.ts
 *   （也可整组跑：npm run test:objective-metrics:postgres）
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}

// 造数走超级用户连接（`ailearn` 有 BYPASSRLS，且这三张表上没有触发器）；
// 读取一律走产品代码 + `withWorkspaceTransaction`。
//
// **但 `withWorkspaceTransaction` 只 `set_config`，不做 `SET LOCAL ROLE`**——RLS 是否
// 真的生效，取决于连接角色。所以两个变量要分开给：`DATABASE_URL`（夹具写）用超级用户，
// `DATABASE_URL_API`（db/client 读数）用受限角色 `ailearn_api`。用同一个超级用户 URL
// 跑也能过，但那是"BYPASSRLS 下的绿"，少验一层（本文件两种角色都已实测通过）。
// 于是"数据没种进去"与"产品读不到"都会表现为断言变红，而不是假绿。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const [{ withWorkspaceTransaction }, surface] = await Promise.all([
  import("../db/client.ts"),
  import("../modules/learning-objectives/surface-service.ts"),
]);
const { assembleObjectiveSurfaceV3, listObjectiveSurfacesV3, toObjectiveListItemV3 } = surface;

const HOUR = 3_600_000;
const T0 = Date.now();
const at = (hoursAgo: number) => new Date(T0 - hoursAgo * HOUR);

const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 2 });
const WORKSPACE = pureV2.workspaceId;
const USER = pureV2.userId;
const objectiveA = pureV2.objectiveIds[0];
const objectiveB = pureV2.objectiveIds[1];

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

async function cardIdOf(objectiveId: string): Promise<string> {
  const rows = await pgSql`
    SELECT card_id FROM learning_cards_v2
    WHERE workspace_id = ${WORKSPACE} AND objective_id = ${objectiveId} AND lifecycle = 'active'
    LIMIT 1
  `;
  assert.ok(rows[0], `fixture 目标 ${objectiveId} 必须有 active card`);
  return rows[0].card_id as string;
}

/**
 * jsonb 列必须用 `pgSql.json(对象)`，**不能**写 `${JSON.stringify(对象)}::jsonb`。
 * 后者会被 postgres.js 按参数类型（jsonb）再 `JSON.stringify` 一次：
 * 存进去的是 `jsonb_typeof = 'string'` 的一整个字符串标量，于是
 * `origin ->> 'objectiveId'` 恒为 null、join 一行都不剩，而插入本身不报错。
 * （实测踩过：`SELECT jsonb_typeof(origin) …` 返回 `string`。同一个坑也存在于
 * `helpers/v2-card-fixture.ts` 的 `canonical_answer`/`learning_support`/`scoring_rubric`
 * 三列上——那是既有夹具的问题，本用例不依赖这三列，未一并改动。）
 */
async function seedRun(objectiveId: string, cardId: string, createdAt: Date): Promise<string> {
  const runId = randomUUID();
  await pgSql`
    INSERT INTO learning_runs
      (id, workspace_id, user_id, origin, return_target, target_fingerprint, goal, phase, created_at, updated_at)
    VALUES (
      ${runId}, ${WORKSPACE}, ${USER},
      ${pgSql.json({ kind: "card", cardId, objectiveId })},
      ${pgSql.json({ kind: "objective", objectiveId })},
      ${`fixture-fp-${runId.slice(0, 8)}`}, 'stabilize', 'completed',
      ${createdAt}, ${createdAt}
    )
  `;
  return runId;
}

async function seedPracticeTrail(
  runId: string,
  scope: "official_user" | "sandbox",
  status: "pending" | "published",
  createdAt: Date,
): Promise<void> {
  await pgSql`
    INSERT INTO practice_trail_event_outbox
      (id, practice_event_id, workspace_id, user_id, run_id, scope, event, status, created_at)
    VALUES (
      ${randomUUID()}, ${`practice-${randomUUID()}`}, ${WORKSPACE}, ${USER}, ${runId}, ${scope},
      ${pgSql.json({ kind: "practice_completed", runId })}, ${status}, ${createdAt}
    )
  `;
}

async function seedCanonicalEvent(
  runId: string,
  status: "pending" | "published",
  createdAt: Date,
): Promise<void> {
  const eventId = `canonical-${randomUUID()}`;
  await pgSql`
    INSERT INTO canonical_learning_event_outbox
      (id, commit_id, canonical_event_id, workspace_id, user_id, run_id, envelope, status, created_at)
    VALUES (
      ${randomUUID()}, ${randomUUID()}, ${eventId}, ${WORKSPACE}, ${USER}, ${runId},
      ${pgSql.json({ canonicalEventId: eventId, runId, fact: { kind: "canonical_demonstrated" } })},
      ${status}, ${createdAt}
    )
  `;
}

function readDetail(objectiveId: string) {
  return withWorkspaceTransaction(
    { workspaceId: WORKSPACE, userId: USER },
    (tx) => assembleObjectiveSurfaceV3(tx, { workspaceId: WORKSPACE, userId: USER }, objectiveId),
  );
}

function readList() {
  return withWorkspaceTransaction(
    { workspaceId: WORKSPACE, userId: USER },
    (tx) => listObjectiveSurfacesV3(tx, { workspaceId: WORKSPACE, userId: USER }, { limit: 20 }),
  );
}

test("种数据之前：两个目标都是 0 次练习、无巩固时间（基线，防夹具漏数据造成假绿）", async () => {
  for (const objectiveId of [objectiveA, objectiveB]) {
    const detail = await readDetail(objectiveId);
    assert.equal(detail.personal.practiceTrailCount, 0, `${objectiveId} 基线练习数`);
    assert.equal(detail.personal.lastCanonicalAt, null, `${objectiveId} 基线巩固时间`);
  }
  const list = await readList();
  assert.deepEqual(
    list.items.map((item) => item.personal.practiceTrailCount).sort(),
    [0, 0],
    "列表基线也必须是 0",
  );
});

/**
 * 夹具矩阵（时间都以 T0 为基准，"越新"= hoursAgo 越小）：
 *
 *   run  目标   canonical              practice trail
 *   r1   A      published @ -6h        published @ -3h
 *   r2   A      published @ -4h ←答案  published @ -2h
 *   r3   A      pending   @ -1h        published @ -1h
 *                                     pending   @ -0.5h
 *   r4   B      published @ -0.2h      published @ -0.2h
 *
 * A 期望：3 次 / -4h。任何一条"多看一眼"的错误都会改变答案：
 * 漏掉 status 过滤 → 4 次 / -1h；漏掉目标过滤 → 4 次 / -0.2h；取成 MIN → -6h。
 */
let answerA: string | null = null;

test("详情页：练过次数只数该目标的 published，最近巩固只取该目标最新的 published", async () => {
  const [cardA, cardB] = [await cardIdOf(objectiveA), await cardIdOf(objectiveB)];
  const r1 = await seedRun(objectiveA, cardA, at(7));
  const r2 = await seedRun(objectiveA, cardA, at(5));
  const r3 = await seedRun(objectiveA, cardA, at(4));
  const r4 = await seedRun(objectiveB, cardB, at(3));

  await seedPracticeTrail(r1, "official_user", "published", at(3));
  await seedPracticeTrail(r2, "official_user", "published", at(2));
  await seedPracticeTrail(r3, "official_user", "published", at(1));
  await seedPracticeTrail(r3, "sandbox", "pending", at(0.5));
  await seedPracticeTrail(r4, "official_user", "published", at(0.2));

  await seedCanonicalEvent(r1, "published", at(6));
  await seedCanonicalEvent(r2, "published", at(4));
  answerA = at(4).toISOString();
  await seedCanonicalEvent(r3, "pending", at(1));
  await seedCanonicalEvent(r4, "published", at(0.2));

  // 前提自检（正对照）：夹具数据确实以"能被 join 到的形状"落库。
  // 没有这一句，下面的 `0 !== 3` 会被读成"产品查不到"，而真因是夹具自己写坏了 jsonb。
  const premise = await pgSql`
    SELECT
      (SELECT count(*)::int FROM learning_runs
        WHERE workspace_id = ${WORKSPACE} AND origin ->> 'objectiveId' = ${objectiveA}) AS runs_a,
      (SELECT count(*)::int FROM practice_trail_event_outbox
        WHERE workspace_id = ${WORKSPACE} AND status = 'published') AS published_trails,
      (SELECT count(*)::int FROM canonical_learning_event_outbox
        WHERE workspace_id = ${WORKSPACE} AND status = 'published') AS published_canonical
  `;
  assert.equal(premise[0].runs_a, 3, "3 个 run 必须带可读的 origin.objectiveId");
  assert.equal(premise[0].published_trails, 4, "4 条 published practice trail（含另一个目标那 1 条）");
  assert.equal(premise[0].published_canonical, 3, "3 条 published canonical（含另一个目标那 1 条）");

  const detail = await readDetail(objectiveA);
  assert.equal(detail.personal.practiceTrailCount, 3, "只数该目标 published 的 3 条");
  assert.equal(detail.personal.lastCanonicalAt, answerA, "只取该目标最新的 published canonical");

  const other = await readDetail(objectiveB);
  assert.equal(other.personal.practiceTrailCount, 1, "B 只看到自己那 1 条");
  assert.equal(other.personal.lastCanonicalAt, at(0.2).toISOString());
});

test("列表页与详情页对同两个数字必须一致（两套实现不能各说各话）", async () => {
  assert.ok(answerA, "上一个用例必须先跑出答案");
  const list = await readList();
  const byId = new Map(list.items.map((item) => [item.objectiveId, item]));
  const itemA = byId.get(objectiveA);
  const itemB = byId.get(objectiveB);
  assert.ok(itemA && itemB, "列表必须能查到两个目标");

  assert.equal(itemA.personal.practiceTrailCount, 3);
  assert.equal(itemA.personal.lastCanonicalAt, answerA);
  assert.equal(itemB.personal.practiceTrailCount, 1);
  assert.equal(itemB.personal.lastCanonicalAt, at(0.2).toISOString());

  // 卡片库真正渲染的是 list item 上的 progress 字段，不是 personal.*
  const card = toObjectiveListItemV3(itemA);
  assert.equal(card.progress.practiceTrailCount, 3, "界面「N 次练习」读的是 progress");
  assert.equal(card.progress.lastCanonicalAt, answerA);

  const detail = await readDetail(objectiveA);
  assert.equal(card.progress.practiceTrailCount, detail.personal.practiceTrailCount);
  assert.equal(card.progress.lastCanonicalAt, detail.personal.lastCanonicalAt);
});
