/**
 * doc 34 L16 —— 删掉的笔记，它的卡还在队列里。
 *
 * 判据是**派生**的（`visibleCardsCondition` / `visibleObjectivesCondition` /
 * `reviewScheduleTargetsConsumableCardPredicate` 各加了一句"来源笔记不在回收站"），
 * 所以这份夹具要证明的不是"写没写状态"，而是三件事：
 *   1. 软删之前，队列/卡列表/首页那颗数都看得见它（正控制——否则"消失"是假绿）；
 *   2. 软删之后，三处一起消失（不是只有一处判）；
 *   3. **恢复之后三处一起回来**（派生判据自愈；写成状态就得再有一套放回的机器，
 *      那套机器漏一次，卡就永久丢了）。
 * 再加一条对照：没有来源笔记的卡（`note_version_id IS NULL`）不受这条影响。
 *
 * 两种角色各跑一遍（L43 的教训）：夹具写用超级用户，读数也在同一份库；
 * 把 `DATABASE_URL_API` 指成 `ailearn_api` 再跑一次才是生产形状。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("L16 集测要求 DATABASE_URL（夹具要写 notes/cards/schedules 全链）");
}
const sql = postgres(CONN, { max: 3 });

const { seedV2Fixture } = await import("./helpers/v2-card-fixture.ts");
const { listReviews } = await import("../modules/review/service.ts");
const { listActiveCardsV2 } = await import("../modules/card-generation-v2/card-service.ts");

type Seeded = Awaited<ReturnType<typeof seedV2Fixture>>;

const seeded: Seeded[] = [];

async function insertDueSchedule(target: Seeded, subjectId: string): Promise<string> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${target.userId}, true)`;
    await tx`
      INSERT INTO review_schedules
        (id, workspace_id, user_id, subject_type, subject_id, status,
         next_review_at, interval_days, generation, policy_version, reason_code,
         created_at, updated_at)
      VALUES
        (${id}, ${target.workspaceId}, ${target.userId}, 'card', ${subjectId}, 'pending',
         now() - interval '1 hour', 1, 1, 'l16-fixture', 'fixture', now(), now())
    `;
  });
  return id;
}

async function queueObjectiveIds(target: Seeded): Promise<string[]> {
  const page = await listReviews(
    target.workspaceId,
    { includeAll: false, limit: 50 },
    target.userId,
  );
  return page.items.map((item) => String(item.review.subjectId));
}

async function listedCardIds(target: Seeded): Promise<string[]> {
  const page = await listActiveCardsV2(
    { workspaceId: target.workspaceId, userId: target.userId },
    { limit: 50 },
  );
  return page.items.map((card) => String(card.cardId));
}

async function setNoteTrashed(target: Seeded, trashed: boolean): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    if (trashed) {
      await tx`UPDATE notes SET deleted_at = now() WHERE id = ${target.noteId}`;
    } else {
      await tx`UPDATE notes SET deleted_at = NULL WHERE id = ${target.noteId}`;
    }
  });
}

before(async () => {
  const derived = await seedV2Fixture(sql);
  seeded.push(derived);
  await insertDueSchedule(derived, derived.objectiveId);

  // 对照组：一张没有来源笔记的卡（手动建立的目标卡）+ 它自己的排程。
  const manual = await seedV2Fixture(sql);
  seeded.push(manual);
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${manual.workspaceId}, true)`;
    await tx`UPDATE learning_cards_v2 SET note_version_id = NULL WHERE card_id = ${manual.cardId}`;
  });
  await insertDueSchedule(manual, manual.objectiveId);
});

after(async () => {
  for (const target of seeded) await target.cleanup();
  await sql.end();
  // 两个 service 用的是 app 自己那份连接池；不 close 进程就不退出
  // （用例全绿然后挂死，是这类集测最常见的假象）。
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("正控制：来源笔记还活着时，队列与卡列表都读得到这张卡", async () => {
  const target = seeded[0];
  assert.ok(
    (await queueObjectiveIds(target)).includes(target.objectiveId),
    "夹具的排程没进队列——后面所有「消失了」的断言都会是假绿",
  );
  assert.ok(
    (await listedCardIds(target)).includes(target.cardId),
    "夹具的卡没进卡列表——同上",
  );
});

test("软删来源笔记：队列与卡列表一起收口", async () => {
  const target = seeded[0];
  await setNoteTrashed(target, true);
  assert.ok(
    !(await queueObjectiveIds(target)).includes(target.objectiveId),
    "笔记进了回收站，它的卡还在到期队列里（L16 的原症状）",
  );
  assert.ok(
    !(await listedCardIds(target)).includes(target.cardId),
    "队列挡住了、卡列表没挡——判据只装在半条路上",
  );
});

test("恢复笔记：两处一起回来，不需要谁去改卡的状态", async () => {
  const target = seeded[0];
  await setNoteTrashed(target, false);
  assert.ok(
    (await queueObjectiveIds(target)).includes(target.objectiveId),
    "恢复之后队列里没有它：卡被这次删除永久弄丢了",
  );
  assert.ok(
    (await listedCardIds(target)).includes(target.cardId),
    "恢复之后卡列表里没有它：同上",
  );
});

test("没有来源笔记的卡不受这条判据影响", async () => {
  const manual = seeded[1];
  assert.ok(
    (await queueObjectiveIds(manual)).includes(manual.objectiveId),
    "`note_version_id IS NULL` 的卡被一起挡掉了——那一支 IS NULL 的豁免没生效",
  );
  // 把它的笔记也"删掉"（这张卡已经不指向它了），队列必须照旧。
  await setNoteTrashed(manual, true);
  assert.ok(
    (await queueObjectiveIds(manual)).includes(manual.objectiveId),
    "删掉一篇与该卡无关的笔记，却把卡从队列里摘走了",
  );
  await setNoteTrashed(manual, false);
});
