import { sql } from "drizzle-orm";
import { closeDatabase, db } from "./db/client.ts";
import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { logger } from "./lib/logger.ts";
import { authRoutes } from "./modules/identity/routes.ts";
import { noteRoutes } from "./modules/note/routes.ts";
import { cardRoutes, cardJobRoutes } from "./modules/card/routes.ts";
import { jobRoutes } from "./modules/job/routes.ts";
import { evidenceRoutes } from "./modules/evidence/routes.ts";
import { validationRoutes } from "./modules/validation/routes.ts";
import { reviewRoutes } from "./modules/review/routes.ts";
import { sourceRoutes } from "./modules/source/routes.ts";
import { importRoutes } from "./modules/import/routes.ts";
import { understandingRoutes } from "./modules/understanding/routes.ts";
import { searchRoutes } from "./modules/search/routes.ts";
import { exportRoutes } from "./modules/export/routes.ts";
import { statsRoutes } from "./modules/stats/routes.ts";
import { benchmarkRoutes } from "./modules/benchmark/routes.ts";
import { cleanupExpiredSessions } from "./modules/identity/service.ts";
import { createGracefulShutdown } from "./lib/graceful-shutdown.ts";

const trustProxyValue = process.env.TRUST_PROXY?.trim();
const normalizedTrustProxyValue = trustProxyValue?.toLowerCase();
const trustProxy = !trustProxyValue || normalizedTrustProxyValue === "false"
  ? false
  : normalizedTrustProxyValue === "true"
    ? true
    : /^\d+$/.test(trustProxyValue)
      ? Number(trustProxyValue)
      : trustProxyValue.split(",").map((value) => value.trim()).filter(Boolean);

const app = Fastify({
  loggerInstance: logger,
  // 不再无条件信任任意 X-Forwarded-For。生产 Compose 只信任
  // loopback / Docker 私网代理，其他部署必须显式配置 TRUST_PROXY。
  trustProxy,
});

// Liveness only proves the process/event loop can answer HTTP. Database and
// schema checks belong exclusively to /ready so a transient dependency outage
// does not make the orchestrator kill an otherwise healthy API process.
app.get("/health", async () => {
  return {
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString(),
  };
});

app.get("/ready", async (_req, reply) => {
  try {
    await db.execute(sql`SELECT 1`);
    const requiredTables = [
      "users",
      "workspaces",
      "workspace_members",
      "invite_codes",
      "sessions",
      "sources",
      "source_segments",
      "notes",
      "note_versions",
      "note_blocks",
      "learning_cards",
      "card_key_points",
      "evidences",
      "evidence_overrides",
      "validation_events",
      "validation_questions",
      "review_schedules",
      "understanding_events",
      "ai_artifacts",
      "ai_audit_log",
      "jobs",
      "search_documents",
      "benchmark_reports",
      "benchmark_labels",
      "auth_rate_limits",
      "user_ai_model_configs",
    ];
    const tableRows = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const presentTables = new Set(
      tableRows.map((row) => (row as { table_name: string }).table_name),
    );
    const missingTables = requiredTables.filter((table) => !presentTables.has(table));

    // Drizzle journal 的最新迁移时间戳。可通过环境变量在后续版本提升门槛，
    // 避免只存在早期核心表时 readiness 仍误报成功。
    const minimumMigrationRaw = process.env.MIN_READY_MIGRATION_CREATED_AT ?? "1784437400000";
    const minimumMigration = Number(minimumMigrationRaw);
    if (!Number.isSafeInteger(minimumMigration) || minimumMigration <= 0) {
      return reply.code(503).send({
        status: "not_ready",
        service: "api",
        error: "MIN_READY_MIGRATION_CREATED_AT must be a positive safe integer",
        timestamp: new Date().toISOString(),
      });
    }
    const migrationRows = await db.execute(sql`
      SELECT max(created_at)::bigint AS created_at
      FROM drizzle.__drizzle_migrations
    `);
    const appliedMigration = Number(
      (migrationRows[0] as { created_at: string | number | null } | undefined)?.created_at ?? 0,
    );

    if (missingTables.length > 0 || appliedMigration < minimumMigration) {
      return reply.code(503).send({
        status: "not_ready",
        service: "api",
        error: "business schema is incomplete — run migrations",
        missingTables,
        appliedMigration,
        requiredMigration: minimumMigration,
        timestamp: new Date().toISOString(),
      });
    }
    return {
      status: "ready",
      service: "api",
      timestamp: new Date().toISOString(),
    };
  } catch {
    return reply.code(503).send({
      status: "not_ready",
      service: "api",
      error: "database connection failed",
      timestamp: new Date().toISOString(),
    });
  }
});

// G-002: 包装在 async IIFE 中，使 esbuild --format=cjs 能正确构建（CJS 不支持 top-level await）
async function main() {
  const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) {
    throw new Error("CORS_ORIGIN must contain at least one origin");
  }
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  // 提供 httpErrors（badRequest / unauthorized / notFound 等）和统一错误序列化。
  await app.register(sensible);

  await app.register(authRoutes);
  await app.register(noteRoutes);
  await app.register(cardRoutes);
  await app.register(cardJobRoutes);
  await app.register(jobRoutes);
  await app.register(evidenceRoutes);
  await app.register(validationRoutes);
  await app.register(reviewRoutes);
  await app.register(sourceRoutes);
  await app.register(importRoutes);
  await app.register(understandingRoutes);
  await app.register(searchRoutes);
  await app.register(exportRoutes);
  await app.register(statsRoutes);
  await app.register(benchmarkRoutes);

  const PORT = Number(process.env.PORT ?? 4000);
  const HOST = "0.0.0.0";

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`API listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  let sessionCleanupTimer: NodeJS.Timeout | undefined;
  const shutdown = createGracefulShutdown({
    clearTimer: () => {
      if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
      sessionCleanupTimer = undefined;
    },
    closeServer: () => app.close(),
    closeDatabase,
  });
  const handleSignal = (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutdown requested");
    void shutdown.shutdown(signal).catch((error) => {
      app.log.error({ err: error, signal }, "graceful shutdown failed");
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  // §2.4: 清理过期 session — 启动时立即执行一次，之后每小时定时清理
  // 启动时先清理一次（进程崩溃重启后可能积累了大量过期 session）
  try {
    const deleted = await cleanupExpiredSessions();
    if (deleted > 0) {
      app.log.info({ deleted }, "expired sessions cleaned up on startup");
    }
  } catch (err) {
    app.log.error({ err }, "session cleanup on startup failed");
  }

  // 每小时定时清理
  if (!shutdown.isShuttingDown()) {
    sessionCleanupTimer = setInterval(async () => {
      try {
        const deleted = await cleanupExpiredSessions();
        if (deleted > 0) {
          app.log.info({ deleted }, "expired sessions cleaned up");
        }
      } catch (err) {
        app.log.error({ err }, "session cleanup failed");
      }
    }, 60 * 60 * 1000); // 1 hour
    sessionCleanupTimer.unref();
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
