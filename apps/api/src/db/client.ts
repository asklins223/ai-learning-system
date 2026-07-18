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

const queryClient = postgres(connectionString, { max: 10 });
let closePromise: Promise<void> | null = null;

export const db = drizzle(queryClient, { schema });

export type ApiTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface WorkspaceTransactionContext {
  workspaceId: string;
  userId: string | null;
}

export interface NormalizedWorkspaceTransactionContext {
  workspaceId: string;
  userId: string | null;
}

export class WorkspaceTransactionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTransactionContextError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (context.userId !== null && typeof context.userId !== "string") {
    throw new WorkspaceTransactionContextError("userId must be a UUID or null");
  }
  return {
    workspaceId: normalizeContextUuid(context.workspaceId, "workspaceId"),
    userId: context.userId === null ? null : normalizeContextUuid(context.userId, "userId"),
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
 * the exact normalized values. An empty app.user_id represents an intentionally
 * absent actor and is consumed through NULLIF by future policies.
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
      pg_catalog.set_config('app.user_id', ${normalized.userId ?? ""}, true) AS user_id
  `);
  const applied = rows[0];
  if (
    applied?.workspace_id?.toLowerCase() !== normalized.workspaceId
    || (applied?.user_id ?? "").toLowerCase() !== (normalized.userId ?? "")
  ) {
    throw new WorkspaceTransactionContextError("database rejected workspace transaction context");
  }
  return normalized;
}

/**
 * Run one application unit of work with transaction-local tenant context.
 * Same-context nesting reuses the active transaction; context changes fail
 * before any query can execute.
 */
export async function withWorkspaceTransaction<T>(
  context: WorkspaceTransactionContext,
  operation: (transaction: ApiTransaction) => Promise<T>,
): Promise<T> {
  const normalized = normalizeWorkspaceTransactionContext(context);
  const active = workspaceTransactionStorage.getStore();
  if (active) {
    if (!active.open) {
      throw new WorkspaceTransactionContextError("workspace transaction is no longer active");
    }
    assertWorkspaceTransactionContextCompatible(active.context, normalized);
    return operation(active.transaction);
  }

  return db.transaction(async (transaction) => {
    await setApiTransactionContext(transaction, normalized);
    const scopedTransaction = { context: normalized, transaction, open: true };
    try {
      return await workspaceTransactionStorage.run(
        scopedTransaction,
        () => operation(transaction),
      );
    } finally {
      scopedTransaction.open = false;
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
