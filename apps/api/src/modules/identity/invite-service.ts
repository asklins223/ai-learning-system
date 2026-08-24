import { and, eq, isNull, or, gte, desc, sql, inArray } from "drizzle-orm";
import { DomainError } from "@ailearn/shared";
import { db, withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import {
  inviteCodes,
  workspaceMembers,
  users,
  workspaces,
} from "../../db/schema/identity.ts";
import { sessions } from "../../db/schema/session.ts";
import { onboardingStates } from "../../db/schema/identity.ts";
import { notes, sources } from "../../db/schema/note.ts";
import { validationEvents } from "../../db/schema/evidence.ts";
import { evidenceSnapshotsV2 } from "../../db/schema/card-generation-v2.ts";
import {
  learningCardsV2,
  learningObjectiveOriginsV2,
} from "../../db/schema/card-generation-v2.ts";
import {
  generateInvitationToken,
  createInvitationTokenStorage,
  hashInvitationToken,
  isValidInvitationToken,
} from "./invitation-token.ts";
import { canonicalizeEmail, hashPassword, issueSession, type SessionContext } from "./service.ts";
import { resolveSystemProviderForCapability } from "@ailearn/shared/task-router";
// OPS-01: Funnel 指标（ADR-0006 §2）
import { recordFunnelEvent } from "../../lib/metrics.ts";

// ─── Types ──────────────────────────────────────────────────────────

export type InviteStatus = "active" | "consumed" | "revoked" | "expired";

export interface CreatedInvite {
  id: string;
  token: string; // plaintext, shown only once
  tokenHint: string;
  role: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface InviteListItem {
  id: string;
  tokenHint: string;
  role: string;
  status: InviteStatus;
  createdAt: Date;
  expiresAt: Date | null;
  consumedAt: Date | null;
  consumedByEmail: string | null;
  revokedAt: Date | null;
}

export type CreateInviteError = "invalid_role" | "generation_failed";
export type RevokeInviteError = "not_found" | "already_consumed" | "already_revoked";
export type ConsumeInviteErrorCode =
  | "not_found"
  | "expired"
  | "revoked"
  | "already_consumed"
  | "email_exists"
  | "concurrent_consumption";

export class ConsumeInviteError extends DomainError {
  readonly code: ConsumeInviteErrorCode;
  constructor(code: ConsumeInviteErrorCode) {
    super({ name: "ConsumeInviteError", code, message: code, statusCode: 400 });
    this.code = code;
  }
}

// ─── Create ─────────────────────────────────────────────────────────

const VALID_ROLES = new Set(["member", "owner"]);

function defaultDisplayName(displayName: string | undefined, email: string): string {
  return (displayName?.trim() || email.split("@")[0] || "用户").slice(0, 32);
}

export async function createInvite(
  workspaceId: string,
  createdBy: string,
  options: { role?: string; expiresAt?: Date | null },
): Promise<CreatedInvite> {
  const role = options.role ?? "member";
  if (!VALID_ROLES.has(role)) {
    throw new Error("invalid_role");
  }

  const token = generateInvitationToken();
  const storage = createInvitationTokenStorage(token);

  const [row] = await withWorkspaceTransaction(
    { workspaceId, userId: createdBy },
    async (tx) => {
      return tx
        .insert(inviteCodes)
        .values({
          workspaceId,
          createdBy,
          role,
          tokenHash: storage.tokenHash,
          tokenHint: storage.tokenHint,
          expiresAt: options.expiresAt ?? null,
        })
        .returning({
          id: inviteCodes.id,
          createdAt: inviteCodes.createdAt,
        });
    },
  );

  if (!row) throw new Error("generation_failed");

  // OPS-01: Funnel 指标 — 邀请码创建
  recordFunnelEvent("invite_created");

  return {
    id: row.id,
    token,
    tokenHint: storage.tokenHint,
    role,
    expiresAt: options.expiresAt ?? null,
    createdAt: row.createdAt,
  };
}

// ─── List ───────────────────────────────────────────────────────────

export function computeStatus(
  row: {
    consumedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date | null;
  },
  now: Date = new Date(),
): InviteStatus {
  if (row.revokedAt) return "revoked";
  if (row.consumedAt) return "consumed";
  if (row.expiresAt && row.expiresAt < now) return "expired";
  return "active";
}

export async function listInvites(
  workspaceId: string,
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ items: InviteListItem[]; total: number }> {
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  const rows = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const items = await tx
        .select({
          id: inviteCodes.id,
          tokenHint: inviteCodes.tokenHint,
          role: inviteCodes.role,
          createdAt: inviteCodes.createdAt,
          expiresAt: inviteCodes.expiresAt,
          consumedAt: inviteCodes.consumedAt,
          revokedAt: inviteCodes.revokedAt,
          consumedBy: inviteCodes.consumedBy,
        })
        .from(inviteCodes)
        .where(eq(inviteCodes.workspaceId, workspaceId))
        .orderBy(desc(inviteCodes.createdAt))
        .limit(limit)
        .offset(offset);

      // Batch-load consumer emails
      const consumerIds = items
        .map((r) => r.consumedBy)
        .filter((id): id is string => id !== null);
      const consumers =
        consumerIds.length > 0
          ? await tx
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(inArray(users.id, consumerIds))
          : [];
      const emailMap = new Map(consumers.map((c) => [c.id, c.email]));

      const countResult = await tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(inviteCodes)
        .where(eq(inviteCodes.workspaceId, workspaceId));

      return {
        items: items.map((r) => ({
          id: r.id,
          tokenHint: r.tokenHint ?? "",
          role: r.role,
          status: computeStatus(r),
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          consumedAt: r.consumedAt,
          consumedByEmail: r.consumedBy ? emailMap.get(r.consumedBy) ?? null : null,
          revokedAt: r.revokedAt,
        })),
        total: countResult[0]?.count ?? 0,
      };
    },
  );

  return rows;
}

// ─── Revoke ─────────────────────────────────────────────────────────

export async function revokeInvite(
  inviteId: string,
  workspaceId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: RevokeInviteError }> {
  const result = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const rows = await tx
        .select({
          id: inviteCodes.id,
          consumedAt: inviteCodes.consumedAt,
          revokedAt: inviteCodes.revokedAt,
        })
        .from(inviteCodes)
        .where(
          and(
            eq(inviteCodes.id, inviteId),
            eq(inviteCodes.workspaceId, workspaceId),
          ),
        )
        .for("update");

      const invite = rows[0];
      if (!invite) return { ok: false as const, error: "not_found" as RevokeInviteError };
      if (invite.consumedAt) return { ok: false as const, error: "already_consumed" as RevokeInviteError };
      if (invite.revokedAt) return { ok: false as const, error: "already_revoked" as RevokeInviteError };

      await tx
        .update(inviteCodes)
        .set({ revokedAt: new Date(), revokedBy: userId })
        .where(eq(inviteCodes.id, inviteId));

      // OPS-01: Funnel 指标 — 邀请码撤销
      recordFunnelEvent("invite_revoked");

      return { ok: true as const };
    },
  );

  return result;
}

// ─── Consume (used by registerWithInviteV2) ─────────────────────────

export async function consumeInvite(
  email: string,
  password: string,
  token: string,
  options?: { displayName?: string; avatarUrl?: string },
): Promise<{ token: string; ctx: SessionContext } | ConsumeInviteError> {
  const normalizedEmail = canonicalizeEmail(email);

  if (!isValidInvitationToken(token)) {
    return new ConsumeInviteError("not_found");
  }

  const tokenHash = hashInvitationToken(token);

  // R5（round-3 审计）：bcryptjs 纯 JS 主线程哈希；在开事务前计算，
  // 避免持有连接池连接的同时在主线程 hash（~50-150ms）。不换库（依赖约束）。
  const passwordHash = await hashPassword(password);

  let result: { userId: string; workspaceId: string } | null;
  try {
    result = await db.transaction(async (tx) => {
      const now = new Date();

      // Lock the invite row by token_hash
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
        // Also check if it exists at all to distinguish error codes
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
        if (row.revokedAt) throw new ConsumeInviteError("revoked");
        if (row.consumedBy) throw new ConsumeInviteError("already_consumed");
        if (row.expiresAt && row.expiresAt < now) throw new ConsumeInviteError("expired");
        return null;
      }

      // Check email uniqueness
      const exactUser = await tx.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
      const existing = exactUser ?? await tx.query.users.findFirst({
        where: sql`lower(${users.email}) = ${normalizedEmail}`,
      });
      if (existing) throw new ConsumeInviteError("email_exists");

      // Create user
      const [user] = await tx
        .insert(users)
        .values({
          email: normalizedEmail,
          passwordHash,
          displayName: defaultDisplayName(options?.displayName, normalizedEmail),
          ...(options?.avatarUrl?.trim() ? { avatarUrl: options.avatarUrl.trim() } : {}),
        })
        .returning();

      // ADR-0009 / PROFILE-01: 创建个人工作区，名称优先使用昵称
      const wsNameBase = options?.displayName?.trim() || user.email.split("@")[0] || "用户";
      const [personalWs] = await tx
        .insert(workspaces)
        .values({
          ownerId: user.id,
          name: `${wsNameBase.slice(0, 46)}的工作区`,
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

      // 协作工作区 membership with invite role
      await tx.insert(workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: invite.role ?? "member",
      });

      // Create onboarding state (协作工作区)
      await tx.insert(onboardingStates).values({
        workspaceId: invite.workspaceId,
        userId: user.id,
        version: "v1",
        steps: {},
        status: "pending",
      });

      // Create onboarding state (个人工作区)
      await tx.insert(onboardingStates).values({
        workspaceId: personalWs.id,
        userId: user.id,
        version: "v1",
        steps: {},
        status: "pending",
      });

      // Mark invite consumed
      await tx
        .update(inviteCodes)
        .set({ consumedBy: user.id, consumedAt: now, consumeContext: "registration" })
        .where(
          and(
            eq(inviteCodes.id, invite.id),
            isNull(inviteCodes.consumedBy),
          ),
        );

      // ADR-0009: 默认进入个人工作区
      return { userId: user.id, workspaceId: personalWs.id };
    });
  } catch (error) {
    if (error instanceof ConsumeInviteError) return error;
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return new ConsumeInviteError("email_exists");
    }
    throw error;
  }

  if (!result) return new ConsumeInviteError("not_found");

  // OPS-01: Funnel 指标 — 邀请码被消费（新用户注册成功）
  recordFunnelEvent("invite_consumed");

  return issueSession(result.userId, result.workspaceId);
}

// ─── Member management ──────────────────────────────────────────────

export interface MemberListItem {
  userId: string;
  email: string;
  role: string;
  joinedAt: Date;
}

export async function listMembers(
  workspaceId: string,
  userId: string,
  options?: { limit?: number },
): Promise<{ items: MemberListItem[]; total: number }> {
  // Y10（round-3 审计）：原实现无 LIMIT 全量返回活跃成员（超大工作区成员很多时
  // 无界响应）。新增可选 limit（默认 200，上限 500）；total 只在翻页满时（很可能还有
  // 更多成员）才补一次 count 查询得到真实总数——小于 limit 的常见情形不额外查询。
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 500);
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // ADR-0009: listMembers 只返回活跃成员（left_at IS NULL）
      const members = await tx
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
        })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            isNull(workspaceMembers.leftAt),
          ),
        )
        .orderBy(desc(workspaceMembers.joinedAt))
        .limit(limit);

      let total = members.length;
      if (members.length >= limit) {
        // 已拿满一页：可能还有更多成员，取真实总数（供前端判断是否还有下一页）。
        const [totalRows] = await tx
          .select({ n: sql<number>`count(*)::integer` })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              isNull(workspaceMembers.leftAt),
            ),
          );
        total = totalRows?.n ?? members.length;
      }

      const userIds = members.map((m) => m.userId);
      const userRows =
        userIds.length > 0
          ? await tx
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(inArray(users.id, userIds))
          : [];
      const emailMap = new Map(userRows.map((u) => [u.id, u.email]));

      return {
        items: members.map((m) => ({
          userId: m.userId,
          email: emailMap.get(m.userId) ?? "",
          role: m.role,
          joinedAt: m.joinedAt,
        })),
        total,
      };
    },
  );
}

export type RemoveMemberError = "not_found" | "last_owner" | "self_remove_owner";

export async function removeMember(
  workspaceId: string,
  ownerId: string,
  targetUserId: string,
): Promise<{ ok: true } | { ok: false; error: RemoveMemberError }> {
  if (ownerId === targetUserId) {
    return { ok: false, error: "self_remove_owner" };
  }

  const result = await withWorkspaceTransaction(
    { workspaceId, userId: ownerId },
    async (tx) => {
      // Check target is a member
      const target = await tx
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId),
          ),
        )
        .for("update");

      if (target.length === 0) return { ok: false as const, error: "not_found" as RemoveMemberError };

      // Count owners to prevent removing the last one
      const ownerCount = await tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.role, "owner"),
          ),
        );

      if (target[0].role === "owner" && (ownerCount[0]?.count ?? 0) <= 1) {
        return { ok: false as const, error: "last_owner" as RemoveMemberError };
      }

      // ADR-0009: 软退出（设置 left_at），允许后续重新邀请加入
      await tx
        .update(workspaceMembers)
        .set({ leftAt: new Date() })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId),
          ),
        );

      // Revoke all sessions for this user in this workspace
      await tx
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, targetUserId),
            eq(sessions.workspaceId, workspaceId),
          ),
        );

      return { ok: true as const };
    },
  );

  return result;
}

// ─── Onboarding ─────────────────────────────────────────────────────

export const ONBOARDING_STEPS = [
  "ai_consent",
  "first_content",
  "first_note",
  "first_card",
  "evidence_review",
  "first_validation",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingState {
  id: string;
  workspaceId: string;
  userId: string;
  version: string;
  steps: Record<string, boolean>;
  status: string;
}

interface DerivedOnboardingSnapshot {
  steps: Record<string, boolean>;
  status: "pending" | "in_progress" | "completed";
}

function onboardingStepsEqual(
  left: Record<string, boolean>,
  right: Record<string, boolean>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && rightKeys.every((key) => left[key] === right[key]);
}

async function deriveOnboardingSnapshot(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  storedSteps: Record<string, boolean>,
): Promise<DerivedOnboardingSnapshot> {
  // N#7-12：5 个派生查询相互无数据依赖，并行化（原来串行 5 次往返）。
  // 该函数在 markOnboardingStep 的 FOR UPDATE 持有期内调用，并行化缩短写锁持有时间。
  const [workspace, firstContent, firstNote, firstCard, firstValidation] = await Promise.all([
    tx.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    }),
    tx
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.workspaceId, workspaceId), eq(sources.createdBy, userId)))
      .limit(1),
    // CONC-03: 软删除的笔记不计入 onboarding 判定
    tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.workspaceId, workspaceId), eq(notes.createdBy, userId), isNull(notes.deletedAt)))
      .limit(1),
    // V2: 检测用户是否已有学习卡（first_card 步骤）。
    // V1 退役：原查询经 learningCards.noteVersionId 直连 note（V1 表已删）。
    // V2 卡片经 objectiveId 关联 objective，再经 learningObjectiveOriginsV2 回溯到 note。
    tx
      .select({ id: learningCardsV2.id })
      .from(learningCardsV2)
      .innerJoin(learningObjectiveOriginsV2, eq(learningObjectiveOriginsV2.objectiveId, learningCardsV2.objectiveId))
      .innerJoin(notes, eq(notes.id, learningObjectiveOriginsV2.noteId))
      .where(
        and(
          eq(learningCardsV2.workspaceId, workspaceId),
          eq(notes.createdBy, userId),
          isNull(notes.deletedAt),
        ),
      )
      .limit(1),
    tx
      .select({ id: validationEvents.id })
      .from(validationEvents)
      .where(
        and(
          eq(validationEvents.workspaceId, workspaceId),
          eq(validationEvents.userId, userId),
        ),
      )
      .limit(1),
  ]);

  // v0.6 单一配置源重构：平台解析完全收敛到 config/ai-platforms.json，
  // 不再读 workspace.aiProvider 或 personal BYOK。
  const effectiveProvider = resolveSystemProviderForCapability("agent_turn");
  const usesExternalProvider = effectiveProvider !== "mock";

  const steps: Record<string, boolean> = {
    ai_consent: !usesExternalProvider || Boolean(workspace?.aiConsentAt && workspace.aiConsentVersion),
    first_content: firstContent.length > 0,
    first_note: firstNote.length > 0,
    first_card: firstCard.length > 0,
    evidence_review: storedSteps.evidence_review === true,
    first_validation: firstValidation.length > 0,
  };
  const completedCount = ONBOARDING_STEPS.filter((step) => steps[step]).length;
  const status = completedCount === ONBOARDING_STEPS.length
    ? "completed"
    : completedCount > 0
      ? "in_progress"
      : "pending";

  return { steps, status };
}

export async function getOnboardingState(
  workspaceId: string,
  userId: string,
): Promise<OnboardingState | null> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const rows = await tx
        .select()
        .from(onboardingStates)
        .where(
          and(
            eq(onboardingStates.workspaceId, workspaceId),
            eq(onboardingStates.userId, userId),
          ),
        )
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      const storedSteps = row.steps as Record<string, boolean>;
      const { steps, status } = await deriveOnboardingSnapshot(
        tx,
        workspaceId,
        userId,
        storedSteps,
      );

      if (!onboardingStepsEqual(storedSteps, steps) || row.status !== status) {
        await tx
          .update(onboardingStates)
          .set({ steps, status, updatedAt: new Date() })
          .where(eq(onboardingStates.id, row.id));
      }
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        userId: row.userId,
        version: row.version,
        steps,
        status,
      };
    },
  );
}

export type UpdateStepError = "invalid_step" | "not_found" | "business_fact_missing";

export async function markOnboardingStep(
  workspaceId: string,
  userId: string,
  step: string,
  completed: boolean = true,
  evidenceId?: string,
): Promise<{ ok: true } | { ok: false; error: UpdateStepError }> {
  // All other steps are derived from authoritative tables. Evidence review is
  // the sole acknowledgement event and must reference evidence the user opened.
  if (step !== "evidence_review" || !completed || !evidenceId) {
    return { ok: false, error: "invalid_step" };
  }

  const result = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const rows = await tx
        .select()
        .from(onboardingStates)
        .where(
          and(
            eq(onboardingStates.workspaceId, workspaceId),
            eq(onboardingStates.userId, userId),
          ),
        )
        .for("update");

      const state = rows[0];
      if (!state) return { ok: false as const, error: "not_found" as UpdateStepError };

      // V1 evidences 表已随 0183 退役；evidence_review 步骤改查 V2 证据快照。
      const evidence = await tx.query.evidenceSnapshotsV2.findFirst({
        where: and(
          eq(evidenceSnapshotsV2.id, evidenceId),
          eq(evidenceSnapshotsV2.workspaceId, workspaceId),
        ),
      });
      if (!evidence) {
        return { ok: false as const, error: "business_fact_missing" as UpdateStepError };
      }

      const storedSteps = state.steps as Record<string, boolean>;
      const wasEvidenceReviewed = storedSteps.evidence_review === true;
      const { steps, status } = await deriveOnboardingSnapshot(
        tx,
        workspaceId,
        userId,
        { ...storedSteps, evidence_review: true },
      );

      if (!onboardingStepsEqual(storedSteps, steps) || state.status !== status) {
        await tx
          .update(onboardingStates)
          .set({ steps, status, updatedAt: new Date() })
          .where(eq(onboardingStates.id, state.id));
      }

      // Record each transition only once. A repeated acknowledgement may still
      // complete onboarding if other authoritative facts changed meanwhile.
      if (!wasEvidenceReviewed) {
        recordFunnelEvent("onboarding_step");
      }
      if (state.status !== "completed" && status === "completed") {
        recordFunnelEvent("onboarding_completed");
      }

      return { ok: true as const };
    },
  );

  return result;
}

/** Ensure an onboarding state exists for a user. Creates if missing. */
export async function ensureOnboardingState(
  workspaceId: string,
  userId: string,
): Promise<OnboardingState> {
  const existing = await getOnboardingState(workspaceId, userId);
  if (existing) return existing;

  await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      await tx
        .insert(onboardingStates)
        .values({
          workspaceId,
          userId,
          version: "v1",
          steps: {},
          status: "pending",
        })
        .onConflictDoNothing();
    },
  );

  const created = await getOnboardingState(workspaceId, userId);
  if (!created) throw new Error("failed to create onboarding state");
  return created;
}
