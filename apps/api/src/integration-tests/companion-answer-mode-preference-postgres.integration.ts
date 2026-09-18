/**
 * 作答模态偏好的真实 Postgres 契约（account 级、跨 workspace 一致）。
 *
 * 为什么必须是集成测试：偏好存在 account 级行（workspace_id IS NULL），
 * 其读写语义完全由 RLS policy（迁移 0075）+ 行锁 upsert 决定——纯 schema 单测
 * 无法覆盖「空 workspaceId 会被 normalizeContextUuid 拒绝」这类真实缺陷
 * （2026-08-12 review blocking：调用方传空串导致端点恒 500）。
 *
 * 本文件取代 answer-mode-preference.test.ts 里原先对 service/routes 源码做正则
 * 断言的「伪行为测试」。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  getAnswerModePreference,
  setAnswerModePreference,
} from "../modules/companion-shell/service.ts";
import { closeDatabase } from "../db/client.ts";

const databaseUrl = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_API 未配置——answer-mode-preference 集成测试要求真实 Postgres");
}

const sql = postgres(databaseUrl, { max: 4 });
const userId = randomUUID();
const otherUserId = randomUUID();
const workspaceId = randomUUID();
const emailPrefix = `answer-mode-${userId.slice(0, 8)}`;

async function seedUsers(): Promise<void> {
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES
      (${userId}, ${`${emailPrefix}@example.test`}, 'test-hash', 'owner'),
      (${otherUserId}, ${`${emailPrefix}-other@example.test`}, 'test-hash', 'owner')
  `;
}


after(async () => {
  await sql`DELETE FROM users WHERE id IN (${userId}, ${otherUserId})`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

await seedUsers();

test("未设置过 → any（跟随安排），updatedAt 为 null", async () => {
  const state = await getAnswerModePreference(userId, workspaceId);
  assert.equal(state.preference, "any");
  assert.equal(state.updatedAt, null);
});

test("silent 落库为 touch_structure（05-1 静音结构化），读取时映射回 silent", async () => {
  const written = await setAnswerModePreference(userId, workspaceId, "silent");
  assert.equal(written.preference, "silent");
  assert.ok(written.updatedAt, "写入后必须返回 updatedAt");

  // RLS：account 级行必须在带 app.user_id 的事务上下文里读（与 service 同一路径），
  // 且断言查询必须跑在**同一个事务连接**上，否则拿不到 session context。
  const stored = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return tx<{ stored: string | null }[]>`
      SELECT explicit_preferences->>'default_input_priority' AS stored
      FROM user_learning_preferences
      WHERE user_id = ${userId} AND workspace_id IS NULL
    `;
  });
  assert.equal(stored[0]?.stored, "touch_structure");

  assert.equal((await getAnswerModePreference(userId, workspaceId)).preference, "silent");
});

test("voice/text 往返一致；any 删除键回到跟随安排", async () => {
  assert.equal((await setAnswerModePreference(userId, workspaceId, "voice")).preference, "voice");
  assert.equal((await getAnswerModePreference(userId, workspaceId)).preference, "voice");
  assert.equal((await setAnswerModePreference(userId, workspaceId, "text")).preference, "text");
  assert.equal((await getAnswerModePreference(userId, workspaceId)).preference, "text");

  await setAnswerModePreference(userId, workspaceId, "any");
  assert.equal((await getAnswerModePreference(userId, workspaceId)).preference, "any");
  const stored = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return tx<{ has_key: boolean }[]>`
      SELECT explicit_preferences ? 'default_input_priority' AS has_key
      FROM user_learning_preferences
      WHERE user_id = ${userId} AND workspace_id IS NULL
    `;
  });
  assert.equal(stored[0]?.has_key, false, "any 必须删除键而不是写 'any'");
});

test("account 级行跨 workspace 一致（同用户另一个 workspace 读到同一偏好）", async () => {
  await setAnswerModePreference(userId, workspaceId, "voice");
  assert.equal((await getAnswerModePreference(userId, randomUUID())).preference, "voice");
});

test("跨用户隔离：另一个用户的偏好不受影响", async () => {
  await setAnswerModePreference(userId, workspaceId, "text");
  assert.equal((await getAnswerModePreference(otherUserId, workspaceId)).preference, "any");
});

test("空 workspaceId 被拒绝（2026-08-12 端点恒 500 的回归锁）", async () => {
  await assert.rejects(() => setAnswerModePreference(userId, "", "voice"));
  await assert.rejects(() => getAnswerModePreference(userId, ""));
});
