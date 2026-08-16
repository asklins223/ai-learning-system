import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";
import * as schema from "./schema/index.ts";

// v0.4: the API must use its own database role in production.  The shared
// DATABASE_URL remains a development/test compatibility path only.
function resolveConnectionString(): string {
  const roleUrl = process.env.DATABASE_URL_API?.trim();
  if (roleUrl) return roleUrl;

  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL_API is required when NODE_ENV=production");
  }

  return (
    process.env.DATABASE_URL?.trim() ??
    "postgres://ailearn:ailearn_dev@postgres:5432/ailearn"
  );
}

const connectionString = resolveConnectionString();

// PERF-WN: 单 postgres 池承载常规请求 + SSE 轮询 + 后台任务；max=10 在大量
// 长连接轮询/并发请求时成为瓶颈（配合 inbox/companion SSE 连接上限使用）。
// 提到 25 摊薄峰值排队，仍受 DB 端 max_connections 约束。
const queryClient = postgres(connectionString, { max: 25 });
let closePromise: Promise<void> | null = null;

export const db = drizzle(queryClient, { schema });

// 2026-08-11（可观测性）：包装 transaction——失败时累加 dbTransactionFailuresTotal
//（此前指标定义后从未 set，空转）。
const originalTransaction = db.transaction.bind(db);
db.transaction = ((...args: Parameters<typeof originalTransaction>) =>
  originalTransaction(...args).catch((error: unknown) => {
    import("../lib/metrics.ts").then(({ dbTransactionFailuresTotal }) => {
      dbTransactionFailuresTotal.inc();
    }).catch(() => {});
    throw error;
  })) as typeof originalTransaction;

export type ApiTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface WorkspaceTransactionContext {
  workspaceId: string;
  userId: string;
}

export interface NormalizedWorkspaceTransactionContext {
  workspaceId: string;
  userId: string;
}

export class WorkspaceTransactionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTransactionContextError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 无具体 actor 的工作区级操作使用固定的系统身份（nil UUID）。
 * 满足 RLS 上下文的 UUID 校验；生产路由总是传入已认证的 session user，
 * 该常量只服务于测试/内部调用方按工作区聚合、不带用户过滤的路径。
 */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

function normalizeContextUuid(value: string, field: "workspaceId" | "userId"): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new WorkspaceTransactionContextError(`${field} must be a UUID`);
  }
  return normalized;
}

/** Pure validation used by both the runtime helper and unit tests. */
export function normalizeWorkspaceTransactionContext(
  context: WorkspaceTransactionContext,
): NormalizedWorkspaceTransactionContext {
  if (!context || typeof context !== "object") {
    throw new WorkspaceTransactionContextError("workspace transaction context is required");
  }
  if (typeof context.workspaceId !== "string") {
    throw new WorkspaceTransactionContextError("workspaceId must be a UUID");
  }
  if (typeof context.userId !== "string") {
    throw new WorkspaceTransactionContextError("userId must be a UUID");
  }
  return {
    workspaceId: normalizeContextUuid(context.workspaceId, "workspaceId"),
    userId: normalizeContextUuid(context.userId, "userId"),
  };
}

/** Nested work may reuse one transaction, but it may never change its tenant or actor. */
export function assertWorkspaceTransactionContextCompatible(
  active: NormalizedWorkspaceTransactionContext,
  requested: NormalizedWorkspaceTransactionContext,
): void {
  if (active.workspaceId !== requested.workspaceId || active.userId !== requested.userId) {
    throw new WorkspaceTransactionContextError(
      "nested database work cannot change workspace or user context",
    );
  }
}

type ActiveWorkspaceTransaction = {
  context: NormalizedWorkspaceTransactionContext;
  transaction: ApiTransaction;
  open: boolean;
};

const workspaceTransactionStorage = new AsyncLocalStorage<ActiveWorkspaceTransaction>();

/**
 * Set both custom settings transaction-locally and verify PostgreSQL returned
 * the exact normalized values. API business work always has an authenticated
 * actor; actor-less system work belongs to controlled functions or the Worker.
 */
export async function setApiTransactionContext(
  transaction: ApiTransaction,
  context: WorkspaceTransactionContext,
): Promise<NormalizedWorkspaceTransactionContext> {
  const normalized = normalizeWorkspaceTransactionContext(context);
  const active = workspaceTransactionStorage.getStore();
  if (active) {
    if (!active.open) {
      throw new WorkspaceTransactionContextError("workspace transaction is no longer active");
    }
    assertWorkspaceTransactionContextCompatible(active.context, normalized);
  }

  const rows = await transaction.execute<{ workspace_id: string; user_id: string }>(sql`
    SELECT
      pg_catalog.set_config('app.workspace_id', ${normalized.workspaceId}, true) AS workspace_id,
      pg_catalog.set_config('app.user_id', ${normalized.userId}, true) AS user_id
  `);
  const applied = rows[0];
  if (
    applied?.workspace_id?.toLowerCase() !== normalized.workspaceId
    || applied?.user_id?.toLowerCase() !== normalized.userId
  ) {
    throw new WorkspaceTransactionContextError("database rejected workspace transaction context");
  }
  return normalized;
}

/**
 * Run one application unit of work with transaction-local tenant context.
 * Same-context nesting reuses the active transaction; context changes fail
 * before any query can execute.
 *
 * ─── QUAL-58/SEC-26 修复完成 ───────────────────────────────────────────
 * `withWorkspaceTransaction` 现已在所有需要 workspace 隔离的 API 模块中使用
 * （note、card、evidence、job、export、validation、stats、understanding、
 * review、benchmark 等）。
 *
 * 已完成的统一工作：
 *   1. benchmark/service.ts 的 3 处 db.transaction 已转为 withWorkspaceTransaction
 *   2. stats/service.ts 的裸 db 查询已包裹在 withWorkspaceTransaction 内
 *   3. understanding/service.ts 的裸 db 查询已包裹在 withWorkspaceTransaction 内
 *   4. validation/service.ts 的裸 db 查询已包裹在 withWorkspaceTransaction 内
 *   5. review/service.ts 的 tx ?? db 回退模式已改为 withWorkspaceTransaction 包裹
 *
 * 保留直接使用 `db` 的场景（有意为之）：
 *   - identity/service.ts：注册/登录等操作在 workspace 建前执行
 *   - 系统级函数（maintenance、seed 等）
 *
 * 最终目标：启用 RLS FORCE 模式后，所有运行时查询自动受 RLS 保护
 * ──────────────────────────────────────────────────────────────────────
 */
export async function withWorkspaceTransaction<T>(
  context: WorkspaceTransactionContext,
  operation: (transaction: ApiTransaction) => Promise<T>,
  options?: { isolationLevel?: "repeatable read" | "read committed" | "serializable" },
): Promise<T> {
  const normalized = normalizeWorkspaceTransactionContext(context);
  const active = workspaceTransactionStorage.getStore();
  if (active) {
    if (!active.open) {
      throw new WorkspaceTransactionContextError("workspace transaction is no longer active");
    }
    assertWorkspaceTransactionContextCompatible(active.context, normalized);
    if (options?.isolationLevel) {
      throw new WorkspaceTransactionContextError(
        "cannot change isolation level inside an already-open workspace transaction",
      );
    }
    return operation(active.transaction);
  }

  return db.transaction(async (transaction) => {
    // SET TRANSACTION 必须是事务内第一条语句：必须在 set_config 查询之前执行。
    if (options?.isolationLevel) {
      await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL ${sql.raw(options.isolationLevel.toUpperCase())}`);
    }
    await setApiTransactionContext(transaction, normalized);
    const scopedTransaction = { context: normalized, transaction, open: true };
    // 2026-08-14（16-remaining-issues #2）：慢响应可观测性——记录事务耗时，
    // 定位"DB 侧无慢查询但 API 偶发 20-207s"的连接池/事件循环排队。
    const startedAt = performance.now();
    try {
      return await workspaceTransactionStorage.run(
        scopedTransaction,
        () => operation(transaction),
      );
    } finally {
      scopedTransaction.open = false;
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= 5000) {
        import("../lib/logger.ts").then(({ logger }) => {
          logger.error(
            { elapsedMs, context: normalized, poolMax: queryClient.options.max },
            "workspace transaction slow (>5s)",
          );
        }).catch(() => {});
      } else if (elapsedMs >= 1000) {
        import("../lib/logger.ts").then(({ logger }) => {
          logger.warn(
            { elapsedMs, context: normalized },
            "workspace transaction slow (>1s)",
          );
        }).catch(() => {});
      }
    }
  });
}

export function closeDatabase(): Promise<void> {
  closePromise ??= queryClient.end({ timeout: 5 });
  return closePromise;
}

export class AdvisoryLockUnavailableError extends Error {
  readonly statusCode = 409;

  constructor(message = "operation already in progress") {
    super(message);
    this.name = "AdvisoryLockUnavailableError";
  }
}

/**
 * Hold a PostgreSQL session advisory lock across a long-running operation
 * without keeping a database transaction open. The reserved connection is
 * always released, and PostgreSQL also drops the lock if the process exits.
 */
export async function withSessionAdvisoryLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const connection = await queryClient.reserve();
  let acquired = false;
  try {
    const rows = await connection<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS acquired
    `;
    acquired = rows[0]?.acquired === true;
    if (!acquired) throw new AdvisoryLockUnavailableError();
    return await operation();
  } finally {
    try {
      if (acquired) {
        await connection`
          SELECT pg_advisory_unlock(hashtextextended(${key}, 0))
        `;
      }
    } finally {
      connection.release();
    }
  }
}

export { schema };
