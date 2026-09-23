/**
 * doc 34 L38 —— 成员退出/被移出之后，"跟这个空间有关的那一份记忆"收掉。
 *
 * 用户给的口径：记忆归属于个人，`scope='workspace'` 的那一份只是关联到空间；
 * 人走就收，`scope='global'`（带 `global_key`）跟着人走不动。
 *
 * 夹具写用超级用户（`DATABASE_URL`），被测走 app 自己的池（`DATABASE_URL_API` 存在时
 * 就是 `ailearn_api`）——同一份库两种角色各跑一遍（doc 34 §1.2 ④ 那条判据）。
 *
 * 最后一条用例守的是**这件事为什么必须有那支 SECURITY DEFINER 函数**：
 * 按调用方身份直接 UPDATE 恒匹配 0 行。哪天有人把函数"简化"成一句 SQL，那条会红。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql as dsql } from "drizzle-orm";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) {
  throw new Error("L38 集测要求 DATABASE_URL（夹具要写 users/workspaces/memories 全链）");
}
const admin = postgres(ADMIN, { max: 2 });

const { withWorkspaceTransaction } = await import("../db/client.ts");
const { removeMember } = await import("../modules/identity/invite-service.ts");
const { leaveWorkspace } = await import("../modules/identity/service.ts");

const ws = randomUUID();
const owner = randomUUID();
const member = randomUUID();
const bystander = randomUUID();
const memberPersonal = randomUUID();
const bystanderPersonal = randomUUID();

const mem = {
  memberWorkspace: randomUUID(),
  memberWorkspaceSecond: randomUUID(),
  memberGlobal: randomUUID(),
  bystanderWorkspace: randomUUID(),
};

async function memoryRow(id: string) {
  const rows = await admin`
    SELECT deleted_at, updated_at, scope, workspace_id, user_id
    FROM assistant_memory_items WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

before(async () => {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`
      INSERT INTO users (id, email, password_hash, role)
      VALUES
        (${owner}, ${`l38-owner-${ws.slice(0, 8)}@example.test`}, 'h', 'owner'),
        (${member}, ${`l38-member-${ws.slice(0, 8)}@example.test`}, 'h', 'owner'),
        (${bystander}, ${`l38-bystander-${ws.slice(0, 8)}@example.test`}, 'h', 'owner')
    `;
    await tx`
      INSERT INTO workspaces (id, name, owner_id, workspace_type)
      VALUES
        (${ws}, ${`l38-ws-${ws.slice(0, 8)}`}, ${owner}, 'collaborative'),
        (${memberPersonal}, ${`l38-personal-${ws.slice(0, 8)}`}, ${member}, 'personal'),
        (${bystanderPersonal}, ${`l38-personal-b-${ws.slice(0, 8)}`}, ${bystander}, 'personal')
    `;
    await tx`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${ws}, ${owner}, 'owner'), (${ws}, ${member}, 'member'), (${ws}, ${bystander}, 'member')
    `;
    await tx`UPDATE users SET personal_workspace_id = ${memberPersonal} WHERE id = ${member}`;
    await tx`UPDATE users SET personal_workspace_id = ${bystanderPersonal} WHERE id = ${bystander}`;

    for (const [id, userId, scope, workspaceId] of [
      [mem.memberWorkspace, member, "workspace", ws],
      [mem.memberWorkspaceSecond, member, "workspace", ws],
      [mem.memberGlobal, member, "global", ws],
      [mem.bystanderWorkspace, bystander, "workspace", ws],
    ] as const) {
      await tx`
        INSERT INTO assistant_memory_items
          (id, workspace_id, user_id, kind, content, scope, global_key)
        VALUES (
          ${id}, ${workspaceId}, ${userId}, 'preference',
          ${`l38 ${scope} ${id.slice(0, 6)}`}, ${scope},
          ${scope === "global" ? id : null}
        )
      `;
    }
  });
});

after(async () => {
  await admin`DELETE FROM assistant_memory_items WHERE workspace_id = ${ws}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
  await admin`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${member}, ${bystander})`;
  await admin`DELETE FROM workspaces WHERE id IN (${ws}, ${memberPersonal}, ${bystanderPersonal})`;
  await admin`DELETE FROM users WHERE id IN (${owner}, ${member}, ${bystander})`;
  await admin.end();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("被移出：这个人关联到该空间的记忆全被收掉，跟人走的那一份不动", async () => {
  const result = await removeMember(ws, owner, member);
  assert.equal(result.ok, true, `removeMember 失败：${JSON.stringify(result)}`);

  assert.ok(await memoryRow(mem.memberWorkspace), "夹具行不见了——收口不该删行，是软删除");
  assert.notEqual(
    (await memoryRow(mem.memberWorkspace))!.deleted_at,
    null,
    "被移出的成员在这个空间里的记忆还挂着 deleted_at=NULL（L38 没收口）",
  );
  assert.notEqual((await memoryRow(mem.memberWorkspaceSecond))!.deleted_at, null, "第二行漏收");
  assert.equal(
    (await memoryRow(mem.memberGlobal))!.deleted_at,
    null,
    "scope=global 的记忆跟人走，不该被一次退出抹掉",
  );
  assert.equal(
    (await memoryRow(mem.bystanderWorkspace))!.deleted_at,
    null,
    "把别人的记忆一起收了——判据少了 user_id 那一半",
  );
});

test("再收一次不重复劳动：0 行、已收过的行时间戳不被推走", async () => {
  const beforeUpdated = (await memoryRow(mem.memberWorkspace))!.updated_at as Date;
  const retired = await withWorkspaceTransaction({ workspaceId: ws, userId: owner }, (tx) =>
    tx.execute(dsql`
      SELECT public.ailearn_retire_workspace_memories_on_departure(
        ${ws}::uuid, ${member}::uuid) AS n
    `).then((rows) => Number((rows[0] as { n: number }).n)),
  );
  assert.equal(retired, 0, "已经收过的行被第二次收口又算进来了");
  const after = (await memoryRow(mem.memberWorkspace))!;
  assert.equal(after.updated_at.getTime(), beforeUpdated.getTime(), "重复调用重写了行");
});

test("自退那条路同样收口（两条路少一条就是半条）", async () => {
  // member 已被移出：自退这条路对它只剩 not_member，说明两条路都收得住同一个事实。
  const alreadyGone = await leaveWorkspace(member, ws);
  assert.deepEqual(alreadyGone, { ok: false, error: "not_member" });

  const left = await leaveWorkspace(bystander, ws);
  assert.equal(left.ok, true, `bystander 自退失败：${JSON.stringify(left)}`);
  assert.notEqual(
    (await memoryRow(mem.bystanderWorkspace))!.deleted_at,
    null,
    "removeMember 收了、leaveWorkspace 没收——判据只装在半条路上",
  );
});

test("为什么必须有那支函数：按调用方身份直接 UPDATE 是静默 0 行", async (t) => {
  // 这条验的是**策略**，超级用户下它必然不成立（BYPASSRLS 改得动任何行）。
  // 与其让它在 dev 默认串下假红，不如明确说它要哪把尺子。
  if (!process.env.DATABASE_URL_API) {
    t.skip("需要 DATABASE_URL_API 指向受限角色（ailearn_api）——被测的是行级策略本身");
    return;
  }

  const matched = await withWorkspaceTransaction({ workspaceId: ws, userId: owner }, (tx) =>
    tx.execute(dsql`
      UPDATE assistant_memory_items SET updated_at = now()
      WHERE workspace_id = ${ws}::uuid AND user_id = ${bystander}::uuid
    `).then((rows) => rows.length),
  );
  // 这句话在 dev（BYPASSRLS 的 ailearn）下永远"看起来没事"，受限角色下才现形：
  // owner 的上下文改不动别人的行，而且不报错。
  assert.equal(
    matched,
    0,
    "owner 上下文里的裸 UPDATE 竟然动到了别人的记忆——策略或角色形状变了，"
    + "那支 SECURITY DEFINER 函数的理由要重新写",
  );
});
