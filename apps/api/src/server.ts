import { sql } from "drizzle-orm";
import { closeDatabase, db } from "./db/client.ts";
import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import compress from "@fastify/compress";
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
import { cardGenerationV2Routes } from "./modules/card-generation-v2/routes.ts";
import { learningObjectiveRoutes } from "./modules/learning-objectives/routes.ts";
import { learningDashboardRoutes } from "./modules/learning-dashboard/routes.ts";
import { isCardGenerationV2Enabled } from "./config/learning-companion-flags.ts";
import { companionShellRoutes } from "./modules/companion-shell/index.ts";
import { learningMetricRoutes } from "./modules/observability/routes.ts";
import { companionConversationRoutes, companionConversationManagementRoutes, companionExportRoutes, assistantSessionRoutes } from "./modules/companion-conversation/index.ts";
import { startCompanionNotifyListener, stopCompanionNotifyListener } from "./modules/companion-conversation/companion-notify.ts";
import { learningSessionRoutes } from "./modules/learning-sessions/session-routes.ts";
import { learningRunRoutes } from "./modules/learning-runs/run-routes.ts";
import { companionBridgeRoutes } from "./modules/companion-bridge/routes.ts";
import { companionJourneyRoutes } from "./modules/companion-journey/routes.ts";
import { understandingProjectionRoutes } from "./modules/understanding/projection-routes.ts";
import { proactiveInboxRoutes } from "./modules/companion-conversation/inbox-routes.ts";
import { deliveryRoutes } from "./modules/companion-conversation/delivery-routes.ts";
import { memoryRoutes } from "./modules/companion-conversation/memory-routes.ts";
import { petProfileRoutes } from "./modules/companion-conversation/pet-profile-routes.ts";
import { dailySummaryRoutes } from "./modules/companion-conversation/daily-summary-routes.ts";
import { deliveryTimelineRoutes } from "./modules/companion-conversation/timeline-routes.ts";
import { voiceRoutes } from "./modules/learning-sessions/voice-routes.ts";
import { assessmentRoutes } from "./modules/learning-sessions/assessment-service.ts";
import { cleanupExpiredSessions } from "./modules/identity/service.ts";
import { purgeSoftDeletedNotes } from "./modules/note/maintenance.ts";
import { runLearningTtlMaintenance } from "./modules/learning-sessions/ttl-maintenance.ts";
import {
  createCommitOutboxWorkerId,
  runCommitOutboxTick,
} from "./modules/learning-sessions/commit-outbox.ts";
import { runLearningRunProcessingTick, closeStructuredSolutionSql } from "./modules/learning-runs/run-processing-tick.ts";
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
  dbPoolActiveConnections,
  dbMigrationVersion,
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
  // 2026-08-11（可观测性）：默认 reqId 是进程内递增计数器——多副本部署下
  // 各进程 id 相同，跨进程追踪不可用。改用随机 UUID（Node 20+ crypto.randomUUID）。
  genReqId: () => crypto.randomUUID(),
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

// NFR-S（方案 16 §19.2）：全局基础安全头——API 独立服务暴露 4000，
// 与 web（Next.js 已配 CSP/nosniff/DENY）同等的防御基线。SSE 走 hijack
// （onSend 不触发），其 writeHead 已带 Content-Type/Cache-Control。
app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
});

// OPS-01: HTTP 请求指标收集 hook（ADR-0006 §1）
// 在每个请求完成后记录 method、route template、status class 和延迟。
// 路由参数被规范化为模板，避免高基数和参数泄漏。
app.addHook("onResponse", async (request, reply) => {
  // 排除 /metrics 和 /health 自身，避免自我放大。
  // 2026-08-11（review 修复）：用 routeOptions.url（不含 query）而非
  // request.url 精确匹配——`/metrics?x=1` 也命中排除。
  const selfRoute = request.routeOptions.url;
  if (selfRoute === "/metrics" || selfRoute === "/health") return;
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
  // 2026-08-11（可观测性，review 修复）：4xx 安全事件统一在 onResponse 记录——
  // 此前放在 setErrorHandler，直接 reply.code(403/429).send() 的路径（限流、
  // switch-workspace 拒绝）不走 error handler，日志不可达。此处覆盖所有路径；
  // setErrorHandler 内的 4xx 日志已移除避免重复。
  if (reply.statusCode === 401 || reply.statusCode === 403 || reply.statusCode === 429) {
    request.log.warn({ statusCode: reply.statusCode, route }, "security event: auth/permission/rate-limit");
  }
});

// security: 未捕获异常统一脱敏（SQL/S3/provider 细节不进响应体）。
// 5xx 一律返回占位 message（细节进日志）；带 statusCode 的业务错误（4xx）
// 保留 code + 产品文案 message（各业务错误类已按产品语义构造）。
app.setErrorHandler((error, request, reply) => {
  const statusCode = Number((error as { statusCode?: unknown }).statusCode ?? 500);
  if (statusCode >= 500) {
    // 2026-08-11：URL 脱敏——request.url 含 query（可能带参数）；改记 route
    // 模板（ADR-0006），query 细节进 request.log 的完整请求日志而非 error 行。
    const routeTemplate = request.routeOptions?.url ?? "unmatched";
    // 2026-08-11（可观测性）：RLS 拒绝（Postgres error code 42501）计数——
    // 此前 dbRlsDeniedTotal 定义后从未 set，RLS 误拦完全不可见。
    const errorCode = (error as { code?: unknown }).code;
    if (errorCode === "42501") {
      import("./lib/metrics.ts").then(({ dbRlsDeniedTotal }) => dbRlsDeniedTotal.inc()).catch(() => {});
    }
    request.log.error({ err: error, route: typeof routeTemplate === "string" ? routeTemplate : "unmatched" }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "服务器内部错误" });
  }
  const code = (error as { code?: unknown }).code;
  // 2026-08-12（错误契约审计 P2-7）：4xx message 透传加形状白名单——
  // 仅透传带短 code + 短 message 的受控业务/Fastify 错误；超长 message
  // （可能是堆栈/内部细节）一律占位，防止未来 throw 未经包装的 Error 泄漏。
  const knownErrorShape = typeof code === "string"
    && code.length > 0
    && code.length <= 64
    && error instanceof Error
    && error.message.length <= 300;
  return reply.code(statusCode).send({
    error: typeof code === "string" && code.length > 0 && code.length <= 64 ? code : "request_error",
    message: knownErrorShape ? error.message : "请求错误",
  });
});

// 2026-08-11：默认 404 会泄漏路由路径模板（如 "Route /notes/:id not found"）；
// 统一为不泄漏内部路径的中文占位。
app.setNotFoundHandler((_request, reply) => {
  return reply.code(404).send({ error: "not_found", message: "资源不存在" });
});

// 2026-08-11：server 侧全局异步兜底（与 setErrorHandler 互补——后者只覆盖
// 请求生命周期内的错误；未捕获 rejection 会直接崩进程）。
process.on("unhandledRejection", (reason) => {
  app.log.error({ reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) }, "unhandledRejection — exiting");
  process.exitCode = 1;
  process.kill(process.pid, "SIGTERM");
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
    // 救火 2（审计）：learning_sessions 是学习伴侣核心表——缺失时服务必须 not_ready
    const coreTables = [
      "users",
      "workspaces",
      "notes",
      "jobs",
      "sessions",
      "learning_sessions",
      "learning_episodes",
      "learning_response_artifacts",
    ];
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

  // 2026-08-11（性能专项）：响应压缩——graph/export/messages/notes 等 JSON 大响应
  // 文本压缩率 >80%，显著降低带宽与传输时间（TLS 场景下压缩收益仍明显）。
  await app.register(compress, { global: true });

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
  // §21.5：Card Generation V2 是原子 capability bundle，默认 fail-closed。
  if (isCardGenerationV2Enabled()) {
    await app.register(cardGenerationV2Routes);
  } else {
    app.log.info({ capability: "card_generation_v2" }, "card-generation-v2 disabled (CARD_GENERATION_V2_ENABLED not set)");
  }
  // Plan 23 W2/W3：Objective Surface + Dashboard 读取端点（只读；页面级切流由
  // learning_objective_system_v3 capability 统一 gate，见 §22）。
  await app.register(learningObjectiveRoutes);
  await app.register(learningDashboardRoutes);
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
  await app.register(learningMetricRoutes);
  await app.register(companionConversationRoutes);
  await app.register(assistantSessionRoutes);
  await app.register(companionConversationManagementRoutes);
  await app.register(companionExportRoutes);
  // §11.6：启动清扫崩溃残留的临时探测音频（>1h hard cap；不阻塞启动）
  import("./modules/learning-sessions/ffprobe.ts")
    .then((m) => m.cleanupStaleTempAudio(60 * 60 * 1000, "/tmp"))
    .catch(() => {});

  // §5.4：进程级单 NOTIFY listener（conversation + account channels）——
  // SSE live 订阅的即时 wake hint；各 SSE 处理器保留 durable fallback。
  startCompanionNotifyListener(
    process.env.DATABASE_URL_API?.trim() ??
      process.env.DATABASE_URL?.trim() ??
      "postgres://ailearn:ailearn_dev@postgres:5432/ailearn",
  );
  await app.register(learningSessionRoutes);
  await app.register(learningRunRoutes);
  await app.register(companionBridgeRoutes);
  await app.register(companionJourneyRoutes);
  await app.register(understandingProjectionRoutes);
  await app.register(proactiveInboxRoutes);
  await app.register(deliveryRoutes);
  await app.register(memoryRoutes);
  await app.register(petProfileRoutes);
  await app.register(dailySummaryRoutes);
  await app.register(deliveryTimelineRoutes);
  await app.register(voiceRoutes);
  await app.register(assessmentRoutes);

  const PORT = Number(process.env.PORT ?? 4000);
  const HOST = "0.0.0.0";

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`API listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  let dbGaugeTimer: NodeJS.Timeout | undefined;
  let sessionCleanupTimer: NodeJS.Timeout | undefined;
  let notePurgeTimer: NodeJS.Timeout | undefined;
  let commitOutboxTimer: NodeJS.Timeout | undefined;
  let learningRunProcessingTimer: NodeJS.Timeout | undefined;
  const shutdown = createGracefulShutdown({
    clearTimer: () => {
      // F5（审计 #13）：dbGaugeTimer 也纳入关停清理，避免优雅停机期间继续每
      // 30s 发 DB gauge 查询。
      if (dbGaugeTimer) clearInterval(dbGaugeTimer);
      dbGaugeTimer = undefined;
      if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
      sessionCleanupTimer = undefined;
      if (notePurgeTimer) clearInterval(notePurgeTimer);
      notePurgeTimer = undefined;
      if (commitOutboxTimer) clearInterval(commitOutboxTimer);
      commitOutboxTimer = undefined;
      if (learningRunProcessingTimer) clearInterval(learningRunProcessingTimer);
      learningRunProcessingTimer = undefined;
    },
    closeServer: () => app.close(),
    // 2026-08-11：NOTIFY listener 连接必须显式关闭，否则进程退出挂起
    afterClose: () => {
      void closeStructuredSolutionSql();
      stopCompanionNotifyListener();
    },
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
    // 2026-08-11（可观测性）：DB 池活跃连接 + 迁移版本周期 gauge（30s）——
    // 此前两个 gauge 定义后从未 set，空转。
    // 2026-08-11：in-flight 守卫变量（回调重叠防护，见下方注释）
    let dbGaugeRunning = false;
    dbGaugeTimer = setInterval(async () => {
      // 2026-08-11（review 修复）：in-flight 守卫——DB 慢查询时上一轮未完成
      // 则跳过本轮，避免回调重叠堆积。
      if (dbGaugeRunning) return;
      dbGaugeRunning = true;
      try {
        const [poolRow, migRow] = await Promise.all([
          db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`),
          db.execute(sql`SELECT max(id)::int AS v FROM drizzle.__drizzle_migrations`),
        ]);
        const poolRows = poolRow as Array<Record<string, unknown>>;
        const migRows = migRow as Array<Record<string, unknown>>;
        dbPoolActiveConnections.set(Number(poolRows[0]?.n ?? 0));
        dbMigrationVersion.set(Number(migRows[0]?.v ?? 0));
      } catch (err) {
        app.log.warn({ err }, "db gauges refresh failed");
      } finally {
        dbGaugeRunning = false;
      }
    }, 30_000);
    dbGaugeTimer?.unref?.();

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

  // Learning Companion TTL（0076/0081/0083 承诺的清理落地）：audit/ledger
  // tombstone 化 + 已处理 outbox 与过期 nonce 删除。启动先跑一次，之后每 6 小时。
  try {
    const ttl = await runLearningTtlMaintenance();
    const touched = ttl.auditedRows + ttl.ledgerRows + ttl.outboxRows + ttl.nonceRows;
    if (touched > 0) {
      app.log.info({ ttl }, "learning TTL maintenance ran on startup");
    }
  } catch (err) {
    app.log.error({ err }, "learning TTL maintenance on startup failed");
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
      try {
        const ttl = await runLearningTtlMaintenance();
        const touched = ttl.auditedRows + ttl.ledgerRows + ttl.outboxRows + ttl.nonceRows;
        if (touched > 0) {
          app.log.info({ ttl }, "learning TTL maintenance ran");
        }
      } catch (err) {
        app.log.error({ err }, "learning TTL maintenance failed");
      }
    }, 6 * 60 * 60 * 1000); // 6 hours
    notePurgeTimer.unref();
  }

  // COMMIT-01: commit_requested outbox 消费（评估完成 → episode-commit 编排，
  // 幂等 commit key + PgCommitPort；commit 应用后触发 committed_change_display）。
  // 轮询 10s：commit 是评估→掌握的即时应答关键路径。
  // 2026-08-15（方案 16 P9）：learning_run_v1 切流后旧 commit 消费者停用——
  // 新链路（run-processing-tick）是唯一 Commit 执行者；旧 SECURITY DEFINER
  // claim 函数（ailearn_claim_commit_outbox）在 schema 演进后列引用歧义
  // （42702），且旧 outbox 已无新写入（P3 原子切流），停用即消除错误循环。
  if (process.env.LEARNING_RUN_V1 !== "true" && !shutdown.isShuttingDown()) {
    const commitOutboxWorkerId = createCommitOutboxWorkerId();
    // 2026-08-11（可观测性）：失败退避——DB 不可达时 10s 轮询会每秒刷 error
    // 日志；失败后间隔翻倍（10s→20s→40s 封顶 60s），成功后立即回到 10s。
    let commitOutboxIntervalMs = 10 * 1000;
    let commitOutboxFailedStreak = 0;
    const scheduleCommitOutboxTick = () => {
      commitOutboxTimer = setTimeout(async () => {
        try {
          const processed = await runCommitOutboxTick(commitOutboxWorkerId, 60_000);
          if (processed > 0) {
            app.log.info({ processed }, "commit outbox processed");
          }
          commitOutboxFailedStreak = 0;
          commitOutboxIntervalMs = 10 * 1000;
        } catch (err) {
          commitOutboxFailedStreak += 1;
          commitOutboxIntervalMs = Math.min(10 * 1000 * (2 ** commitOutboxFailedStreak), 60_000);
          app.log.error({ err, nextRetryMs: commitOutboxIntervalMs }, "commit outbox tick failed");
        }
        scheduleCommitOutboxTick();
      }, commitOutboxIntervalMs);
      commitOutboxTimer.unref();
    };
    scheduleCommitOutboxTick();
  }

  // LR-PROC-01: learning_run_processing_outbox 消费（assessment_requested →
  // 确定性评估/Fail-closed → commit_requested → canonical_unable Commit）。
  // 轮询 10s，与 commit outbox 同一节奏；失败退避同模式。
  if (!shutdown.isShuttingDown()) {
    const processingWorkerId = `run-proc:${crypto.randomUUID()}`;
    let processingIntervalMs = 10 * 1000;
    let processingFailedStreak = 0;
    const scheduleProcessingTick = () => {
      learningRunProcessingTimer = setTimeout(async () => {
        try {
          const result = await runLearningRunProcessingTick(processingWorkerId, 50);
          if (result.processed > 0 || result.failed > 0) {
            app.log.info({ ...result }, "learning run processing tick");
          }
          processingFailedStreak = 0;
          processingIntervalMs = 10 * 1000;
        } catch (err) {
          processingFailedStreak += 1;
          processingIntervalMs = Math.min(10 * 1000 * (2 ** processingFailedStreak), 60_000);
          app.log.error({ err, nextRetryMs: processingIntervalMs }, "learning run processing tick failed");
        }
        scheduleProcessingTick();
      }, processingIntervalMs);
      learningRunProcessingTimer.unref();
    };
    scheduleProcessingTick();
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
