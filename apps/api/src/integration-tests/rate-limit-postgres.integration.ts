import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PostgresRateLimitStore } from "../modules/identity/rate-limit.ts";

test("shares a PostgreSQL rate-limit window atomically", async () => {
  const databaseUrl = process.env.RATE_LIMIT_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("RATE_LIMIT_TEST_DATABASE_URL is required for the PostgreSQL integration gate");
  }

  const client = postgres(databaseUrl, { max: 8 });
  const database = drizzle(client);
  const store = new PostgresRateLimitStore(database as never);
  const key = `test:rate-limit:${process.pid}:${Date.now()}`;

  try {
    await store.delete(key);
    const entries = await Promise.all(
      Array.from({ length: 8 }, () => store.increment(key, 60_000, Date.now())),
    );
    assert.deepEqual(
      entries.map((entry) => entry.count).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(new Set(entries.map((entry) => entry.resetAt)).size, 1);
  } finally {
    await store.delete(key);
    await client.end();
  }
});
