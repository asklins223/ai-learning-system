import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema/index.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function resolveConnectionString(): string {
  const roleUrl = process.env.DATABASE_URL_MIGRATOR?.trim();
  if (roleUrl) return roleUrl;

  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL_MIGRATOR is required when NODE_ENV=production");
  }

  return (
    process.env.DATABASE_URL?.trim() ??
    "postgres://ailearn:ailearn_dev@postgres:5432/ailearn"
  );
}

const connectionString = resolveConnectionString();

// CI uses a truncated journal + SQL directory to materialize a representative
// deployed baseline before exercising forward migrations.  Production keeps the
// default folder; an override is explicit and never inferred from NODE_ENV.
const migrationsFolder = process.env.MIGRATIONS_FOLDER
  ? resolve(process.cwd(), process.env.MIGRATIONS_FOLDER)
  : resolve(__dirname, "migrations");

async function main() {
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql, { schema });

  try {
    console.log("Running migrations…");
    await migrate(db, {
      migrationsFolder,
    });
    console.log("Migrations complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
