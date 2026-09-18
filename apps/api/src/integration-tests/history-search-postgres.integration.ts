/**
 * 完整历史全文搜索 HTTP 集成测试（方案 16 §10.4）。
 *
 * 覆盖：消息正文命中（参数化 ILIKE，只搜当前 user/workspace）、无命中、
 * 删除会话后不命中（物理清除）、缺 q 参数 400。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/history-search-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });
const { closeDatabase } = await import("../db/client.ts");

/**
 * 裸 SQL 夹具/校验必须带 workspace/user 上下文。
 *
 * companion_conversations / companion_messages 是 FORCE RLS：受限角色
 * （ailearn_api）在无上下文事务里 DELETE 会静默匹配 0 行，于是"删除会话后
 * 不再命中"的断言仍然搜得到旧行（超级用户则绕过 RLS 掩盖同一问题）。
 */
function scoped<T>(
  scope: { workspaceId: string; userId: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

after(async () => {
  await closeDatabase();
  await sql.end({ timeout: 2 });
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function seedIdentity() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const token = `hs-test-${randomUUID()}`;
  const conversationId = randomUUID();
  await scoped({ workspaceId, userId }, async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${"hs-" + userId.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, ${"w" + workspaceId.slice(0, 8)}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO sessions (token, user_id, workspace_id, expires_at)
      VALUES (${hashToken(token)}, ${userId}, ${workspaceId}, now() + interval '1 hour')`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, status, title, title_source, created_at, updated_at)
      VALUES (${conversationId}, ${workspaceId}, ${userId}, 'inbox', 'active', '搜索测试会话', 'placeholder', now(), now())`;
    await tx`INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
      VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, 1, 'user', 'text',
              '[{"kind":"text","text":"我喜欢独特关键词xyz的学习方法"}]'::jsonb, ${"h1"}, now())`;
    await tx`INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
      VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, 2, 'assistant', 'text',
              '[{"kind":"text","text":"明白，我会按这个目标安排。"}]'::jsonb, ${"h2"}, now())`;
  });
  const cleanup = async () => {
    await scoped({ workspaceId, userId }, async (tx) => {
      await tx`DELETE FROM companion_messages WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { token, workspaceId, userId, conversationId, cleanup };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { assistantSessionRoutes } = await import("../modules/companion-conversation/assistant-session-routes.ts");
  await app.register(assistantSessionRoutes);
  return app;
}

test("§10.4 历史搜索：命中/无命中/删除后不命中/缺 q 400", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    const auth = { authorization: `Bearer ${identity.token}` };

    // 命中。
    const hit = await app.inject({
      method: "GET",
      url: `/companion/history/search?q=${encodeURIComponent("独特关键词xyz")}`,
      headers: auth,
    });
    assert.equal(hit.statusCode, 200);
    const hitBody = hit.json();
    assert.equal(hitBody.version, 1);
    assert.equal(hitBody.items.length, 1);
    assert.equal(hitBody.items[0].conversationId, identity.conversationId);
    assert.equal(hitBody.items[0].conversationTitle, "搜索测试会话");

    // 无命中。
    const miss = await app.inject({
      method: "GET",
      url: `/companion/history/search?q=${encodeURIComponent("不存在的词zzz")}`,
      headers: auth,
    });
    assert.equal(miss.statusCode, 200);
    assert.equal(miss.json().items.length, 0);

    // 缺 q → 400。
    const bad = await app.inject({ method: "GET", url: "/companion/history/search", headers: auth });
    assert.equal(bad.statusCode, 400);

    // 删除会话后不命中（物理清除；redacted 内容不得命中）。
    await scoped(identity, (tx) => tx`DELETE FROM companion_conversations WHERE id = ${identity.conversationId}`);
    const afterDelete = await app.inject({
      method: "GET",
      url: `/companion/history/search?q=${encodeURIComponent("独特关键词xyz")}`,
      headers: auth,
    });
    assert.equal(afterDelete.json().items.length, 0);
  } finally {
    await identity.cleanup();
    await app.close();
  }
});
