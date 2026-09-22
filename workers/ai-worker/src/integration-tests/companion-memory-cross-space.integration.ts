/**
 * 跨空间记忆同步（2026-09-22 Owner 裁决：「跟空间关联性不强的记忆也是需要带过去的」）。
 *
 * 钉住三件事：
 *   1. `global` 记忆会被铺到该用户的**每一个**活跃空间（0267 的铺开函数）；
 *   2. 与空间绑定的种类**不会**被铺（否则"目标"会跑到另一个空间去，那里的卡片
 *      和笔记并不存在）；
 *   3. 后来加入的新空间会**补铺**已有的 global 记忆——否则"同步"只在写入那一刻
 *      成立，之后加入的空间永远是空的。
 *
 * 每条负向断言都配正向对照：只报"没铺"的话，铺开函数彻底不工作时同样绿。
 *
 * 真 Postgres。用超级用户连接写夹具（绕过 RLS 建多空间），断言走真实函数。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { memoryScopeForKind } from "../handlers/companion-memory-extractor.ts";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

const tag = randomUUID();
const userId = randomUUID();
const spaceA = randomUUID();
const spaceB = randomUUID();
const spaceC = randomUUID();

async function seedSpace(workspaceId: string, name: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type)
             VALUES (${workspaceId}, ${name}, ${userId}, 'collaborative')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
             VALUES (${workspaceId}, ${userId}, 'owner')`;
  });
}

await sql.begin(async (tx) => {
  await tx`INSERT INTO users (id, email, password_hash, role)
           VALUES (${userId}, ${`xspace-${tag}@x.test`}, 'h', 'owner')`;
});
await seedSpace(spaceA, `xspace-A-${tag}`);
await seedSpace(spaceB, `xspace-B-${tag}`);

/** 在 spaceA 里插一条记忆，返回它的 id。 */
async function insertMemory(kind: string, scope: string, content: string): Promise<string> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${spaceA}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO assistant_memory_items
               (id, workspace_id, user_id, kind, content, scope, source_event_id,
                candidate, importance, confidence, source_type, embedding_status)
             VALUES (${id}, ${spaceA}, ${userId}, ${kind}, ${content}, ${scope},
                     ${`evt-${id}`}, false, 0.8, 0.9, 'model_inferred', 'pending')`;
  });
  return id;
}

async function rowsIn(workspaceId: string, globalKey: string) {
  return sql`
    SELECT id, workspace_id, scope, kind, content FROM assistant_memory_items
    WHERE user_id = ${userId} AND global_key = ${globalKey}::uuid AND deleted_at IS NULL
      AND workspace_id = ${workspaceId}
  `;
}

test("scope 由种类 + 绑定判据决定（收紧后：只有 preference 可能跨空间）", () => {
  // 正向：关于"怎么学、怎么相处"的偏好跟人走。
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "喜欢在安静时段学习"), "global");
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "看新概念时更想先看反例"), "global");
  // 收紧的那一半：科目/考试/本地指代绑定的偏好留在原空间。
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "正在学习数据库索引优化"), "workspace");
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "这个班的作业每周三交"), "workspace");
  // interaction_note 实测记的多半是"用户当前在做什么"，改回本地。
  assert.equal(memoryScopeForKind("interaction_note", "workspace", "portable", "被追问原因时会先举例"), "workspace");
  // 其余三类本来就绑定空间内容。
  assert.equal(memoryScopeForKind("goal", "workspace", "portable", "下个月要考日语N3"), "workspace");
  assert.equal(memoryScopeForKind("learning_context", "workspace", "portable", "正在学习物理"), "workspace");
  assert.equal(memoryScopeForKind("episodic", "workspace", "portable", "第一次独立完成微旅程"), "workspace");
  // 缺省 fail-closed：没给 binding 按本地。
  assert.equal(memoryScopeForKind("preference", "workspace", undefined, "喜欢在安静时段学习"), "workspace");
});

test("global 记忆被铺到该用户的每个活跃空间，workspace 记忆不铺", async () => {
  const globalId = await insertMemory("preference", "global", `我习惯晚上学习 ${tag}`);
  const localId = await insertMemory("goal", "workspace", `这个空间的目标 ${tag}`);

  await sql`
    SELECT public.ailearn_fanout_global_companion_memory(${globalId}::uuid) AS inserted
  `;

  const keyRows = await sql`
    SELECT global_key FROM assistant_memory_items WHERE id = ${globalId}::uuid
  `;
  const globalKey = String(keyRows[0]?.global_key ?? "");
  assert.ok(globalKey.length > 0, "源行必须认领 global_key");

  // 正向对照：A 与 B 各有一份。
  assert.equal((await rowsIn(spaceA, globalKey)).length, 1, "源空间那一份不见了");
  assert.equal((await rowsIn(spaceB, globalKey)).length, 1, "另一个空间没有拿到这条记忆");

  // 负向：空间内记忆没有被铺（它的 global_key 是 NULL，函数也直接返回 0）。
  const localFan = await sql`
    SELECT public.ailearn_fanout_global_companion_memory(${localId}::uuid) AS inserted
  `;
  assert.equal(Number(localFan[0]?.inserted ?? 0), 0, "非 global 记忆不该被铺");
  const localInB = await sql`
    SELECT id FROM assistant_memory_items
    WHERE workspace_id = ${spaceB} AND user_id = ${userId} AND content = ${`这个空间的目标 ${tag}`}
  `;
  assert.equal(localInB.length, 0, "目标类记忆跑到了另一个空间——那里的卡片并不存在");
});

test("幂等：同一条记忆重复铺不会在同一个空间里出现第二份", async () => {
  const id = await insertMemory("preference", "global", `重复铺的偏好 ${tag}`);
  await sql`SELECT public.ailearn_fanout_global_companion_memory(${id}::uuid)`;
  await sql`SELECT public.ailearn_fanout_global_companion_memory(${id}::uuid)`;
  const rows = await sql`
    SELECT workspace_id FROM assistant_memory_items
    WHERE user_id = ${userId} AND content = ${`重复铺的偏好 ${tag}`} AND deleted_at IS NULL
  `;
  // 按**空间集合**断言而不是总行数：同一个用户可能还有别的活跃空间（夹具累积），
  // 但"一个空间里两份"永远是错的。
  const byWorkspace = new Map<string, number>();
  for (const row of rows) {
    const key = String(row.workspace_id);
    byWorkspace.set(key, (byWorkspace.get(key) ?? 0) + 1);
  }
  const duplicated = [...byWorkspace.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(duplicated, [], `同一空间里出现了重复副本：${JSON.stringify(duplicated)}`);
  assert.ok(byWorkspace.has(spaceA), "源空间那一份不见了");
  assert.ok(byWorkspace.has(spaceB), "另一个空间没有拿到这条记忆");
});

test("后来加入的新空间会补铺已有的 global 记忆", async () => {
  const id = await insertMemory("preference", "global", `别用太长的句子 ${tag}`);
  await sql`SELECT public.ailearn_fanout_global_companion_memory(${id}::uuid)`;
  const keyRows = await sql`SELECT global_key FROM assistant_memory_items WHERE id = ${id}::uuid`;
  const globalKey = String(keyRows[0]?.global_key ?? "");

  // C 在记忆之后才加入——触发器应当把它补上。
  await seedSpace(spaceC, `xspace-C-${tag}`);
  const inC = await rowsIn(spaceC, globalKey);
  assert.equal(inC.length, 1, "后加入的空间没有拿到已有的跨空间记忆");
  assert.equal(String(inC[0]?.kind), "preference");

  // 正向对照：C 里**只有** global 那些，空间内记忆不该被带过去。
  const localInC = await sql`
    SELECT id FROM assistant_memory_items
    WHERE workspace_id = ${spaceC} AND user_id = ${userId} AND scope = 'workspace'
  `;
  assert.equal(localInC.length, 0, "补铺把空间内记忆也带过去了");
});

test("改一处、其余副本跟着走；删一处、其余一起消失", async () => {
  const id = await insertMemory("preference", "global", `会被改的偏好 ${tag}`);
  await sql`SELECT public.ailearn_fanout_global_companion_memory(${id}::uuid)`;
  const keyRows = await sql`SELECT global_key FROM assistant_memory_items WHERE id = ${id}::uuid`;
  const globalKey = String(keyRows[0]?.global_key ?? "");
  assert.equal((await rowsIn(spaceA, globalKey)).length, 1);
  assert.equal((await rowsIn(spaceB, globalKey)).length, 1);

  // 在 A 里纠正内容：B 那一份必须跟着变。
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${spaceA}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`UPDATE assistant_memory_items SET content = ${`改过的偏好 ${tag}`}
             WHERE id = ${id}::uuid`;
  });
  const inB = await rowsIn(spaceB, globalKey);
  assert.equal(String(inB[0]?.content), `改过的偏好 ${tag}`, "另一个空间的副本没跟着改");

  // 在 A 里软删除：B 那一份必须一起消失（否则用户撤销不掉一条记忆）。
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${spaceA}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`UPDATE assistant_memory_items SET deleted_at = now() WHERE id = ${id}::uuid`;
  });
  assert.equal((await rowsIn(spaceB, globalKey)).length, 0, "删了 A 的，B 还留着——撤销不掉");

  // 正向对照：同一条 key 下的**未删除**副本确实存在过（上一步不是"两边都空"的假绿）。
  const all = await sql`
    SELECT workspace_id FROM assistant_memory_items
    WHERE user_id = ${userId} AND global_key = ${globalKey}::uuid
      AND workspace_id IN (${spaceA}, ${spaceB})
  `;
  assert.equal(all.length, 2, "两份副本应当都还在（只是都被标成已删除）");
});
