/**
 * LOOP-01 / LOOP-02: Review attempt service (ADR-0004).
 *
 * Implements the start → submit/later → history lifecycle for review attempts.
 * Every completion path writes one auditable review_attempts row, updates the
 * review schedule, and conditionally emits an understanding event — all inside
 * a single transaction-local workspace context (SEC-01).
 *
 * Privacy: answer_text is only stored in the business table. It is never
 * logged, never included in telemetry, and never returned in history summaries
 * unless the caller explicitly requests the full attempt.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import {
  reviewAttempts,
  reviewSchedules,
  validationEvents,
  validationQuestions,
  evidences,
  evidenceOverrides,
  understandingEvents,
} from "../../db/schema/evidence.ts";
import { validationActionCommands } from "../../db/schema/index.ts";
import { ReviewStatus } from "@ailearn/shared";
import {
  REVIEW_ATTEMPT_LATER_REASON,
  type ReviewAttemptStartInput,
  type ReviewAttemptSubmitInput,
  type ReviewAttemptLaterInput,
  type ReviewAttemptHistoryPagination,
} from "@ailearn/shared";
import {
  effectiveAlignmentForUser,
  type EvidenceOverride,
} from "../../lib/evidence.ts";
import { calculateReviewSchedule } from "./scheduling-policy.ts";
import { reviewScheduleTargetsConsumableCardPredicate } from "./consumer-eligibility.ts";
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";
// OPS-01: Funnel 指标（ADR-0006 §2）
import { recordFunnelEvent } from "../../lib/metrics.ts";

// ─── Errors ──────────────────────────────────────────────────────────────

export type ReviewAttemptErrorCode =
  | "schedule_not_found"
  | "schedule_not_pending"
  | "attempt_not_found"
  | "attempt_not_started"
  | "attempt_already_completed"
  | "question_not_found"
  | "question_expired"
  | "card_not_found"
  | "key_point_not_found"
  | "idempotency_key_reused";

export class ReviewAttemptError extends Error {
  readonly code: ReviewAttemptErrorCode;
  readonly statusCode: number;

  constructor(code: ReviewAttemptErrorCode) {
    super(code);
    this.name = "ReviewAttemptError";
    this.code = code;
    this.statusCode = code === "schedule_not_found"
      || code === "attempt_not_found"
      || code === "card_not_found"
      || code === "key_point_not_found"
      || code === "question_not_found"
      ? 404
      : code === "schedule_not_pending"
          || code === "attempt_not_started"
          || code === "attempt_already_completed"
          || code === "idempotency_key_reused"
        ? 409
        : 410;
  }
}

// ─── Result types ────────────────────────────────────────────────────────

export interface ReviewAttemptStartResult {
  attemptId: string;
  reviewScheduleId: string;
  subjectType: string;
  subjectId: string;
  status: string;
  startedAt: Date;
  idempotent: boolean;
}

export interface ReviewAttemptSubmitResult {
  attemptId: string;
  status: string;
  outcome: string;
  scheduleReasonCode: string;
  understandingEffect: string;
  beforeIntervalDays: number;
  afterIntervalDays: number;
  nextReviewAt: Date;
  nextScheduleId: string;
  idempotent: boolean;
}

export interface ReviewAttemptLaterResult {
  attemptId: string;
  status: string;
  scheduleReasonCode: string;
  nextReviewAt: Date;
  intervalDays: number;
  idempotent: boolean;
}

export interface ReviewAttemptHistoryItem {
  id: string;
  reviewScheduleId: string;
  subjectType: string;
  subjectId: string;
  answerType: string | null;
  outcome: string | null;
  confidence: number | null;
  skipReason: string | null;
  scheduleBeforeIntervalDays: number | null;
  scheduleAfterIntervalDays: number | null;
  scheduleReasonCode: string | null;
  understandingEffect: string | null;
  nextReviewAt: Date | null;
  // V05-RISK-05: next schedule created by this attempt's submit
  nextScheduleId: string | null;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
}

export interface ReviewAttemptHistoryResult {
  items: ReviewAttemptHistoryItem[];
  nextCursor: string | null;
}

/**
 * V05-RISK-04: Result of querying the active (started) attempt for a schedule.
 * Returns null fields when no active attempt exists.
 */
export interface ReviewAttemptActiveResult {
  attemptId: string;
  reviewScheduleId: string;
  subjectType: string;
  subjectId: string;
  status: string;
  startedAt: Date;
  idempotencyKey: string;
}

/**
 * V05-RISK-04: Result of abandoning a started attempt.
 */
export interface ReviewAttemptAbandonResult {
  attemptId: string;
  status: string;
  abandonedAt: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

type ReviewAttemptRow = typeof reviewAttempts.$inferSelect;

function toStartResult(
  attempt: ReviewAttemptRow,
  idempotent: boolean,
): ReviewAttemptStartResult {
  return {
    attemptId: attempt.id,
    reviewScheduleId: attempt.reviewScheduleId,
    subjectType: attempt.subjectType,
    subjectId: attempt.subjectId,
    status: attempt.status,
    startedAt: attempt.startedAt,
    idempotent,
  };
}

function assertIdempotentAttemptMatches(
  attempt: ReviewAttemptRow,
  reviewScheduleId: string,
  expectedOperation: "start" | "later",
): void {
  const isLater = attempt.skipReason === REVIEW_ATTEMPT_LATER_REASON;
  if (
    attempt.reviewScheduleId !== reviewScheduleId
    || (expectedOperation === "later" ? !isLater : isLater)
  ) {
    throw new ReviewAttemptError("attempt_not_started");
  }
}

async function findAttemptByIdempotencyKey(
  transaction: ApiTransaction,
  workspaceId: string,
  userId: string,
  idempotencyKey: string,
): Promise<ReviewAttemptRow | undefined> {
  return transaction.query.reviewAttempts.findFirst({
    where: and(
      eq(reviewAttempts.workspaceId, workspaceId),
      eq(reviewAttempts.userId, userId),
      eq(reviewAttempts.idempotencyKey, idempotencyKey),
    ),
  });
}

/**
 * Check whether the target key point has at least one aligned (hard) evidence
 * for the given user, accounting for both legacy and user-level overrides.
 */
async function keyPointHasHardEvidence(
  transaction: ApiTransaction,
  keyPointId: string | null | undefined,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  if (!keyPointId) return false;
  const keyPointEvidences = await transaction.query.evidences.findMany({
    where: and(
      eq(evidences.keyPointId, keyPointId),
      eq(evidences.workspaceId, workspaceId),
    ),
  });
  if (keyPointEvidences.length === 0) return false;
  const userOverrideRows = await transaction.query.evidenceOverrides.findMany({
    where: and(
      eq(evidenceOverrides.workspaceId, workspaceId),
      eq(evidenceOverrides.userId, userId),
      inArray(
        evidenceOverrides.evidenceId,
        keyPointEvidences.map((evidence) => evidence.id),
      ),
    ),
    columns: {
      evidenceId: true,
      override: true,
    },
  });
  const userOverrideMap = new Map<string, EvidenceOverride>(
    userOverrideRows.map((row) => [row.evidenceId, row.override as EvidenceOverride]),
  );
  return keyPointEvidences.some(
    (evidence) =>
      effectiveAlignmentForUser(
        evidence.alignment,
        evidence.userOverride,
        userOverrideMap.get(evidence.id) ?? null,
      ) === "aligned",
  );
}

/**
 * Validate that a server-side question is active and belongs to the schedule's
 * card. Returns the question row or null.
 */
async function loadActiveQuestion(
  transaction: ApiTransaction,
  questionId: string | undefined,
  workspaceId: string,
  cardId: string | null,
): Promise<{ id: string; keyPointId: string | null; expiresAt: Date | null } | null> {
  if (!questionId || !cardId) return null;
  const question = await transaction.query.validationQuestions.findFirst({
    where: and(
      eq(validationQuestions.id, questionId),
      eq(validationQuestions.workspaceId, workspaceId),
      eq(validationQuestions.cardId, cardId),
    ),
  });
  if (!question) return null;
  if (question.expiresAt && question.expiresAt <= new Date()) return null;
  return {
    id: question.id,
    keyPointId: question.keyPointId ?? null,
    expiresAt: question.expiresAt,
  };
}

// ─── Start ───────────────────────────────────────────────────────────────

/**
 * Begin a review attempt. Creates a review_attempts row with status="started".
 * Idempotent: if an attempt with the same (workspace, user, idempotencyKey)
 * already exists, returns it without creating a duplicate.
 */
export async function startReviewAttempt(
  workspaceId: string,
  userId: string,
  input: ReviewAttemptStartInput,
): Promise<ReviewAttemptStartResult> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // Idempotent replay must succeed even if the original schedule has since
      // been completed. Validate the request fingerprint before touching it.
      const existing = await findAttemptByIdempotencyKey(
        tx,
        workspaceId,
        userId,
        input.idempotencyKey,
      );
      if (existing) {
        assertIdempotentAttemptMatches(existing, input.reviewScheduleId, "start");
        return toStartResult(existing, true);
      }

      // Lock the schedule so it cannot transition after validation but before
      // the started attempt is inserted.
      const [schedule] = await tx
        .select()
        .from(reviewSchedules)
        .where(
          and(
            eq(reviewSchedules.id, input.reviewScheduleId),
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.userId, userId),
            reviewScheduleTargetsConsumableCardPredicate(),
          ),
        )
        .for("update");
      if (!schedule) throw new ReviewAttemptError("schedule_not_found");
      if (schedule.status !== ReviewStatus.PENDING) {
        throw new ReviewAttemptError("schedule_not_pending");
      }

      // V05-RISK-04: Auto-abandon any existing 'started' attempt for the same
      // schedule before creating a new one. This prevents cross-device/cross-tab
      // duplicate started attempts. The partial unique index
      // review_attempts_active_started_unique_idx enforces this at the DB level,
      // but we proactively abandon to provide a clean transition rather than
      // relying on a constraint violation.
      const [existingStarted] = await tx
        .select({ id: reviewAttempts.id })
        .from(reviewAttempts)
        .where(
          and(
            eq(reviewAttempts.workspaceId, workspaceId),
            eq(reviewAttempts.userId, userId),
            eq(reviewAttempts.reviewScheduleId, schedule.id),
            eq(reviewAttempts.status, "started"),
          ),
        )
        .for("update");
      if (existingStarted) {
        await tx
          .update(reviewAttempts)
          .set({
            status: "abandoned",
            abandonedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(reviewAttempts.id, existingStarted.id),
              eq(reviewAttempts.status, "started"),
            ),
          );
      }

      const [insertedAttempt] = await tx
        .insert(reviewAttempts)
        .values({
          workspaceId,
          userId,
          reviewScheduleId: schedule.id,
          subjectType: schedule.subjectType,
          subjectId: schedule.subjectId,
          validationEventId: schedule.validationEventId,
          idempotencyKey: input.idempotencyKey,
          status: "started",
        })
        .onConflictDoNothing()
        .returning();

      if (insertedAttempt) return toStartResult(insertedAttempt, false);

      // A concurrent request with the same key won the unique-index race.
      const racedAttempt = await findAttemptByIdempotencyKey(
        tx,
        workspaceId,
        userId,
        input.idempotencyKey,
      );
      if (!racedAttempt) {
        throw new Error("review attempt idempotency conflict did not expose an existing row");
      }
      assertIdempotentAttemptMatches(racedAttempt, input.reviewScheduleId, "start");
      return toStartResult(racedAttempt, true);
    },
  );
}

// ─── Submit ──────────────────────────────────────────────────────────────

/**
 * Submit a review attempt with an answer and outcome. Computes the scheduling
 * decision via the ADR-0004 policy, updates the schedule, and conditionally
 * emits an understanding event — all in one transaction.
 *
 * Idempotent: if the attempt is already completed, returns the existing
 * scheduling decision without re-processing.
 */
export async function submitReviewAttempt(
  workspaceId: string,
  userId: string,
  input: ReviewAttemptSubmitInput,
): Promise<ReviewAttemptSubmitResult> {
  // BUG-05 修复：使用独立变量追踪幂等状态，不再将内部标记放入返回对象
  const { result, isIdempotent } = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // 1. Serialize every submission for this attempt.
      const [attempt] = await tx
        .select()
        .from(reviewAttempts)
        .where(
          and(
            eq(reviewAttempts.id, input.attemptId),
            eq(reviewAttempts.workspaceId, workspaceId),
            eq(reviewAttempts.userId, userId),
          ),
        )
        .for("update");
      if (!attempt) throw new ReviewAttemptError("attempt_not_found");
      if (attempt.reviewScheduleId !== input.reviewScheduleId) {
        throw new ReviewAttemptError("schedule_not_found");
      }
      if (attempt.idempotencyKey !== input.idempotencyKey) {
        throw new ReviewAttemptError("attempt_not_started");
      }

      // Lock the schedule identified by the server-side attempt binding, never
      // a different row supplied by the client.
      const [schedule] = await tx
        .select()
        .from(reviewSchedules)
        .where(
          and(
            eq(reviewSchedules.id, attempt.reviewScheduleId),
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.userId, userId),
            reviewScheduleTargetsConsumableCardPredicate(),
          ),
        )
        .for("update");
      if (!schedule) throw new ReviewAttemptError("schedule_not_found");

      // Idempotency: already completed.
      if (attempt.status === "completed") {
        const nextSchedule = await tx.query.reviewSchedules.findFirst({
          where: and(
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.userId, userId),
            eq(reviewSchedules.subjectType, attempt.subjectType),
            eq(reviewSchedules.subjectId, attempt.subjectId),
            eq(reviewSchedules.status, ReviewStatus.PENDING),
          ),
          orderBy: (s, { asc }) => [asc(s.nextReviewAt)],
        });
        return {
          result: {
            attemptId: attempt.id,
            status: attempt.status,
            outcome: attempt.outcome ?? input.outcome,
            scheduleReasonCode: attempt.scheduleReasonCode ?? "",
            understandingEffect: attempt.understandingEffect ?? "unchanged",
            beforeIntervalDays: attempt.scheduleBeforeIntervalDays ?? 0,
            afterIntervalDays: attempt.scheduleAfterIntervalDays ?? 0,
            nextReviewAt: attempt.nextReviewAt ?? nextSchedule?.nextReviewAt ?? new Date(),
            nextScheduleId: nextSchedule?.id ?? "",
            idempotent: true,
          },
          isIdempotent: true, // 幂等返回
        };
      }
      if (attempt.status !== "started") {
        throw new ReviewAttemptError("attempt_not_started");
      }
      if (schedule.status !== ReviewStatus.PENDING) {
        throw new ReviewAttemptError("schedule_not_pending");
      }

      // 3. Resolve the card and key point for evidence checking.
      let cardId: string | null = null;
      let keyPointId: string | null = schedule.keyPointId ?? null;

      if (schedule.subjectType === "card") {
        cardId = schedule.subjectId;
      } else if (schedule.subjectType === "validation" && schedule.validationEventId) {
        const ve = await tx.query.validationEvents.findFirst({
          where: and(
            eq(validationEvents.id, schedule.validationEventId),
            eq(validationEvents.workspaceId, workspaceId),
          ),
        });
        if (ve) {
          cardId = ve.cardId;
          keyPointId = ve.keyPointId ?? null;
        }
      }

      // 4. Load the validation question (if provided).
      const question = await loadActiveQuestion(
        tx,
        input.validationQuestionId,
        workspaceId,
        cardId,
      );
      const hasValidServerQuestion = question !== null;
      if (input.validationQuestionId && !question) {
        // The client explicitly referenced a question that is missing or expired.
        // We still record the attempt but the scheduling policy will block upgrade.
      }
      if (question?.keyPointId) {
        keyPointId = question.keyPointId;
      }

      // 5. Check hard evidence for the key point.
      const hasHardEvidence = await keyPointHasHardEvidence(
        tx,
        keyPointId,
        workspaceId,
        userId,
      );

      // 6. Compute the scheduling decision.
      // ReviewAttemptOutcome (shared) is a subset of ReviewOutcome (scheduling
      // policy) — both use the same canonical string values.
      const decision = calculateReviewSchedule({
        currentIntervalDays: schedule.intervalDays,
        outcome: input.outcome,
        hasValidServerQuestion,
        hasHardEvidence,
        now: new Date(),
      });

      // 7. Transactionally update attempt, schedule, and understanding event.
      const now = new Date();

      // 7a. Mark the current schedule as completed.
      const [completedSchedule] = await tx
        .update(reviewSchedules)
        .set({
          status: ReviewStatus.COMPLETED,
          lastReviewAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(reviewSchedules.id, schedule.id),
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.userId, userId),
            eq(reviewSchedules.status, ReviewStatus.PENDING),
          ),
        )
        .returning({ id: reviewSchedules.id });
      if (!completedSchedule) {
        throw new ReviewAttemptError("schedule_not_pending");
      }

      // 7b. Create the next pending schedule.
      const [nextSchedule] = await tx
        .insert(reviewSchedules)
        .values({
          workspaceId,
          userId,
          subjectType: schedule.subjectType,
          subjectId: schedule.subjectId,
          validationEventId: schedule.validationEventId,
          keyPointId,
          status: ReviewStatus.PENDING,
          nextReviewAt: decision.nextReviewAt,
          intervalDays: decision.afterIntervalDays,
        })
        .returning();

      // 7c. Update the attempt with the full result.
      const [completedAttempt] = await tx
        .update(reviewAttempts)
        .set({
          status: "completed",
          answerType: input.answerType,
          answerText: input.answer ?? null,
          outcome: input.outcome,
          confidence: input.confidence,
          validationQuestionId: question?.id ?? null,
          keyPointId,
          scheduleBeforeIntervalDays: decision.beforeIntervalDays,
          scheduleAfterIntervalDays: decision.afterIntervalDays,
          scheduleReasonCode: decision.reasonCode,
          understandingEffect: decision.understandingEffect,
          nextReviewAt: decision.nextReviewAt,
          // V05-RISK-05: persist the next schedule ID for source tracking.
          nextScheduleId: nextSchedule.id,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(reviewAttempts.id, attempt.id),
            eq(reviewAttempts.status, "started"),
          ),
        )
        .returning({ id: reviewAttempts.id });
      if (!completedAttempt) {
        throw new ReviewAttemptError("attempt_not_started");
      }

      // 7d. Emit understanding event only on upgrade.
      if (decision.understandingEffect === "upgrade") {
        await tx.insert(understandingEvents).values({
          workspaceId,
          userId,
          subjectType: schedule.subjectType,
          subjectId: schedule.subjectId,
          eventType: "reviewed",
          payload: {
            attemptId: attempt.id,
            reviewScheduleId: schedule.id,
            intervalDays: decision.afterIntervalDays,
            reasonCode: decision.reasonCode,
          },
        });
      }

      return {
        result: {
          attemptId: attempt.id,
          status: "completed",
          outcome: input.outcome,
          scheduleReasonCode: decision.reasonCode,
          understandingEffect: decision.understandingEffect,
          beforeIntervalDays: decision.beforeIntervalDays,
          afterIntervalDays: decision.afterIntervalDays,
          nextReviewAt: decision.nextReviewAt,
          nextScheduleId: nextSchedule.id,
          idempotent: false,
        },
        isIdempotent: false, // 非幂等返回
      };
    },
  );

  // OPS-01: Funnel 指标 — 复习尝试终态（非幂等提交）
  // BUG-05 修复：使用独立变量判断幂等状态，不再从返回对象中读取内部标记
  if (!isIdempotent) {
    recordFunnelEvent("review_attempt_terminal");
  }
  return result;
}

// ─── Later ───────────────────────────────────────────────────────────────

/**
 * v0.6 Action command idempotency helpers for the "later" action (计划 §6.4.1).
 *
 * The "later" action is migrated from the v0.5 review-attempt-level idempotency
 * (reviewAttempts.idempotencyKey) to the v0.6 unified action command ledger
 * (validation_action_commands). This ensures consistent idempotency semantics
 * across all v0.6 validation and review mutations.
 *
 * The existing reviewAttempts.idempotencyKey unique index is kept as a
 * secondary safety net for backward compatibility.
 */

function computeLaterRequestHash(input: ReviewAttemptLaterInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      action: "later",
      reviewScheduleId: input.reviewScheduleId,
      reason: input.reason,
    }))
    .digest("hex");
}

async function checkLaterActionCommand(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ exists: boolean; responseSnapshot?: Record<string, unknown> }> {
  const existing = await tx.query.validationActionCommands.findFirst({
    where: and(
      eq(validationActionCommands.workspaceId, workspaceId),
      eq(validationActionCommands.userId, userId),
      eq(validationActionCommands.action, "later"),
      eq(validationActionCommands.idempotencyKey, idempotencyKey),
    ),
  });

  if (existing) {
    // 计划 §6.4.1: 命中但 request hash 不同 → 409 idempotency_key_reused
    if (existing.requestHash !== requestHash) {
      throw new ReviewAttemptError("idempotency_key_reused");
    }
    return { exists: true, responseSnapshot: existing.responseSnapshot ?? undefined };
  }

  await tx.insert(validationActionCommands).values({
    workspaceId,
    userId,
    action: "later",
    idempotencyKey,
    requestHash,
    responseStatus: "pending",
  });

  return { exists: false };
}

async function completeLaterActionCommand(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  idempotencyKey: string,
  responseSnapshot: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(validationActionCommands)
    .set({
      responseStatus: "success",
      responseSnapshot,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(validationActionCommands.workspaceId, workspaceId),
        eq(validationActionCommands.userId, userId),
        eq(validationActionCommands.action, "later"),
        eq(validationActionCommands.idempotencyKey, idempotencyKey),
      ),
    );
}

/**
 * Defer a review with a "later" skip reason. Creates an attempt, applies the
 * short deferral, and keeps the interval unchanged. Does not emit an
 * understanding event.
 *
 * v0.6: Uses validation_action_commands for idempotency (计划 §6.4.1),
 * consistent with the validation session service pattern. The existing
 * reviewAttempts.idempotencyKey unique index remains as a secondary safety net.
 */
export async function laterReviewAttempt(
  workspaceId: string,
  userId: string,
  input: ReviewAttemptLaterInput,
): Promise<ReviewAttemptLaterResult> {
  const requestHash = computeLaterRequestHash(input);

  // BUG-05 修复：使用独立变量追踪幂等状态
  const { result, isIdempotent } = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // 1. Check action command ledger for idempotent replay (计划 §6.4.1).
      const actionCmd = await checkLaterActionCommand(
        tx,
        workspaceId,
        userId,
        input.idempotencyKey,
        requestHash,
      );
      if (actionCmd.exists && actionCmd.responseSnapshot) {
        // 幂等重放 — 返回缓存的响应
        return {
          result: {
            ...(actionCmd.responseSnapshot as unknown as Omit<ReviewAttemptLaterResult, "idempotent">),
            idempotent: true,
          },
          isIdempotent: true,
        };
      }

      // 2. Lock the schedule so different requests cannot race its deferral.
      const [schedule] = await tx
        .select()
        .from(reviewSchedules)
        .where(
          and(
            eq(reviewSchedules.id, input.reviewScheduleId),
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.userId, userId),
            reviewScheduleTargetsConsumableCardPredicate(),
          ),
        )
        .for("update");
      if (!schedule) throw new ReviewAttemptError("schedule_not_found");
      if (schedule.status !== ReviewStatus.PENDING) {
        throw new ReviewAttemptError("schedule_not_pending");
      }

      // 3. Compute the scheduling decision.
      const decision = calculateReviewSchedule({
        currentIntervalDays: schedule.intervalDays,
        outcome: "later",
        hasValidServerQuestion: true,
        hasHardEvidence: true,
        now: new Date(),
      });

      const now = new Date();

      // 4. Create the attempt (reviewAttempts.idempotencyKey remains as
      //    secondary safety net for backward compatibility).
      const [attempt] = await tx
        .insert(reviewAttempts)
        .values({
          workspaceId,
          userId,
          reviewScheduleId: schedule.id,
          subjectType: schedule.subjectType,
          subjectId: schedule.subjectId,
          validationEventId: schedule.validationEventId,
          skipReason: REVIEW_ATTEMPT_LATER_REASON,
          scheduleBeforeIntervalDays: decision.beforeIntervalDays,
          scheduleAfterIntervalDays: decision.afterIntervalDays,
          scheduleReasonCode: decision.reasonCode,
          understandingEffect: decision.understandingEffect,
          nextReviewAt: decision.nextReviewAt,
          idempotencyKey: input.idempotencyKey,
          status: "skipped",
          completedAt: now,
        })
        .onConflictDoNothing()
        .returning();

      if (!attempt) {
        // Secondary safety net triggered — the reviewAttempts unique index
        // prevented a duplicate. Fetch the existing attempt for replay.
        const racedAttempt = await findAttemptByIdempotencyKey(
          tx,
          workspaceId,
          userId,
          input.idempotencyKey,
        );
        if (!racedAttempt) {
          throw new Error("review attempt idempotency conflict did not expose an existing row");
        }
        assertIdempotentAttemptMatches(racedAttempt, input.reviewScheduleId, "later");
        const replayResult = {
          attemptId: racedAttempt.id,
          status: racedAttempt.status,
          scheduleReasonCode: racedAttempt.scheduleReasonCode ?? "later_short_deferral",
          nextReviewAt: racedAttempt.nextReviewAt ?? decision.nextReviewAt,
          intervalDays: racedAttempt.scheduleAfterIntervalDays ?? schedule.intervalDays,
          idempotent: true,
        };
        // Complete the action command with the replayed response.
        await completeLaterActionCommand(
          tx,
          workspaceId,
          userId,
          input.idempotencyKey,
          replayResult as unknown as Record<string, unknown>,
        );
        return {
          result: replayResult,
          isIdempotent: true,
        };
      }

      // 5. Update the schedule's next review time (keep interval, keep pending).
      const [updatedSchedule] = await tx
        .update(reviewSchedules)
        .set({
          nextReviewAt: decision.nextReviewAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reviewSchedules.id, schedule.id),
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.userId, userId),
            eq(reviewSchedules.status, ReviewStatus.PENDING),
          ),
        )
        .returning({ id: reviewSchedules.id });
      if (!updatedSchedule) {
        throw new ReviewAttemptError("schedule_not_pending");
      }

      const result = {
        attemptId: attempt.id,
        status: "skipped" as const,
        scheduleReasonCode: decision.reasonCode,
        nextReviewAt: decision.nextReviewAt,
        intervalDays: decision.afterIntervalDays,
        idempotent: false,
      };

      // 6. Complete the action command with the response snapshot.
      await completeLaterActionCommand(
        tx,
        workspaceId,
        userId,
        input.idempotencyKey,
        result as unknown as Record<string, unknown>,
      );

      return {
        result: {
          attemptId: attempt.id,
          status: "skipped",
          scheduleReasonCode: decision.reasonCode,
          nextReviewAt: decision.nextReviewAt,
          intervalDays: decision.afterIntervalDays,
          idempotent: false,
        },
        isIdempotent: false,
      };
    },
  );

  // OPS-01: Funnel 指标 — 复习尝试终态（跳过）
  // BUG-05 修复：使用独立变量判断幂等状态
  if (!isIdempotent) {
    recordFunnelEvent("review_attempt_terminal");
  }
  return result;
}

// ─── History ─────────────────────────────────────────────────────────────

/**
 * List review attempt history for the authenticated user. Uses cursor-based
 * pagination on (created_at, id) to avoid offset drift under concurrent
 * inserts.
 *
 * Privacy: answer_text is intentionally excluded from history summaries.
 */
export async function listReviewAttemptHistory(
  workspaceId: string,
  userId: string,
  pagination: ReviewAttemptHistoryPagination,
  filterScheduleId?: string,
): Promise<ReviewAttemptHistoryResult> {
  const limit = pagination.limit;
  const cursor = decodeCursor(pagination.cursor ?? undefined);

  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      let whereCondition = and(
        eq(reviewAttempts.workspaceId, workspaceId),
        eq(reviewAttempts.userId, userId),
      );

      if (filterScheduleId) {
        const schedule = await tx.query.reviewSchedules.findFirst({
          where: and(
            eq(reviewSchedules.id, filterScheduleId),
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.userId, userId),
          ),
          columns: {
            subjectType: true,
            subjectId: true,
          },
        });
        if (!schedule) throw new ReviewAttemptError("schedule_not_found");
        // A completed attempt belongs to the previous schedule row; the queue
        // exposes its newly-created pending successor. Subject-level filtering
        // keeps that history visible across schedule generations.
        whereCondition = and(
          whereCondition,
          eq(reviewAttempts.subjectType, schedule.subjectType),
          eq(reviewAttempts.subjectId, schedule.subjectId),
        );
      }

      if (cursor) {
        whereCondition = and(
          whereCondition,
          sql`(${reviewAttempts.createdAt}, ${reviewAttempts.id}) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const rows = await tx.query.reviewAttempts.findMany({
        where: whereCondition,
        orderBy: (a, { desc: d }) => [d(a.createdAt), d(a.id)],
        limit: limit + 1, // fetch one extra to determine if there's a next page
        columns: {
          id: true,
          reviewScheduleId: true,
          subjectType: true,
          subjectId: true,
          answerType: true,
          // answerText intentionally excluded from history summaries
          outcome: true,
          confidence: true,
          skipReason: true,
          scheduleBeforeIntervalDays: true,
          scheduleAfterIntervalDays: true,
          scheduleReasonCode: true,
          understandingEffect: true,
          nextReviewAt: true,
          nextScheduleId: true,
          status: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
        },
      });

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = pageRows[pageRows.length - 1];
      const nextCursor = hasMore && lastItem
        ? encodeCursor(lastItem.createdAt, lastItem.id)
        : null;
      const items = pageRows.map(({ createdAt: _createdAt, ...item }) => item);

      return { items, nextCursor };
    },
  );
}

// ─── Abandon (V05-RISK-04) ───────────────────────────────────────────────

/**
 * Abandon a started review attempt. The attempt transitions from "started" to
 * "abandoned" with an `abandonedAt` timestamp. This allows users to explicitly
 * cancel an in-progress review, and enables cross-device recovery by making the
 * schedule available for a new start.
 *
 * Idempotent: if the attempt is already abandoned, returns the existing state.
 * If the attempt is completed, returns an `attempt_already_completed` error.
 */
export async function abandonReviewAttempt(
  workspaceId: string,
  userId: string,
  attemptId: string,
): Promise<ReviewAttemptAbandonResult> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const [attempt] = await tx
        .select()
        .from(reviewAttempts)
        .where(
          and(
            eq(reviewAttempts.id, attemptId),
            eq(reviewAttempts.workspaceId, workspaceId),
            eq(reviewAttempts.userId, userId),
          ),
        )
        .for("update");
      if (!attempt) throw new ReviewAttemptError("attempt_not_found");

      if (attempt.status === "completed" || attempt.status === "skipped") {
        throw new ReviewAttemptError("attempt_already_completed");
      }
      if (attempt.status === "abandoned") {
        return {
          attemptId: attempt.id,
          status: "abandoned",
          abandonedAt: attempt.abandonedAt ?? attempt.updatedAt,
        };
      }
      // status === "started"
      const now = new Date();
      const [updated] = await tx
        .update(reviewAttempts)
        .set({
          status: "abandoned",
          abandonedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(reviewAttempts.id, attemptId),
            eq(reviewAttempts.status, "started"),
          ),
        )
        .returning({ id: reviewAttempts.id });
      if (!updated) {
        // Race: another request completed or abandoned it concurrently.
        throw new ReviewAttemptError("attempt_not_started");
      }
      return {
        attemptId: attempt.id,
        status: "abandoned",
        abandonedAt: now,
      };
    },
  );
}

// ─── Active Attempt Query (V05-RISK-04) ──────────────────────────────────

/**
 * Find the active (started) review attempt for a given schedule. Returns null
 * if no active attempt exists, enabling cross-device/cross-tab recovery: the
 * client can detect an in-progress attempt and either resume it or abandon it
 * before starting a new one.
 */
export async function getActiveReviewAttempt(
  workspaceId: string,
  userId: string,
  reviewScheduleId: string,
): Promise<ReviewAttemptActiveResult | null> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const attempt = await tx.query.reviewAttempts.findFirst({
        where: and(
          eq(reviewAttempts.workspaceId, workspaceId),
          eq(reviewAttempts.userId, userId),
          eq(reviewAttempts.reviewScheduleId, reviewScheduleId),
          eq(reviewAttempts.status, "started"),
        ),
      });
      if (!attempt) return null;
      return {
        attemptId: attempt.id,
        reviewScheduleId: attempt.reviewScheduleId,
        subjectType: attempt.subjectType,
        subjectId: attempt.subjectId,
        status: attempt.status,
        startedAt: attempt.startedAt,
        idempotencyKey: attempt.idempotencyKey,
      };
    },
  );
}
