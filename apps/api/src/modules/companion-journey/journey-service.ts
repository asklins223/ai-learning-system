/**
 * Journey V2 服务（文档 16 §10.1）。
 *
 * invitation（账号级 CAS）、journey 动作（workspace/RLS/CAS）、领域事件
 * 应用（JourneyReducer 唯一写 currentStep/refs/completionKind，
 * (journeyId, domainEventId) 幂等）。全部在 withWorkspaceTransaction 内。
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { DomainError } from "@ailearn/shared";
import {
  companionAccountInvitations,
  companionJourneyPendingEvents,
  companionJourneys,
} from "../../db/schema/companion-journey.ts";
import type {
  CompanionInvitationActionV2,
  CompanionInvitationV2,
  CompanionJourneyActionV2,
  CompanionJourneyBootstrapV2,
  CompanionJourneyV2,
} from "@ailearn/shared";
import {
  applyJourneyAction,
  applyJourneyEvent,
  classifyJourneyEvent,
  initialJourneyState,
  JourneyActionError,
  type JourneyReducerState,
} from "./journey-reducer.ts";

export interface JourneyScope {
  workspaceId: string;
  userId: string;
}

export class JourneyServiceError extends DomainError {
  constructor(code: string, message: string) {
    super({ name: "JourneyServiceError", code, message, statusCode: 500 });
  }
}

const TERMINAL = ["skipped", "completed"];

/**
 * 轻量 refs 结构比较：refs 是扁平对象（各字段为可选 string）。逐键比较 key 集合
 * 与值，避免在逐事件/逐行循环里对 next 与当前状态反复 JSON.stringify（O(refs) 且
 * 每次分配字符串）。语义与 JSON.stringify 严格相等一致（值仅 string|undefined）。
 */
function refsEqual(a: CompanionJourneyV2["refs"], b: CompanionJourneyV2["refs"]): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key as keyof typeof a] !== b[key as keyof typeof b]) return false;
  }
  return true;
}

// ─── 读取/映射 ──────────────────────────────────────────────────────────

function invitationToContract(row: typeof companionAccountInvitations.$inferSelect): CompanionInvitationV2 {
  return {
    version: 2,
    userId: row.userId,
    status: row.status as CompanionInvitationV2["status"],
    offeredAt: row.offeredAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    deferredUntil: row.deferredUntil?.toISOString() ?? null,
    replayRequestedAt: row.replayRequestedAt?.toISOString() ?? null,
    revision: row.revision,
  };
}

function journeyToContract(row: typeof companionJourneys.$inferSelect): CompanionJourneyV2 {
  return {
    version: 2,
    journeyId: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    assistantSessionId: row.assistantSessionId,
    status: row.status as CompanionJourneyV2["status"],
    branch: row.branch as CompanionJourneyV2["branch"],
    currentStep: (row.currentStep as CompanionJourneyV2["currentStep"]) ?? null,
    stepRevision: row.stepRevision,
    dismissedNarrationSteps: row.dismissedNarrationSteps as CompanionJourneyV2["dismissedNarrationSteps"],
    refs: row.refs as CompanionJourneyV2["refs"],
    lastDomainEventId: row.lastDomainEventId,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    pauseReason: (row.pauseReason as CompanionJourneyV2["pauseReason"]) ?? null,
    resumeTokenRef: row.resumeTokenRef,
    resumeExpiresAt: row.resumeExpiresAt?.toISOString() ?? null,
    completionKind: (row.completionKind as CompanionJourneyV2["completionKind"]) ?? null,
    error: row.error as CompanionJourneyV2["error"],
    revision: row.revision,
  };
}

function stateFromContract(journey: CompanionJourneyV2): JourneyReducerState {
  return {
    status: journey.status,
    branch: journey.branch,
    currentStep: journey.currentStep,
    stepRevision: journey.stepRevision,
    dismissedNarrationSteps: journey.dismissedNarrationSteps,
    refs: journey.refs,
    lastDomainEventId: journey.lastDomainEventId,
    completionKind: journey.completionKind,
    pausedAt: journey.pausedAt,
    pauseReason: journey.pauseReason,
    error: journey.error,
  };
}

async function loadInvitation(tx: ApiTransaction, userId: string) {
  const rows = await tx
    .select()
    .from(companionAccountInvitations)
    .where(eq(companionAccountInvitations.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

async function ensureInvitation(tx: ApiTransaction, userId: string, now: Date) {
  const existing = await loadInvitation(tx, userId);
  if (existing) return existing;
  // 文档 16 §8.1.1：注册完成 → 桌宠首邀卡出现即视为 invitation 已 offer。
  // 直接以 offered 起步，保证 start_journey/defer/skip 状态机可达。
  const inserted = await tx.insert(companionAccountInvitations).values({
    userId,
    status: "offered",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    offeredAt: now,
  }).returning();
  return inserted[0];
}

// ─── bootstrap ───────────────────────────────────────────────────────────

export async function bootstrapJourney(
  tx: ApiTransaction,
  scope: JourneyScope,
  now: Date = new Date(),
): Promise<CompanionJourneyBootstrapV2> {
  const invitation = await ensureInvitation(tx, scope.userId, now);
  // 存量兼容（2026-08-16）：早期 ensureInvitation 以 not_offered 起步且无
  // offer 转换路径，导致首邀卡可见但 start_journey 恒 409。此处惰性幂等
  // 升级：邀请卡在桌宠窗口出现即视同已 offer（与 create 时 offered 同语义）。
  if (invitation.status === "not_offered") {
    const upgraded = await tx
      .update(companionAccountInvitations)
      .set({
        status: "offered",
        offeredAt: invitation.offeredAt ?? now,
        revision: invitation.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(companionAccountInvitations.userId, scope.userId),
        eq(companionAccountInvitations.status, "not_offered"),
      ))
      .returning();
    if (upgraded[0]) {
      return bootstrapJourney(tx, scope, now);
    }
  }
  // 惰性 drain：先消费 pending 里程碑事件，再返回最新投影。
  const activeRows = await tx
    .select({ id: companionJourneys.id })
    .from(companionJourneys)
    .where(and(
      eq(companionJourneys.userId, scope.userId),
      eq(companionJourneys.workspaceId, scope.workspaceId),
      eq(companionJourneys.status, "active"),
    ))
    .limit(1);
  if (activeRows[0]) {
    await drainPendingJourneyEvents(tx, scope, activeRows[0].id, now);
  }
  const journeyRows = await tx
    .select()
    .from(companionJourneys)
    .where(and(
      eq(companionJourneys.userId, scope.userId),
      eq(companionJourneys.workspaceId, scope.workspaceId),
    ))
    .orderBy(companionJourneys.updatedAt)
    .limit(5);
  const current = journeyRows.find((row) => !TERMINAL.includes(row.status)) ?? null;
  // resumable：账号在其他 workspace 的可恢复旅程（跨 workspace 摘要）。
  const otherWorkspaceRows = current === null
    ? await tx
        .select()
        .from(companionJourneys)
        .where(and(
          eq(companionJourneys.userId, scope.userId),
          eq(companionJourneys.status, "paused"),
          ne(companionJourneys.workspaceId, scope.workspaceId),
        ))
        .limit(1)
    : [];
  return {
    invitation: invitationToContract(invitation),
    journey: current ? journeyToContract(current) : null,
    resumableJourney: otherWorkspaceRows[0] ? journeyToContract(otherWorkspaceRows[0]) : null,
  };
}

// ─── invitation actions（账号级 CAS）─────────────────────────────────────

export async function applyInvitationAction(
  tx: ApiTransaction,
  scope: JourneyScope,
  request: { expectedRevision: number; action: CompanionInvitationActionV2; idempotencyKey: string },
  now: Date = new Date(),
): Promise<CompanionInvitationV2> {
  void request.idempotencyKey;
  const invitation = await ensureInvitation(tx, scope.userId, now);
  if (invitation.revision !== request.expectedRevision) {
    throw new JourneyServiceError("stale_revision", "邀请状态已变化，请刷新后重试");
  }
  const action = request.action;
  let status = invitation.status;
  let decidedAt = invitation.decidedAt;
  let deferredUntil = invitation.deferredUntil;
  let replayRequestedAt = invitation.replayRequestedAt;
  let journeyCreated: CompanionJourneyV2 | null = null;

  switch (action.kind) {
    case "defer": {
      if (invitation.status !== "offered") {
        throw new JourneyServiceError("invalid_transition", "当前状态不允许稍后处理");
      }
      status = "deferred";
      deferredUntil = new Date(action.deferredUntil);
      decidedAt = now;
      break;
    }
    case "skip": {
      if (!["offered", "deferred"].includes(invitation.status)) {
        throw new JourneyServiceError("invalid_transition", "当前状态不允许跳过");
      }
      status = "skipped";
      decidedAt = now;
      break;
    }
    case "start_journey": {
      if (!["offered", "deferred"].includes(invitation.status)) {
        throw new JourneyServiceError("invalid_transition", "当前状态不允许开始旅程");
      }
      if (action.workspaceId !== scope.workspaceId) {
        throw new JourneyServiceError("workspace_mismatch", "旅程必须从当前工作区开始");
      }
      // §10.1：同一账号最多一个自动活跃旅程（非终态：active/paused/recoverable_error）。
      const activeRows = await tx
        .select({ id: companionJourneys.id })
        .from(companionJourneys)
        .where(and(
          eq(companionJourneys.userId, scope.userId),
          inArray(companionJourneys.status, ["active", "paused", "recoverable_error"]),
        ))
        .limit(1);
      if (activeRows.length > 0) {
        throw new JourneyServiceError("journey_conflict", "已有进行中的新手旅程");
      }
      status = "accepted";
      decidedAt = now;
      try {
        journeyCreated = await createJourneyRow(tx, scope, action.branch, null, now);
      } catch (err) {
        // 并发双 start：唯一索引兜底 → 409 而非 500。
        if (err && typeof err === "object" && "code" in err
          && (err as { code?: string }).code === "23505"
          && (err as { constraint?: string }).constraint === "companion_journeys_user_active_unique_idx") {
          throw new JourneyServiceError("journey_conflict", "已有进行中的新手旅程");
        }
        throw err;
      }
      break;
    }
    case "replay": {
      // replay 需要已决定过的 invitation；新 Journey revision/ID，parent 关联旧旅程。
      if (!["accepted", "skipped"].includes(invitation.status)) {
        throw new JourneyServiceError("invalid_transition", "当前状态不允许重播");
      }
      const activeRows = await tx
        .select({ id: companionJourneys.id })
        .from(companionJourneys)
        .where(and(
          eq(companionJourneys.userId, scope.userId),
          inArray(companionJourneys.status, ["active", "paused", "recoverable_error"]),
        ))
        .limit(1);
      if (activeRows.length > 0) {
        throw new JourneyServiceError("journey_conflict", "已有进行中的新手旅程");
      }
      replayRequestedAt = now;
      decidedAt = now;
      const parent = await tx
        .select({ id: companionJourneys.id })
        .from(companionJourneys)
        .where(and(eq(companionJourneys.userId, scope.userId), eq(companionJourneys.workspaceId, scope.workspaceId)))
        .orderBy(companionJourneys.createdAt)
        .limit(1);
      try {
        journeyCreated = await createJourneyRow(tx, scope, action.branch, parent[0]?.id ?? null, now);
      } catch (err) {
        if (err && typeof err === "object" && "code" in err
          && (err as { code?: string }).code === "23505"
          && (err as { constraint?: string }).constraint === "companion_journeys_user_active_unique_idx") {
          throw new JourneyServiceError("journey_conflict", "已有进行中的新手旅程");
        }
        throw err;
      }
      break;
    }
  }

  // N#7-9: UPDATE 增补 revision 谓词 + 校验 rowCount==1——并发下读 N 写 N+1 的两事务，
  // 后到者在 WHERE 上不匹配（其 Snapshot 的 revision 已被前者推进），rowCount=0 → CAS 失败。
  const updateResult = await tx.update(companionAccountInvitations)
    .set({
      status,
      decidedAt,
      deferredUntil,
      replayRequestedAt,
      revision: invitation.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(companionAccountInvitations.userId, scope.userId),
      eq(companionAccountInvitations.revision, invitation.revision),
    ))
    .returning();
  if (updateResult.length !== 1) {
    throw new JourneyServiceError("stale_revision", "邀请状态已变化，请刷新后重试");
  }

  const updated = await loadInvitation(tx, scope.userId);
  const contract = invitationToContract(updated!);
  // start_journey/replay 创建了旅程:响应携带 journey 摘要(客户端恢复引用)。
  if (journeyCreated) {
    contract.journey = {
      journeyId: journeyCreated.journeyId,
      branch: journeyCreated.branch,
      refs: {
        sandboxNamespaceId: journeyCreated.refs.sandboxNamespaceId,
        noteId: journeyCreated.refs.noteId,
        cardId: journeyCreated.refs.cardId,
        keyPointId: journeyCreated.refs.keyPointId,
      },
    };
  }
  return contract;
}

async function createJourneyRow(
  tx: ApiTransaction,
  scope: JourneyScope,
  branch: CompanionJourneyV2["branch"],
  parentJourneyId: string | null,
  now: Date,
): Promise<CompanionJourneyV2> {
  const state = initialJourneyState(branch);
  // §10.1：创建 onboarding AssistantSession（kind='journey'，历史页可区分）。
  const { randomUUID } = await import("node:crypto");
  const { companionConversations } = await import("../../db/schema/companion-conversations.ts");
  const sessionId = randomUUID();
  await tx.insert(companionConversations).values({
    id: sessionId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    kind: "journey",
    title: "新手旅程",
    titleSource: "placeholder",
    status: "active",
    nextMessageSeq: 1,
    nextEventSeq: 1,
    nextGeneration: 1,
    summaryVersion: 0,
  });
  // §16.4：sandbox 分支创建隔离教学空间（24h TTL）。
  const sandboxNamespaceId = branch === "sandbox_sample" ? randomUUID() : null;
  const journeyId = randomUUID();
  if (sandboxNamespaceId) {
    const { companionSandboxNamespaces } = await import("../../db/schema/companion-sandbox.ts");
    await tx.insert(companionSandboxNamespaces).values({
      id: sandboxNamespaceId,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      journeyId,
      status: "active",
      branch,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    });
  }
  const refs = sandboxNamespaceId
    ? { ...state.refs, sandboxNamespaceId }
    : state.refs;
  const inserted = await tx.insert(companionJourneys).values({
    id: journeyId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    assistantSessionId: sessionId,
    status: state.status,
    branch: state.branch,
    currentStep: state.currentStep,
    stepRevision: state.stepRevision,
    dismissedNarrationSteps: state.dismissedNarrationSteps as never,
    refs: refs as never,
    parentJourneyId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return journeyToContract(inserted[0]);
}

// ─── journey actions（workspace/RLS/CAS）─────────────────────────────────

export async function applyJourneyActionRequest(
  tx: ApiTransaction,
  scope: JourneyScope,
  journeyId: string,
  request: { expectedRevision: number; action: CompanionJourneyActionV2; idempotencyKey: string },
  now: Date = new Date(),
): Promise<CompanionJourneyV2> {
  void request.idempotencyKey;
  const rows = await tx
    .select()
    .from(companionJourneys)
    .where(and(
      eq(companionJourneys.id, journeyId),
      eq(companionJourneys.workspaceId, scope.workspaceId),
      eq(companionJourneys.userId, scope.userId),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw new JourneyServiceError("journey_not_found", "旅程不存在");
  if (row.revision !== request.expectedRevision) {
    throw new JourneyServiceError("stale_revision", "旅程状态已变化，请刷新后重试");
  }
  const journey = journeyToContract(row);
  // resume 凭证校验：journey 持有 resumeTokenRef 时必须匹配（P6 暂无签发
  // 路径 → resumeTokenRef 恒 null；非 null token 时拒绝，防止伪造凭证）。
  if (request.action.kind === "resume") {
    if (journey.resumeTokenRef !== null && request.action.resumeToken !== journey.resumeTokenRef) {
      throw new JourneyServiceError("invalid_resume_token", "恢复凭证无效");
    }
    if (journey.resumeTokenRef === null && request.action.resumeToken !== null) {
      throw new JourneyServiceError("invalid_resume_token", "恢复凭证无效");
    }
    if (journey.resumeExpiresAt !== null && new Date(journey.resumeExpiresAt).getTime() < now.getTime()) {
      throw new JourneyServiceError("resume_expired", "恢复凭证已过期，请重新开始");
    }
  }
  let next: JourneyReducerState;
  try {
    next = applyJourneyAction(stateFromContract(journey), request.action, now);
  } catch (err) {
    if (err instanceof JourneyActionError) {
      throw new JourneyServiceError(
        err.message === "branch_locked" ? "branch_locked" : "invalid_transition",
        err.message === "branch_locked" ? "已有分支专属对象，不能切换分支" : err.message,
      );
    }
    throw err;
  }
  // §16.4 联动：journey 进入终态（skipped/completed）时，其 sandbox namespace
  // 同步退出（拒绝完整性不依赖 24h TTL 兜底）。
  if (["skipped", "completed"].includes(next.status) && journey.branch === "sandbox_sample" && journey.refs.sandboxNamespaceId) {
    const { companionSandboxNamespaces } = await import("../../db/schema/companion-sandbox.ts");
    await tx.update(companionSandboxNamespaces)
      .set({ status: "exited", exitedAt: now, updatedAt: now })
      .where(and(
        eq(companionSandboxNamespaces.id, journey.refs.sandboxNamespaceId),
        eq(companionSandboxNamespaces.workspaceId, scope.workspaceId),
        eq(companionSandboxNamespaces.userId, scope.userId),
      ));
  }
  // N#7-9: UPDATE 增补 revision 谓词（CAS 守卫）+ 校验 rowCount==1，防并发 lost update。
  const updateResult = await tx.update(companionJourneys)
    .set({
      status: next.status,
      branch: next.branch,
      currentStep: next.currentStep,
      stepRevision: next.stepRevision,
      dismissedNarrationSteps: next.dismissedNarrationSteps as never,
      refs: next.refs as never,
      lastDomainEventId: next.lastDomainEventId,
      pausedAt: next.pausedAt ? new Date(next.pausedAt) : null,
      pauseReason: next.pauseReason,
      completionKind: next.completionKind,
      error: next.error as never,
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(companionJourneys.id, row.id),
      eq(companionJourneys.revision, row.revision),
    ))
    .returning();
  if (updateResult.length !== 1) {
    throw new JourneyServiceError("stale_revision", "旅程状态已变化，请刷新后重试");
  }
  const updated = updateResult[0];
  return journeyToContract(updated);
}

// ─── 领域事件应用（JourneyReducer 唯一写 currentStep/refs/completionKind）─

export async function applyJourneyDomainEvent(
  tx: ApiTransaction,
  scope: JourneyScope,
  input: { journeyId: string; domainEventId: string; eventType: string; payload: Record<string, unknown> },
  now: Date = new Date(),
): Promise<CompanionJourneyV2 | null> {
  // 先锁 journey 行（防 TOCTOU：applied 检查与推进都必须在锁内）。
  const journeyRows = await tx
    .select()
    .from(companionJourneys)
    .where(and(
      eq(companionJourneys.id, input.journeyId),
      eq(companionJourneys.workspaceId, scope.workspaceId),
      eq(companionJourneys.userId, scope.userId),
    ))
    .limit(1)
    // 并发事件推进：行锁防 lost update（CAS 由锁内 revision 校验保证）。
    .for("update")
    .execute();
  const row = journeyRows[0];
  if (!row) return null;

  // (journeyId, domainEventId) 幂等：已应用 → 返回当前状态（锁内检查）。
  const appliedRows = await tx
    .select({ id: companionJourneyPendingEvents.id })
    .from(companionJourneyPendingEvents)
    .where(and(
      eq(companionJourneyPendingEvents.journeyId, input.journeyId),
      eq(companionJourneyPendingEvents.domainEventId, input.domainEventId),
      eq(companionJourneyPendingEvents.status, "applied"),
    ))
    .limit(1);
  if (appliedRows.length > 0) {
    return journeyToContract(row);
  }
  // 归属校验通过后再写 pending（避免留下引用他人旅程的事件行）。
  await tx.insert(companionJourneyPendingEvents).values({
    journeyId: input.journeyId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    domainEventId: input.domainEventId,
    eventType: input.eventType,
    payload: input.payload as never,
    status: "pending",
    createdAt: now,
  }).onConflictDoNothing();
  const journey = journeyToContract(row);
  const next = applyJourneyEvent(stateFromContract(journey), {
    domainEventId: input.domainEventId,
    eventType: input.eventType,
    payload: input.payload,
  });
  const changed = next.stepRevision !== journey.stepRevision
    || next.status !== journey.status
    || !refsEqual(next.refs, journey.refs)
    || next.completionKind !== journey.completionKind;
  if (changed) {
    await tx.update(companionJourneys)
      .set({
        status: next.status,
        currentStep: next.currentStep,
        stepRevision: next.stepRevision,
        refs: next.refs as never,
        lastDomainEventId: next.lastDomainEventId,
        completionKind: next.completionKind,
        error: next.error as never,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(companionJourneys.id, row.id));
    await tx.update(companionJourneyPendingEvents)
      .set({ status: "applied", appliedAt: now })
      .where(and(
        eq(companionJourneyPendingEvents.journeyId, input.journeyId),
        eq(companionJourneyPendingEvents.domainEventId, input.domainEventId),
      ));
  }
  // 未推进：区分 noop（未知事件，标 superseded 终止重试）与乱序（保持
  // pending，由后续 drain 在前置事件到达后重试——避免永久 pending 写放大）。
  if (!changed) {
    const { classifyJourneyEvent } = await import("./journey-reducer.ts");
    const command = classifyJourneyEvent({
      domainEventId: input.domainEventId,
      eventType: input.eventType,
      payload: input.payload,
    });
    if (command.kind === "noop") {
      await tx.update(companionJourneyPendingEvents)
        .set({ status: "superseded", appliedAt: now })
        .where(and(
          eq(companionJourneyPendingEvents.journeyId, input.journeyId),
          eq(companionJourneyPendingEvents.domainEventId, input.domainEventId),
        ));
    }
  }
  const updated = await tx
    .select()
    .from(companionJourneys)
    .where(eq(companionJourneys.id, row.id))
    .limit(1);
  return journeyToContract(updated[0]);
}

/** 当前 workspace 的 active journey（领域事件挂钩用）。 */
export async function findActiveJourney(
  tx: ApiTransaction,
  scope: JourneyScope,
): Promise<CompanionJourneyV2 | null> {
  const rows = await tx
    .select()
    .from(companionJourneys)
    .where(and(
      eq(companionJourneys.userId, scope.userId),
      eq(companionJourneys.workspaceId, scope.workspaceId),
      eq(companionJourneys.status, "active"),
    ))
    .limit(1);
  return rows[0] ? journeyToContract(rows[0]) : null;
}

/** 惰性 drain：按到达序消费 pending 事件（乱序保持 pending 等前置）。
 *
 * 批量实现：单次 SELECT FOR UPDATE 锁定 journey 行，然后在内存中按序套用
 * reducer，最后以少量批量 UPDATE（journey 一次、pending 按状态分两批）落库，
 * 避免对每个事件重复 3-5 次 DB 往返。语义与逐事件 applyJourneyDomainEvent
 * 一致：每次状态推进 revision +1，未推进的 noop 事件标 superseded，乱序保持
 * pending。 */
export async function drainPendingJourneyEvents(
  tx: ApiTransaction,
  scope: JourneyScope,
  journeyId: string,
  now: Date = new Date(),
): Promise<void> {
  const rows = await tx
    .select()
    .from(companionJourneyPendingEvents)
    .where(and(
      eq(companionJourneyPendingEvents.journeyId, journeyId),
      eq(companionJourneyPendingEvents.workspaceId, scope.workspaceId),
      eq(companionJourneyPendingEvents.userId, scope.userId),
      eq(companionJourneyPendingEvents.status, "pending"),
    ))
    .orderBy(companionJourneyPendingEvents.createdAt)
    .limit(50);
  if (rows.length === 0) return;

  // 锁一次 journey 行（防并发 lost update，原则同 applyJourneyDomainEvent）。
  const journeyRows = await tx
    .select()
    .from(companionJourneys)
    .where(and(
      eq(companionJourneys.id, journeyId),
      eq(companionJourneys.workspaceId, scope.workspaceId),
      eq(companionJourneys.userId, scope.userId),
    ))
    .limit(1)
    .for("update")
    .execute();
  const row = journeyRows[0];
  if (!row) return;

  let state = stateFromContract(journeyToContract(row));
  const appliedIds: string[] = [];
  const supersededIds: string[] = [];

  for (const event of rows) {
    const input = {
      domainEventId: event.domainEventId,
      eventType: event.eventType,
      payload: event.payload as Record<string, unknown>,
    };
    const next = applyJourneyEvent(state, input);
    const changed = next.stepRevision !== state.stepRevision
      || next.status !== state.status
      || !refsEqual(next.refs, state.refs)
      || next.completionKind !== state.completionKind;
    if (changed) {
      state = next;
      appliedIds.push(event.id);
    } else {
      const command = classifyJourneyEvent(input);
      if (command.kind === "noop") {
        supersededIds.push(event.id);
      }
      // 乱序：保持 pending，等待前置事件到达后再次 drain。
    }
  }

  if (appliedIds.length > 0) {
    await tx.update(companionJourneys)
      .set({
        status: state.status,
        currentStep: state.currentStep,
        stepRevision: state.stepRevision,
        dismissedNarrationSteps: state.dismissedNarrationSteps as never,
        refs: state.refs as never,
        lastDomainEventId: state.lastDomainEventId,
        pausedAt: state.pausedAt ? new Date(state.pausedAt) : null,
        pauseReason: state.pauseReason,
        completionKind: state.completionKind,
        error: state.error as never,
        // 逐事件推进时每个 changed event 使 revision +1（CAS 语义保持一致）。
        revision: row.revision + appliedIds.length,
        updatedAt: now,
      })
      .where(eq(companionJourneys.id, row.id));
  }
  if (appliedIds.length > 0) {
    await tx.update(companionJourneyPendingEvents)
      .set({ status: "applied", appliedAt: now })
      .where(and(
        eq(companionJourneyPendingEvents.journeyId, journeyId),
        inArray(companionJourneyPendingEvents.id, appliedIds),
      ));
  }
  if (supersededIds.length > 0) {
    await tx.update(companionJourneyPendingEvents)
      .set({ status: "superseded", appliedAt: now })
      .where(and(
        eq(companionJourneyPendingEvents.journeyId, journeyId),
        inArray(companionJourneyPendingEvents.id, supersededIds),
      ));
  }
}
