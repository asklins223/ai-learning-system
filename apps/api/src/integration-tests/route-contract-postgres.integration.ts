/**
 * 路由层 HTTP 契约集成测试（第五轮 B1 盲区）。
 *
 * 此前全仓无 `.inject(` 测试——分页形状、错误 JSON、状态码全靠手写契约，
 * 无自动化保护。本测试用真实 Fastify 实例 + 真实 DB session 认证，
 * 锁死以下契约（2026-08-11 统一后）：
 * - 错误响应统一 { error, message }（invalid_id_format / not_found）；
 * - 非法 UUID 一律 400；
 * - 软删除返回 204（DELETE /sources/:id）；
 * - 分页统一 { items, nextCursor, total }（GET /notes）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
const sql = postgres(CONN, { max: 2 });
const { closeDatabase } = await import("../db/client.ts");

after(async () => {
  await closeDatabase();
  await sql.end({ timeout: 2 });
});

/** 与 identity/service.ts hashToken 一致（SHA-256 hex） */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function seedIdentity(): Promise<{
  token: string;
  workspaceId: string;
  userId: string;
  cleanup: () => Promise<void>;
}> {
  const ws = randomUUID();
  const uid = randomUUID();
  const token = `contract-test-${randomUUID()}`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"ct-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
    await tx`INSERT INTO sessions (token, user_id, workspace_id, expires_at)
      VALUES (${hashToken(token)}, ${uid}, ${ws}, now() + interval '1 hour')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM sources WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM sessions WHERE user_id = ${uid}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      await tx`DELETE FROM users WHERE id = ${uid}`;
    });
  };
  return { token, workspaceId: ws, userId: uid, cleanup };
}

async function buildApp(extra?: {
  rateLimitStore?: { increment: () => unknown; delete: () => void; sweep?: () => void };
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const multipart = (await import("@fastify/multipart")).default;
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  const { noteRoutes } = await import("../modules/note/routes.ts");
  const { reviewRoutes } = await import("../modules/review/routes.ts");
  const { sourceRoutes } = await import("../modules/source/routes.ts");
  const { uploadRoutes } = await import("../modules/upload/routes.ts");
  const { importRoutes } = await import("../modules/import/routes.ts");
  await app.register(noteRoutes);
  await app.register(reviewRoutes);
  await app.register(sourceRoutes);
  await app.register(uploadRoutes, extra as never);
  await app.register(importRoutes);
  return app;
}

test("契约：错误响应统一 {error, message} + 非法 UUID 400 + 软删除 204 + 分页形状", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    const auth = { authorization: `Bearer ${identity.token}` };

    // 1) 非法 UUID → 400 { error: "invalid_id_format", message }
    const badId = await app.inject({ method: "GET", url: "/v2/notes/not-a-uuid", headers: auth });
    assert.equal(badId.statusCode, 400);
    assert.deepEqual(badId.json(), { error: "invalid_id_format", message: "无效的 id 格式" });

    // 2) 合法但不存在 → 404 { error: "not_found", message }
    const missingId = await app.inject({
      method: "GET",
      url: `/v2/notes/${randomUUID()}`,
      headers: auth,
    });
    assert.equal(missingId.statusCode, 404);
    assert.deepEqual(missingId.json(), { error: "not_found", message: "资源不存在" });

    // 3) 软删除 source → 204（无响应体）
    const sourceId = randomUUID();
    await sql`INSERT INTO sources (id, workspace_id, created_by, type, title, status)
      VALUES (${sourceId}, ${identity.workspaceId}, ${identity.userId}, 'url', '契约测试', 'ready')`;
    const del = await app.inject({
      method: "DELETE",
      url: `/sources/${sourceId}`,
      headers: auth,
    });
    assert.equal(del.statusCode, 204);
    assert.equal(del.body, "");

    // 4) 分页统一 { items, nextCursor, total }（GET /notes）
    for (let index = 0; index < 2; index += 1) {
      await sql`INSERT INTO notes (id, workspace_id, created_by, title)
        VALUES (${randomUUID()}, ${identity.workspaceId}, ${identity.userId}, ${"契约笔记" + index})`;
    }
    const list = await app.inject({ method: "GET", url: "/notes?limit=1", headers: auth });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.ok(Array.isArray(body.items), "分页响应必须含 items 数组");
    assert.equal(typeof body.total, "number", "分页响应必须含 total");
    assert.ok(
      body.nextCursor === null || typeof body.nextCursor === "string",
      "分页响应必须含 nextCursor（string|null）",
    );
    assert.ok(!("nextOffset" in body), "nextOffset 已废弃，不得出现在响应中");
  } finally {
    await identity.cleanup();
    await app.close();
  }
});

test("契约：upload 429 限流返回 {error: rate_limited, message} + Retry-After", async () => {
  const identity = await seedIdentity();
  const app = await buildApp({
    rateLimitStore: {
      // 永不允许：count 超限、resetAt 未来
      increment: () => ({ count: 99, resetAt: Date.now() + 60_000 }),
      delete: () => {},
      sweep: () => {},
    },
  });
  try {
    const boundary = "----contract-boundary-7d4f";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="dummy"',
      "",
      "x",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const res = await app.inject({
      method: "POST",
      url: "/uploads/images",
      headers: {
        authorization: `Bearer ${identity.token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(Buffer.byteLength(body)),
      },
      payload: body,
    });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["retry-after"], "60");
    assert.deepEqual(res.json(), { error: "rate_limited", message: "上传过于频繁，请稍后重试" });
  } finally {
    await identity.cleanup();
    await app.close();
  }
});

test("契约：/import/markdown 相同 importId 幂等（F-033）", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    const auth = { authorization: `Bearer ${identity.token}` };
    const body = {
      importId: "idem-contract-1",
      items: [{ title: "幂等契约笔记", content: "# 幂等契约笔记\n\n正文内容。" }],
    };
    const first = await app.inject({
      method: "POST",
      url: "/import/markdown",
      headers: auth,
      payload: body,
    });
    assert.equal(first.statusCode, 200, `首次导入应成功: ${first.body}`);
    const second = await app.inject({
      method: "POST",
      url: "/import/markdown",
      headers: auth,
      payload: body,
    });
    assert.equal(second.statusCode, 200, "幂等重放应成功（不报错）");
    const rows = await sql`
      SELECT count(*)::int AS c FROM notes WHERE workspace_id = ${identity.workspaceId}
    `;
    assert.equal(Number(rows[0]?.c ?? 0), 1, "同 importId 重放不得创建重复笔记");
  } finally {
    await identity.cleanup();
    await app.close();
  }
});
