import { sql } from "drizzle-orm";
import { closeDatabase, db } from "./db/client.ts";
import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import { logger } from "./lib/logger.ts";
import { authRoutes } from "./modules/identity/routes.ts";
import { noteRoutes } from "./modules/note/routes.ts";
import { cardRoutes, cardJobRoutes } from "./modules/card/routes.ts";
import { cardSetRoutes } from "./modules/card-set/routes.ts";
import { jobRoutes } from "./modules/job/routes.ts";
import { evidenceRoutes } from "./modules/evidence/routes.ts";
import { validationRoutes } from "./modules/validation/routes.ts";
import { validationSessionRoutes } from "./modules/validation/session-routes.ts";
import { reviewRoutes } from "./modules/review/routes.ts";
import { sourceRoutes } from "./modules/source/routes.ts";
import { importRoutes } from "./modules/import/routes.ts";
import { understandingRoutes } from "./modules/understanding/routes.ts";
import { searchRoutes } from "./modules/search/routes.ts";
import { exportRoutes } from "./modules/export/routes.ts";
import { statsRoutes } from "./modules/stats/routes.ts";
import { benchmarkRoutes } from "./modules/benchmark/routes.ts";
import { uploadRoutes } from "./modules/upload/routes.ts";
import { cardGenerationRoutes } from "./modules/card-generation/routes.ts";
import { companionShellRoutes } from "./modules/companion-shell/index.ts";
import { learningSessionRoutes } from "./modules/learning-sessions/session-routes.ts";
import { cleanupExpiredSessions } from "./modules/identity/service.ts";
import { purgeSoftDeletedNotes } from "./modules/note/maintenance.ts";
import { createGracefulShutdown } from "./lib/graceful-shutdown.ts";
import {
  getMetricsText,
  getMetricsContentType,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  httpErrors5xxTotal,
  readinessStatus,
  setReleaseInfo,
  statusToClass,
  normalizeRouteTemplate,
} from "./lib/metrics.ts";

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

// OPS-01: Prometheus 指标端点（ADR-0006 §1）
// 不需要认证，但应在生产环境通过网络策略限制访问（仅 Prometheus scraper 可达）。
app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", getMetricsContentType());
  return getMetricsText();
});

// OPS-01: HTTP 请求指标收集 hook（ADR-0006 §1）
// 在每个请求完成后记录 method、route template、status class 和延迟。
// 路由参数被规范化为模板，避免高基数和参数泄漏。
app.addHook("onResponse", async (request, reply) => {
  // 排除 /metrics 和 /health 自身，避免自我放大
  if (request.url === "/metrics" || request.url === "/health") return;
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    .includes(request.method)
    ? request.method
    : "OTHER";
  const routeTemplate = request.routeOptions.url;
  const route = typeof routeTemplate === "string" && routeTemplate.length > 0
    ? normalizeRouteTemplate(routeTemplate)
    : "unmatched";
  const statusClass = statusToClass(reply.statusCode);
  const durationSeconds = reply.elapsedTime / 1000;

  httpRequestsTotal.inc({ method, route, status_class: statusClass });
  httpRequestDurationSeconds.observe({ method, route }, durationSeconds);
  if (statusClass === "5xx") {
    httpErrors5xxTotal.inc({ method, route });
  }
});

/**
 * QUAL-08 修复：不再硬编码表名列表，改为运行时动态查询数据库 schema 中所有表。
 * 这样新增表时无需手动维护此列表，避免遗漏导致 readiness 检查误报。
 * 仅检查核心表是否存在（通过 information_schema.tables 查询）。
 */
app.get("/ready", async (_req, reply) => {
  try {
    await db.execute(sql`SELECT 1`);
    // 动态查询当前数据库中所有 public schema 的表
    const tableRows = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const presentTables = new Set(
      tableRows.map((row) => (row as { table_name: string }).table_name),
    );
    // QUAL-08 修复：不再与硬编码列表对比，改为检查核心表是否存在
    const coreTables = ["users", "workspaces", "notes", "jobs", "sessions"];
    const missingTables = coreTables.filter((table) => !presentTables.has(table));

    // Drizzle journal 的最新迁移时间戳。可通过环境变量在后续版本提升门槛，
    // 避免只存在早期核心表时 readiness 仍误报成功。
    const minimumMigrationRaw = process.env.MIN_READY_MIGRATION_CREATED_AT ?? "1786683800000";
    const minimumMigration = Number(minimumMigrationRaw);
    if (!Number.isSafeInteger(minimumMigration) || minimumMigration <= 0) {
      readinessStatus.set(0);
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
      readinessStatus.set(0);
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
    readinessStatus.set(1);
    return {
      status: "ready",
      service: "api",
      timestamp: new Date().toISOString(),
    };
  } catch {
    readinessStatus.set(0);
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

  // 图片上传：multipart/form-data 解析插件
  // 在流式读取阶段就拒绝超大文件，防止 OOM
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,  // 10MB — 全局上限；头像端点通过 req.file({ limits }) 单独覆写为 2MB
      files: 1,                     // 每次请求只允许 1 个文件
      fields: 3,                    // 非文件字段上限（noteId 等；CSRF token 通过 header 传递，不计入）
      fieldSize: 1024,              // 单个字段值上限
    },
  });

  // OPS-01: 设置 Release 信息（ADR-0006 §2）
  // 在启动时将版本、commit 和迁移数暴露为 Prometheus label。
  const releaseVersion = process.env.npm_package_version ?? "0.5.0";
  const releaseCommit = process.env.GIT_COMMIT ?? "unknown";
  const releaseMigrations = Number(process.env.MIGRATION_COUNT ?? "0");
  setReleaseInfo(releaseVersion, releaseCommit, releaseMigrations);

  await app.register(authRoutes);
  await app.register(noteRoutes);
  await app.register(cardRoutes);
  await app.register(cardJobRoutes);
  await app.register(cardSetRoutes);
  await app.register(cardGenerationRoutes);
  await app.register(jobRoutes);
  await app.register(evidenceRoutes);
  await app.register(validationRoutes);
  await app.register(validationSessionRoutes);
  await app.register(reviewRoutes);
  await app.register(sourceRoutes);
  await app.register(importRoutes);
  await app.register(understandingRoutes);
  await app.register(searchRoutes);
  await app.register(exportRoutes);
  await app.register(statsRoutes);
  await app.register(benchmarkRoutes);
  await app.register(uploadRoutes);
  await app.register(companionShellRoutes);
  await app.register(learningSessionRoutes);

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
  let notePurgeTimer: NodeJS.Timeout | undefined;
  const shutdown = createGracefulShutdown({
    clearTimer: () => {
      if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
      sessionCleanupTimer = undefined;
      if (notePurgeTimer) clearInterval(notePurgeTimer);
      notePurgeTimer = undefined;
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

  // CONC-03: 定时物理清除超过保留期（30 天）的软删除笔记
  // 启动时先执行一次，之后每 6 小时执行一次
  try {
    const purged = await purgeSoftDeletedNotes();
    if (purged > 0) {
      app.log.info({ purged }, "soft-deleted notes purged on startup");
    }
  } catch (err) {
    app.log.error({ err }, "note purge on startup failed");
  }

  if (!shutdown.isShuttingDown()) {
    notePurgeTimer = setInterval(async () => {
      try {
        const purged = await purgeSoftDeletedNotes();
        if (purged > 0) {
          app.log.info({ purged }, "soft-deleted notes purged");
        }
      } catch (err) {
        app.log.error({ err }, "note purge failed");
      }
    }, 6 * 60 * 60 * 1000); // 6 hours
    notePurgeTimer.unref();
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
