import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRateLimitStoreFromEnv,
  MemoryRateLimitStore,
  PostgresRateLimitStore,
  RateLimiter,
  type RateLimitEntry,
  type RateLimitStore,
} from "../modules/identity/rate-limit.ts";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  createAuthCookieHeaders,
  createClearAuthCookieHeaders,
  extractAuthCredential,
  hasValidCookieCsrf,
  parseCookieHeader,
  secureCookiesEnabled,
} from "../modules/identity/session-auth.ts";
import { loginSchema } from "../modules/identity/routes.ts";

describe("authentication rate limiter", () => {
  it("selects memory in development and PostgreSQL in production", () => {
    const fakeDatabase = { execute: async () => [] } as never;
    assert.ok(
      createRateLimitStoreFromEnv({ NODE_ENV: "development" }, fakeDatabase)
        instanceof MemoryRateLimitStore,
    );
    assert.ok(
      createRateLimitStoreFromEnv({ NODE_ENV: "production" }, fakeDatabase)
        instanceof PostgresRateLimitStore,
    );
    assert.throws(
      () => createRateLimitStoreFromEnv({ AUTH_RATE_LIMIT_STORE: "redis" }, fakeDatabase),
      /AUTH_RATE_LIMIT_STORE must be memory or postgres/,
    );
  });

  it("shares counters across limiter instances using the same store", async () => {
    let now = 1_000;
    const store = new MemoryRateLimitStore();
    const firstReplica = new RateLimiter(store, {
      windowMs: 10_000,
      maxAttempts: 2,
      now: () => now,
    });
    const secondReplica = new RateLimiter(store, {
      windowMs: 10_000,
      maxAttempts: 2,
      now: () => now,
    });

    assert.equal((await firstReplica.consume("email:user@example.com")).allowed, true);
    assert.equal((await secondReplica.consume("email:user@example.com")).allowed, true);
    const blocked = await firstReplica.consume("email:user@example.com");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.count, 3);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.resetAt, 11_000);

    now = 11_000;
    const renewed = await secondReplica.consume("email:user@example.com");
    assert.deepEqual(renewed, {
      allowed: true,
      count: 1,
      remaining: 1,
      resetAt: 21_000,
    });
  });

  it("resets successful identities and sweeps expired memory entries", async () => {
    let now = 5_000;
    const store = new MemoryRateLimitStore();
    const limiter = new RateLimiter(store, {
      windowMs: 1_000,
      maxAttempts: 1,
      now: () => now,
    });

    await limiter.consume("ip:127.0.0.1");
    assert.equal((await limiter.consume("ip:127.0.0.1")).allowed, false);
    await limiter.reset("ip:127.0.0.1");
    assert.equal((await limiter.consume("ip:127.0.0.1")).allowed, true);

    now = 6_000;
    await limiter.sweep();
    assert.equal(store.size, 0);
  });

  it("supports asynchronous shared stores", async () => {
    class AsyncStore implements RateLimitStore {
      private entry: RateLimitEntry | undefined;

      async increment(_key: string, windowMs: number, now: number): Promise<RateLimitEntry> {
        this.entry = !this.entry || now >= this.entry.resetAt
          ? { count: 1, resetAt: now + windowMs }
          : { ...this.entry, count: this.entry.count + 1 };
        return this.entry;
      }

      async delete(): Promise<void> {
        this.entry = undefined;
      }
    }

    const limiter = new RateLimiter(new AsyncStore(), { windowMs: 500, maxAttempts: 1 });
    assert.equal(await limiter.allow("shared-key"), true);
    assert.equal(await limiter.allow("shared-key"), false);
  });

  it("maps PostgreSQL atomic upsert results and cleanup calls", async () => {
    const queries: unknown[] = [];
    const fakeDatabase = {
      execute: async (query: unknown) => {
        queries.push(query);
        if (queries.length === 1) return [{ count: "3", reset_at_ms: "1700000000123" }];
        return [];
      },
    } as never;
    const store = new PostgresRateLimitStore(fakeDatabase);

    assert.deepEqual(await store.increment("ip:127.0.0.1", 15 * 60 * 1000, Date.now()), {
      count: 3,
      resetAt: 1_700_000_000_123,
    });
    await store.delete("ip:127.0.0.1");
    await store.sweep(Date.now());
    assert.equal(queries.length, 3);
  });

  it("shares a PostgreSQL window atomically when an integration URL is provided", {
    skip: !process.env.RATE_LIMIT_TEST_DATABASE_URL,
  }, async () => {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(process.env.RATE_LIMIT_TEST_DATABASE_URL!, { max: 8 });
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
});

describe("session credential migration", () => {
  it("defaults production cookies to Secure while honoring an explicit local-http override", () => {
    assert.equal(secureCookiesEnabled({ NODE_ENV: "production" }), true);
    assert.equal(
      secureCookiesEnabled({ NODE_ENV: "production", AUTH_COOKIE_SECURE: "false" }),
      false,
    );
    assert.equal(secureCookiesEnabled({ NODE_ENV: "development" }), false);
    assert.equal(secureCookiesEnabled({ AUTH_COOKIE_SECURE: "true" }), true);
  });

  it("defaults login remember to a browser-session cookie", () => {
    assert.equal(loginSchema.parse({ email: "user@example.com", password: "secret" }).remember, false);
    assert.equal(
      loginSchema.parse({ email: "user@example.com", password: "secret", remember: true }).remember,
      true,
    );
  });

  it("keeps Bearer credentials first while accepting the HttpOnly cookie fallback", () => {
    assert.deepEqual(
      extractAuthCredential({
        authorization: "Bearer api-token",
        cookie: `${SESSION_COOKIE_NAME}=cookie-token`,
      }),
      { token: "api-token", source: "bearer" },
    );
    assert.deepEqual(
      extractAuthCredential({ cookie: `${SESSION_COOKIE_NAME}=cookie%20token` }),
      { token: "cookie token", source: "cookie" },
    );
  });

  it("creates an HttpOnly session cookie and a readable CSRF cookie", () => {
    const { headers, csrfToken } = createAuthCookieHeaders("session token", 3_600, "csrf-token");
    assert.equal(csrfToken, "csrf-token");
    assert.match(headers[0], new RegExp(`^${SESSION_COOKIE_NAME}=session%20token; HttpOnly;`));
    assert.match(headers[0], /SameSite=Lax/);
    assert.match(headers[1], new RegExp(`^${CSRF_COOKIE_NAME}=csrf-token;`));
    assert.doesNotMatch(headers[1], /HttpOnly/);
  });

  it("can issue a browser-session cookie when remember is disabled", () => {
    const { headers } = createAuthCookieHeaders("session token", undefined, "csrf-token");
    assert.doesNotMatch(headers[0], /Max-Age=/);
    assert.doesNotMatch(headers[1], /Max-Age=/);
  });

  it("requires matching CSRF values only for cookie-authenticated mutations", () => {
    const cookie = `${SESSION_COOKIE_NAME}=session; ${CSRF_COOKIE_NAME}=csrf-value`;
    assert.equal(hasValidCookieCsrf("GET", { cookie }), true);
    assert.equal(hasValidCookieCsrf("POST", { cookie }), false);
    assert.equal(
      hasValidCookieCsrf("POST", { cookie, [CSRF_HEADER_NAME]: "wrong" }),
      false,
    );
    assert.equal(
      hasValidCookieCsrf("POST", { cookie, [CSRF_HEADER_NAME]: "csrf-value" }),
      true,
    );
  });

  it("parses cookie values defensively and emits explicit expiry headers", () => {
    assert.deepEqual(parseCookieHeader("valid=a%20b; malformed=%E0%A4%A; flag"), { valid: "a b" });
    const headers = createClearAuthCookieHeaders();
    assert.equal(headers.length, 2);
    assert.ok(headers.every((header) => header.includes("Max-Age=0")));
    assert.ok(headers.every((header) => header.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT")));
  });
});
