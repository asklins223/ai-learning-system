/**
 * doc 34 L14 —— "换了措辞的同一件事"要被认成同一件事（用户 2026-09-23 拍的口径 ①）。
 *
 * **向量是本测试构造的**：这里测的是机制（两边都有向量时，语义距离过阈值就把新那条
 * 也继承"已忽略"），不是阈值的出处——出处只有一次实测，写在
 * `MEMORY_SEMANTIC_SIMILARITY_THRESHOLD` 的注释里（dev 库 7 行 / 21 对互不相关的记忆，
 * cosine similarity 最大 0.663）。真实改写对要等有真的 embedding 才能校准，
 * 那条限制在那段注释里，不在这里假装解决。
 *
 * 角色：夹具写用 `DATABASE_URL`（超级用户），判定走 worker 自己的事务
 * （`DATABASE_URL_WORKER` = `ailearn_worker`）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) throw new Error("需要 DATABASE_URL（夹具建 user/workspace/memories）");
const sql = postgres(ADMIN, { max: 2 });

const { withWorkerWorkspaceTransaction } = await import("../db.ts");
const { dismissSemanticTwin } = await import("../handlers/companion-memory-embedding.ts");

const workspaceId = randomUUID();
const userId = randomUUID();
const dismissedId = randomUUID();
const freshId = randomUUID();
const unrelatedId = randomUUID();

/** 1024 维（dev 的向量列就是 1024）：前两维承载全部角度，其余为 0。 */
function vec(cos: number): string {
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  return `[${cos},${sin},${Array.from({ length: 1022 }, () => 0).join(",")}]`;
}
// "我喜欢夜间记录"与"白天只做采集"这类改写对，字面相似度被实测证明挡不住；
// 这里用 cos 0.9 / 0.4 两个点把"过阈值 / 不过阈值"两种结果各测一次。
const NEAR = vec(0.9);
const FAR = vec(0.4);

before(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`sem-${workspaceId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type)
      VALUES (${workspaceId}, ${`sem-${workspaceId.slice(0, 8)}`}, ${userId}, 'personal')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
    for (const [id, content, dismissed] of [
      [dismissedId, "她习惯在夜间写笔记，白天只做采集", true],
      [freshId, "晚上记笔记、白天收材料——同一种安排", false],
      [unrelatedId, "第一次独立完成三分钟微旅程验证", false],
    ] as const) {
      await tx`
        INSERT INTO assistant_memory_items
          (id, workspace_id, user_id, kind, content, candidate, scope, embedding_status,
           dismissed_at, created_at, updated_at)
        VALUES (${id}, ${workspaceId}, ${userId}, 'preference', ${content},
                false, 'workspace', 'ready',
                ${dismissed ? new Date() : null}, now(), now())
      `;
    }
    await tx`
      INSERT INTO assistant_memory_embeddings (memory_id, workspace_id, user_id, embedding, model_revision, updated_at)
      VALUES (${dismissedId}, ${workspaceId}, ${userId}, ${NEAR}::vector, 'BAAI/bge-m3', now())
    `;
  });
});

after(async () => {
  await sql`DELETE FROM assistant_memory_embeddings WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM assistant_memory_items WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
  await sql.end();
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase();
});

async function dismissedAtOf(id: string): Promise<Date | null> {
  const rows = await sql`SELECT dismissed_at FROM assistant_memory_items WHERE id = ${id}`;
  return rows[0]?.dismissed_at ?? null;
}

test("语义上过阈值的候选继承「已忽略」，而不是被删掉", async () => {
  const hit = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    dismissSemanticTwin(tx, { workspaceId, userId, memoryId: freshId, embedding: NEAR }));
  assert.equal(hit, true, "近义改写没被判成同一件事（L14 的后半没闭上）");
  assert.ok(await dismissedAtOf(freshId), "只报了命中，行上没有 dismissed_at");
  const stillThere = await sql`SELECT id FROM assistant_memory_items WHERE id = ${freshId}`;
  assert.equal(stillThere.length, 1, "把记忆删了——「她忽略过什么」的记录不能少");
});

test("对照：语义不近的不许继承（误挡比漏挡贵）", async () => {
  const hit = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    dismissSemanticTwin(tx, { workspaceId, userId, memoryId: unrelatedId, embedding: FAR }));
  assert.equal(hit, false, "一条不相关的记忆被判成她忽略过的事——阈值或判据太宽");
  assert.equal(await dismissedAtOf(unrelatedId), null);
});

test("幂等：已经判过的不再重复劳动", async () => {
  const hit = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    dismissSemanticTwin(tx, { workspaceId, userId, memoryId: freshId, embedding: NEAR }));
  assert.equal(hit, false, "第二次还被算成一次新收口");
});

test("别人的已忽略不能替她决定：跨用户不成立", async () => {
  // 上一版这条测的不是它说的事：`target` 属于 userId，而 before() 里已经有一条
  // **她自己的**已忽略记忆带着 NEAR 向量——那次命中是真阳性，`false` 才是错的。
  // 这一版把"被判定的人"换成一个自己没有任何已忽略记忆的新成员，只留别人的已忽略+向量。
  const other = randomUUID();
  const otherMemory = randomUUID();
  const probeOwner = randomUUID();
  const probeMemory = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${other}, ${`sem-x-${other.slice(0, 8)}@example.test`}, 'h', 'owner'),
              (${probeOwner}, ${`sem-p-${probeOwner.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${other}, 'member'), (${workspaceId}, ${probeOwner}, 'member')`;
    await tx`INSERT INTO assistant_memory_items
      (workspace_id, user_id, kind, content, scope, embedding_status, dismissed_at, id)
      VALUES (${workspaceId}, ${other}, 'preference', '她忽略的那条',
              'workspace', 'ready', now(), ${otherMemory})`;
    await tx`INSERT INTO assistant_memory_embeddings
      (memory_id, workspace_id, user_id, embedding, model_revision, updated_at)
      VALUES (${otherMemory}, ${workspaceId}, ${other}, ${NEAR}::vector, 'BAAI/bge-m3', now())`;
    await tx`INSERT INTO assistant_memory_items
      (workspace_id, user_id, kind, content, scope, embedding_status, id)
      VALUES (${workspaceId}, ${probeOwner}, 'preference', '我的另一条',
              'workspace', 'ready', ${probeMemory})`;
  });

  const hit = await withWorkerWorkspaceTransaction({ workspaceId, userId: probeOwner }, (tx) =>
    dismissSemanticTwin(tx, { workspaceId, userId: probeOwner, memoryId: probeMemory, embedding: NEAR }));
  assert.equal(hit, false, "判据丢了 user_id：别人忽略过的事把她的记忆也判死了");
  const stillFresh = await sql`SELECT dismissed_at FROM assistant_memory_items WHERE id = ${probeMemory}`;
  assert.equal(stillFresh[0].dismissed_at, null, "函数没改，但行还是被别的判据改了");

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM assistant_memory_embeddings WHERE memory_id = ${otherMemory}`;
    await tx`DELETE FROM assistant_memory_items WHERE id IN (${otherMemory}, ${probeMemory})`;
    await tx`DELETE FROM workspace_members WHERE user_id IN (${other}, ${probeOwner})`;
    await tx`DELETE FROM users WHERE id IN (${other}, ${probeOwner})`;
  });
});
