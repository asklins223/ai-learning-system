import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, isNull, lt, or, gte, inArray, desc, count, sql, ne } from "drizzle-orm";
import { db } from "../../db/client.ts";
import {
  users,
  workspaceMembers,
  inviteCodes,
  workspaces,
  aiAuditLog,
  onboardingStates,
} from "../../db/schema/identity.ts";
import { sessions } from "../../db/schema/session.ts";
import {
  hashInvitationToken as hashInvitationTokenLocal,
  isValidInvitationToken as isValidInvitationTokenLocal,
} from "./invitation-token.ts";
import { deleteObject } from "../../lib/object-storage.ts";
import { logger } from "../../lib/logger.ts";

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

export function hashPassword(plain: string): Promise<string> {
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

export async function issueSession(userId: string, workspaceId: string): Promise<{ token: string; ctx: SessionContext }> {
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
  workspaceType: string;
  isPersonal: boolean;
  leftAt: Date | null;
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
  // ADR-0009: 查询所有活跃工作区（left_at IS NULL），排除已退出的
  const memberships = await db.query.workspaceMembers.findMany({
    where: and(
      eq(workspaceMembers.userId, user.id),
      isNull(workspaceMembers.leftAt),
    ),
  });
  if (memberships.length === 0) return null;

  // 获取所有工作区名称
  const workspaceIds = memberships.map((m) => m.workspaceId);
  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, workspaceIds),
  });
  const workspacesList: WorkspaceInfo[] = memberships.map((m) => {
    const ws = workspaceRows.find((w) => w.id === m.workspaceId);
    // ADR-0009 §3.6: isPersonal 基于 ownerId === userId，而非 personalWorkspaceId
    const isPersonal = ws?.ownerId === user.id;
    return {
      workspaceId: m.workspaceId,
      workspaceName: ws?.name ?? "未命名工作区",
      role: m.role,
      workspaceType: ws?.workspaceType ?? "personal",
      isPersonal,
      leftAt: m.leftAt,
    };
  });

  // ADR-0009: 默认进入个人工作区（personalWorkspaceId），否则第一个
  const defaultWorkspaceId = user.personalWorkspaceId ?? memberships[0].workspaceId;
  const session = await issueSession(user.id, defaultWorkspaceId);
  return { ...session, workspaces: workspacesList };
}

const MAX_WORKSPACE_NAME_LENGTH = 50;

/**
 * PROFILE-01: 生成默认个人工作区名称。
 * 优先使用 displayName，过长则截断；回退到 email 本地部分。
 */
export function generateDefaultWorkspaceName(displayName: string | null | undefined, email: string): string {
  const base = (displayName?.trim() || email.split("@")[0] || "用户").slice(0, MAX_WORKSPACE_NAME_LENGTH - 4);
  return `${base}的工作区`;
}

function generateDefaultDisplayName(displayName: string | null | undefined, email: string): string {
  return (displayName?.trim() || email.split("@")[0] || "用户").slice(0, 32);
}

export async function registerWithInvite(
  email: string,
  password: string,
  inviteCode: string,
  options?: { displayName?: string; avatarUrl?: string },
): Promise<{ token: string; ctx: SessionContext } | null> {
  const normalizedEmail = canonicalizeEmail(email);
  let result: { userId: string; workspaceId: string } | null;
  try {
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
        .values({
          email: normalizedEmail,
          passwordHash: await hashPassword(password),
          displayName: generateDefaultDisplayName(options?.displayName, normalizedEmail),
          ...(options?.avatarUrl?.trim() ? { avatarUrl: options.avatarUrl.trim() } : {}),
        })
        .returning();

      // ADR-0009 / PROFILE-01: 创建个人工作区，名称优先使用昵称
      const [personalWs] = await tx
        .insert(workspaces)
        .values({
          ownerId: user.id,
          name: generateDefaultWorkspaceName(options?.displayName, user.email),
          workspaceType: "personal",
        })
        .returning({ id: workspaces.id });

      // 设置用户的 personal_workspace_id
      await tx
        .update(users)
        .set({ personalWorkspaceId: personalWs.id })
        .where(eq(users.id, user.id));

      // 个人工作区 membership（owner）
      await tx.insert(workspaceMembers).values({
        workspaceId: personalWs.id,
        userId: user.id,
        role: "owner",
      });

      // 邀请码对应的协作工作区 membership（使用邀请码指定的角色）
      await tx.insert(workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: invite.role ?? "member",
      });

      // Both memberships are immediately visible after registration, so both
      // workspaces need an onboarding state in the same transaction.
      await tx.insert(onboardingStates).values([
        {
          workspaceId: personalWs.id,
          userId: user.id,
          version: "v1",
          steps: {},
          status: "pending",
        },
        {
          workspaceId: invite.workspaceId,
          userId: user.id,
          version: "v1",
          steps: {},
          status: "pending",
        },
      ]);

      await tx
        .update(inviteCodes)
        .set({ consumedBy: user.id, consumedAt: now, consumeContext: "registration" })
        .where(and(eq(inviteCodes.code, inviteCode), isNull(inviteCodes.consumedBy)));

      // ADR-0009: 默认进入个人工作区
      return { userId: user.id, workspaceId: personalWs.id };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return null;
    }
    throw error;
  }
  if (!result) return null;
  return issueSession(result.userId, result.workspaceId);
}

/**
 * ADR-0009: 无邀请码注册 — 只创建个人工作区，不加入任何协作空间。
 */
export async function registerWithoutInvite(
  email: string,
  password: string,
  options?: { displayName?: string; avatarUrl?: string },
): Promise<{ token: string; ctx: SessionContext } | null> {
  const normalizedEmail = canonicalizeEmail(email);
  let result: { userId: string; workspaceId: string } | null;
  try {
    result = await db.transaction(async (tx) => {
      const exactUser = await tx.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
      const existing = exactUser ?? await tx.query.users.findFirst({
        where: sql`lower(${users.email}) = ${normalizedEmail}`,
      });
      if (existing) return null;

      const [user] = await tx
        .insert(users)
        .values({
          email: normalizedEmail,
          passwordHash: await hashPassword(password),
          displayName: generateDefaultDisplayName(options?.displayName, normalizedEmail),
          ...(options?.avatarUrl?.trim() ? { avatarUrl: options.avatarUrl.trim() } : {}),
        })
        .returning();

      // 创建个人工作区，名称优先使用昵称
      const [personalWs] = await tx
        .insert(workspaces)
        .values({
          ownerId: user.id,
          name: generateDefaultWorkspaceName(options?.displayName, user.email),
          workspaceType: "personal",
        })
        .returning({ id: workspaces.id });

      await tx
        .update(users)
        .set({ personalWorkspaceId: personalWs.id })
        .where(eq(users.id, user.id));

      await tx.insert(workspaceMembers).values({
        workspaceId: personalWs.id,
        userId: user.id,
        role: "owner",
      });

      await tx.insert(onboardingStates).values({
        workspaceId: personalWs.id,
        userId: user.id,
        version: "v1",
        steps: {},
        status: "pending",
      });

      return { userId: user.id, workspaceId: personalWs.id };
    });
  } catch (error) {
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
  // ADR-0009: 检查用户是否仍是 workspace 的活跃成员（left_at IS NULL），被移除或退出后立即吊销 session
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, session.workspaceId),
      eq(workspaceMembers.userId, session.userId),
      isNull(workspaceMembers.leftAt),
    ),
  });
  if (!membership) {
    // 用户已被移出或已退出 workspace，主动删除旧 session
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
 * ADR-0009: 切换工作区 — 重新签发绑定目标 workspace 的 session。
 * 验证用户是否仍是目标 workspace 的活跃成员（left_at IS NULL）。
 */
export async function switchWorkspace(
  userId: string,
  workspaceId: string,
): Promise<{ token: string; ctx: SessionContext } | null> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      isNull(workspaceMembers.leftAt),
    ),
  });
  if (!membership) return null;
  return issueSession(userId, workspaceId);
}

/**
 * ADR-0009: 列出用户可访问的所有活跃工作区（含个人工作区和协作工作区）。
 */
export async function listUserWorkspaces(userId: string): Promise<WorkspaceInfo[]> {
  const memberships = await db.query.workspaceMembers.findMany({
    where: and(
      eq(workspaceMembers.userId, userId),
      isNull(workspaceMembers.leftAt),
    ),
  });
  if (memberships.length === 0) return [];

  const workspaceIds = memberships.map((m) => m.workspaceId);
  const workspaceRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, workspaceIds),
  });

  return memberships.map((m) => {
    const ws = workspaceRows.find((w) => w.id === m.workspaceId);
    // ADR-0009 §3.6: isPersonal 基于 ownerId === userId，而非 personalWorkspaceId
    const isPersonal = ws?.ownerId === userId;
    return {
      workspaceId: m.workspaceId,
      workspaceName: ws?.name ?? "未命名工作区",
      role: m.role,
      workspaceType: ws?.workspaceType ?? "personal",
      isPersonal,
      leftAt: m.leftAt,
    };
  });
}

/** ADR-0009: 协作工作区加入上限 */
export const MAX_COLLABORATIVE_WORKSPACES = 3;

export type JoinWorkspaceErrorCode =
  | "not_found"
  | "expired"
  | "revoked"
  | "already_consumed"
  | "concurrent_consumption"
  | "workspace_limit_reached"
  | "already_member";

export class JoinWorkspaceError extends Error {
  readonly code: JoinWorkspaceErrorCode;
  constructor(code: JoinWorkspaceErrorCode) {
    super(code);
    this.name = "JoinWorkspaceError";
    this.code = code;
  }
}

/**
 * ADR-0009: 已登录用户通过邀请码加入协作工作区。
 * 不创建新用户，只创建 membership 记录。
 */
export async function joinWorkspaceByInviteToken(
  userId: string,
  token: string,
): Promise<{ workspaceId: string; workspaceName: string; role: string } | JoinWorkspaceError> {
  // 验证邀请码
  if (!isValidInvitationTokenLocal(token)) {
    return new JoinWorkspaceError("not_found");
  }
  const tokenHash = hashInvitationTokenLocal(token);

  let result: { workspaceId: string; workspaceName: string; role: string } | null;
  try {
    result = await db.transaction(async (tx) => {
      const now = new Date();

      // Serialize all join operations for the same user so two different
      // invitation tokens cannot both pass the three-workspace limit.
      const userRows = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      const userRow = userRows[0];
      if (!userRow) return null;

      const inviteRows = await tx
        .select()
        .from(inviteCodes)
        .where(
          and(
            eq(inviteCodes.tokenHash, tokenHash),
            isNull(inviteCodes.consumedBy),
            isNull(inviteCodes.revokedAt),
            or(isNull(inviteCodes.expiresAt), gte(inviteCodes.expiresAt, now)),
          ),
        )
        .for("update");

      const invite = inviteRows[0];
      if (!invite) {
        // 检查是否存在但已失效
        const existing = await tx
          .select({
            consumedBy: inviteCodes.consumedBy,
            revokedAt: inviteCodes.revokedAt,
            expiresAt: inviteCodes.expiresAt,
          })
          .from(inviteCodes)
          .where(eq(inviteCodes.tokenHash, tokenHash))
          .limit(1);
        if (existing.length === 0) return null;
        const row = existing[0];
        if (row.revokedAt) throw new JoinWorkspaceError("revoked");
        if (row.consumedBy) throw new JoinWorkspaceError("already_consumed");
        if (row.expiresAt && row.expiresAt < now) throw new JoinWorkspaceError("expired");
        return null;
      }

      // 检查目标 workspace 是否存在
      const ws = await tx.query.workspaces.findFirst({
        where: eq(workspaces.id, invite.workspaceId),
      });
      if (!ws) return null;
      // ADR-0009: 允许邀请人加入个人工作区——对邀请者而言始终是「个人工作区」，
      // 对被邀请者而言则显示为「协作工作区」（基于 isPersonal 用户视角判断）。

      // 检查是否已是活跃成员
      const existingMembership = await tx.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, userId),
          isNull(workspaceMembers.leftAt),
        ),
      });
      if (existingMembership) {
        throw new JoinWorkspaceError("already_member");
      }

      // ADR-0009 defines a collaborative membership from the current user's
      // perspective: active workspaces owned by somebody else. Excluding only
      // personalWorkspaceId would incorrectly count other user-owned spaces.
      const activeCollabMemberships = await tx
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            isNull(workspaceMembers.leftAt),
            ne(workspaces.ownerId, userId),
          ),
        );
      if (activeCollabMemberships.length >= MAX_COLLABORATIVE_WORKSPACES) {
        throw new JoinWorkspaceError("workspace_limit_reached");
      }

      // 检查是否有已退出的历史记录（可以重新加入）
      const leftMembership = await tx.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, userId),
          // left_at IS NOT NULL — 已退出的记录
          sql`${workspaceMembers.leftAt} IS NOT NULL`,
        ),
      });

      if (leftMembership) {
        // 重新加入：清除 left_at，使用邀请码指定的角色
        await tx
          .update(workspaceMembers)
          .set({ leftAt: null, role: invite.role ?? "member", joinedAt: now })
          .where(
            and(
              eq(workspaceMembers.workspaceId, invite.workspaceId),
              eq(workspaceMembers.userId, userId),
            ),
          );
      } else {
        // 新加入
        await tx.insert(workspaceMembers).values({
          workspaceId: invite.workspaceId,
          userId,
          role: invite.role ?? "member",
        });
      }

      await tx
        .insert(onboardingStates)
        .values({
          workspaceId: invite.workspaceId,
          userId,
          version: "v1",
          steps: {},
          status: "pending",
        })
        .onConflictDoNothing();

      // 标记邀请码已消费
      await tx
        .update(inviteCodes)
        .set({ consumedBy: userId, consumedAt: now, consumeContext: "workspace_join" })
        .where(
          and(
            eq(inviteCodes.id, invite.id),
            isNull(inviteCodes.consumedBy),
          ),
        );

      return { workspaceId: invite.workspaceId, workspaceName: ws.name, role: invite.role ?? "member" };
    });
  } catch (error) {
    if (error instanceof JoinWorkspaceError) return error;
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return new JoinWorkspaceError("already_member");
    }
    throw error;
  }

  if (!result) return new JoinWorkspaceError("not_found");
  return result;
}

export type LeaveWorkspaceError =
  | "not_found"
  | "not_member"
  | "owner_cannot_leave"
  | "personal_workspace_cannot_leave"
  | "personal_workspace_missing";

/**
 * ADR-0009: 用户主动退出协作工作区。
 * - 软退出（设置 left_at）
 * - 邀请码标记为 revoked（退出即失效）
 * - 撤销该用户在该 workspace 的所有 session
 * - 返回用户应该切换到的个人工作区 ID
 */
export async function leaveWorkspace(
  userId: string,
  workspaceId: string,
): Promise<{ ok: true; personalWorkspaceId: string } | { ok: false; error: LeaveWorkspaceError }> {
  const result = await db.transaction(async (tx) => {
    const userRows = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    const userRow = userRows[0];
    if (!userRow) return { ok: false as const, error: "not_found" as LeaveWorkspaceError };
    if (!userRow.personalWorkspaceId) {
      return { ok: false as const, error: "personal_workspace_missing" as LeaveWorkspaceError };
    }
    if (userRow.personalWorkspaceId === workspaceId) {
      return { ok: false as const, error: "personal_workspace_cannot_leave" as LeaveWorkspaceError };
    }
    const personalRows = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, userRow.personalWorkspaceId),
          eq(workspaces.ownerId, userId),
        ),
      )
      .limit(1);
    if (!personalRows[0]) {
      return { ok: false as const, error: "personal_workspace_missing" as LeaveWorkspaceError };
    }

    const membership = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .for("update");

    const m = membership[0];
    if (!m) return { ok: false as const, error: "not_member" as LeaveWorkspaceError };
    if (m.leftAt) return { ok: false as const, error: "not_member" as LeaveWorkspaceError };
    if (m.role === "owner") {
      return { ok: false as const, error: "owner_cannot_leave" as LeaveWorkspaceError };
    }

    // 软退出
    await tx
      .update(workspaceMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );

    // 撤销该用户在该 workspace 的所有 session
    await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.workspaceId, workspaceId),
        ),
      );

    // 将该用户消费的邀请码标记为 revoked（退出即失效）
    await tx
      .update(inviteCodes)
      .set({ revokedAt: new Date(), revokedBy: userId })
      .where(
        and(
          eq(inviteCodes.workspaceId, workspaceId),
          eq(inviteCodes.consumedBy, userId),
          isNull(inviteCodes.revokedAt),
        ),
      );

    return { ok: true as const, personalWorkspaceId: userRow.personalWorkspaceId };
  });

  return result;
}

// ─── PROFILE-01: 用户档案与工作区改名 ──────────────────────────────

export type UpdateProfileError = "not_found";

/**
 * PROFILE-01: 更新当前用户的展示名和头像 URL。
 * 传 undefined 表示不修改对应字段；传 null 或空串表示清除。
 * 当头像从站内上传路径变更为新值时，异步清理旧头像文件。
 */
export async function updateUserProfile(
  userId: string,
  fields: { displayName?: string | null; avatarUrl?: string | null },
): Promise<{ ok: true; displayName: string | null; avatarUrl: string | null } | { ok: false; error: UpdateProfileError }> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (fields.displayName !== undefined) {
    const trimmed = fields.displayName?.trim() ?? null;
    updates.displayName = trimmed && trimmed.length > 0 ? trimmed.slice(0, 32) : null;
  }

  let oldAvatarUrl: string | null = null;
  if (fields.avatarUrl !== undefined) {
    // Query old avatarUrl before updating so we can clean it up
    const existingUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { avatarUrl: true },
    });
    oldAvatarUrl = existingUser?.avatarUrl ?? null;

    const trimmed = fields.avatarUrl?.trim() ?? null;
    updates.avatarUrl = trimmed && trimmed.length > 0 ? trimmed.slice(0, 500) : null;
  }

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, userId))
    .returning({ displayName: users.displayName, avatarUrl: users.avatarUrl });
  if (!updated) return { ok: false, error: "not_found" };

  // Clean up old avatar from object storage if it was a site-uploaded avatar
  // and the new avatar URL is different.
  if (
    oldAvatarUrl &&
    oldAvatarUrl.startsWith("/api/uploads/avatars/") &&
    oldAvatarUrl !== updates.avatarUrl
  ) {
    const oldObjectKey = oldAvatarUrl.replace("/api/uploads/", "");
    void deleteObject(oldObjectKey).catch((err) => {
      logger.warn({ err, oldObjectKey }, "failed to delete old avatar");
    });
  }

  return {
    ok: true,
    displayName: updated.displayName,
    avatarUrl: updated.avatarUrl,
  };
}

export type RenameWorkspaceError =
  | "not_found"
  | "not_member"
  | "not_personal_workspace"
  | "empty_name";

/**
 * PROFILE-01: 重命名工作区。
 * 仅允许重命名当前用户拥有的个人工作区（personalWorkspaceId === workspaceId）。
 */
export async function renameWorkspace(
  userId: string,
  workspaceId: string,
  newName: string,
): Promise<{ ok: true; workspaceId: string; name: string } | { ok: false; error: RenameWorkspaceError }> {
  const trimmedName = newName.trim();
  if (!trimmedName) return { ok: false, error: "empty_name" };
  if (trimmedName.length > MAX_WORKSPACE_NAME_LENGTH) return { ok: false, error: "empty_name" };

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return { ok: false, error: "not_found" };

  // 仅允许重命名个人工作区
  if (user.personalWorkspaceId !== workspaceId) {
    return { ok: false, error: "not_personal_workspace" };
  }

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!ws) return { ok: false, error: "not_found" };

  await db.update(workspaces).set({ name: trimmedName }).where(eq(workspaces.id, workspaceId));
  return { ok: true, workspaceId, name: trimmedName };
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
    aiDataPolicy: {
      sendToExternal: ws.aiDataPolicy.sendToExternal,
      sendImageContent: ws.aiDataPolicy.sendImageContent ?? false,
      piiDetection: ws.aiDataPolicy.piiDetection,
      auditLogging: ws.aiDataPolicy.auditLogging,
    },
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
    sendImageContent: boolean;
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
