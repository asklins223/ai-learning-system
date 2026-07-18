import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.ts";

export function resolveWorkerDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const roleUrl = env.DATABASE_URL_WORKER?.trim();
  if (roleUrl) return roleUrl;
  if (env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL_WORKER is required when NODE_ENV=production");
  }
  return env.DATABASE_URL?.trim() ?? "postgres://ailearn:ailearn_dev@postgres:5432/ailearn";
}

const connectionString = resolveWorkerDatabaseUrl();

const queryClient = postgres(connectionString, { max: 5 });
export const db = drizzle(queryClient, { schema });
