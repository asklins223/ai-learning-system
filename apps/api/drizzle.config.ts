import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const migratorUrl = process.env.DATABASE_URL_MIGRATOR?.trim();
if (process.env.NODE_ENV === "production" && !migratorUrl) {
  throw new Error("DATABASE_URL_MIGRATOR is required when NODE_ENV=production");
}

export default defineConfig({
  // 2026-08-24（AI 设计审查 §4.4 第三批）：schema 单一事实来源下沉至
  // packages/shared/src/db-schema（api 与 worker 平级消费）。
  schema: "../../packages/shared/src/db-schema/index.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      migratorUrl ??
      process.env.DATABASE_URL ??
      "postgres://ailearn:ailearn_dev@postgres:5432/ailearn",
  },
  verbose: true,
  strict: true,
});
