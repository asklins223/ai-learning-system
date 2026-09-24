import { createHash, randomBytes, randomUUID } from "node:crypto";

import { retireWorkspaceMemoriesOnDeparture } from "../companion-conversation/memory-departure.ts";
import { DomainError } from "@ailearn/shared";
import bcrypt from "bcryptjs";
import { and, eq, isNull, lt, or, gte, inArray, desc, count, sql, ne } from "drizzle-orm";
import {
  db,
  withWorkspaceTransaction,
  withActorTransaction,
  adoptWorkspaceContext,
  assumeActor,
  SYSTEM_USER_ID,
  type ApiTransaction,
} from "../../db/client.ts";
import {
  users,
  workspaceMembers,
  inviteCodes,
  workspaces,
  aiAuditLog,
  onboardingStates,
  userAiSettings,
} from "@ailearn/shared/db-schema/identity";
import { sessions } from "@ailearn/shared/db-schema/session";
import {
  hashInvitationToken as hashInvitationTokenLocal,
  isValidInvitationToken as isValidInvitationTokenLocal,
} from "./invitation-token.ts";
import { resolveSystemProviderForCapability } from "@ailearn/shared/task-router";
import { deleteObject } from "../../lib/object-storage.ts";
import { recordWorkspaceAudit } from "../audit/service.ts";
import { logger } from "../../lib/logger.ts";

/**
 * 会话滑动窗口：一次续期后，凭据在这个时长内保持有效。
 *
 * 桌面端可以把凭据加密保存在本机，所以窗口长度直接决定"多久不打开应用会被登出"。
 * 7 天对学习类应用过短（用户会间断几周），30 天是常见取值。
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 绝对上限，从会话创建时刻起算。没有它，"滑动续期"就等于"永不失效"——
 * 被窃取的 token 只要定期使用就能一直存活。到期后必须重新登录。
 */
export const SESSION_ABSOLUTE_MAX_MS = 180 * 24 * 60 * 60 * 1000;
/**
 * 只在剩余寿命不足窗口一半时才续期，避免活跃会话每个请求都写一次库。
 * 按 30 天窗口算，单个会话最多约每 15 天写一次。
 */
export const SESSION_RENEW_WHEN_REMAINING_MS = SESSION_TTL_MS / 2;

/**
 * 决定一次会话使用是否应当延长过期时间。纯函数，便于离线测试。
 *
 * 返回 null 表示无需写库：要么剩余寿命还充裕，要么已经顶到绝对上限。
 */
export function nextSessionExpiry(input: {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly now: Date;
}): Date | null {
  const { createdAt, expiresAt, now } = input;
  // 续期永远不能复活一个已经到期的会话，即使调用方没有先做过期判断。
  if (expiresAt.getTime() <= now.getTime()) return null;
  if (expiresAt.getTime() - now.getTime() >= SESSION_RENEW_WHEN_REMAINING_MS) return null;
  const ceiling = createdAt.getTime() + SESSION_ABSOLUTE_MAX_MS;
  const renewed = Math.min(now.getTime() + SESSION_TTL_MS, ceiling);
  return renewed > expiresAt.getTime() ? new Date(renewed) : null;
}
export const RECOVERED_PASSWORD_SENTINEL = "$RESET_REQUIRED$";
const BCRYPT_COST = 10;
// Keep unknown-account logins on the same expensive bcrypt path as known
// accounts so response timing does not become a reliable email oracle.
const DUMMY_PASSWORD_HASH = "$2a$10$cgxNDTz4bljIsmxLn2w.7O6Cd/C3cZK3neQBb/2Xxx4xNJkIgMrse";

function systemUsesExternalAI(): boolean {
  return (
    resolveSystemProviderForCapability("agent_turn") !== "mock" ||
    resolveSystemProviderForCapability("vision") !== "mock" ||
    resolveSystemProviderForCapability("text_generation") !== "mock" ||
    resolveSystemProviderForCapability("embedding") !== "mock"
  );
}

export function canonicalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

async function verifyPassword(plain: string, stored: string): Promise<boolean> {
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
  /** 2026-08-11（性能专项）：decodeToken 合并 JOIN 时顺带取回的成员角色，
   * 供 /auth/me 等端点复用（避免重复查 workspace_members）。 */
  membershipRole?: string | null;
  /**
   * 当前空间的 `owner_id`，同样由 decodeToken 一次 JOIN 带回。
   *
   * 为什么要有它：`isWorkspaceOwner` 是 OR 语义（成员行写着 owner，**或**空间
   * owner_id 就是本人）。此前只有 `requireOwner` 自己再去查一遍 owner_id，于是
   * `/auth/capabilities/v1` 与笔记投影这些"只想判一次角色"的地方拿不到 owner_id，
   * 就各自写了个只看 membershipRole 的简化版——同一个人在服务端可写、在 UI 上却被
   * 判成只读。把 owner_id 放进 session 上下文，判据才有唯一的落点。
   */
  workspaceOwnerId?: string | null;
  /**
   * 当前空间的服务端边界令牌（`workspaces.workspace_epoch`，迁移 0261）。
   *
   * 审查 1.3 说服务端"无 workspaceEpoch 概念（只有硬编码 1）→ 无法做某空间全端
   * 强制下线"。这一列把那个数字变成真的事实源：成员变动 / AI 同意或外发政策改变 /
   * 空间改名时 +1（触发器），会话每次解码时读回当前值。客户端拿旧值请求会被
   * 主进程的 `assertEpoch` 判 `stale_workspace`，重读会话后才继续。
   */
  workspaceEpoch: number;
}

/**
 * 签发一个会话行。
 *
 * `executor` 是**可选的**：调用方若已经在 actor 事务里（登录、切空间、注册），
 * 传进来就能复用同一事务——`sessions` 的写策略要求 `user_id = app.user_id`，
 * 没有 actor 上下文的裸 `db` 写会被 RLS 挡掉（静默 0 行，不是报错）。
 */
export async function issueSession(
  userId: string,
  workspaceId: string,
  executor?: ApiTransaction,
): Promise<{ token: string; ctx: SessionContext }> {
  const token = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const values = { token: hashToken(token), userId, workspaceId, createdAt: now, expiresAt };
  // R-011: 存储 token 的哈希值，而非明文
  if (executor) {
    await executor.insert(sessions).values(values);
  } else {
    await withActorTransaction({ userId, workspaceId, sessionToken: hashToken(token) }, (tx) =>
      tx.insert(sessions).values(values),
    );
  }
  // 边界令牌必须**当场**读出来：签发的这一刻就是客户端认识的第一个值，
  // 写死 1 会让"服务端抬过 epoch 的空间"在下次请求时立刻被判过期。
  const [workspace] = await (executor ?? db)
    .select({ workspaceEpoch: workspaces.workspaceEpoch })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return { token, ctx: { userId, workspaceId, workspaceEpoch: workspace?.workspaceEpoch ?? 1 } };
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
  // R4（round-3 审计）：不再用 lower(email) = ...（无表达式索引 → 每次登录 Seq Scan）。
  // canonicalizeEmail 已在注册/邀请路径将 email 小写存储，直接 eq(users.email, ...)
  // 命中 users_email_idx 唯一索引。
  const user = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
  });
  if (!user) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  // 空间建立之前的 actor 事务：这条路的**第一件事**就是把"这个人属于哪些空间"
  // 读出来，而 RLS 的租户守卫要的正是"当前空间"。所以用 actor 上下文
  // （`app.user_id`）而不是 workspace 上下文——`workspace_members` /
  // `workspaces` 上的 actor 读策略就是为这一条路装的（迁移 0257）。
  return withActorTransaction({ userId: user.id }, async (tx) => {
    // ADR-0009: 查询所有活跃工作区（left_at IS NULL），排除已退出的
    const memberships = await tx.query.workspaceMembers.findMany({
      where: and(
        eq(workspaceMembers.userId, user.id),
        isNull(workspaceMembers.leftAt),
      ),
    });
    if (memberships.length === 0) return null;

    // 获取所有工作区名称
    const workspaceIds = memberships.map((m) => m.workspaceId);
    const workspaceRows = await tx.query.workspaces.findMany({
      where: inArray(workspaces.id, workspaceIds),
    });
  // PERF: 一次性建 Map，避免 memberships.map 内逐条 find() 的 O(m*n)。
    const workspaceById = new Map(workspaceRows.map((w) => [w.id, w]));
    const workspacesList: WorkspaceInfo[] = memberships.map((m) => {
      const ws = workspaceById.get(m.workspaceId);
      // `workspaceType` 是空间自身的属性，不是"谁在看"的函数。此前它由
      // ownerId === 查看者派生，于是任何人的个人空间被别人加入后都会自称
      // collaborative，而真正的协作空间反而没有创建入口。
      const workspaceType = ws?.workspaceType ?? "personal";
      // ADR-0009 §3.6: 个人归属仍按 ownerId 判定（而非 personalWorkspaceId），
      // 但只有这一行本身是 personal 类型时才算"我的个人空间"。
      const isPersonal = workspaceType === "personal" && ws?.ownerId === user.id;
      return {
        workspaceId: m.workspaceId,
        workspaceName: ws?.name ?? "未命名工作区",
        role: m.role,
        workspaceType,
        isPersonal,
        leftAt: m.leftAt,
      };
    });

    // BUG-67 修复：验证 personalWorkspaceId 是否仍在活跃成员列表中。
    // 如果用户被移出或主动退出了个人工作区（leftAt 非空），
    // personalWorkspaceId 仍指向已退出的工作区，签发的 session 将无效。
    // 改为优先从活跃成员列表中查找 personalWorkspaceId，找不到则回退到第一个。
    const activeWorkspaceIds = new Set(memberships.map((m) => m.workspaceId));
    const defaultWorkspaceId =
      (user.personalWorkspaceId && activeWorkspaceIds.has(user.personalWorkspaceId))
        ? user.personalWorkspaceId
        : memberships[0].workspaceId;
    const session = await issueSession(user.id, defaultWorkspaceId, tx);
    return { ...session, workspaces: workspacesList };
  });
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


/**
 * ADR-0009: 无邀请码注册 — 只创建个人工作区，不加入任何协作空间。
 */
export async function registerWithoutInvite(
  email: string,
  password: string,
  options?: { displayName?: string; avatarUrl?: string },
): Promise<{ token: string; ctx: SessionContext } | null> {
  const normalizedEmail = canonicalizeEmail(email);
  // R5（round-3 审计）：bcryptjs 为纯 JS 主线程 CPU 密集（cost 10 ≈ 50-150ms）。
  // 在开事务前计算哈希，避免持有 10 连接池之一的同时在主线程哈希。
  // 不换库（依赖约束），保留纯 JS bcryptjs；未来可迁移 native bcrypt/worker。
  // 副作用：重复注册（已在期用户）路径会多做一次哈希，但该路径罕见且开销可忽略。
  const passwordHash = await hashPassword(password);
  // 新账号的 id 在插入前就取定：`withActorTransaction` 的 actor 必须在事务开始时
  // 确定，而注册这条路要写 `users` / `workspaces` / `workspace_members` /
  // `onboarding_states` / `sessions` 五张表——其中四张的策略按 `app.user_id` 判。
  // 让数据库自己 gen_random_uuid() 再回头设 actor，就会在嵌套校验上撞车
  // （同一条请求里两个身份），所以这里显式生成一次，只生成这一个值。
  const newUserId = randomUUID();
  let result: { session: { token: string; ctx: SessionContext } } | null;
  try {
    result = await withActorTransaction({ userId: newUserId }, async (tx) => {
      const existing = await tx.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
      if (existing) return null;

      const [user] = await tx
        .insert(users)
        .values({
          id: newUserId,
          email: normalizedEmail,
          passwordHash,
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

      // 注册是"边界事务"：新空间的 id 到这里才知道，而随后的成员行与引导行
      // 都要过租户守卫。actor 已经是新用户（见上面 newUserId 的说明），这里
      // 只需补上 `app.workspace_id`。
      await adoptWorkspaceContext(tx, personalWs.id);

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

      return { userId: user.id, workspaceId: personalWs.id, session: await issueSession(user.id, personalWs.id, tx) };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return null;
    }
    throw error;
  }
  if (!result) return null;
  return result.session;
}

/**
 * 把凭据解成一个会话上下文。挂在 18 处 preHandler 上，是全站最热的一条查询。
 *
 * ─── 为什么从"一条 JOIN"改成"两段"（SEC-01 重开 RLS）───
 * 旧写法是一条 `sessions LEFT JOIN workspace_members LEFT JOIN workspaces`。
 * RLS 重开之后它不再成立：`workspace_members` 与 `workspaces` 的策略都要
 * `app.workspace_id`，而**这个值正是要从这一行读出来的**——用未知量做谓词是循环。
 *
 * 所以按"已知量"分两段，并且都在同一个 actor 事务里：
 *   1. 用令牌哈希读 `sessions`（策略 `sec01_v1_sessions_actor_read` 认
 *      `token = app.session_token`），拿到 user_id / workspace_id；
 *   2. 用这两个值查 `workspace_members` 与 `workspaces`——它们是**同一行里的
 *      事实**，不是调用方传进来的参数，所以按它们取行不会放宽隔离。
 *
 * 代价是每个已认证请求多一次往返（两次都是主键/唯一索引命中）。换来的是一条
 * 真正的边界：任何"按 token 查会话"的语句都只能拿到自己手里那一个令牌的行。
 */
export async function decodeToken(token: string): Promise<SessionContext | null> {
  // R-011: 查询时使用 token 哈希
  const tokenHash = hashToken(token);

  return withActorTransaction({ userId: SYSTEM_USER_ID, sessionToken: tokenHash }, async (tx) => {
    const session = await tx.query.sessions.findFirst({
      where: eq(sessions.token, tokenHash),
      columns: { userId: true, workspaceId: true, createdAt: true, expiresAt: true },
    });
    if (!session) return null;
    if (session.expiresAt < new Date()) {
      // Remove expired credentials on first use as well as during the periodic
      // cleanup job. This bounds the lifetime of a stolen, already-expired token.
      await tx.delete(sessions).where(eq(sessions.token, tokenHash));
      return null;
    }

    // 第二段：会话行自带的两个 id 是这里的已知量。`withActorTransaction` 的
    // 嵌套校验只认同一个 actor，所以 actor 在这里从 SYSTEM_USER_ID 换成
    // 令牌真正的主人——用一次显式的 `set_config`，语义是"这条事务从现在起
    // 代表这个已认证用户"。
    await assumeActor(tx, session.userId, session.workspaceId);

    const membership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, session.workspaceId),
        eq(workspaceMembers.userId, session.userId),
      ),
      columns: { leftAt: true, role: true },
    });
    // ADR-0009: 无 membership 行或 left_at 非空（已退出）——用户被移出/退出后
    // 立即吊销 session。旧写法用 `membershipRole !== null` 区分"join 未命中"与
    // "活跃成员（left_at 为 NULL）"；现在 membership 行本身在手上，判据更直白。
    if (!membership || membership.leftAt !== null) {
      await tx.delete(sessions).where(eq(sessions.token, tokenHash));
      return null;
    }

    // 空间归属人（isWorkspaceOwner 的 OR 判据需要它）与边界令牌（0261）。
    const workspace = await tx.query.workspaces.findFirst({
      where: eq(workspaces.id, session.workspaceId),
      columns: { ownerId: true, workspaceEpoch: true },
    });

    // 滑动续期：桌面端把凭据存在本机，只要用户还在用就一直有效，直到绝对上限。
    // 低频写入由 nextSessionExpiry 的阈值保证（见常量注释）。
    const renewed = nextSessionExpiry({ createdAt: session.createdAt, expiresAt: session.expiresAt, now: new Date() });
    if (renewed) {
      await tx.update(sessions).set({ expiresAt: renewed }).where(eq(sessions.token, tokenHash));
    }
    return {
      userId: session.userId,
      workspaceId: session.workspaceId,
      membershipRole: membership.role ?? null,
      workspaceOwnerId: workspace?.ownerId ?? null,
      // 空间行读不到时退回 1（而不是 0）：契约是 positiveInt，0 会让整个会话
      // 在客户端解析失败。读不到只可能是空间刚被删，那种情况下一次请求就会被拒。
      workspaceEpoch: workspace?.workspaceEpoch ?? 1,
    };
  });
}

/** Revoke a session by its raw bearer/cookie token. */
export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await withActorTransaction({ userId: SYSTEM_USER_ID, sessionToken: tokenHash }, (tx) =>
    tx.delete(sessions).where(eq(sessions.token, tokenHash)),
  );
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
  // 恢复账号的密码重置：操作者是空间 owner，被改的是另一个人的账号，所以
  // actor 用**目标账号**（会话删除要按它的 user_id 过策略），租户用当前空间
  // （成员行与空间守卫都要它）。
  return withActorTransaction({ userId, workspaceId }, async (tx) => {
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

// R9（round-3 审计）：会话清理 in-flight 守卫。refer dbGaugeRunning 模式，
// 防止 1h 定时任务在上一轮尚未结束（或重叠快照）时再次并发执行无界删除。
let sessionCleanupRunning = false;
const SESSION_CLEANUP_BATCH = 1000;

export async function cleanupExpiredSessions(): Promise<number> {
  if (sessionCleanupRunning) return 0;
  sessionCleanupRunning = true;
  try {
    // 系统级的会话维护：没有"某一个令牌"要处理，所以 actor 用 nil UUID 且
    // sessionToken 留空——`sec01_v1_sessions_actor_*` 的空令牌分支就是为这条
    // 每小时的清理路留的（只按 expires_at 扫，不认人）。
    return await withActorTransaction({ userId: SYSTEM_USER_ID }, async (tx) => {
      let total = 0;
      for (;;) {
        // 分批删除：先取一批过期 token（LIMIT 有界），再按 id 删除，
        // 避免单条无界 DELETE 在过期积压大时形成长事务。
        const expired = await tx
          .select({ token: sessions.token })
          .from(sessions)
          .where(lt(sessions.expiresAt, new Date()))
          .limit(SESSION_CLEANUP_BATCH);
        if (expired.length === 0) break;
        const ids = expired.map((r) => r.token);
        // 按实际删除行计数（returning 中的 token 唯一；若个别 id 因并发已被删，
        // returning 的 len 才反映真实删除数）。
        const deleted = await tx.delete(sessions).where(inArray(sessions.token, ids)).returning({ token: sessions.token });
        total += deleted.length;
        if (expired.length < SESSION_CLEANUP_BATCH) break;
      }
      return total;
    });
  } finally {
    sessionCleanupRunning = false;
  }
}

/**
 * ADR-0009: 切换工作区 — 重新签发绑定目标 workspace 的 session。
 * 验证用户是否仍是目标 workspace 的活跃成员（left_at IS NULL）。
 */
export async function switchWorkspace(
  userId: string,
  workspaceId: string,
  previousToken: string | null,
): Promise<{ token: string; ctx: SessionContext } | null> {
  // 目标空间在这条路的入口就是已知量（请求体带 workspaceId），所以直接进
  // workspace 事务：成员行要过租户守卫，会话行的撤销与签发要过 actor 策略。
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const membership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.leftAt),
      ),
    });
    if (!membership) return null;
    // 2026-08-11（安全修复）：同一事务内"撤销旧 token + 签发新 token"——
    // 此前 routes 先签发后撤销，revoke 失败时被窃取的旧 token 继续有效。
    if (previousToken) {
      await tx.delete(sessions).where(eq(sessions.token, hashToken(previousToken)));
    }
    const session = await issueSession(userId, workspaceId, tx);
    return {
      token: session.token,
      ctx: {
        userId,
        workspaceId,
        membershipRole: membership.role ?? null,
        workspaceEpoch: session.ctx.workspaceEpoch,
      },
    };
  });
}

export type CreateWorkspaceError = "invalid_name" | "workspace_limit_reached";

/**
 * 新建一个协作工作区。
 *
 * 为什么需要它：生产代码里此前**没有任何创建工作区的入口**——`workspaces` 只在注册
 * 时建 `personal` 行，而 `workspaceType` 是按"查看者是不是 owner"派生出来的。于是
 * 协作空间事实上无法存在，唯一的共享方式是把别人拉进**自己的个人空间**，ADR-0009 的
 * 个人/协作二分因此只剩一半是真的。
 *
 * 配额沿用加入邀请码那套 `MAX_COLLABORATIVE_WORKSPACES`：自己建的协作空间同样占一个
 * 活跃协作名额，不另开第二条政策。
 */
export async function createCollaborativeWorkspace(
  userId: string,
  name: string,
): Promise<
  | { ok: true; workspaceId: string; workspaceName: string }
  | { ok: false; error: CreateWorkspaceError }
> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_WORKSPACE_NAME_LENGTH) {
    return { ok: false, error: "invalid_name" };
  }

  // 边界事务：进来的第一件事是按 user_id 查自己已有的协作空间（那时还没有当前
  // 空间），建出新的之后才把租户切过去——所以 actor 上下文，不是 workspace 上下文。
  return withActorTransaction({ userId }, async (tx) => {
    // 与 joinWorkspaceByInviteToken 同一把 users 行锁：两个并发请求不能各自越过配额。
    const userRows = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (userRows.length === 0) return { ok: false, error: "invalid_name" } as const;

    const activeCollaborative = await tx
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          isNull(workspaceMembers.leftAt),
          eq(workspaces.workspaceType, "collaborative"),
        ),
      );
    if (activeCollaborative.length >= MAX_COLLABORATIVE_WORKSPACES) {
      return { ok: false, error: "workspace_limit_reached" } as const;
    }

    const [created] = await tx
      .insert(workspaces)
      .values({ ownerId: userId, name: trimmed, workspaceType: "collaborative" })
      .returning({ id: workspaces.id, name: workspaces.name });

    // 新空间的成员行与引导行都要过租户守卫，而它的 id 到这一步才知道。
    await adoptWorkspaceContext(tx, created.id);

    await tx.insert(workspaceMembers).values({
      workspaceId: created.id,
      userId,
      role: "owner",
    });
    await tx.insert(onboardingStates).values({
      workspaceId: created.id,
      userId,
      version: "v1",
      steps: {},
      status: "pending",
    });

    return { ok: true, workspaceId: created.id, workspaceName: created.name };
  });
}

/**
 * ADR-0009: 列出用户可访问的所有活跃工作区（含个人工作区和协作工作区）。
 */
export async function listUserWorkspaces(userId: string): Promise<WorkspaceInfo[]> {
  // 与登录同一条理由：这条路要读的正是"我属于哪些空间"，而当前空间还没定。
  return withActorTransaction({ userId }, async (tx) => {
    const memberships = await tx.query.workspaceMembers.findMany({
      where: and(
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.leftAt),
      ),
    });
    if (memberships.length === 0) return [];

    const workspaceIds = memberships.map((m) => m.workspaceId);
    const workspaceRows = await tx.query.workspaces.findMany({
      where: inArray(workspaces.id, workspaceIds),
    });

    // PERF: 一次性建 Map 替代逐条 find() 的 O(m*n)。
    const workspaceById = new Map(workspaceRows.map((w) => [w.id, w]));
    return memberships.map((m) => {
      const ws = workspaceById.get(m.workspaceId);
      // 见 listUserWorkspaces 同名注释：类型属于空间，不属于查看者。
      const workspaceType = ws?.workspaceType ?? "personal";
      const isPersonal = workspaceType === "personal" && ws?.ownerId === userId;
      return {
        workspaceId: m.workspaceId,
        workspaceName: ws?.name ?? "未命名工作区",
        role: m.role,
        workspaceType,
        isPersonal,
        leftAt: m.leftAt,
      };
    });
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

export class JoinWorkspaceError extends DomainError {
  readonly code: JoinWorkspaceErrorCode;
  constructor(code: JoinWorkspaceErrorCode) {
    super({ name: "JoinWorkspaceError", code, message: code, statusCode: 400 });
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
    // 边界事务：进来时只知道"手里这串邀请码"，空间 id 要读出来才知道。
    // actor 是加入者本人；令牌哈希进 `app.session_token`，让邀请码那一行的
    // actor 读策略能命中（策略见迁移 0257）。
    result = await withActorTransaction(
      { userId, sessionToken: tokenHash },
      async (tx) => {
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

        // 空间 id 到这里才知道，随后的成员行 / 引导行 / 邀请码消费都要过租户守卫。
        await adoptWorkspaceContext(tx, invite.workspaceId);

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
      },
    );
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

export type TransferOwnershipError =
  | "not_found"
  | "not_owner"
  | "target_not_member"
  | "target_is_owner"
  | "personal_workspace_not_transferable";

/**
 * 把协作空间的所有权交给另一个**活跃成员**（审查附录 C 的"没有出口"）。
 *
 * 为什么必须有这条路：`leaveWorkspace` 对 owner 直接拒（`owner_cannot_leave`）——
 * 那道拦截是对的（否则空间变无主，`requireOwner` 的 OR 语义会让所有 member 同时
 * "非 owner"，整个空间锁死），但它把 owner 也关死了：既不能退，也不能交。
 * 有了转让，退出这条路才重新打开（先交、再退）。
 *
 * 三条不变量：
 *   - 只有**当前** owner 能发起（`isWorkspaceOwner`，与其余判据同源）；
 *   - 目标必须是这个空间的活跃成员（数据库触发器也拦一次，见迁移 0264）；
 *   - 个人空间不能转让（个人空间的所有权就是"这是我"这件事，ADR-0009）。
 *
 * 转让写审计（`workspace.ownership_transferred`）：这是"谁能拿走全空间数据"的变更，
 * 比一次导出更该留痕。
 */
export async function transferWorkspaceOwnership(
  actorUserId: string,
  workspaceId: string,
  targetUserId: string,
): Promise<
  | { ok: true; workspaceId: string; newOwnerUserId: string }
  | { ok: false; error: TransferOwnershipError }
> {
  return withActorTransaction({ userId: actorUserId }, async (tx) => {
    const workspace = await tx.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { id: true, ownerId: true, workspaceType: true },
    });
    if (!workspace) return { ok: false, error: "not_found" } as const;
    if (workspace.workspaceType === "personal") {
      return { ok: false, error: "personal_workspace_not_transferable" } as const;
    }

    // 当前 owner 判定要**同时**认 membership.role 与 workspaces.owner_id
    // （`isWorkspaceOwner` 的 OR 语义），否则 co-owner 会被自己建的判据挡在门外。
    const actorMembership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorUserId),
        isNull(workspaceMembers.leftAt),
      ),
      columns: { role: true },
    });
    const actorIsOwner = workspace.ownerId === actorUserId || actorMembership?.role === "owner";
    if (!actorIsOwner) return { ok: false, error: "not_owner" } as const;
    if (workspace.ownerId === targetUserId) {
      return { ok: false, error: "target_is_owner" } as const;
    }

    const targetMembership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId),
        isNull(workspaceMembers.leftAt),
      ),
      columns: { role: true },
    });
    if (!targetMembership) return { ok: false, error: "target_not_member" } as const;

    await adoptWorkspaceContext(tx, workspaceId);

    // 先写 owner_id（触发器要求新 owner 已是活跃成员，这里已核实）。
    await tx
      .update(workspaces)
      .set({ ownerId: targetUserId })
      .where(eq(workspaces.id, workspaceId));
    // 成员角色跟着走：两个 co-owner 并列会让 `isWorkspaceOwner` 的 OR 语义出现
    // 两个人都能"全权"的状态，而"谁是 owner"必须只有一个答案。
    await tx
      .update(workspaceMembers)
      .set({ role: "member" })
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorUserId),
      ));
    await tx
      .update(workspaceMembers)
      .set({ role: "owner" })
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ));

    await recordWorkspaceAudit(tx, {
      workspaceId,
      actorUserId,
      action: "workspace.ownership_transferred",
      targetKind: "user",
      targetId: targetUserId,
      detail: { previousOwnerUserId: actorUserId },
    });

    return { ok: true, workspaceId, newOwnerUserId: targetUserId } as const;
  });
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
  const result = await withActorTransaction({ userId }, async (tx) => {
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
    // 这一步要在"要退出的那个空间"的租户上下文里读不到：`workspaces` 的
    // actor 读策略认 `id = app.workspace_id`。所以先把上下文摆到**个人空间**上
    // （它的 id 就是 userRow.personalWorkspaceId），确认它还在、还是这个人的，
    // 再把上下文切到要退出的空间做后面三张表的写入。
    await adoptWorkspaceContext(tx, userRow.personalWorkspaceId);
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

    // 退出动作全部发生在"要退出的那个空间"里：成员行、该空间内的会话、
    // 该空间里被这个用户消费掉的邀请码——三张表的租户守卫都要它。
    await adoptWorkspaceContext(tx, workspaceId);

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

    // 离开时收掉**这个空间那一侧的记忆**（doc 34 L38）：`scope='workspace'` 的行软删除，
    // 跟人绑定的 `scope='global'` 不动。与被退同一事务——回滚了却留下一堆"被收掉的记忆"
    // 是假证据。走数据库函数是因为策略要求 app.user_id 等于行的 user_id，
    // 而 owner 移人时上下文里的 actor 不是当事人。
    await retireWorkspaceMemoriesOnDeparture(tx, { workspaceId, userId });

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
  // SEC 修复（2026-09 后端审查）：必须确认旧对象键属于当前用户名下
  // （avatars/{userId}/...）。此前只校验 "/api/uploads/avatars/" 前缀，而
  // avatarUrlSchema 允许任意该前缀的路径——用户可把 avatarUrl 指向他人头像，
  // 再修改/清空头像即删除他人存储对象。
  if (
    oldAvatarUrl &&
    oldAvatarUrl.startsWith(`/api/uploads/avatars/${userId}/`) &&
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
  | "not_owner"
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

  // 个人空间：仍然只允许重命名自己那一个（原有规则）。
  //
  // 协作空间（审计 F39）：**它的 owner 也能改名**。此前这条把协作空间一律拒掉，
  // 而界面上唯一的替代出口是不可逆的解散——"名字随手起错了"没有轻的出路是操作
  // 逻辑问题，改名本身没有任何破坏性。判据与 `transferWorkspaceOwnership` 同一句：
  // `workspaces.owner_id` 或 membership.role=owner（co-owner 也是 owner）。
  if (user.personalWorkspaceId !== workspaceId) {
    const [workspace, membership] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { ownerId: true, workspaceType: true } }),
      db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
          isNull(workspaceMembers.leftAt),
        ),
        columns: { role: true },
      }),
    ]);
    if (!workspace) return { ok: false, error: "not_found" };
    if (!membership && workspace.ownerId !== userId) return { ok: false, error: "not_member" };
    const actorIsOwner = workspace.ownerId === userId || membership?.role === "owner";
    if (!actorIsOwner) return { ok: false, error: "not_owner" };
    if (workspace.workspaceType !== "collaborative") return { ok: false, error: "not_personal_workspace" };
  }

  // 读写都在同一个 workspace 事务里：`workspaces` 的租户守卫按
  // `id = app.workspace_id` 判，裸 db 查询在 RLS 下会读到 0 行。
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const ws = await tx.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) return { ok: false, error: "not_found" };

    await tx.update(workspaces).set({ name: trimmedName }).where(eq(workspaces.id, workspaceId));
    return { ok: true, workspaceId, name: trimmedName };
  });
}

// ─── N-011: AI 隐私治理 ────────────────────────────────────────────

/**
 * N-011: 获取工作区的 AI 隐私治理配置。
 */
/**
 * 读取本人的 AI 同意与数据外发政策（0237 起为账号级）。
 *
 * 必须走 `withWorkspaceTransaction`：`user_ai_settings` 启用了 RLS 且策略按
 * `app.user_id`，用默认 `db` 连接查它会**静默返回 0 行**，表现成"同意永远未签"
 * 而不是报错。`workspaceId` 只用于设置事务上下文，不参与这张表的隔离。
 */
export async function getAIPrivacySettings(workspaceId: string, userId: string) {
  const rows = await withWorkspaceTransaction(
    { workspaceId, userId },
    (transaction) => transaction
      .select()
      .from(userAiSettings)
      .where(eq(userAiSettings.userId, userId))
      .limit(1),
  );
  const settings = rows[0];
  if (!settings) return null;
  return {
    requiresConsent: systemUsesExternalAI(),
    consentVersion: settings.consentVersion,
    consentAt: settings.consentAt,
    dataPolicy: {
      sendToExternal: settings.dataPolicy.sendToExternal,
      sendImageContent: settings.dataPolicy.sendImageContent ?? false,
      piiDetection: settings.dataPolicy.piiDetection,
      auditLogging: settings.dataPolicy.auditLogging,
    },
  };
}

/**
 * 签署本人的 AI 使用同意。0237 起不再要求 owner 身份，也不再影响同空间的其他人。
 */
export async function updateAIConsent(
  workspaceId: string,
  userId: string,
  consentVersion: string,
): Promise<void> {
  await withWorkspaceTransaction(
    { workspaceId, userId },
    (transaction) => transaction
      .insert(userAiSettings)
      .values({
        userId,
        consentVersion,
        consentAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userAiSettings.userId,
        set: { consentVersion, consentAt: new Date(), updatedAt: new Date() },
      }),
  );
}

/** 更新本人的 AI 数据外发政策。 */
export async function updateAIDataPolicy(
  workspaceId: string,
  userId: string,
  policy: {
    sendToExternal: boolean;
    sendImageContent: boolean;
    piiDetection: boolean;
    auditLogging: boolean;
  },
): Promise<void> {
  await withWorkspaceTransaction(
    { workspaceId, userId },
    (transaction) => transaction
      .insert(userAiSettings)
      .values({ userId, dataPolicy: policy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userAiSettings.userId,
        set: { dataPolicy: policy, updatedAt: new Date() },
      }),
  );
}

/**
 * N-011: 查询 AI 审计日志（分页）。
 *
 * `ai_audit_log` 在 0257 里是 `ENABLE + FORCE ROW LEVEL SECURITY`，所以这两句读
 * **必须带工作区上下文**：裸 `db` 在 `ailearn_api`（NOBYPASSRLS，生产形状）下恒 0 行，
 * rows 与 count 双双为空——而设置页写的是"每次外发都留下可追溯的记录，供你回看"
 * （doc 34 L3，与 L2 同一颗雷：dev 的 API 角色绕过 RLS，所以本地永远是绿的）。
 */
export async function listAIAuditLog(
  workspaceId: string,
  userId: string,
  opts: { limit: number; offset: number },
): Promise<{ items: AIAuditLogItem[]; total: number }> {
  const [rows, totalRows] = await withWorkspaceTransaction(
    { workspaceId, userId },
    (transaction) => Promise.all([
      transaction
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
      transaction
        .select({ total: count() })
        .from(aiAuditLog)
        .where(eq(aiAuditLog.workspaceId, workspaceId)),
    ]),
  );

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
          }
  | {
      actorUserId?: undefined;
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
  const actorUserId = params.actorUserId;
  if (!actorUserId) {
    throw new Error("AI audit log requires actorUserId (the initiating user UUID)");
  }
  // `ai_audit_log` 有租户守卫 + 插入 actor 守卫，两者都要上下文。
  await withActorTransaction({ userId: actorUserId, workspaceId: params.workspaceId }, (tx) =>
    tx.insert(aiAuditLog).values({
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
    }),
  );
}

/**
 * 2026-08-11（安全加固）：修改密码——验证旧密码后更新 bcrypt 哈希，
 * 并在同一事务内撤销该用户**全部** session（改密后强制全端重新登录）。
 * 返回 false 表示旧密码错误（不区分其他原因，避免枚举）。
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) return false;
  const newHash = await hashPassword(newPassword);
  // 撤销"这个人的全部会话"是改密的语义本身，所以 actor 就是这个人，
  // 不带 sessionToken——`sec01_v1_sessions_actor_*` 的空令牌分支允许按 user_id 批量删。
  await withActorTransaction({ userId }, async (tx) => {
    await tx.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
  return true;
}

/**
 * 2026-08-11（安全加固）：撤销用户全部会话（"退出所有设备"）。
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await withActorTransaction({ userId }, (tx) =>
    tx.delete(sessions).where(eq(sessions.userId, userId)),
  );
}

/**
 * 解散一个协作空间（doc 34 L6 的 ②；实现体是迁移 0276 里那支函数）。
 *
 * 为什么把整件事放进一支 `SECURITY DEFINER` 函数而不是在 TS 里循环删：
 * 库里有 102 张表带 `workspace_id`、只有 13 张真有指向 `workspaces` 的外键，
 * 逐表清理必须在**同一个事务**里完成并且由 catalog 决定清单——留在 TS 侧就是一段
 * 会随迁移增长而悄悄漏表的清单（漏一张就是一批没人认领的孤儿行）。
 * TS 这一层只做三件事：拿会话身份、把函数抛的错误名翻成人能懂的错误码、把逐表计数带回去。
 */
/**
 * 解散**之前**的先睹计数（审计 F39 ③）。
 *
 * 解散的确认文案自己写着"这个空间会连同其中的笔记、卡片与排程一起消失"，但界面上
 * 一个数都没有——用户要点开一颗盲盒。真删了多少行由迁移 0276 那个函数逐表带回来，
 * 那一刻已经太晚，所以这里在确认之前先读一次。
 *
 * 两道门卫的分工要写清楚：**能不能删仍然只由 SQL 函数判**（`actor_is_not_active_owner`
 * 等三条），这份预览只是"给已经在界面上看得到解散按钮的人一个数"。因此这里的判据
 * 取与改名/转让同一句（`owner_id` 或 membership.role=owner，且必须是协作空间）；
 * 它不会比真动作更宽松——放宽一点也不会删掉任何东西，收紧则会撒"没有"的谎。
 */
export async function previewWorkspaceDissolve(
  workspaceId: string,
  actorUserId: string,
): Promise<
  | { ok: true; counts: { notes: number; sources: number; cards: number; schedules: number } }
  | { ok: false; error: "workspace_not_found" | "actor_is_not_active_owner" | "cannot_dissolve_personal_workspace" }
> {
  const [workspace, membership] = await Promise.all([
    db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { ownerId: true, workspaceType: true },
    }),
    db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorUserId),
        isNull(workspaceMembers.leftAt),
      ),
      columns: { role: true },
    }),
  ]);
  if (!workspace) return { ok: false, error: "workspace_not_found" };
  if (workspace.workspaceType !== "collaborative") {
    return { ok: false, error: "cannot_dissolve_personal_workspace" };
  }
  if (workspace.ownerId !== actorUserId && membership?.role !== "owner") {
    return { ok: false, error: "actor_is_not_active_owner" };
  }

  // 四张表一起数：`notes`/`sources` 连外键都靠 workspace_id 判，RLS 下必须带上下文，
  // 否则受限角色读到 0 行——那会让确认文案说"这里什么都没有"。
  const [row] = await withWorkspaceTransaction({ workspaceId, userId: actorUserId }, async (tx) =>
    tx.execute(sql`
      SELECT
        (SELECT count(*) FROM notes WHERE workspace_id = ${workspaceId}::uuid)::int AS notes,
        (SELECT count(*) FROM sources WHERE workspace_id = ${workspaceId}::uuid)::int AS sources,
        (SELECT count(*) FROM learning_cards_v2 WHERE workspace_id = ${workspaceId}::uuid)::int AS cards,
        (SELECT count(*) FROM review_schedules WHERE workspace_id = ${workspaceId}::uuid)::int AS schedules
    `),
  );
  const counts = (Array.isArray(row) ? row[0] : row) as {
    notes: number; sources: number; cards: number; schedules: number;
  };
  return { ok: true, counts };
}

export async function dissolveWorkspace(
  workspaceId: string,
  actorUserId: string,
): Promise<{ ok: true; counts: Record<string, number> } | { ok: false; error: string }> {
  try {
    const rows = await withActorTransaction({ userId: actorUserId }, (tx) =>
      tx.execute(sql`
        SELECT public.ailearn_dissolve_workspace(${workspaceId}::uuid, ${actorUserId}::uuid)
          AS counts
      `));
    const counts = (rows[0] as { counts: Record<string, number> } | undefined)?.counts ?? {};
    return { ok: true, counts };
  } catch (err) {
    // drizzle 会把驱动错误包成 `Failed query: …`，真正的 `RAISE EXCEPTION` 文本在
    // `err.cause` 上——只读 message 的话三种门卫全会掉进 500（我第一次跑就是这样）。
    const chain: string[] = [];
    let cursor: unknown = err;
    for (let depth = 0; depth < 5 && cursor; depth += 1) {
      const item = cursor as { message?: unknown; cause?: unknown };
      if (typeof item.message === "string") chain.push(item.message);
      cursor = item.cause;
    }
    const message = chain.join(" | ");
    const code = [
      "workspace_not_found",
      "cannot_dissolve_personal_workspace",
      "actor_is_not_active_owner",
      "actor_has_no_surviving_workspace_for_audit",
    ].find((name) => message.includes(name));
    return { ok: false, error: code ?? "dissolve_failed" };
  }
}
