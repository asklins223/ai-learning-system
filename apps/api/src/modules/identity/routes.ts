import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { users, workspaceMembers, workspaces } from "../../db/schema/identity.ts";
import { loginWithPassword, registerWithInvite, registerWithoutInvite, switchWorkspace, listUserWorkspaces, joinWorkspaceByInviteToken, leaveWorkspace, JoinWorkspaceError, getAIPrivacySettings, updateAIConsent, updateAIDataPolicy, listAIAuditLog, revokeSession, resetRecoveredUserPassword, SESSION_TTL_MS, updateUserProfile, renameWorkspace } from "./service.ts";
import { parseBody } from "../../lib/validate.ts";
import { requireSession, requireOwner, getRequestCredential } from "./middleware.ts";
import { clampLimit, clampOffset, parseQuery } from "../../lib/pagination.ts";
import {
  createAuthCookieHeaders,
  createClearAuthCookieHeaders,
} from "./session-auth.ts";
import {
  createInvite,
  listInvites,
  revokeInvite,
  consumeInvite,
  ConsumeInviteError,
  listMembers,
  removeMember,
  ensureOnboardingState,
  markOnboardingStep,
} from "./invite-service.ts";
import {
  createRateLimitStoreFromEnv,
  RateLimiter,
  type RateLimitStore,
} from "./rate-limit.ts";

export const loginSchema = z.object({
  email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
  password: z.string().min(4).max(200),
  // Controls whether the browser keeps the HttpOnly cookie after closing.
  // Bearer clients can ignore this field and continue using the response token.
  remember: z.boolean().optional().default(false),
});

const displayNameSchema = z.string().trim().min(1).max(32);
export const avatarUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    // 站内上传路径：仅允许 /api/uploads/avatars/ 前缀（防止 /admin 等内部路径探测）
    if (value.startsWith("/api/uploads/avatars/")) return true;
    // 向后兼容：外部 HTTPS URL（已有用户数据）
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "avatarUrl must be an HTTPS URL or a site-uploaded avatar path");

const registerSchema = z.object({
  email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
  password: z.string().min(8).max(200),
  inviteCode: z.string().trim().min(1).max(200),
  displayName: displayNameSchema.optional(),
  avatarUrl: avatarUrlSchema.optional(),
});

// ADR-0009: 无邀请码注册 — 只创建个人工作区
const registerPersonalSchema = z.object({
  email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
  password: z.string().min(8).max(200),
  displayName: displayNameSchema.optional(),
  avatarUrl: avatarUrlSchema.optional(),
});

const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_RATE_LIMIT_MAX = 5; // max attempts per window
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

  /**
   * POST /auth/register
   * @deprecated Use POST /auth/register-v2 with secure invite token.
   * Legacy endpoint uses plaintext invite code lookup. Will be removed
   * after migration window closes.
   */
  app.post("/auth/register", async (req, reply) => {
    reply.header("Deprecation", "true");
    reply.header("Sunset", "Sat, 31 Jan 2027 00:00:00 GMT");
    reply.header("Link", '</auth/register-v2>; rel="successor-version"');
    // G-005: 使用 req.ip 而非 req.socket.remoteAddress
    const ip = req.ip;
    const ipKey = `auth:register:ip:${ip}`;
    const ipDecision = await limiter.consume(ipKey);
    if (!ipDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(ipDecision.resetAt));
      return reply.code(429).send({ error: "Too many registration attempts. Please try again later." });
    }
    const body = parseBody(app, registerSchema, req.body);
    const result = await registerWithInvite(body.email, body.password, body.inviteCode, {
      displayName: body.displayName,
      avatarUrl: body.avatarUrl,
    });
    if (!result) {
      throw app.httpErrors.badRequest("invalid invite or email exists");
    }
    // G-005: 成功注册后重置限流
    await limiter.reset(ipKey);
    const csrfToken = setSessionCookies(reply, result.token);
    return { ...result, csrfToken };
  });

  app.post("/auth/logout", async (req, reply) => {
    // Logout 不要求 CSRF 校验：
    // 1) Logout 是低风险操作——攻击者最多让用户退出登录，不会造成数据泄露或篡改。
    // 2) 前端 setCsrfCookie 兜底设置的 ailearn_csrf 是 session cookie（无 Max-Age），
    //    当用户勾选"保持登录"后重启浏览器，ailearn_session 仍在但 ailearn_csrf 已消失，
    //    导致退出登录被 403 阻断。其他写操作不受影响因为它们在活跃会话期间使用。
    // 3) 即便移除 CSRF 校验，SameSite=Lax 已经阻止跨站表单 POST 退出登录。
    const credential = getRequestCredential(req);
    if (credential) await revokeSession(credential.token);
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  // ─── ADR-0009: 加入/退出协作工作区 ────────────────────────────

  // POST /auth/join-workspace — 已登录用户通过邀请码加入协作工作区
  const joinWorkspaceSchema = z.object({
    inviteToken: z.string().min(1).max(200),
  });
  app.post("/auth/join-workspace", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, joinWorkspaceSchema, req.body);
    const result = await joinWorkspaceByInviteToken(req.session.userId, body.inviteToken);
    if (result instanceof JoinWorkspaceError) {
      const statusMap: Record<string, number> = {
        not_found: 404,
        expired: 410,
        revoked: 410,
        already_consumed: 409,
        concurrent_consumption: 409,
        workspace_limit_reached: 409,
        already_member: 409,
      };
      return reply.code(statusMap[result.code] ?? 400).send({ error: result.code });
    }
    return result;
  });

  // POST /auth/leave-workspace — 用户主动退出协作工作区
  const leaveWorkspaceSchema = z.object({
    workspaceId: z.string().uuid(),
  });
  app.post("/auth/leave-workspace", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, leaveWorkspaceSchema, req.body);
    const result = await leaveWorkspace(req.session.userId, body.workspaceId);
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        not_found: 404,
        not_member: 404,
        owner_cannot_leave: 409,
        personal_workspace_cannot_leave: 400,
        personal_workspace_missing: 409,
      };
      return reply.code(statusMap[result.error] ?? 400).send({ error: result.error });
    }
    // 只有退出当前工作区时才需要重签个人工作区 session。退出列表中的
    // 非当前工作区不能悄悄改变当前租户上下文。
    if (req.session.workspaceId !== body.workspaceId) {
      return { ok: true, switchedToPersonalWorkspace: false };
    }

    const switchResult = await switchWorkspace(req.session.userId, result.personalWorkspaceId);
    if (!switchResult) {
      // 理论上不会发生，但保护性处理
      clearSessionCookies(reply);
      return reply.code(500).send({ error: "failed to switch to personal workspace" });
    }
    const csrfToken = setSessionCookies(reply, switchResult.token);
    return { ...switchResult, csrfToken, switchedToPersonalWorkspace: true };
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
      displayName: user.displayName ?? null,
      avatarUrl: user.avatarUrl ?? null,
      workspaceName: workspace?.name ?? "个人工作区",
      workspaceType: workspace?.workspaceType ?? "personal",
      // ADR-0009 §3.6: isPersonal 基于 ownerId === userId，而非 personalWorkspaceId
      isPersonal: workspace?.ownerId === userId,
      personalWorkspaceId: user.personalWorkspaceId,
    };
  });

  // PROFILE-01: 更新当前用户档案（昵称/头像）
  const updateProfileSchema = z.object({
    displayName: displayNameSchema.nullable().optional(),
    avatarUrl: avatarUrlSchema.nullable().optional(),
  });
  app.put("/auth/profile", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, updateProfileSchema, req.body);
    const result = await updateUserProfile(req.session.userId, {
      displayName: body.displayName,
      avatarUrl: body.avatarUrl,
    });
    if (!result.ok) {
      return reply.code(404).send({ error: result.error });
    }
    return { ok: true, displayName: result.displayName, avatarUrl: result.avatarUrl };
  });

  // PROFILE-01: 重命名个人工作区（仅允许重命名自己的个人工作区）
  const renameWorkspaceSchema = z.object({
    name: z.string().trim().min(1).max(50),
  });
  app.patch<{ Params: { id: string } }>(
    "/workspaces/:id/name",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = parseBody(app, renameWorkspaceSchema, req.body);
      const result = await renameWorkspace(req.session.userId, req.params.id, body.name);
      if (!result.ok) {
        const statusMap: Record<string, number> = {
          not_found: 404,
          not_member: 403,
          not_personal_workspace: 403,
          empty_name: 400,
        };
        return reply.code(statusMap[result.error] ?? 400).send({ error: result.error });
      }
      return result;
    },
  );

  // ─── ADR-0009: 无邀请码注册端点 ────────────────────────────────
  app.post("/auth/register-personal", async (req, reply) => {
    const ip = req.ip;
    const ipKey = `auth:register:ip:${ip}`;
    const ipDecision = await limiter.consume(ipKey);
    if (!ipDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(ipDecision.resetAt));
      return reply.code(429).send({ error: "Too many registration attempts. Please try again later." });
    }
    const body = parseBody(app, registerPersonalSchema, req.body);
    const result = await registerWithoutInvite(body.email, body.password, {
      displayName: body.displayName,
      avatarUrl: body.avatarUrl,
    });
    if (!result) {
      throw app.httpErrors.badRequest("email already exists");
    }
    await limiter.reset(ipKey);
    const csrfToken = setSessionCookies(reply, result.token);
    return { ...result, csrfToken };
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
    const previousCredential = getRequestCredential(req);
    const result = await switchWorkspace(req.session.userId, body.workspaceId);
    if (!result) {
      return reply.code(403).send({ error: "not a member of this workspace" });
    }
    if (previousCredential && previousCredential.token !== result.token) {
      await revokeSession(previousCredential.token);
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
    sendImageContent: z.boolean(),
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

  // ─── SEC-02 / ALPHA-01: 邀请管理 ──────────────────────────────

  const createInviteSchema = z.object({
    role: z.enum(["member", "owner"]).optional().default("member"),
    expiresInHours: z.number().int().min(1).max(168).optional(), // max 7 days
  });

  app.post(
    "/invites",
    { preHandler: [requireSession, requireOwner] },
    async (req) => {
      const body = parseBody(app, createInviteSchema, req.body);
      const expiresAt = body.expiresInHours
        ? new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000)
        : null;
      return await createInvite(req.session.workspaceId, req.session.userId, {
        role: body.role,
        expiresAt,
      });
    },
  );

  const inviteListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });

  app.get(
    "/invites",
    { preHandler: [requireSession, requireOwner] },
    async (req) => {
      const q = parseQuery(app, inviteListQuerySchema, req.query);
      return await listInvites(req.session.workspaceId, req.session.userId, {
        limit: q.limit,
        offset: q.offset,
      });
    },
  );

  app.delete<{ Params: { inviteId: string } }>(
    "/invites/:inviteId",
    { preHandler: [requireSession, requireOwner] },
    async (req, reply) => {
      const result = await revokeInvite(
        req.params.inviteId,
        req.session.workspaceId,
        req.session.userId,
      );
      if (!result.ok) {
        const statusMap: Record<string, number> = {
          not_found: 404,
          already_consumed: 409,
          already_revoked: 409,
        };
        return reply.code(statusMap[result.error] ?? 400).send({ error: result.error });
      }
      return reply.code(204).send();
    },
  );

  // ─── SEC-02 / ALPHA-01: 成员管理 ──────────────────────────────

  app.get(
    "/members",
    { preHandler: [requireSession, requireOwner] },
    async (req) => {
      return await listMembers(req.session.workspaceId, req.session.userId);
    },
  );

  app.delete<{ Params: { userId: string } }>(
    "/members/:userId",
    { preHandler: [requireSession, requireOwner] },
    async (req, reply) => {
      const result = await removeMember(
        req.session.workspaceId,
        req.session.userId,
        req.params.userId,
      );
      if (!result.ok) {
        const statusMap: Record<string, number> = {
          not_found: 404,
          last_owner: 409,
          self_remove_owner: 409,
        };
        return reply.code(statusMap[result.error] ?? 400).send({ error: result.error });
      }
      return reply.code(204).send();
    },
  );

  // ─── SEC-02 / ALPHA-01: Onboarding 状态 ───────────────────────

  app.get(
    "/onboarding/state",
    { preHandler: [requireSession] },
    async (req) => {
      const state = await ensureOnboardingState(
        req.session.workspaceId,
        req.session.userId,
      );
      return state;
    },
  );

  const markStepSchema = z.object({
    step: z.literal("evidence_review"),
    completed: z.literal(true).optional().default(true),
    evidenceId: z.string().uuid(),
  });

  app.post(
    "/onboarding/steps",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = parseBody(app, markStepSchema, req.body);
      const result = await markOnboardingStep(
        req.session.workspaceId,
        req.session.userId,
        body.step,
        body.completed,
        body.evidenceId,
      );
      if (!result.ok) {
        return reply
          .code(result.error === "business_fact_missing" ? 409 : 400)
          .send({ error: result.error });
      }
      return reply.code(204).send();
    },
  );

  // ─── SEC-02 / ALPHA-01: v0.5 邀请注册（hash token）────────────

  const registerV2Schema = z.object({
    email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
    password: z.string().min(8).max(200),
    inviteToken: z.string().min(1).max(200).optional(),
    displayName: displayNameSchema.optional(),
    avatarUrl: avatarUrlSchema.optional(),
  });

  // PROFILE-01 / ADR-0009: 统一注册端点
  // - 无 inviteToken：只创建个人工作区
  // - 有 inviteToken：创建个人工作区 + 加入邀请的工作区
  app.post("/auth/register-v2", async (req, reply) => {
    const ip = req.ip;
    const ipKey = `auth:register:ip:${ip}`;
    const ipDecision = await limiter.consume(ipKey);
    if (!ipDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(ipDecision.resetAt));
      return reply.code(429).send({ error: "Too many registration attempts. Please try again later." });
    }
    const body = parseBody(app, registerV2Schema, req.body);

    // 分支：有 inviteToken → consumeInvite；无 → registerWithoutInvite
    if (body.inviteToken) {
      const result = await consumeInvite(body.email, body.password, body.inviteToken, {
        displayName: body.displayName,
        avatarUrl: body.avatarUrl,
      });
      if (result instanceof ConsumeInviteError) {
        const statusMap: Record<string, number> = {
          not_found: 404,
          expired: 410,
          revoked: 410,
          already_consumed: 409,
          email_exists: 409,
          concurrent_consumption: 409,
        };
        await limiter.reset(ipKey); // don't penalize exploration
        return reply.code(statusMap[result.code] ?? 400).send({ error: result.code });
      }
      await limiter.reset(ipKey);
      const csrfToken = setSessionCookies(reply, result.token);
      return { ...result, csrfToken };
    }

    // 无邀请码注册
    const result = await registerWithoutInvite(body.email, body.password, {
      displayName: body.displayName,
      avatarUrl: body.avatarUrl,
    });
    if (!result) {
      throw app.httpErrors.badRequest("email already exists");
    }
    await limiter.reset(ipKey);
    const csrfToken = setSessionCookies(reply, result.token);
    return { ...result, csrfToken };
  });
}
