import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, isNull, lt, or, gte, inArray, desc, count, sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { users, workspaceMembers, inviteCodes, workspaces, aiAuditLog } from "../../db/schema/identity.ts";
import { sessions } from "../../db/schema/session.ts";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RECOVERED_PASSWORD_SENTINEL = "$RESET_REQUIRED$";
const BCRYPT_COST = 10;
// Keep unknown-account logins on the same expensive bcrypt path as known
// accounts so response timing does not become a reliable email oracle.
const DUMMY_PASSWORD_HASH = "$2a$10$cgxNDTz4bljIsmxLn2w.7O6Cd/C3cZK3neQBb/2Xxx4xNJkIgMrse";

export function canonicalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function legacyHashPassword(plain: string): string {
  return createHash("sha256").update(`ailearn:${plain}`).digest("hex");
}

function isLegacyHash(h: string): boolean {
  return !h.startsWith("$2") && h.length === 64;
}

function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (isLegacyHash(stored)) {
    const candidate = Buffer.from(legacyHashPassword(plain));
    const expected = Buffer.from(stored);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
  return bcrypt.compare(plain, stored);
}

function generateToken(): string {
  return randomBytes(24).toString("hex");
}

// R-011: 对 token 做 SHA-256 哈希后存储，数据库泄露不暴露可用 session
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionContext {
  userId: string;
  workspaceId: string;
}

async function issueSession(userId: string, workspaceId: string): Promise<{ token: string; ctx: SessionContext }> {
  const token = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  // R-011: 存储 token 的哈希值，而非明文
  await db.insert(sessions).values({ token: hashToken(token), userId, workspaceId, createdAt: now, expiresAt });
  return { token, ctx: { userId, workspaceId } };
}

export interface WorkspaceInfo {
  workspaceId: string;
  workspaceName: string;
  role: string;
}

export async function loginWithPassword(
  email: string,
  password: string,
): Promise<{ token: string; ctx: SessionContext; workspaces: WorkspaceInfo[] } | null> {
  const normalizedEmail = canonicalizeEmail(email);
  const exactUser = await db.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
  // Existing installations may contain mixed-case addresses. Keep the indexed
  // canonical lookup fast and only use the compatibility scan when necessary.
  const user = exactUser ?? await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${normalizedEmail}`,
  });
  if (!user) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  if (isLegacyHash(user.passwordHash)) {
    const newHash = await hashPassword(password);
    await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, user.id));
  }
  // N-013: 查询所有可访问的工作区，而非任意取第一条
  const memberships = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.userId, user.id),
  });
  if (memberships.length === 0) return null;

  // 获取所有工作区名称
  const workspaceIds = memberships.map((m) => m.workspaceId);
  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, workspaceIds),
  });
  const workspacesList: WorkspaceInfo[] = memberships.map((m) => {
    const ws = workspaceRows.find((w) => w.id === m.workspaceId);
    return {
      workspaceId: m.workspaceId,
      workspaceName: ws?.name ?? "未命名工作区",
      role: m.role,
    };
  });

  // 默认使用第一个工作区
  const defaultWorkspaceId = memberships[0].workspaceId;
  const session = await issueSession(user.id, defaultWorkspaceId);
  return { ...session, workspaces: workspacesList };
}

export async function registerWithInvite(
  email: string,
  password: string,
  inviteCode: string,
): Promise<{ token: string; ctx: SessionContext } | null> {
  const normalizedEmail = canonicalizeEmail(email);
  let result: { userId: string; workspaceId: string } | null;
  try {
    // Lock the invite row first, then mark both consumed fields together only
    // after the user and membership writes have succeeded.
    result = await db.transaction(async (tx) => {
      const now = new Date();
      const inviteRows = await tx
        .select()
        .from(inviteCodes)
        .where(
          and(
            eq(inviteCodes.code, inviteCode),
            isNull(inviteCodes.consumedBy),
            or(isNull(inviteCodes.expiresAt), gte(inviteCodes.expiresAt, now)),
          ),
        )
        .for("update");
      const invite = inviteRows[0];
      if (!invite) return null;

      const exactUser = await tx.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
      const existing = exactUser ?? await tx.query.users.findFirst({
        where: sql`lower(${users.email}) = ${normalizedEmail}`,
      });
      if (existing) return null;

      const [user] = await tx
        .insert(users)
        .values({ email: normalizedEmail, passwordHash: await hashPassword(password) })
        .returning();
      await tx.insert(workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: "member",
      });
      await tx
        .update(inviteCodes)
        .set({ consumedBy: user.id, consumedAt: now })
        .where(and(eq(inviteCodes.code, inviteCode), isNull(inviteCodes.consumedBy)));
      return { userId: user.id, workspaceId: invite.workspaceId };
    });
  } catch (error) {
    // A concurrent registration through another invite may win the unique
    // email race after our pre-check. Treat that as the same public conflict
    // as an already-existing email and let the transaction roll back cleanly.
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return null;
    }
    throw error;
  }
  if (!result) return null;
  return issueSession(result.userId, result.workspaceId);
}

export async function decodeToken(token: string): Promise<SessionContext | null> {
  // R-011: 查询时使用 token 哈希
  const session = await db.query.sessions.findFirst({ where: eq(sessions.token, hashToken(token)) });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    // Remove expired credentials on first use as well as during the periodic
    // cleanup job. This bounds the lifetime of a stolen, already-expired token.
    await db.delete(sessions).where(eq(sessions.token, hashToken(token)));
    return null;
  }
  // R-006: 检查用户是否仍是 workspace 成员，被移除后立即吊销 session
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, session.workspaceId),
      eq(workspaceMembers.userId, session.userId),
    ),
  });
  if (!membership) {
    // 用户已被移出 workspace，主动删除旧 session
    await db.delete(sessions).where(eq(sessions.token, hashToken(token)));
    return null;
  }
  return { userId: session.userId, workspaceId: session.workspaceId };
}

/** Revoke a session by its raw bearer/cookie token. */
export async function revokeSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, hashToken(token)));
}

/**
 * Set the first real password for a user restored from a workspace export.
 * Existing accounts cannot be changed through this path, and every old
 * session for the restored identity is revoked before the transaction commits.
 */
export async function resetRecoveredUserPassword(
  workspaceId: string,
  userId: string,
  password: string,
): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const membership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    });
    if (!membership) return false;

    const updated = await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(and(
        eq(users.id, userId),
        eq(users.passwordHash, RECOVERED_PASSWORD_SENTINEL),
      ))
      .returning({ id: users.id });
    if (updated.length === 0) return false;

    await tx.delete(sessions).where(eq(sessions.userId, userId));
    return true;
  });
}

export async function cleanupExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ token: sessions.token });
  return deleted.length;
}

/**
 * N-013: 切换工作区 — 重新签发绑定目标 workspace 的 session。
 * 验证用户是否仍是目标 workspace 的成员，被移除后拒绝切换。
 */
export async function switchWorkspace(
  userId: string,
  workspaceId: string,
): Promise<{ token: string; ctx: SessionContext } | null> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
    ),
  });
  if (!membership) return null;
  return issueSession(userId, workspaceId);
}

/**
 * N-013: 列出用户可访问的所有工作区。
 */
export async function listUserWorkspaces(userId: string): Promise<WorkspaceInfo[]> {
  const memberships = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.userId, userId),
  });
  if (memberships.length === 0) return [];

  const workspaceIds = memberships.map((m) => m.workspaceId);
  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, workspaceIds),
  });

  return memberships.map((m) => {
    const ws = workspaceRows.find((w) => w.id === m.workspaceId);
    return {
      workspaceId: m.workspaceId,
      workspaceName: ws?.name ?? "未命名工作区",
      role: m.role,
    };
  });
}

// ─── N-011: AI 隐私治理 ────────────────────────────────────────────

/**
 * N-011: 获取工作区的 AI 隐私治理配置。
 */
export async function getAIPrivacySettings(workspaceId: string) {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!ws) return null;
  return {
    aiProvider: ws.aiProvider,
    aiConsentVersion: ws.aiConsentVersion,
    aiConsentAt: ws.aiConsentAt,
    aiConsentBy: ws.aiConsentBy,
    aiDataPolicy: ws.aiDataPolicy,
  };
}

/**
 * N-011: 更新工作区 AI 同意状态（owner 签署同意）。
 */
export async function updateAIConsent(
  workspaceId: string,
  userId: string,
  consentVersion: string,
): Promise<void> {
  await db
    .update(workspaces)
    .set({
      aiConsentVersion: consentVersion,
      aiConsentAt: new Date(),
      aiConsentBy: userId,
    })
    .where(eq(workspaces.id, workspaceId));
}

/**
 * N-011: 更新工作区 AI 数据策略。
 */
export async function updateAIDataPolicy(
  workspaceId: string,
  policy: {
    sendToExternal: boolean;
    piiDetection: boolean;
    auditLogging: boolean;
  },
): Promise<void> {
  await db
    .update(workspaces)
    .set({ aiDataPolicy: policy })
    .where(eq(workspaces.id, workspaceId));
}

/**
 * N-011: 查询 AI 审计日志（分页）。
 */
export async function listAIAuditLog(
  workspaceId: string,
  opts: { limit: number; offset: number },
): Promise<{ items: AIAuditLogItem[]; total: number }> {
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: aiAuditLog.id,
        workspaceId: aiAuditLog.workspaceId,
        userId: aiAuditLog.userId,
        jobId: aiAuditLog.jobId,
        provider: aiAuditLog.provider,
        modelId: aiAuditLog.modelId,
        operation: aiAuditLog.operation,
        dataCategories: aiAuditLog.dataCategories,
        dataSizeBytes: aiAuditLog.dataSizeBytes,
        costTokens: aiAuditLog.costTokens,
        durationMs: aiAuditLog.durationMs,
        status: aiAuditLog.status,
        errorMessage: aiAuditLog.errorMessage,
        createdAt: aiAuditLog.createdAt,
        operatorId: users.id,
        operatorEmail: users.email,
      })
      .from(aiAuditLog)
      .leftJoin(users, eq(aiAuditLog.userId, users.id))
      .where(eq(aiAuditLog.workspaceId, workspaceId))
      .orderBy(desc(aiAuditLog.createdAt))
      .limit(opts.limit)
      .offset(opts.offset),
    db
      .select({ total: count() })
      .from(aiAuditLog)
      .where(eq(aiAuditLog.workspaceId, workspaceId)),
  ]);

  return {
    items: rows.map(({ operatorId, operatorEmail, ...audit }) => ({
      ...audit,
      // Keep userId for existing clients and expose a stable operator object
      // for attribution-aware clients. A missing user is retained as null so
      // historical rows remain inspectable instead of being silently dropped.
      operator: operatorId && operatorEmail
        ? { userId: operatorId, email: operatorEmail }
        : null,
    })),
    total: Number(totalRows[0]?.total ?? 0),
  };
}

export interface AIAuditActor {
  userId: string;
  email: string;
}

export interface AIAuditLogItem {
  id: string;
  workspaceId: string;
  userId: string;
  jobId: string | null;
  provider: string;
  modelId: string;
  operation: string;
  dataCategories: string[];
  dataSizeBytes: number | null;
  costTokens: number | null;
  durationMs: number | null;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  operator: AIAuditActor | null;
}

/**
 * N-011: 写入 AI 审计日志（供 worker / API 调用）。
 */
type AuditActorIdentity =
  | {
      /** Canonical field for the user who initiated the job/request. */
      actorUserId: string;
      /** @deprecated Use actorUserId. */
      userId?: string;
    }
  | {
      actorUserId?: undefined;
      /** @deprecated Use actorUserId. Kept for worker/API compatibility during migration. */
      userId: string;
    };

export type LogAICallParams = AuditActorIdentity & {
  workspaceId: string;
  jobId?: string | null;
  provider: string;
  modelId: string;
  operation: string;
  dataCategories?: string[];
  dataSizeBytes?: number | null;
  costTokens?: number | null;
  durationMs?: number | null;
  status?: string;
  errorMessage?: string | null;
};

export async function logAICall(params: LogAICallParams): Promise<void> {
  const actorUserId = params.actorUserId ?? params.userId;
  if (!actorUserId) {
    throw new Error("AI audit log requires actorUserId (the initiating user UUID)");
  }
  await db.insert(aiAuditLog).values({
    workspaceId: params.workspaceId,
    userId: actorUserId,
    jobId: params.jobId ?? null,
    provider: params.provider,
    modelId: params.modelId,
    operation: params.operation,
    dataCategories: params.dataCategories ?? [],
    dataSizeBytes: params.dataSizeBytes ?? null,
    costTokens: params.costTokens ?? null,
    durationMs: params.durationMs ?? null,
    status: params.status ?? "success",
    errorMessage: params.errorMessage ?? null,
  });
}

/**
 * N-011: 检查工作区是否已签署 AI 同意。
 * 未签署同意时，AI 调用应被阻止。
 */
export async function checkAIConsent(workspaceId: string): Promise<boolean> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!ws) return false;
  // mock provider 不需要同意
  if (ws.aiProvider === "mock") return true;
  // 其他 provider 需要已签署同意
  return ws.aiConsentVersion !== null && ws.aiConsentAt !== null;
}
