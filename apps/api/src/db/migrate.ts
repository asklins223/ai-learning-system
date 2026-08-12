import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
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

/**
 * 根治（2026-08-11）：drizzle-orm 的 pg migrate() 用「__drizzle_migrations
 * 最新 created_at < journal folderMillis」判断是否执行。一旦该表混入来自
 * CI truncated journal 或其他来源的更大时间戳记录（如 1789967600000），
 * 所有后续迁移都会被静默跳过（表现为 "Migrations complete" 但不建表）。
 *
 * 此处改为逐条精确对比：journal 每个迁移的 hash（sha256(SQL 文件内容)）
 * 已在 __drizzle_migrations 中 → 跳过；不在 → 执行并记录。该逻辑不再受
 * 最新时间戳影响，任何新迁移（0096+）都会可靠执行；已应用且内容未变的
 * 迁移保持幂等跳过。
 */
async function main() {
  const sql = postgres(connectionString, { max: 1 });

  try {
    const migrations = await readMigrationFiles({ migrationsFolder });
    await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await sql`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `;
    const applied = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
    const appliedSet = new Set(applied.map((r) => String(r.hash)));

    const toRun = migrations.filter((m) => !appliedSet.has(m.hash));
    console.log(
      `Running migrations… (${migrations.length} total, ${toRun.length} to run)`,
    );
    for (const m of toRun) {
      const tag = (m as { path?: string }).path?.split("/").pop() ?? "?";
      console.log(`  -> ${tag}`);
    }
    if (toRun.length === 0) {
      console.log("Migrations complete (all applied).");
      return;
    }

    await sql.begin(async (tx) => {
      for (const migration of toRun) {
        for (const stmt of migration.sql) {
          await tx.unsafe(stmt);
        }
        await tx`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${migration.hash}, ${migration.folderMillis})
        `;
      }
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
