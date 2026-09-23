/**
 * doc 34 L17 —— 30 天清除到底清不清得掉东西。
 *
 * 这条承诺此前**一层测试都没有**：`purgeSoftDeletedNotes` 没有单测，也没有集测，
 * 所以它"在生产里恒 0 行"（L37 症状 A）才能一直不被发现。这里钉三件事：
 *   1. 过期的、没有卡引用的笔记真的会被物理删掉（否则"清道夫在跑"是假的）；
 *   2. 没到过 30 天的不动（保留窗口是承诺的一部分）；
 *   3. **生成过卡的那篇删不掉**——这是 L17 的原症状，写成断言而不是注释，
 *      将来谁把外键改掉或者补上卡的清理，这条会红，逼他同步改这里的说法。
 *
 * 角色：夹具用超级用户写（`DATABASE_URL`），清除走的是 app 自己的连接池
 * （`DATABASE_URL_API` 存在时就是 `ailearn_api`）。两种角色各跑一遍。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("purge 集测要求 DATABASE_URL（要造 40 天前的软删行）");
}
const sql = postgres(CONN, { max: 3 });

const { seedV2Fixture } = await import("./helpers/v2-card-fixture.ts");
const { listReviews } = await import("../modules/review/service.ts");
const { listActiveCardsV2 } = await import("../modules/card-generation-v2/card-service.ts");
const { purgeSoftDeletedNotes } = await import("../modules/note/maintenance.ts");

const tag = Math.random().toString(36).slice(2, 8);
const ids = {
  staleClean: "",
  staleWithCard: "",
  fresh: "",
  workspace: "",
  cardId: "",
};

const seeded: Array<Awaited<ReturnType<typeof seedV2Fixture>>> = [];
let firstPurgeCount = -1;
const trashed: Array<{ cleanup: () => Promise<void> }> = [];

before(async () => {
  const first = await seedV2Fixture(sql);
  trashed.push(first);
  seeded.push(first);
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${first.workspaceId}, true)`;
    await tx`
      INSERT INTO review_schedules
        (id, workspace_id, user_id, subject_type, subject_id, status,
         next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${first.workspaceId}, ${first.userId}, 'card', ${first.objectiveId},
              'pending', now() - interval '1 hour', 1, 1, 'l17-fixture', 'fixture', now(), now())
    `;
  });
  ids.workspace = first.workspaceId;
  ids.staleWithCard = first.noteId;
  ids.cardId = first.cardId;

  // 同一空间里再造两篇：一篇过期且无卡引用，一篇刚删 5 天。
  for (const [name, ageDays] of [["staleClean", 40], ["fresh", 5]] as const) {
    const noteId = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${first.workspaceId}, true)`;
      await tx`
        INSERT INTO notes (id, workspace_id, title, created_by, deleted_at)
        VALUES (${noteId}, ${first.workspaceId}, ${`purge-${name}-${tag}`},
                ${first.userId}, now() - (${ageDays} * interval '1 day'))
      `;
    });
    ids[name] = noteId;
  }

  // 让"过期且无卡"那一行确实过期：fixture 那篇也推到 40 天前。
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${first.workspaceId}, true)`;
    await tx`UPDATE notes SET deleted_at = now() - interval '40 days' WHERE id = ${first.noteId}`;
  });
});

after(async () => {
  for (const target of trashed) await target.cleanup();
  await sql.end();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("L17：生成过卡的那篇现在删得掉——卡退役、指针置空、不回队列", async () => {
  const target = seeded[0];
  // 正控制要先把笔记放回"活着"的状态：L16 之后，回收站里那篇笔记的卡本来就不该在队列里，
  // 拿那个状态当"删除之前"会让下面那句「删完不在队列」变成同义反复。
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    await tx`UPDATE notes SET deleted_at = NULL WHERE id = ${ids.staleWithCard}`;
  });
  // 正控制用**卡列表**那一路：夹具产出的目标没有过激活闸门，到期队列一开始本来就不该收它
  // （第一版我拿队列当正控制，红的是我自己那句前提）。删除之后"不回队列"仍然是硬断言——
  // 那才是 0274 头部写的陷阱：置空指针 + 卡仍 active 时，队列会把它收回去。
  assert.ok(
    (await listActiveCardsV2({ workspaceId: target.workspaceId, userId: target.userId }, { limit: 50 }))
      .items.some((card) => String(card.cardId) === target.cardId),
    "夹具的卡一开始就不在卡列表里，同上",
  );

  // 回到"过期且在回收站"的状态，这次让清除任务真去删它。
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    await tx`UPDATE notes SET deleted_at = now() - interval '40 days' WHERE id = ${ids.staleWithCard}`;
  });

  // 整轮清除的"真的删掉了东西"这条正控制记在这里：后面那条用例再跑一次 purge，
  // 库里已经没有可删的行，计数必然是 0。
  firstPurgeCount = await purgeSoftDeletedNotes(30);

  const gone = await sql`SELECT id FROM notes WHERE id = ${ids.staleWithCard}`;
  assert.equal(gone.length, 0, "生成过卡的笔记还是删不掉——0274 的那半（SET NULL）没生效");

  const card = await sql`
    SELECT lifecycle, note_version_id FROM learning_cards_v2 WHERE card_id = ${ids.cardId}
  `;
  assert.equal(card.length, 1, "卡被连带删掉了——用户要的是「卡留着但退役」");
  assert.equal(card[0].lifecycle, "archived", "卡没退役：physicalDeleteNote 里那一步没生效");
  assert.equal(card[0].note_version_id, null, "来源版本行没了而指针还指着它");

  const after = await sql`SELECT count(*)::int AS n FROM learning_objectives_v2
    WHERE objective_id = ${seeded[0].objectiveId} AND lifecycle = 'active'`;
  assert.equal(after[0].n, 0, "目标还 active：它唯一那张活卡已退役，队列判据可能不一致");

  // 反陷阱（0274 头部写的那条）：指针置空之后，这张卡绝不能经
  // `visibleCardsCondition` 的 IS NULL 那一支重新变得可服务。
  assert.ok(
    !(await listReviews(target.workspaceId, { includeAll: false, limit: 50 }, target.userId))
      .items.some((item) => String(item.review.subjectId) === target.objectiveId),
    "删完笔记，退役的卡回到到期队列了——顺序被写成先断线后退役了",
  );
  assert.ok(
    !(await listActiveCardsV2({ workspaceId: target.workspaceId, userId: target.userId }, { limit: 50 }))
      .items.some((card2) => String(card2.cardId) === ids.cardId),
    "删完笔记，退役的卡回到卡列表了",
  );
});


test("正控制：那一次清除真的删掉了行，而且没到保留期的不动", async () => {
  assert.ok(firstPurgeCount >= 1, `整轮清除报删了 ${firstPurgeCount} 篇——扫描或事务上下文是瞎的`);
  const gone = await sql`SELECT id FROM notes WHERE id = ${ids.staleClean}`;
  assert.equal(gone.length, 0, "过期且没有卡引用的笔记还在：30 天清除没真的删东西");
  const still = await sql`SELECT id FROM notes WHERE id = ${ids.fresh}`;
  assert.equal(still.length, 1, "刚删 5 天的笔记被清了——30 天窗口没被尊重");
});
