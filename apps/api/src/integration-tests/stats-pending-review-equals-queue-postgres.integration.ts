/**
 * doc 34 L23 —— "待复习"这一句读数只许一个来源。
 *
 * 断言写成**等式**而不是我手算一个数：屏幕上"待复习"那颗数（`/stats/overview` 的
 * `pendingReviewCount`）必须**等于**用户点进复习列表看到的条数（`listReviews` 的 total）。
 * 以前它数的是"全部 pending 排程"——不判到点、不判延后、不判卡还可不可消费，
 * 于是恒大于列表，而且两份判据各写一遍、改一处不会让另一处红。
 *
 * 三种排程各一条：到点的、没到点的、到点但她说过"稍后"的。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("L23 集测要求 DATABASE_URL（要造排程行）");
}
const sql = postgres(CONN, { max: 3 });

const { seedV2Fixture } = await import("./helpers/v2-card-fixture.ts");
const { listReviews } = await import("../modules/review/service.ts");
const { getStatsOverview } = await import("../modules/stats/service.ts");

const seeded: Awaited<ReturnType<typeof seedV2Fixture>>[] = [];

async function insertSchedule(
  target: { workspaceId: string; userId: string; objectiveId: string },
  opts: { nextReviewDays: number; deferredDaysFromNow?: number },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    await tx`
      INSERT INTO review_schedules
        (id, workspace_id, user_id, subject_type, subject_id, status,
         next_review_at, user_deferred_until, interval_days, generation,
         policy_version, reason_code, created_at, updated_at)
      VALUES
        (${randomUUID()}, ${target.workspaceId}, ${target.userId}, 'card', ${target.objectiveId},
         'pending',
         now() + (${opts.nextReviewDays} * interval '1 day'),
         ${opts.deferredDaysFromNow === undefined
    ? null
    : new Date(Date.now() + opts.deferredDaysFromNow * 86_400_000)},
         1, 1, 'l23-fixture', 'fixture', now(), now())
    `;
  });
}

before(async () => {
  const target = await seedV2Fixture(sql);
  seeded.push(target);
  await insertSchedule(target, { nextReviewDays: -1 });
  await insertSchedule(target, { nextReviewDays: 2 });
  await insertSchedule(target, { nextReviewDays: -1, deferredDaysFromNow: 1 });
});

after(async () => {
  for (const target of seeded) await target.cleanup();
  await sql.end();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("读数对得上：只有到点且没被「稍后」挡住的那条算待复习", async () => {
  const target = seeded[0];
  const queue = await listReviews(target.workspaceId, { includeAll: false, limit: 50 }, target.userId);
  const overview = await getStatsOverview(target.workspaceId, target.userId);
  assert.equal(queue.total, 1, `夹具三条排程应当只剩 1 条到点，实际 ${queue.total} 条——队列判据变了`);
  assert.equal(
    overview.pendingReviewCount,
    queue.total,
    `屏幕上的"待复习"(${overview.pendingReviewCount}) 与列表条数(${queue.total}) 不是同一个数`,
  );
});

test("正向对照：把到点那条推到未来，两个数一起变成 0", async () => {
  const target = seeded[0];
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    await tx`
      UPDATE review_schedules
      SET next_review_at = now() + interval '9 days', user_deferred_until = NULL
      WHERE workspace_id = ${target.workspaceId}
    `;
  });
  const queue = await listReviews(target.workspaceId, { includeAll: false, limit: 50 }, target.userId);
  const overview = await getStatsOverview(target.workspaceId, target.userId);
  assert.equal(queue.total, 0, "推到 9 天之后队列还有条数——到点那一半没判");
  assert.equal(overview.pendingReviewCount, queue.total, "两个数只在有内容时相等，边界上不成立");
});
