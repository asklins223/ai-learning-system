/**
 * Runtime-fence multi-instance contract against real Postgres.
 *
 * This is intentionally an integration-only test: the default unit suite must
 * remain runnable without a database, while the deployed API path must prove
 * persistence, monotonic surface epochs, expiry cleanup, and the per-user cap.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  createRuntimeFence,
  getActiveRuntimeFence,
  listActiveRuntimeFences,
} from "../modules/companion-shell/service.ts";
import { closeDatabase } from "../db/client.ts";

const databaseUrl = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_API 未配置——runtime-fence 集成测试要求真实 Postgres");
}

const sql = postgres(databaseUrl, { max: 4 });
const userId = randomUUID();
const workspaceId = randomUUID();
const devicePrefix = `runtime-fence-${userId.slice(0, 8)}`;

async function seedUser(): Promise<void> {
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${userId}, ${`${devicePrefix}@example.test`}, 'test-hash', 'owner')
  `;
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

await seedUser();

after(async () => {
  await cleanup().catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

test("runtime fence persists across service calls and never regresses surface epoch", async () => {
  const first = await createRuntimeFence(userId, workspaceId, {
    deviceSessionId: `${devicePrefix}-primary`,
    surfaceEpoch: 42,
    ttlSeconds: 30,
  });
  const staleRetry = await createRuntimeFence(userId, workspaceId, {
    deviceSessionId: `${devicePrefix}-primary`,
    surfaceEpoch: 7,
    ttlSeconds: 30,
  });

  assert.equal(first.surfaceEpoch, 42);
  assert.equal(staleRetry.surfaceEpoch, 42);
  assert.equal(
    (await getActiveRuntimeFence(userId, workspaceId, `${devicePrefix}-primary`))?.surfaceEpoch,
    42,
  );
});

test("runtime fence serializes concurrent writes and enforces the 64-device cap", async () => {
  const results = await Promise.all(
    Array.from({ length: 65 }, (_, index) => createRuntimeFence(userId, workspaceId, {
      deviceSessionId: `${devicePrefix}-cap-${String(index).padStart(2, "0")}`,
      surfaceEpoch: index + 1,
      ttlSeconds: 30,
    })),
  );
  assert.equal(results.length, 65);
  assert.equal((await listActiveRuntimeFences(userId, workspaceId)).length, 64);
});

test("expired runtime fences are removed on the next user-scoped write", async () => {
  const expiringDevice = `${devicePrefix}-expiring`;
  await createRuntimeFence(userId, workspaceId, {
    deviceSessionId: expiringDevice,
    surfaceEpoch: 1,
    ttlSeconds: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await createRuntimeFence(userId, workspaceId, {
    deviceSessionId: `${devicePrefix}-expiry-trigger`,
    surfaceEpoch: 2,
    ttlSeconds: 30,
  });
  assert.equal(await getActiveRuntimeFence(userId, workspaceId, expiringDevice), null);
});
