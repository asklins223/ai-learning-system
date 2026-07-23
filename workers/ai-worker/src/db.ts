import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
import * as schema from "./schema/index.ts";

const DEFAULT_DATABASE_URL = "postgres://ailearn:ailearn_dev@postgres:5432/ailearn";

export function resolveWorkerDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const roleUrl = env.DATABASE_URL_WORKER?.trim();
  if (roleUrl) return roleUrl;
  if (env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL_WORKER is required when NODE_ENV=production");
  }
  return env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}

const connectionString = resolveWorkerDatabaseUrl();

// Pool size must accommodate QUEUE_CONCURRENCY (3) parallel jobs, each of which
// may issue up to 4 concurrent queries via Promise.all (e.g. generate_card's
// version+blocks+governance fan-out).  Peak demand = 3 × 4 = 12 concurrent
// connections.  10 was slightly too small at peak — 2 queries would queue
// inside the pool.  15 provides headroom for peak demand plus connection
// lifecycle overhead (claim/reap/metrics queries running alongside handlers).
const queryClient = postgres(connectionString, { max: 15 });
export const db = drizzle(queryClient, { schema });

export type WorkerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface WorkerWorkspaceTransactionContext {
  workspaceId: string;
  userId: string | null;
}

export interface NormalizedWorkerWorkspaceTransactionContext {
  workspaceId: string;
  userId: string | null;
}

export class WorkerWorkspaceTransactionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerWorkspaceTransactionContextError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeContextUuid(value: string, field: "workspaceId" | "userId"): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new WorkerWorkspaceTransactionContextError(`${field} must be a UUID`);
  }
  return normalized;
}

export function normalizeWorkerWorkspaceTransactionContext(
  context: WorkerWorkspaceTransactionContext,
): NormalizedWorkerWorkspaceTransactionContext {
  if (!context || typeof context !== "object") {
    throw new WorkerWorkspaceTransactionContextError("worker workspace transaction context is required");
  }
  if (typeof context.workspaceId !== "string") {
    throw new WorkerWorkspaceTransactionContextError("workspaceId must be a UUID");
  }
  if (context.userId !== null && typeof context.userId !== "string") {
    throw new WorkerWorkspaceTransactionContextError("userId must be a UUID or null");
  }
  return {
    workspaceId: normalizeContextUuid(context.workspaceId, "workspaceId"),
    userId: context.userId === null ? null : normalizeContextUuid(context.userId, "userId"),
  };
}

export function assertWorkerWorkspaceTransactionContextCompatible(
  active: NormalizedWorkerWorkspaceTransactionContext,
  requested: NormalizedWorkerWorkspaceTransactionContext,
): void {
  if (active.workspaceId !== requested.workspaceId || active.userId !== requested.userId) {
    throw new WorkerWorkspaceTransactionContextError(
      "nested worker database work cannot change workspace or user context",
    );
  }
}

type ActiveWorkerWorkspaceTransaction = {
  context: NormalizedWorkerWorkspaceTransactionContext;
  transaction: WorkerTransaction;
  open: boolean;
};

const workerWorkspaceTransactionStorage =
  new AsyncLocalStorage<ActiveWorkerWorkspaceTransaction>();

export async function setWorkerTransactionContext(
  transaction: WorkerTransaction,
  context: WorkerWorkspaceTransactionContext,
): Promise<NormalizedWorkerWorkspaceTransactionContext> {
  const normalized = normalizeWorkerWorkspaceTransactionContext(context);
  const active = workerWorkspaceTransactionStorage.getStore();
  if (active) {
    if (!active.open) {
      throw new WorkerWorkspaceTransactionContextError(
        "worker workspace transaction is no longer active",
      );
    }
    assertWorkerWorkspaceTransactionContextCompatible(active.context, normalized);
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
    throw new WorkerWorkspaceTransactionContextError(
      "database rejected worker workspace transaction context",
    );
  }
  return normalized;
}

export async function withWorkerWorkspaceTransaction<T>(
  context: WorkerWorkspaceTransactionContext,
  operation: (transaction: WorkerTransaction) => Promise<T>,
): Promise<T> {
  const normalized = normalizeWorkerWorkspaceTransactionContext(context);
  const active = workerWorkspaceTransactionStorage.getStore();
  if (active) {
    if (!active.open) {
      throw new WorkerWorkspaceTransactionContextError(
        "worker workspace transaction is no longer active",
      );
    }
    assertWorkerWorkspaceTransactionContextCompatible(active.context, normalized);
    return operation(active.transaction);
  }

  return db.transaction(async (transaction) => {
    await setWorkerTransactionContext(transaction, normalized);
    const scopedTransaction = { context: normalized, transaction, open: true };
    try {
      return await workerWorkspaceTransactionStorage.run(
        scopedTransaction,
        () => operation(transaction),
      );
    } finally {
      scopedTransaction.open = false;
    }
  });
}

/** Stop accepting new queries and drain the Postgres.js pool on shutdown. */
export async function closeDatabase(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
