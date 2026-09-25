/**
 * 她作为泄露源的记账（39b §9.7 / D7 §6；39d W2-6）——真库三条：
 * 题目身份、幂等、换人读写不到。
 *
 * 为什么单独一支：这条链路**没有模型参与**（判据是集合关系，写入在服务端），所以它可以
 * 完全确定性地在真库上验；而它写进的是"这一题还能不算独立证明"的那张表
 * （`target-snapshot-adapter` 会读回去算冷却窗口），写错一次就会污染正式判定资格。
 *
 * 角色纪律同 `companion-turn-facts`：夹具写走超级用户（`DATABASE_URL`），被测读数走
 * `DATABASE_URL_WORKER`（受限角色）；RLS 那一腿用 `SET LOCAL ROLE ailearn_api` 在
 * **同一条超级用户连接**里量（受限角色自己 SET ROLE 不了）。
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { FormalAnswerFixture } from "./helpers/formal-answer-fixture.ts";

const ADMIN_CONN = process.env.DATABASE_URL ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@127.0.0.1:5432/ailearn";
const sql = postgres(ADMIN_CONN, { max: 2 });

const { findFormalAnswerTarget } = await import("../lib/formal-answer-signal.ts");
const { recordCompanionAnswerExposure } = await import("../handlers/companion-answer-exposure.ts");
const { seedFormalAnswerRun } = await import("./helpers/formal-answer-fixture.ts");
const { withWorkerWorkspaceTransaction } = await import("../db.ts");

let fixture: FormalAnswerFixture;

before(async () => {
  fixture = await seedFormalAnswerRun(sql);
});

after(async () => {
  await fixture.cleanup();
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase().catch(() => undefined);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

function learnerScope(f: FormalAnswerFixture) { return { workspaceId: f.workspaceId, userId: f.userId }; }

test("正在作答的那一题：身份取到的是这一轮**冻结的那一版**，别人取不到", async () => {
  const target = await withWorkerWorkspaceTransaction(learnerScope(fixture),
    (tx) => findFormalAnswerTarget(tx, learnerScope(fixture)));
  assert.ok(target, "判据没认出这一题（夹具的 variant/phase 对不上？）");
  assert.equal(target.objectiveId, fixture.objectiveId);
  assert.equal(target.objectiveRevision, 1, "objective_revision 必须是快照里那一版，不是目标当前版");
  assert.equal(target.cardId, fixture.cardId);
  assert.equal(target.taskPrompt, fixture.taskPrompt);
  assert.ok(target.canonicalAnswer?.includes("选择性"), "答案原文没带出来，泄露判据就没有对照物");

  // 正向对照的另一半：同空间另一位成员没有正在作答的轮次 ⇒ 拿不到身份（写入门不会被她绕过去）。
  const asOther = await withWorkerWorkspaceTransaction(
    { workspaceId: fixture.workspaceId, userId: fixture.otherUserId },
    (tx) => findFormalAnswerTarget(tx, { workspaceId: fixture.workspaceId, userId: fixture.otherUserId }));
  assert.equal(asOther, null, "别人的会话解析到了这个人的题目");
});

test("记一笔、再记一次仍是一笔（幂等用现成唯一键，不另建去重）", async () => {
  const companionRunId = randomUUID();
  const target = await withWorkerWorkspaceTransaction(learnerScope(fixture),
    (tx) => findFormalAnswerTarget(tx, learnerScope(fixture)));
  assert.ok(target);
  const record = () => withWorkerWorkspaceTransaction(learnerScope(fixture), (tx) =>
    recordCompanionAnswerExposure(tx, {
      workspaceId: fixture.workspaceId,
      userId: fixture.userId,
      companionRunId,
      target: target!,
      kind: "answer_reveal",
    }));
  assert.equal(await record(), true, "第一次没写进去");
  assert.equal(await record(), false, "同一个伴星轮次记了两笔（撞幂等键要当幂等处理）");
  const rows = await sql`SELECT exposure_kind, objective_id, objective_revision, idempotency_key
                         FROM learning_exposures_v2 WHERE workspace_id = ${fixture.workspaceId}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exposure_kind, "answer_reveal");
  assert.equal(String(rows[0].objective_id), fixture.objectiveId);
  assert.equal(rows[0].objective_revision, 1);
  assert.equal(rows[0].idempotency_key, `companion-turn:${companionRunId}`);
});

test("换 user 读不到这笔账，也替别人写不进（RLS 对 worker 形同不存在）", async () => {
  const companionRunId = randomUUID();
  const target = await withWorkerWorkspaceTransaction(learnerScope(fixture),
    (tx) => findFormalAnswerTarget(tx, learnerScope(fixture)));
  await withWorkerWorkspaceTransaction(learnerScope(fixture), (tx) =>
    recordCompanionAnswerExposure(tx, {
      workspaceId: fixture.workspaceId,
      userId: fixture.userId,
      companionRunId,
      target: target!,
      kind: "evidence_reveal",
    }));

  const asOwner = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ailearn_api`;
    await tx`SELECT set_config('app.workspace_id', ${fixture.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${fixture.userId}, true)`;
    return tx`SELECT exposure_kind FROM learning_exposures_v2 WHERE workspace_id = ${fixture.workspaceId}`;
  });
  // 只断言"读得到 >= 1"：上一条用例在这个空间里也记过一笔，跨用例数总条数会假红。
  assert.ok(asOwner.length >= 1, "本人（API 角色）读不到自己的暴露行——上面那笔没落地");

  const asOther = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ailearn_api`;
    await tx`SELECT set_config('app.workspace_id', ${fixture.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${fixture.otherUserId}, true)`;
    return tx`SELECT 1 FROM learning_exposures_v2 WHERE workspace_id = ${fixture.workspaceId}`;
  });
  assert.equal(asOther.length, 0, "同空间另一位成员读到了别人的暴露账目");

  // 替别人写这一笔：策略必须直接拒。**独立事务**里试——事务内一旦报错整事务就废了，
  // 把 `.catch` 写在事务里只会得到 current transaction is aborted。
  let rejectedWith: string | null = null;
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ailearn_api`;
      await tx`SELECT set_config('app.workspace_id', ${fixture.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${fixture.otherUserId}, true)`;
      await tx`
        INSERT INTO learning_exposures_v2
          (id, workspace_id, exposure_id, user_id, objective_id, objective_revision,
           exposure_kind, context_hash, idempotency_key, exposed_at)
        VALUES (${randomUUID()}, ${fixture.workspaceId}, ${randomUUID()}, ${fixture.userId},
                ${fixture.objectiveId}, 1, 'answer_reveal', 'probe', ${`probe-${randomUUID()}`}, now())
      `;
    });
  } catch (error) {
    rejectedWith = String((error as Error).message);
  }
  assert.ok(rejectedWith, "API 角色替别人写进了暴露账目（该表的策略没执行）");
  assert.match(rejectedWith, /row-level security/, `拒的原因不是策略：${rejectedWith}`);
});
