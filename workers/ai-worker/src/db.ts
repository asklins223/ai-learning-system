import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
// 2026-08-24（AI 设计审查 §4.4 第三批）：drizzle schema 单一事实来源下沉至
// packages/shared，worker 与 api 平级消费（反向路径依赖清零）。
import * as schema from "@ailearn/shared/db-schema";

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

// Pool size is derived from QUEUE_CONCURRENCY so the connection capacity stays
// coupled to the actual parallel-job demand (W3). Each claimed job may issue up
// to ~4 concurrent queries via Promise.all fan-out (version+blocks+governance
// reads) plus lifecycle queries (claim/reap/metrics) running alongside handlers.
//   pool = clamp(QUEUE_CONCURRENCY * 4, 15, 64)
// QUEUE_CONCURRENCY parsing mirrors queue.ts (default 3, clamp [1,16]) so the
// two constants never drift. Default concurrency 3 → 3×4=12 → min floor 15.
function resolveWorkerConcurrency(input: string | undefined): number {
  const raw = Number(input ?? 3);
  const parsed = Number.isFinite(raw) ? raw : 3;
  return Math.max(1, Math.min(16, parsed));
}
const workerConcurrency = resolveWorkerConcurrency(process.env.QUEUE_CONCURRENCY);
const poolMax = Math.max(15, Math.min(64, workerConcurrency * 4));
const queryClient = postgres(connectionString, { max: poolMax });
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

  // userId 为 null 时必须设 NULL 而非空串：RLS 策略中 `user_id = ''::uuid`
  // 是计划期常量转换，空串会直接抛 "invalid input syntax for type uuid: """，
  // 与 OR 短路无关（0138 审查修复后验证到的真实故障）。
  const rows = await transaction.execute<{ workspace_id: string; user_id: string | null }>(sql`
    SELECT
      pg_catalog.set_config('app.workspace_id', ${normalized.workspaceId}, true) AS workspace_id,
      pg_catalog.set_config('app.user_id', ${normalized.userId ?? null}, true) AS user_id
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
