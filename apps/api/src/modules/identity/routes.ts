import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { users, workspaces } from "@ailearn/shared/db-schema/identity";
import { loginWithPassword, registerWithoutInvite, switchWorkspace, createCollaborativeWorkspace, listUserWorkspaces, joinWorkspaceByInviteToken, leaveWorkspace, JoinWorkspaceError, getAIPrivacySettings, updateAIConsent, updateAIDataPolicy, listAIAuditLog, revokeSession, resetRecoveredUserPassword, SESSION_TTL_MS, updateUserProfile, renameWorkspace, changePassword, revokeAllSessionsForUser, transferWorkspaceOwnership, dissolveWorkspace, previewWorkspaceDissolve } from "./service.ts";
import { parseBody } from "../../lib/validate.ts";
import { requireSession, requireOwner, isWorkspaceOwner, getRequestCredential } from "./middleware.ts";
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
import { buildDesktopCapabilityProjection } from "./capability-projection.ts";

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
  .refine(
    (value) => value.startsWith("/api/uploads/avatars/"),
    "avatarUrl must be a site-uploaded avatar path",
  );

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
      return reply.code(429).send({ error: "rate_limited", message: "登录尝试过于频繁，请稍后重试" });
    }
    const body = parseBody(app, loginSchema, req.body);
    // R-011: 也按 email 限流，防止跨 IP 暴力破解单个账户
    const emailKey = `auth:login:email:${body.email}`;
    const emailDecision = await limiter.consume(emailKey);
    if (!emailDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(emailDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: "该账号登录尝试过于频繁，请稍后重试" });
    }
    const result = await loginWithPassword(body.email, body.password);
    if (!result) {
      throw app.httpErrors.unauthorized("invalid credentials");
    }
    // G-005: 成功登录后重置该账户限流计数（2026-08-11 收紧：不再重置 IP
    // 计数——否则攻击者用任一有效凭据登录一次即清空自身 IP 失败计数，
    // 支持跨账户分布式暴力破解）。
    await limiter.reset(emailKey);
    // Set an HttpOnly cookie for clients that opt into cookie auth while still
    // returning the Bearer token for existing API consumers.
    const csrfToken = setSessionCookies(reply, result.token, body.remember);
    return { ...result, csrfToken };
  });

  app.post("/auth/logout", async (req, reply) => {
    // Logout 不要求 CSRF 校验：
    // 1) Logout 是低风险操作——攻击者最多让用户退出登录，不会造成数据泄露或篡改。
    // 2) SameSite=Lax 已阻止跨站表单 POST 退出登录。
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

    const switchResult = await switchWorkspace(req.session.userId, result.personalWorkspaceId, null);
    if (!switchResult) {
      // 理论上不会发生，但保护性处理
      clearSessionCookies(reply);
      return reply.code(500).send({ error: "failed to switch to personal workspace" });
    }
    const csrfToken = setSessionCookies(reply, switchResult.token);
    return { ...switchResult, csrfToken, switchedToPersonalWorkspace: true };
  });

  // R-026: 返回当前登录用户的真实信息，Sidebar 不再硬编码 owner 邮箱和角色
  // 2026-08-11（性能专项）：补 response schema（fast-json-stringify 预编译序列化）
  app.get<{ Reply: unknown }>("/auth/me", {
    preHandler: [requireSession],
    schema: {
      response: {
        200: {
          type: "object",
          required: ["userId", "workspaceId", "email", "role", "displayName", "avatarUrl", "workspaceName", "workspaceType", "isPersonal", "personalWorkspaceId", "workspaceEpoch"],
          properties: {
            userId: { type: "string" },
            workspaceId: { type: "string" },
            email: { type: "string" },
            role: { type: "string" },
            displayName: { type: ["string", "null"] },
            avatarUrl: { type: ["string", "null"] },
            workspaceName: { type: "string" },
            workspaceType: { type: "string" },
            isPersonal: { type: "boolean" },
            personalWorkspaceId: { type: ["string", "null"] },
            // 0261：服务端边界令牌。**必须在响应 schema 里列出来**——Fastify 会按
            // schema 裁剪响应体，漏了这一行就等于 handler 里加了字段但客户端永远
            // 收不到（实测过：`/auth/me` 少了它，而 `/auth/capabilities/v1` 有）。
            workspaceEpoch: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
      },
    },
  }, async (req) => {
    const { userId, workspaceId, membershipRole } = req.session;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw req.server.httpErrors.notFound("user not found");
    // 2026-08-11（性能专项）：membership 已由 decodeToken 合并 JOIN 取回，
    // 不再重复查 workspace_members（原 /auth/me 共 5 次 DB 查询 → 3 次）。
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    // 角色只由 isWorkspaceOwner 决定，与 requireOwner、能力投影、笔记投影同一谓词。
    const role = isWorkspaceOwner(req.session) ? "owner" : membershipRole ?? "member";
    const workspaceType = workspace?.workspaceType ?? "personal";
    const isPersonal = workspaceType === "personal" && workspace?.ownerId === userId;
    return {
      userId,
      workspaceId,
      email: user.email,
      role,
      displayName: user.displayName ?? null,
      avatarUrl: user.avatarUrl ?? null,
      workspaceName: workspace?.name ?? "个人工作区",
      // 类型取自 workspaces.workspace_type 这一列本身。原先它由"查看者是不是
      // owner"派生，注释还明说"别人的个人空间对我投影成 collaborative"——那是
      // 因为没有创建协作空间的入口而将就地补的洞：它让个人空间一旦被人加入就
      // 改名成协作空间，也让权限与协同判据无法建立在类型上。
      workspaceType,
      isPersonal,
      personalWorkspaceId: user.personalWorkspaceId,
      // 服务端边界令牌（0261）。桌面网关把它当作本机 epoch 的**权威值**：
      // 空间边界一变（成员/同意/改名），下一次读会话就会拿到更大的数，
      // 在途请求随之被判 stale_workspace 并重读。
      workspaceEpoch: req.session.workspaceEpoch,
    };
  });

  app.get("/auth/capabilities/v1", { preHandler: [requireSession] }, async (req) => {
    const role = isWorkspaceOwner(req.session) ? "owner" : "member";
    // 伴星能否外发由**请求者本人**的 AI 同意与数据策略决定（0237 起为账号级）。
    // 读不到时按 fail-closed 交给投影处理。
    const aiSettings = await getAIPrivacySettings(req.session.workspaceId, req.session.userId);
    return buildDesktopCapabilityProjection({
      role,
      ai: aiSettings
        ? {
            requiresConsent: aiSettings.requiresConsent,
            consentSigned: Boolean(aiSettings.consentVersion && aiSettings.consentAt),
            sendToExternal: aiSettings.dataPolicy.sendToExternal,
          }
        : null,
      // 边界令牌来自会话解码时读回的空间行（0261），不再写死 1。
      workspaceEpoch: req.session.workspaceEpoch,
    });
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
    const result = await switchWorkspace(req.session.userId, body.workspaceId, previousCredential?.token ?? null);
    if (!result) {
      return reply.code(403).send({ error: "not a member of this workspace" });
    }
    const csrfToken = setSessionCookies(reply, result.token);
    return { ...result, csrfToken };
  });

  // 新建协作空间。此前生产代码里没有任何创建工作区的入口，"共享"只能是把别人拉进
  // 自己的个人空间，协作类型因此从未真实存在过（dev 库实测 856 个空间全是 personal）。
  const createWorkspaceSchema = z.object({
    name: z.string().min(1).max(50),
  });
  app.post(
    "/workspaces",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = parseBody(app, createWorkspaceSchema, req.body);
      const result = await createCollaborativeWorkspace(req.session.userId, body.name);
      if (!result.ok) {
        return reply
          .code(result.error === "workspace_limit_reached" ? 409 : 400)
          .send({ error: result.error });
      }
      return { workspaceId: result.workspaceId, workspaceName: result.workspaceName };
    },
  );

  // 转让协作空间的所有权（审查附录 C：owner 此前既不能退也不能交）。
  const transferOwnershipSchema = z.object({ toUserId: z.string().uuid() });
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/transfer-ownership",
    { preHandler: [requireSession, requireOwner] },
    async (req, reply) => {
      const params = parseQuery(app, z.object({ id: z.string().uuid() }), req.params);
      const body = parseBody(app, transferOwnershipSchema, req.body);
      const result = await transferWorkspaceOwnership(
        req.session.userId,
        params.id,
        body.toUserId,
      );
      if (!result.ok) {
        const statusMap: Record<string, number> = {
          not_found: 404,
          not_owner: 403,
          target_not_member: 409,
          target_is_owner: 409,
          personal_workspace_not_transferable: 409,
        };
        return reply.code(statusMap[result.error] ?? 400).send({ error: result.error });
      }
      return { ok: true, workspaceId: result.workspaceId, newOwnerUserId: result.newOwnerUserId };
    },
  );

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

  // 2026-08-11（安全加固）：修改密码——验证旧密码 + 更新 bcrypt + 撤销全部
  // 会话（全端注销，泄露凭据可自轮换）。
  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200),
  });
  app.post("/auth/change-password", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, changePasswordSchema, req.body);
    const changed = await changePassword(req.session.userId, body.currentPassword, body.newPassword);
    if (!changed) {
      return reply.code(403).send({ error: "invalid_password", message: "当前密码不正确" });
    }
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  // 2026-08-11（安全加固）：退出所有设备——撤销当前用户全部会话。
  app.delete("/auth/sessions", { preHandler: [requireSession] }, async (req, reply) => {
    await revokeAllSessionsForUser(req.session.userId);
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  // GET /me/ai-settings — 本人的 AI 使用同意与数据外发政策。
  // 0237 起这是账号级数据：它管的是"我的内容能不能送出去"，授权范围只能是本人，
  // 所以不再有 requireOwner，也不再有 canManage——本人永远能改自己的。
  app.get("/me/ai-settings", { preHandler: [requireSession] }, async (req) => {
    const settings = await getAIPrivacySettings(req.session.workspaceId, req.session.userId);
    if (!settings) throw app.httpErrors.notFound("user not found");
    return {
      version: 1 as const,
      requiresConsent: settings.requiresConsent,
      consentVersion: settings.consentVersion,
      consentAt: settings.consentAt ? settings.consentAt.toISOString() : null,
      dataPolicy: settings.dataPolicy,
    };
  });

  const aiConsentSchema = z.object({
    consentVersion: z.string().min(1).max(50),
  });
  app.put("/me/ai-consent", { preHandler: [requireSession] }, async (req) => {
    const body = parseBody(app, aiConsentSchema, req.body);
    await updateAIConsent(req.session.workspaceId, req.session.userId, body.consentVersion);
    return { success: true };
  });

  const aiDataPolicySchema = z.object({
    sendToExternal: z.boolean(),
    sendImageContent: z.boolean(),
    piiDetection: z.boolean(),
    auditLogging: z.boolean(),
  });
  app.put("/me/ai-data-policy", { preHandler: [requireSession] }, async (req) => {
    const body = parseBody(app, aiDataPolicySchema, req.body);
    await updateAIDataPolicy(req.session.workspaceId, req.session.userId, body);
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
      return await listAIAuditLog(req.session.workspaceId, req.session.userId, { limit, offset });
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
      // Y10（round-3 审计）：支持可选 ?limit=（服务端默认 200、上限 500），
      // 防止超大工作区成员全量无界返回。total 为真实总数（含未返回的后段）。
      const rawLimit = (req.query as { limit?: unknown }).limit;
      const parsedLimit = typeof rawLimit === "string" && /^\d+$/.test(rawLimit)
        ? Number(rawLimit)
        : undefined;
      return await listMembers(req.session.workspaceId, req.session.userId, { limit: parsedLimit });
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
      return reply.code(429).send({ error: "rate_limited", message: "注册尝试过于频繁，请稍后重试" });
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
        // 2026-08-11（安全修复）：失败分支不再 reset(ipKey)——此前无效 token
        // 请求即可清空注册 IP 计数，配合无邮箱验证可无限批量注册假账户。
        return reply.code(statusMap[result.code] ?? 400).send({ error: result.code });
      }
      // SEC 修复（2026-09 后端审查）：成功分支同样不得 reset——见 register-personal
      // 处的说明；成功即重置会让 IP 上限完全失效。
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
    const csrfToken = setSessionCookies(reply, result.token);
    return { ...result, csrfToken };
  

});

  // 解散空间：不可逆，且**这一轮故意不做界面入口**（判据与逐表计数先给出来，
  // 露不露按钮由看过计数的人决定）。错误码全部如实翻成状态码，不并进 forbidden。
  app.delete(
    "/workspaces/:id",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = req.params as { id: string };
      const result = await dissolveWorkspace(params.id, req.session.userId);
      if (!result.ok) {
        const status: Record<string, number> = {
          workspace_not_found: 404,
          cannot_dissolve_personal_workspace: 409,
          actor_is_not_active_owner: 403,
          actor_has_no_surviving_workspace_for_audit: 409,
        };
        return reply
          .code(status[result.error] ?? 500)
          .send({ error: result.error, message: DISSOLVE_MESSAGES[result.error] });
      }
      reply.header("cache-control", "private, no-store");
      return { dissolved: true, counts: result.counts };
    },
  );

  // 解散之前的先睹计数（审计 F39 ③）：确认文案说得出"会带走 N 篇笔记、M 张卡"，
  // 用户点的才不是盲盒。判据与 DELETE 同源——能不能真删仍由 SQL 函数判。
  app.get(
    "/workspaces/:id/dissolve-preview",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = req.params as { id: string };
      const result = await previewWorkspaceDissolve(params.id, req.session.userId);
      if (!result.ok) {
        const status: Record<string, number> = {
          workspace_not_found: 404,
          cannot_dissolve_personal_workspace: 409,
          actor_is_not_active_owner: 403,
        };
        return reply
          .code(status[result.error] ?? 500)
          .send({ error: result.error, message: DISSOLVE_MESSAGES[result.error] });
      }
      reply.header("cache-control", "private, no-store");
      return { counts: result.counts };
    },
  );

  const DISSOLVE_MESSAGES: Record<string, string> = {
    workspace_not_found: "没有这个空间。",
    cannot_dissolve_personal_workspace: "个人空间不能解散，它是你回到应用时的落脚点。",
    actor_is_not_active_owner: "只有这个空间的所有者能解散它。",
    actor_has_no_surviving_workspace_for_audit: "你还没有可以留存这次记录的个人空间，先建一个再解散。",
    dissolve_failed: "这次解散没有成功。",
  };

}
