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

export const db = drizzle(queryClient, { schema });

export { schema };
