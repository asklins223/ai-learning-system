import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
