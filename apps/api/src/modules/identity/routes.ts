import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { users, workspaceMembers, workspaces } from "../../db/schema/identity.ts";
import { loginWithPassword, registerWithInvite, switchWorkspace, listUserWorkspaces, getAIPrivacySettings, updateAIConsent, updateAIDataPolicy, listAIAuditLog, logAICall, revokeSession, resetRecoveredUserPassword, SESSION_TTL_MS } from "./service.ts";
import { parseBody } from "../../lib/validate.ts";
import { requireSession, requireOwner, getRequestCredential } from "./middleware.ts";
import { clampLimit, clampOffset, parseQuery } from "../../lib/pagination.ts";
import {
  createAuthCookieHeaders,
  createClearAuthCookieHeaders,
  hasValidCookieCsrf,
} from "./session-auth.ts";
import {
  createRateLimitStoreFromEnv,
  RateLimiter,
  type RateLimitStore,
} from "./rate-limit.ts";
import {
  AIModelConfigError,
  PERSONAL_AI_PROVIDERS,
  deletePersonalAIModelConfig,
  getPersonalAIModelConfig,
  savePersonalAIModelConfig,
} from "./ai-model-config.ts";
import {
  AIModelConnectionError,
  testPersonalAIModelConnection,
} from "./ai-model-connection.ts";

export const loginSchema = z.object({
  email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
  password: z.string().min(4).max(200),
  // Controls whether the browser keeps the HttpOnly cookie after closing.
  // Bearer clients can ignore this field and continue using the response token.
  remember: z.boolean().optional().default(false),
});

const registerSchema = z.object({
  email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
  password: z.string().min(8).max(200),
  inviteCode: z.string().trim().min(1).max(200),
});

const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_RATE_LIMIT_MAX = 5; // max attempts per window
const DEFAULT_AI_MODEL_TEST_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_AI_MODEL_TEST_RATE_LIMIT_MAX = 5;

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

// Development remains dependency-free. Production defaults to the shared
// PostgreSQL store, while AUTH_RATE_LIMIT_STORE can explicitly select either
// backend for controlled test/staging environments.
const defaultRateLimitStore = createRateLimitStoreFromEnv();
const cleanupTimer = setInterval(() => {
  void defaultRateLimitStore.sweep?.(Date.now());
}, 5 * 60 * 1000);
cleanupTimer.unref?.();

export interface AuthRoutesOptions {
  rateLimitStore?: RateLimitStore;
  rateLimitWindowMs?: number;
  rateLimitMaxAttempts?: number;
  aiModelTestRateLimitWindowMs?: number;
  aiModelTestRateLimitMaxAttempts?: number;
}

function setSessionCookies(
  reply: { header(name: string, value: string | string[]): unknown },
  token: string,
  remember = false,
): string {
  const maxAgeSeconds = remember ? Math.floor(SESSION_TTL_MS / 1000) : undefined;
  const cookie = createAuthCookieHeaders(token, maxAgeSeconds);
  reply.header("Set-Cookie", cookie.headers);
  reply.header("Cache-Control", "no-store");
  return cookie.csrfToken;
}

function clearSessionCookies(reply: { header(name: string, value: string | string[]): unknown }) {
  reply.header("Set-Cookie", createClearAuthCookieHeaders());
  reply.header("Cache-Control", "no-store");
}

function retryAfterSeconds(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions = {}) {
  const limiter = new RateLimiter(options.rateLimitStore ?? defaultRateLimitStore, {
    windowMs: options.rateLimitWindowMs ?? positiveIntegerEnv(
      "AUTH_RATE_LIMIT_WINDOW_MS",
      DEFAULT_RATE_LIMIT_WINDOW_MS,
    ),
    maxAttempts: options.rateLimitMaxAttempts ?? positiveIntegerEnv(
      "AUTH_RATE_LIMIT_MAX_ATTEMPTS",
      DEFAULT_RATE_LIMIT_MAX,
    ),
  });
  const aiModelTestLimiter = new RateLimiter(options.rateLimitStore ?? defaultRateLimitStore, {
    windowMs: options.aiModelTestRateLimitWindowMs ?? positiveIntegerEnv(
      "AI_MODEL_TEST_RATE_LIMIT_WINDOW_MS",
      DEFAULT_AI_MODEL_TEST_RATE_LIMIT_WINDOW_MS,
    ),
    maxAttempts: options.aiModelTestRateLimitMaxAttempts ?? positiveIntegerEnv(
      "AI_MODEL_TEST_RATE_LIMIT_MAX_ATTEMPTS",
      DEFAULT_AI_MODEL_TEST_RATE_LIMIT_MAX,
    ),
  });

  app.post("/auth/login", async (req, reply) => {
    // G-005: 使用 req.ip（trustProxy=true 时解析 X-Forwarded-For）而非 req.socket.remoteAddress
    const ip = req.ip;
    const ipKey = `auth:login:ip:${ip}`;
    const ipDecision = await limiter.consume(ipKey);
    if (!ipDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(ipDecision.resetAt));
      return reply.code(429).send({ error: "Too many login attempts. Please try again later." });
    }
    const body = parseBody(app, loginSchema, req.body);
    // R-011: 也按 email 限流，防止跨 IP 暴力破解单个账户
    const emailKey = `auth:login:email:${body.email}`;
    const emailDecision = await limiter.consume(emailKey);
    if (!emailDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(emailDecision.resetAt));
      return reply.code(429).send({ error: "Too many login attempts for this account. Please try again later." });
    }
    const result = await loginWithPassword(body.email, body.password);
    if (!result) {
      throw app.httpErrors.unauthorized("invalid credentials");
    }
    // G-005: 成功登录后重置该账户和 IP 的限流计数
    await limiter.reset(emailKey);
    await limiter.reset(ipKey);
    // Set an HttpOnly cookie for clients that opt into cookie auth while still
    // returning the Bearer token for existing API consumers.
    const csrfToken = setSessionCookies(reply, result.token, body.remember);
    return { ...result, csrfToken };
  });

  app.post("/auth/register", async (req, reply) => {
    // G-005: 使用 req.ip 而非 req.socket.remoteAddress
    const ip = req.ip;
    const ipKey = `auth:register:ip:${ip}`;
    const ipDecision = await limiter.consume(ipKey);
    if (!ipDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(ipDecision.resetAt));
      return reply.code(429).send({ error: "Too many registration attempts. Please try again later." });
    }
    const body = parseBody(app, registerSchema, req.body);
    const result = await registerWithInvite(body.email, body.password, body.inviteCode);
    if (!result) {
      throw app.httpErrors.badRequest("invalid invite or email exists");
    }
    // G-005: 成功注册后重置限流
    await limiter.reset(ipKey);
    const csrfToken = setSessionCookies(reply, result.token);
    return { ...result, csrfToken };
  });

  app.post("/auth/logout", async (req, reply) => {
    const credential = getRequestCredential(req);
    if (credential?.source === "cookie" && !hasValidCookieCsrf(req.method, req.headers)) {
      return reply.code(403).send({ error: "csrf token required" });
    }
    if (credential) await revokeSession(credential.token);
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  // R-026: 返回当前登录用户的真实信息，Sidebar 不再硬编码 owner 邮箱和角色
  app.get("/auth/me", { preHandler: [requireSession] }, async (req) => {
    const { userId, workspaceId } = req.session;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw req.server.httpErrors.notFound("user not found");
    const membership = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    });
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const role = membership?.role === "owner" || workspace?.ownerId === userId
      ? "owner"
      : membership?.role ?? "member";
    return {
      userId,
      workspaceId,
      email: user.email,
      role,
      workspaceName: workspace?.name ?? "个人工作区",
    };
  });

  const personalAIModelConfigSchema = z.object({
    provider: z.enum(PERSONAL_AI_PROVIDERS),
    baseUrl: z.string().trim().max(500).nullable().optional(),
    model: z.string().trim().max(200).nullable().optional(),
    // Omit/blank keeps the existing encrypted key only for the same provider/origin.
    // The key itself is never returned.
    apiKey: z.string().trim().max(4096).optional(),
  });

  app.get("/auth/ai-model-config", { preHandler: [requireSession] }, async (req) => {
    return getPersonalAIModelConfig(req.session.userId);
  });

  app.put("/auth/ai-model-config", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, personalAIModelConfigSchema, req.body);
    try {
      return await savePersonalAIModelConfig(req.session.userId, body);
    } catch (error) {
      if (error instanceof AIModelConfigError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/auth/ai-model-config/test", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, personalAIModelConfigSchema, req.body);
    const decision = await aiModelTestLimiter.consume(`ai-model-test:user:${req.session.userId}`);
    if (!decision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(decision.resetAt));
      return reply.code(429).send({
        error: "连接测试过于频繁，请稍后再试",
        code: "test_rate_limited",
      });
    }

    try {
      const result = await testPersonalAIModelConnection(req.session.userId, body);
      const privacy = await getAIPrivacySettings(req.session.workspaceId).catch(() => null);
      if (privacy?.aiDataPolicy.auditLogging) {
        void logAICall({
          workspaceId: req.session.workspaceId,
          actorUserId: req.session.userId,
          provider: result.provider,
          modelId: result.model,
          operation: "test_connection",
          dataCategories: ["fixed_connection_probe"],
          dataSizeBytes: 0,
          durationMs: result.latencyMs,
          status: "success",
        }).catch((error) => {
          app.log.warn({ err: error, userId: req.session.userId }, "failed to audit AI connection test");
        });
      }
      return result;
    } catch (error) {
      if (error instanceof AIModelConnectionError) {
        if (error.provider && error.model && error.durationMs !== undefined) {
          const privacy = await getAIPrivacySettings(req.session.workspaceId).catch(() => null);
          if (privacy?.aiDataPolicy.auditLogging) {
            void logAICall({
              workspaceId: req.session.workspaceId,
              actorUserId: req.session.userId,
              provider: error.provider,
              modelId: error.model,
              operation: "test_connection",
              dataCategories: ["fixed_connection_probe"],
              dataSizeBytes: 0,
              durationMs: error.durationMs,
              status: "failed",
              errorMessage: error.message,
            }).catch((auditError) => {
              app.log.warn({ err: auditError, userId: req.session.userId }, "failed to audit AI connection test");
            });
          }
        }
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      }
      if (error instanceof AIModelConfigError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          code: "invalid_configuration",
        });
      }
      throw error;
    }
  });

  app.delete("/auth/ai-model-config", { preHandler: [requireSession] }, async (req, reply) => {
    await deletePersonalAIModelConfig(req.session.userId);
    return reply.code(204).send();
  });

  // N-013: 列出用户可访问的所有工作区
  app.get("/auth/workspaces", { preHandler: [requireSession] }, async (req) => {
    const workspaces = await listUserWorkspaces(req.session.userId);
    return { workspaces };
  });

  // N-013: 切换工作区
  const switchWorkspaceSchema = z.object({
    workspaceId: z.string().uuid(),
  });
  app.post("/auth/switch-workspace", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, switchWorkspaceSchema, req.body);
    const result = await switchWorkspace(req.session.userId, body.workspaceId);
    if (!result) {
      return reply.code(403).send({ error: "not a member of this workspace" });
    }
    const csrfToken = setSessionCookies(reply, result.token);
    return { ...result, csrfToken };
  });

  const recoveredPasswordParamsSchema = z.object({ userId: z.string().uuid() });
  const recoveredPasswordBodySchema = z.object({
    password: z.string().min(12).max(200),
  });
  app.post<{ Params: { userId: string } }>(
    "/auth/recovered-users/:userId/reset-password",
    { preHandler: [requireSession, requireOwner] },
    async (req, reply) => {
      const params = parseQuery(app, recoveredPasswordParamsSchema, req.params);
      const body = parseBody(app, recoveredPasswordBodySchema, req.body);
      const reset = await resetRecoveredUserPassword(
        req.session.workspaceId,
        params.userId,
        body.password,
      );
      if (!reset) {
        return reply.code(404).send({ error: "restored user not found or password already initialized" });
      }
      return reply.code(204).send();
    },
  );

  // ─── N-011: AI 隐私治理路由 ────────────────────────────────────

  // GET /workspace/ai-settings — 获取当前工作区 AI 隐私配置
  app.get("/workspace/ai-settings", { preHandler: [requireSession] }, async (req) => {
    const settings = await getAIPrivacySettings(req.session.workspaceId);
    if (!settings) throw app.httpErrors.notFound("workspace not found");
    return settings;
  });

  // PUT /workspace/ai-consent — Owner 签署 AI 同意
  const aiConsentSchema = z.object({
    consentVersion: z.string().min(1).max(50),
  });
  app.put("/workspace/ai-consent", { preHandler: [requireSession, requireOwner] }, async (req) => {
    const body = parseBody(app, aiConsentSchema, req.body);
    await updateAIConsent(req.session.workspaceId, req.session.userId, body.consentVersion);
    return { success: true };
  });

  // PUT /workspace/ai-data-policy — Owner 更新 AI 数据策略
  const aiDataPolicySchema = z.object({
    sendToExternal: z.boolean(),
    piiDetection: z.boolean(),
    auditLogging: z.boolean(),
  });
  app.put("/workspace/ai-data-policy", { preHandler: [requireSession, requireOwner] }, async (req) => {
    const body = parseBody(app, aiDataPolicySchema, req.body);
    await updateAIDataPolicy(req.session.workspaceId, body);
    return { success: true };
  });

  // GET /workspace/ai-audit-log — 查询 AI 审计日志（分页）
  const auditLogQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });
  app.get(
    "/workspace/ai-audit-log",
    { preHandler: [requireSession, requireOwner] },
    async (req) => {
      const q = parseQuery(app, auditLogQuerySchema, req.query);
      const limit = clampLimit(q.limit, 50);
      const offset = clampOffset(q.offset);
      return await listAIAuditLog(req.session.workspaceId, { limit, offset });
    },
  );
}
