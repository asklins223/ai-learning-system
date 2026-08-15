/** Authentication rate-limiting primitives and storage backends. */

import { sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { authRateLimits } from "../../db/schema/identity.ts";

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  /**
   * Atomically consume one attempt for `key`.
   * Implementations must start a new window when `now >= resetAt`.
   */
  increment(key: string, windowMs: number, now: number): RateLimitEntry | Promise<RateLimitEntry>;
  delete(key: string): void | Promise<void>;
  /** Optional maintenance hook for stores that retain expired keys locally. */
  sweep?(now: number): void | Promise<void>;
}

/** A small no-dependency store for local development and tests. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, RateLimitEntry>();

  /**
   * PERF-B9 修复：memory 桶此前从不被 sweep（upload 独立实例无定时器），
   * 大量 userId 桶随 increment 永久驻留 → 无界增长。现改为 increment 时惰性
   * 清理：基于 resetAt 顺带淘汰已过期 key；达到阈值时整批扫过期，保证 Map 有界。
   * 每次递增扫描是 O(n)，但对 dev/test 的有界用户集可接受，且避免了加定时器
   * 与跨模块共享实例的复杂度。
   */
  increment(key: string, windowMs: number, now: number): RateLimitEntry {
    this.lazySweep(now);
    const current = this.entries.get(key);
    const entry = !current || now >= current.resetAt
      ? { count: 1, resetAt: now + windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };
    this.entries.set(key, entry);

    // Map 已膨胀时整批清一次过期桶，限制驻留规模。
    if (this.entries.size > MemoryRateLimitStore.MAX_ENTRIES_BEFORE_SWEEP) {
      this.sweep(now);
    }
    return entry;
  }

  /**
   * 惰性清理：基于 resetAt 删除过期条目。每批最多删除
   * MAX_SWEEP_PER_CALL 条，避免单次请求扫描整个 Map。
   */
  private lazySweep(now: number): void {
    if (this.entries.size === 0) return;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
        if (++removed >= MemoryRateLimitStore.MAX_SWEEP_PER_CALL) break;
      }
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }
  }

  private static readonly MAX_ENTRIES_BEFORE_SWEEP = 1_000;
  private static readonly MAX_SWEEP_PER_CALL = 200;

  /** Exposed only for diagnostics/tests; callers cannot mutate the map. */
  get size(): number {
    return this.entries.size;
  }
}

type RateLimitDatabase = Pick<typeof db, "execute">;

/**
 * PostgreSQL-backed shared bucket store.
 *
 * The insert/update is one statement and is serialized by the primary-key
 * conflict row lock.  `clock_timestamp()` is evaluated by PostgreSQL so
 * separate API replicas do not depend on identical application clocks.
 *
 * SEC-02 安全说明：SQL 语句通过 drizzle 的 `sql` 模板标签构造，
 * 所有用户输入（`key`、`windowMs`）作为参数化值传递，不会直接拼接到 SQL 字符串中。
 * 表名 `authRateLimits` 是 drizzle schema 对象（编译时常量），非用户输入。
 * 因此不存在 SQL 注入风险。
 */
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly database: RateLimitDatabase = db) {}

  async increment(key: string, windowMs: number, _now: number): Promise<RateLimitEntry> {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("rate-limit windowMs must be positive");
    }

    const rows = await this.database.execute(sql`
      WITH rate_clock AS (
        SELECT clock_timestamp() AS now
      )
      INSERT INTO ${authRateLimits}
        ("bucket_key", "count", "reset_at", "updated_at")
      SELECT
        ${key},
        1,
        rate_clock.now + (${windowMs} * interval '1 millisecond'),
        rate_clock.now
      FROM rate_clock
      ON CONFLICT ("bucket_key") DO UPDATE
      SET
        "count" = CASE
          WHEN "auth_rate_limits"."reset_at" <= EXCLUDED."updated_at" THEN 1
          ELSE "auth_rate_limits"."count" + 1
        END,
        "reset_at" = CASE
          WHEN "auth_rate_limits"."reset_at" <= EXCLUDED."updated_at"
            THEN EXCLUDED."reset_at"
          ELSE "auth_rate_limits"."reset_at"
        END,
        "updated_at" = EXCLUDED."updated_at"
      RETURNING
        "count",
        extract(epoch FROM "reset_at") * 1000 AS "reset_at_ms"
    `);

    const row = rows[0] as { count?: number | string; reset_at_ms?: number | string } | undefined;
    const count = Number(row?.count);
    const resetAt = Number(row?.reset_at_ms);
    if (!Number.isSafeInteger(count) || !Number.isFinite(resetAt)) {
      throw new Error("rate-limit store returned an invalid bucket row");
    }
    return { count, resetAt };
  }

  async delete(key: string): Promise<void> {
    await this.database.execute(sql`
      DELETE FROM ${authRateLimits}
      WHERE ${authRateLimits.bucketKey} = ${key}
    `);
  }

  async sweep(_now: number): Promise<void> {
    await this.database.execute(sql`
      DELETE FROM ${authRateLimits}
      WHERE ${authRateLimits.resetAt} <= clock_timestamp()
    `);
  }
}

export type RateLimitStoreKind = "memory" | "postgres";

/** Select the local or shared backend without changing route behavior. */
export function createRateLimitStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  database: RateLimitDatabase = db,
): RateLimitStore {
  const configured = env.AUTH_RATE_LIMIT_STORE?.trim().toLowerCase();
  const kind = configured || (env.NODE_ENV === "production" ? "postgres" : "memory");
  if (kind === "memory") return new MemoryRateLimitStore();
  if (kind === "postgres") return new PostgresRateLimitStore(database);
  throw new Error(`AUTH_RATE_LIMIT_STORE must be memory or postgres, got ${kind}`);
}

export interface RateLimitDecision extends RateLimitEntry {
  allowed: boolean;
  remaining: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  maxAttempts: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly now: () => number;

  constructor(
    private readonly store: RateLimitStore,
    private readonly options: RateLimiterOptions,
  ) {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error("rate-limit windowMs must be positive");
    }
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0) {
      throw new Error("rate-limit maxAttempts must be a positive integer");
    }
    this.now = options.now ?? Date.now;
  }

  async consume(key: string): Promise<RateLimitDecision> {
    const entry = await this.store.increment(key, this.options.windowMs, this.now());
    return {
      ...entry,
      allowed: entry.count <= this.options.maxAttempts,
      remaining: Math.max(0, this.options.maxAttempts - entry.count),
    };
  }

  async allow(key: string): Promise<boolean> {
    return (await this.consume(key)).allowed;
  }

  async reset(key: string): Promise<void> {
    await this.store.delete(key);
  }

  async sweep(): Promise<void> {
    await this.store.sweep?.(this.now());
  }
}
