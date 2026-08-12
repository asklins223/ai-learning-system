/**
 * v0.6 Validation Session Service (计划 §8.2, §8.6, §8.7)
 *
 * Implements the trusted mastery closed-loop API:
 * - start: create submission, bind or generate question
 * - get: return sanitized state (no rubric/expectedConcept leak)
 * - draft: save draft with revision CAS
 * - revealSource: record assistance exposure (pre-submit)
 * - revealResult: record post-result exposure, return feedback
 * - submit: lock answer, create evaluation job
 * - unable: finalize with missing assessments (no AI call)
 * - retryQuestion / retryEvaluation: create new lineage jobs
 * - abandon: terminal state, no schedule mutation
 *
 * All mutations use withWorkspaceTransaction (SEC-01).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import {
  validationSubmissions,
  validationSubmissionJobs,
  validationActionCommands,
  validationAssistanceExposures,
  validationQuestionRubricItems,
  validationPointAssessments,
  validationQuestions,
  validationEvents,
  validationQualitySignals,
  reviewSchedules,
  reviewAttempts,
  understandingEvents,
  aiArtifacts,
  evidences,
  schedulingShadowDecisions,
  jobs,
} from "../../db/schema/index.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { createJob } from "../job/service.ts";
import {
  SubmissionStatus,
  SubmissionContext,
  AssistanceLevel,
  AssessmentSource,
  ExposureKind,
  JobType,
  ReviewStatus,
  ArtifactType,
  ArtifactStatus,
  TerminalReason,
  RubricVerdict,
  QuestionStatus,
  JobStatus,
} from "@ailearn/shared";
import {
  reduceRubric,
  toReviewOutcome,
  calculateSchedule,
  computeExposureFingerprint,
  computeSourceFingerprint,
  computeUnassistedEligibleAfter,
  isUnassistedEligible,
  RUBRIC_REDUCER_VERSION,
  computeFSRSShadowDecision,
  isFSRSShadowEnabled,
  type FSRSShadowInput,
  type RubricItemInput,
} from "@ailearn/shared";
import {
  effectiveAlignmentForUser,
  getUserOverrideMap,
} from "../../lib/evidence.ts";
import type {
  StartSessionInput,
  DraftAnswerInput,
  RevealSourceInput,
  RevealResultInput,
  SubmitAnswerInput,
  UnableInput,
  RetryQuestionInput,
  RetryEvaluationInput,
  AbandonInput,
  QualitySignalInput,
} from "./session-schema.ts";
import { recordFunnelEvent } from "../../lib/metrics.ts";
import { activeLearningCardConsumerPredicate } from "../card/consumer-eligibility.ts";

// ─── Constants ───────────────────────────────────────────────────────────

const ASSISTANCE_COOLDOWN_HOURS = 24;
const QUESTION_PROMPT_VERSION = "question-v1";

// ─── Error types ─────────────────────────────────────────────────────────

export type SessionErrorCode =
  | "not_found"
  | "card_not_found"
  | "no_key_point"
  | "no_hard_evidence"
  | "stale_card"
  | "assistance_cooldown"
  | "unsafe_question"
  | "question_expired"
  | "invalid_state_transition"
  | "draft_conflict"
  | "question_not_ready"
  | "already_completed"
  | "not_retryable"
  | "not_abandonable"
  | "idempotency_key_reused"
  | "schedule_not_found"
  | "schedule_not_pending"
  | "not_yet_due"
  | "submission_locked";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  readonly statusCode: number;

  constructor(code: SessionErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SessionError";
    this.code = code;
    this.statusCode =
      code === "not_found" || code === "card_not_found"
        ? 404
        : code === "no_hard_evidence" || code === "assistance_cooldown" || code === "unsafe_question" || code === "question_expired"
          ? 422
          : code === "no_key_point" || code === "stale_card"
            ? 409
            : 409;
  }
}

async function requireConsumableLearningCard(
  transaction: ApiTransaction,
  cardId: string,
  workspaceId: string,
): Promise<typeof learningCards.$inferSelect> {
  const card = await transaction.query.learningCards.findFirst({
    where: and(
      eq(learningCards.id, cardId),
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
    ),
  });
  if (!card) throw new SessionError("card_not_found");
  return card;
}

// ─── Result types ────────────────────────────────────────────────────────

export interface StartSessionResult {
  status:
    | "ready"
    | "question_preparing"
    | "answer_saved"
    | "evaluation_pending"
    | "question_retryable"
    | "evaluation_retryable"
    | "blocked";
  submissionId?: string;
  question?: SanitizedQuestion;
  jobId?: string;
  reason?: string;
  unassistedEligibleAt?: string;
}

export interface SanitizedQuestion {
  questionId: string;
  questionType: string;
  question: string;
  keyPointOrdinal?: number;
}

export interface GetSessionResult {
  submissionId: string;
  status: string;
  context: string;
  keyPointId: string | null;
  question?: SanitizedQuestion;
  draftRevision: number;
  draftAnswer?: string;
  selfConfidence?: number | null;
  assistanceLevel: string;
  sourceAvailable: boolean;
  resultAvailable: boolean;
  jobId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DraftResult {
  revision: number;
  answerHash: string;
}

export interface SubmitResult {
  status: "evaluation_pending";
  jobId: string;
}

export interface UnableResult {
  status: "completed";
  resultAvailable: true;
}

export interface RetryResult {
  status: "question_preparing" | "evaluation_pending";
  jobId: string;
}

export interface AbandonResult {
  status: "abandoned";
}

export interface RevealSourceResult {
  assistanceLevel: string;
  sourceAvailable: boolean;
}

export interface RevealResultResult {
  outcome: string;
  feedback: unknown;
  rubricItems: Array<{
    criterion: string;
    verdict: string;
    rationale?: string;
  }>;
  userAnswer: string;
  evidenceRefs: Array<{
    quoteText: string;
    alignment: string;
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function hashAnswer(answer: string): string {
  return createHash("sha256").update(answer, "utf8").digest("hex");
}

/**
 * 计划 §6.4.1：request hash 必须是服务端摘要。
 * 旧实现直接存 JSON.stringify(input)，导致用户答案原文进入
 * validation_action_commands.request_hash；改为 SHA-256 摘要。
 */
function hashRequest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/**
 * 需要"先提交 stale 转移、再向调用方抛错"的场景使用的哨兵返回值。
 * 直接在事务回调里 throw 会让 withWorkspaceTransaction 回滚 stale 写入
 * （提交前的 422/409 反而把终态转移吞掉），因此事务回调返回该哨兵、
 * 提交后再在事务外抛出 SessionError。
 */
const STALE_TX_ERROR = Symbol("staleTxError");
interface StaleTxError {
  readonly kind: typeof STALE_TX_ERROR;
  readonly code: SessionErrorCode;
  readonly detail?: string;
}
function staleTxError(code: SessionErrorCode, detail?: string): StaleTxError {
  return { kind: STALE_TX_ERROR, code, detail };
}
function isStaleTxError(value: unknown): value is StaleTxError {
  return typeof value === "object" && value !== null
    && (value as { kind?: unknown }).kind === STALE_TX_ERROR;
}

/**
 * 计划 §8.7 锁序第 2 层：learning-unit guard。
 * 在读取/更新 assistance exposure 聚合行之前对 (workspace,user,key_point)
 * 取事务级 advisory lock，把 reveal / submit / unable / start 的跨 submission
 * 竞争串行化（同一 key point 的 initial_validation 与 review 是两行不同的
 * submission，仅靠行锁无法互斥）。所有调用方必须在获取 submission/question
 * 行锁之前先取该锁，保持全局锁序一致。
 */
async function acquireLearningUnitLock(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  keyPointId: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`learning-unit:${workspaceId}:${userId}:${keyPointId}`}, 0)
    )
  `);
}

/**
 * 将 submission 置为 STALE 终态，并同事务把 review 上下文中仍处于
 * started 的 review attempt 置为 abandoned（计划 §8.3/§8.7：stale/blocked
 * 终态必须同事务处理 attempt，input schedule 保持 pending）。
 */
async function markSubmissionStaleTx(
  tx: ApiTransaction,
  submission: typeof validationSubmissions.$inferSelect,
  workspaceId: string,
  userId: string,
  failureStage: string,
  failureCode: string,
  now: Date,
): Promise<void> {
  await tx.update(validationSubmissions).set({
    status: SubmissionStatus.STALE,
    failureStage,
    failureCode,
    terminalReason: TerminalReason.SOURCE_STALE,
    updatedAt: now,
  }).where(eq(validationSubmissions.id, submission.id));

  if (submission.context === SubmissionContext.REVIEW && submission.reviewAttemptId) {
    await tx.update(reviewAttempts).set({
      status: "abandoned",
      abandonedAt: now,
      updatedAt: now,
    }).where(and(
      eq(reviewAttempts.id, submission.reviewAttemptId),
      eq(reviewAttempts.workspaceId, workspaceId),
      eq(reviewAttempts.userId, userId),
      eq(reviewAttempts.status, "started"),
    ));
  }
}

/**
 * 计划 §6.2/§7.5：question 到期必须在 start/resume/submit/result-write 事务内
 * 原子 active → expired。释放 (ws,user,kp,fingerprint) 的 active 唯一槽位，
 * 否则同 fingerprint 的新题目永远无法落库（唯一索引冲突 → 永久 question_retryable）。
 */
async function expireQuestionTx(
  tx: ApiTransaction,
  questionId: string,
  workspaceId: string,
): Promise<void> {
  await tx.update(validationQuestions).set({
    status: QuestionStatus.EXPIRED,
  }).where(and(
    eq(validationQuestions.id, questionId),
    eq(validationQuestions.workspaceId, workspaceId),
    eq(validationQuestions.status, QuestionStatus.ACTIVE),
  ));
}

/**
 * Resume 路径的到期 fail-closed 检查（计划 §6.2 start/resume 原子 active→expired）。
 * 返回 true 表示绑定题目已到期：题目已置 expired、submission 已置 stale，
 * 调用方应继续走"新建 submission"路径。
 */
async function expireResumedSubmissionIfDue(
  tx: ApiTransaction,
  submission: typeof validationSubmissions.$inferSelect,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  if (!submission.questionId) return false;
  const question = await tx.query.validationQuestions.findFirst({
    where: and(
      eq(validationQuestions.id, submission.questionId),
      eq(validationQuestions.workspaceId, workspaceId),
    ),
  });
  if (!question) return false;
  const now = new Date();
  const expiredByTime = question.expiresAt !== null && question.expiresAt <= now;
  const inactive = question.status !== QuestionStatus.ACTIVE;
  if (!expiredByTime && !inactive) return false;
  if (expiredByTime) {
    await expireQuestionTx(tx, question.id, workspaceId);
  }
  await markSubmissionStaleTx(
    tx, submission, workspaceId, userId,
    "resume",
    expiredByTime ? "question_expired" : "question_not_active",
    now,
  );
  return true;
}

export interface TerminalJobRecoveryProjection {
  status: "question_retryable" | "evaluation_retryable";
  failureStage: "question_generation" | "evaluation";
  failureCode: string;
}

/**
 * A queue terminal state must never leave a validation session polling
 * forever. Worker handlers normally project their own retryable/terminal
 * state before the queue row becomes terminal; this is the crash/reaper and
 * historical-data recovery path when that projection did not happen.
 */
export function terminalJobRecoveryProjection(
  submissionStatus: string,
  jobStatus: string | "missing",
): TerminalJobRecoveryProjection | null {
  const terminalJobStatuses = new Set<string>([
    JobStatus.SUCCEEDED,
    JobStatus.FAILED,
    JobStatus.DEAD,
    "missing",
  ]);
  if (!terminalJobStatuses.has(jobStatus)) return null;

  if (submissionStatus === SubmissionStatus.QUESTION_PREPARING) {
    return {
      status: SubmissionStatus.QUESTION_RETRYABLE,
      failureStage: "question_generation",
      failureCode: `question_job_${jobStatus}_without_projection`,
    };
  }
  if (submissionStatus === SubmissionStatus.EVALUATION_PENDING) {
    return {
      status: SubmissionStatus.EVALUATION_RETRYABLE,
      failureStage: "evaluation",
      failureCode: `evaluation_job_${jobStatus}_without_projection`,
    };
  }
  return null;
}

async function reconcilePendingJobProjection(
  tx: ApiTransaction,
  submission: typeof validationSubmissions.$inferSelect,
): Promise<typeof validationSubmissions.$inferSelect> {
  const jobId = submission.status === SubmissionStatus.QUESTION_PREPARING
    ? submission.currentGenerationJobId
    : submission.status === SubmissionStatus.EVALUATION_PENDING
      ? submission.currentEvaluationJobId
      : null;
  if (!jobId) return submission;

  const job = await tx.query.jobs.findFirst({
    where: and(
      eq(jobs.id, jobId),
      eq(jobs.workspaceId, submission.workspaceId),
    ),
  });
  const projection = terminalJobRecoveryProjection(
    submission.status,
    job?.status ?? "missing",
  );
  if (!projection) return submission;

  const now = new Date();
  const currentJobColumn = submission.status === SubmissionStatus.QUESTION_PREPARING
    ? validationSubmissions.currentGenerationJobId
    : validationSubmissions.currentEvaluationJobId;
  const [recovered] = await tx
    .update(validationSubmissions)
    .set({
      status: projection.status,
      failureStage: projection.failureStage,
      failureCode: projection.failureCode,
      updatedAt: now,
    })
    .where(and(
      eq(validationSubmissions.id, submission.id),
      eq(validationSubmissions.workspaceId, submission.workspaceId),
      eq(validationSubmissions.userId, submission.userId),
      eq(validationSubmissions.status, submission.status),
      eq(currentJobColumn, jobId),
    ))
    .returning();

  if (recovered) return recovered;

  // A worker or retry may have advanced the row after the original read. The
  // conditional UPDATE waits for that writer and re-checks its predicate, so
  // a miss must return the fresh state rather than a synthetic retryable view.
  const current = await tx.query.validationSubmissions.findFirst({
    where: and(
      eq(validationSubmissions.id, submission.id),
      eq(validationSubmissions.workspaceId, submission.workspaceId),
      eq(validationSubmissions.userId, submission.userId),
    ),
  });
  if (!current) throw new SessionError("not_found");
  return current;
}

async function keyPointHasHardEvidence(
  tx: ApiTransaction,
  keyPointId: string,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const keyPointEvidences = await tx.query.evidences.findMany({
    where: and(
      eq(evidences.keyPointId, keyPointId),
      eq(evidences.workspaceId, workspaceId),
    ),
  });
  const userOverrideMap = await getUserOverrideMap(
    userId,
    keyPointEvidences.map((evidence) => evidence.id),
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
 * Compute the exposure fingerprint from real database data (计划 §6.7).
 * The exposure fingerprint covers workspace/user/key point, normalized claim/quote,
 * note content hash, and effective hard evidence — but explicitly excludes
 * question, prompt, model, rubric/policy version, and pure metadata.
 */
/**
 * Compute the source fingerprint from real database data (计划 §6.7).
 * The source fingerprint covers workspace/user/card/key point, claim/quote,
 * note version + content hash, hard evidence, and question/rubric policy versions.
 * Used to verify that an existing question's fingerprint still matches the current source.
 */
/**
 * SEC-19 安全注释：此函数查询包含用户笔记内容（claim、quote、noteBlocks 等）。
 * 风险：这些查询从数据库加载用户笔记内容到内存，用于计算 source fingerprint。
 *   如果服务器日志级别设置过高（如 debug），这些内容可能被记录到日志中。
 * 缓解措施：
 *   1. 此函数仅在 validation session 事务中调用，结果用于 fingerprint 比对
 *   2. fingerprint 本身是哈希值，不包含明文内容
 *   3. 查询已通过 workspaceId 过滤，确保租户隔离
 *   4. 不应将中间变量（claim、quote、noteBlocks）记录到日志中
 */
async function computeSourceFingerprintFromDb(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  keyPointId: string,
  cardId: string,
): Promise<string> {
  // Load key point for claim and quote
  const kp = await tx.query.cardKeyPoints.findFirst({
    where: and(
      eq(cardKeyPoints.id, keyPointId),
      eq(cardKeyPoints.workspaceId, workspaceId),
    ),
  });
  const claim = kp?.claim ?? "";
  const quote = kp?.quoteText ?? "";

  // Load card for noteVersionId
  const card = await tx.query.learningCards.findFirst({
    where: and(
      eq(learningCards.id, cardId),
      eq(learningCards.workspaceId, workspaceId),
    ),
  });
  const noteVersionId = card?.noteVersionId ?? "";

  // Load evidence for this key point
  const keyPointEvidences = await tx.query.evidences.findMany({
    where: and(
      eq(evidences.keyPointId, keyPointId),
      eq(evidences.workspaceId, workspaceId),
    ),
  });
  const userOverrideMap = await getUserOverrideMap(
    userId,
    keyPointEvidences.map((evidence) => evidence.id),
  );

  const evidenceParts = keyPointEvidences
    .map((evidence) => {
      const effective = effectiveAlignmentForUser(
        evidence.alignment,
        evidence.userOverride,
        userOverrideMap.get(evidence.id) ?? null,
      );
      return { evidence, effective };
    })
    .filter(({ effective }) => effective === "aligned")
    .map(({ evidence, effective }) => ({
      evidenceId: evidence.id,
      blockId: evidence.blockId,
      quoteHash: createHash("sha256").update(evidence.quoteText, "utf8").digest("hex"),
      alignment: effective as string,
      override: (userOverrideMap.get(evidence.id) ?? evidence.userOverride) ?? null,
    }));

  return computeSourceFingerprint({
    workspaceId,
    userId,
    cardId,
    keyPointId,
    claim,
    quote,
    noteVersionId,
    noteContentHash: noteVersionId,
    evidence: evidenceParts,
    questionPromptVersion: QUESTION_PROMPT_VERSION,
    rubricPolicyVersion: RUBRIC_REDUCER_VERSION,
  });
}

async function computeExposureFingerprintFromDb(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  keyPointId: string,
  cardId: string,
): Promise<string> {
  // Load key point for claim and quote
  const kp = await tx.query.cardKeyPoints.findFirst({
    where: and(
      eq(cardKeyPoints.id, keyPointId),
      eq(cardKeyPoints.workspaceId, workspaceId),
    ),
  });
  const claim = kp?.claim ?? "";
  const quote = kp?.quoteText ?? "";

  // Load card for noteVersionId (used as noteContentHash proxy)
  const card = await tx.query.learningCards.findFirst({
    where: and(
      eq(learningCards.id, cardId),
      eq(learningCards.workspaceId, workspaceId),
    ),
  });
  const noteContentHash = card?.noteVersionId ?? "";

  // Load evidence for this key point
  const keyPointEvidences = await tx.query.evidences.findMany({
    where: and(
      eq(evidences.keyPointId, keyPointId),
      eq(evidences.workspaceId, workspaceId),
    ),
  });
  const userOverrideMap = await getUserOverrideMap(
    userId,
    keyPointEvidences.map((evidence) => evidence.id),
  );

  const evidenceParts = keyPointEvidences
    .map((evidence) => {
      const effective = effectiveAlignmentForUser(
        evidence.alignment,
        evidence.userOverride,
        userOverrideMap.get(evidence.id) ?? null,
      );
      return { evidence, effective };
    })
    .filter(({ effective }) => effective === "aligned")
    .map(({ evidence, effective }) => ({
      evidenceId: evidence.id,
      blockId: evidence.blockId,
      quoteHash: createHash("sha256").update(evidence.quoteText, "utf8").digest("hex"),
      alignment: effective as string,
      override: (userOverrideMap.get(evidence.id) ?? evidence.userOverride) ?? null,
    }));

  return computeExposureFingerprint({
    workspaceId,
    userId,
    keyPointId,
    claim,
    quote,
    noteContentHash,
    evidence: evidenceParts,
  });
}

/**
 * Load and sanitize a question for client consumption.
 * Strips rubric items, expectedConcept, evidence refs, and fingerprints.
 */
async function loadSanitizedQuestion(
  tx: ApiTransaction,
  questionId: string,
  workspaceId: string,
): Promise<SanitizedQuestion | null> {
  const question = await tx.query.validationQuestions.findFirst({
    where: and(
      eq(validationQuestions.id, questionId),
      eq(validationQuestions.workspaceId, workspaceId),
    ),
  });
  if (!question) return null;

  let keyPointOrdinal: number | undefined;
  if (question.keyPointId) {
    const kp = await tx.query.cardKeyPoints.findFirst({
      where: and(
        eq(cardKeyPoints.id, question.keyPointId),
        eq(cardKeyPoints.workspaceId, workspaceId),
      ),
    });
    keyPointOrdinal = kp?.ordinal ?? undefined;
  }

  return {
    questionId: question.id,
    questionType: question.questionType,
    question: question.question,
    keyPointOrdinal,
  };
}

/**
 * Check and record an action command for idempotency.
 * Returns the existing response if the action was already processed.
 */
async function checkActionCommand(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  action: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ exists: boolean; responseSnapshot?: Record<string, unknown> }> {
  const existing = await tx.query.validationActionCommands.findFirst({
    where: and(
      eq(validationActionCommands.workspaceId, workspaceId),
      eq(validationActionCommands.userId, userId),
      eq(validationActionCommands.action, action),
      eq(validationActionCommands.idempotencyKey, idempotencyKey),
    ),
  });
  if (existing) {
    // 计划 §6.4.1: 命中但 request hash 不同 → 409 idempotency_key_reused
    if (existing.requestHash !== requestHash) {
      throw new SessionError("idempotency_key_reused");
    }
    return { exists: true, responseSnapshot: existing.responseSnapshot ?? undefined };
  }

  // 并发首用同一 idempotency key：两个事务同时 miss findFirst 时，后到的
  // insert 会撞唯一索引。onConflictDoNothing + 重读，把裸 23505（HTTP 500）
  // 变成正常的回放/冲突语义。
  const [inserted] = await tx.insert(validationActionCommands).values({
    workspaceId,
    userId,
    action,
    idempotencyKey,
    requestHash,
    responseStatus: "pending",
  }).onConflictDoNothing().returning({ id: validationActionCommands.id });

  if (!inserted) {
    const raced = await tx.query.validationActionCommands.findFirst({
      where: and(
        eq(validationActionCommands.workspaceId, workspaceId),
        eq(validationActionCommands.userId, userId),
        eq(validationActionCommands.action, action),
        eq(validationActionCommands.idempotencyKey, idempotencyKey),
      ),
    });
    if (!raced) {
      // 冲突后行又消失——按 key 重用处理，fail closed
      throw new SessionError("idempotency_key_reused");
    }
    if (raced.requestHash !== requestHash) {
      throw new SessionError("idempotency_key_reused");
    }
    return { exists: true, responseSnapshot: raced.responseSnapshot ?? undefined };
  }

  return { exists: false };
}

async function completeActionCommand(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  action: string,
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
        eq(validationActionCommands.action, action),
        eq(validationActionCommands.idempotencyKey, idempotencyKey),
      ),
    );
}

/**
 * Complete an action command outside a transaction (after job creation).
 * Used when the response includes a jobId that's only available after commit.
 */
async function completeActionCommandDb(
  workspaceId: string,
  userId: string,
  action: string,
  idempotencyKey: string,
  responseSnapshot: Record<string, unknown>,
): Promise<void> {
  // SEC-01/RLS：validation_action_commands 是 user-bound RLS 表。裸 db 句柄
  // 没有 app.workspace_id/app.user_id GUC，在生产 RLS 角色下 UPDATE 会静默
  // 命中 0 行（命令永远停留在 pending）。必须走 withWorkspaceTransaction。
  await withWorkspaceTransaction(
    { workspaceId, userId },
    (tx) => completeActionCommand(tx, workspaceId, userId, action, idempotencyKey, responseSnapshot),
  );
}

// ─── 1. Start ────────────────────────────────────────────────────────────

export async function startValidationSession(
  cardId: string,
  workspaceId: string,
  userId: string,
  input: StartSessionInput,
): Promise<StartSessionResult> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // Idempotency check
      const requestHash = hashRequest({ cardId, ...input });
      const actionCheck = await checkActionCommand(
        tx, workspaceId, userId, "start", input.idempotencyKey, requestHash,
      );
      if (actionCheck.exists && actionCheck.responseSnapshot) {
        return actionCheck.responseSnapshot as unknown as StartSessionResult;
      }

      // Validate card
      await requireConsumableLearningCard(
        tx,
        cardId,
        workspaceId,
      );

      // ── Determine context and resolve review linkage (计划 §8.3) ──
      const submissionContext = input.context === "review"
        ? SubmissionContext.REVIEW
        : SubmissionContext.INITIAL_VALIDATION;
      let reviewAttemptId: string | undefined;
      let inputScheduleId: string | undefined;
      let resolvedReviewKeyPointId: string | undefined;
      let reviewScheduleForAttempt: typeof reviewSchedules.$inferSelect | undefined;

      if (submissionContext === SubmissionContext.REVIEW) {
        // v0.6 review context (计划 §8.3):
        // - Lock the input schedule FOR UPDATE and validate PENDING
        // - Resolve keyPointId from the schedule
        // - Check effective start: max(next_review_at, unassisted_eligible_after)
        // - Create or resume a review attempt
        if (!input.reviewScheduleId) throw new SessionError("invalid_state_transition", "reviewScheduleId required for review context");

        const [schedule] = await tx
          .select()
          .from(reviewSchedules)
          .where(and(
            eq(reviewSchedules.id, input.reviewScheduleId),
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.userId, userId),
          ))
          .for("update");
        if (!schedule) throw new SessionError("schedule_not_found");
        if (schedule.status !== ReviewStatus.PENDING) throw new SessionError("schedule_not_pending");

        // Resolve the review target from the locked server-side schedule. Older
        // schedules predate review_schedules.key_point_id, so their canonical
        // key point must be recovered from the polymorphic subject. Never trust
        // the client-provided keyPointId for review sessions.
        let scheduleCardId: string | undefined;
        let scheduleKeyPointId = schedule.keyPointId ?? undefined;

        if (schedule.subjectType === "card") {
          scheduleCardId = schedule.subjectId;
        } else if (schedule.subjectType === "validation") {
          const validationEventId = schedule.validationEventId ?? schedule.subjectId;
          const validationEvent = await tx.query.validationEvents.findFirst({
            where: and(
              eq(validationEvents.id, validationEventId),
              eq(validationEvents.workspaceId, workspaceId),
              eq(validationEvents.userId, userId),
            ),
          });
          if (!validationEvent) throw new SessionError("schedule_not_found");
          scheduleCardId = validationEvent.cardId;
          scheduleKeyPointId ??= validationEvent.keyPointId ?? undefined;
        } else if (schedule.subjectType === "key_point") {
          const subjectKeyPointId = schedule.keyPointId ?? schedule.subjectId;
          const subjectKeyPoint = await tx.query.cardKeyPoints.findFirst({
            where: and(
              eq(cardKeyPoints.id, subjectKeyPointId),
              eq(cardKeyPoints.workspaceId, workspaceId),
            ),
          });
          if (!subjectKeyPoint) throw new SessionError("no_key_point");
          scheduleCardId = subjectKeyPoint.cardId;
          scheduleKeyPointId = subjectKeyPoint.id;
        } else {
          throw new SessionError("schedule_not_found");
        }

        if (scheduleCardId !== cardId) {
          throw new SessionError("schedule_not_found");
        }

        if (scheduleKeyPointId) {
          const scheduledKeyPoint = await tx.query.cardKeyPoints.findFirst({
            where: and(
              eq(cardKeyPoints.id, scheduleKeyPointId),
              eq(cardKeyPoints.cardId, cardId),
              eq(cardKeyPoints.workspaceId, workspaceId),
            ),
          });
          if (!scheduledKeyPoint) throw new SessionError("no_key_point");
          resolvedReviewKeyPointId = scheduledKeyPoint.id;
        } else {
          // Legacy card-level schedules used the first key point throughout the
          // queue. Preserve that deterministic compatibility rule here too.
          const firstKeyPoint = await tx.query.cardKeyPoints.findFirst({
            where: and(
              eq(cardKeyPoints.cardId, cardId),
              eq(cardKeyPoints.workspaceId, workspaceId),
            ),
            orderBy: (keyPoint, { asc }) => [asc(keyPoint.ordinal), asc(keyPoint.id)],
          });
          resolvedReviewKeyPointId = firstKeyPoint?.id;
        }

        if (!resolvedReviewKeyPointId) throw new SessionError("no_key_point");
        inputScheduleId = schedule.id;
        reviewScheduleForAttempt = schedule;

        // Check effective start: max(next_review_at, unassisted_eligible_after)
        // (计划 §10.6: "Review effective start 使用 max(next_review_at, unassisted_eligible_after)")
        // The assistance cooldown check below handles unassisted_eligible_after.
        // Here we check next_review_at — if the schedule is not yet due, block.
        const now = new Date();
        if (schedule.nextReviewAt > now) {
          const result: StartSessionResult = {
            status: "blocked",
            reason: "not_yet_due",
            unassistedEligibleAt: schedule.nextReviewAt.toISOString(),
          };
          await completeActionCommand(tx, workspaceId, userId, "start", input.idempotencyKey, result as unknown as Record<string, unknown>);
          return result;
        }

      }

      // Determine keyPoint
      let keyPointId = submissionContext === SubmissionContext.REVIEW
        ? resolvedReviewKeyPointId
        : input.keyPointId;
      if (!keyPointId) {
        const first = await tx.query.cardKeyPoints.findFirst({
          where: and(
            eq(cardKeyPoints.cardId, cardId),
            eq(cardKeyPoints.workspaceId, workspaceId),
          ),
          orderBy: sql`${cardKeyPoints.ordinal} ASC`,
        });
        keyPointId = first?.id;
      } else {
        const kp = await tx.query.cardKeyPoints.findFirst({
          where: and(
            eq(cardKeyPoints.id, keyPointId),
            eq(cardKeyPoints.cardId, cardId),
            eq(cardKeyPoints.workspaceId, workspaceId),
          ),
        });
        if (!kp) throw new SessionError("no_key_point");
      }

      if (!keyPointId) throw new SessionError("no_key_point");

      // 计划 §8.7 第 2 层锁：learning-unit guard。先于 exposure/cooldown 读取
      // 和一切 submission 行锁，串行化同一 (ws,user,kp) 上的并发 start/reveal/
      // submit/unable（跨 submission 的 assistance 竞争）。
      await acquireLearningUnitLock(tx, workspaceId, userId, keyPointId);

      // Check hard evidence
      const hasHardEvidence = await keyPointHasHardEvidence(tx, keyPointId, workspaceId, userId);
      if (!hasHardEvidence) throw new SessionError("no_hard_evidence");

      // Check assistance cooldown
      const exposure = await tx.query.validationAssistanceExposures.findFirst({
        where: and(
          eq(validationAssistanceExposures.workspaceId, workspaceId),
          eq(validationAssistanceExposures.userId, userId),
          eq(validationAssistanceExposures.keyPointId, keyPointId),
        ),
        orderBy: sql`${validationAssistanceExposures.unassistedEligibleAfter} DESC`,
      });
      if (exposure && !isUnassistedEligible(exposure.unassistedEligibleAfter, new Date())) {
        // 计划 §6.4.2: 冷却期未结束时返回 blocked: assistance_cooldown，
        // 不创建正式 submission/attempt
        const result: StartSessionResult = {
          status: "blocked",
          reason: "assistance_cooldown",
          unassistedEligibleAt: exposure.unassistedEligibleAfter.toISOString(),
        };
        await completeActionCommand(tx, workspaceId, userId, "start", input.idempotencyKey, result as unknown as Record<string, unknown>);
        return result;
      }

      // A blocked review must not leave a started attempt behind. Create or
      // resume the attempt only after both hard-evidence and effective-start
      // checks have passed.
      if (submissionContext === SubmissionContext.REVIEW) {
        const schedule = reviewScheduleForAttempt;
        if (!schedule || !resolvedReviewKeyPointId) {
          throw new SessionError("schedule_not_found");
        }

        const [existingStarted] = await tx
          .select({ id: reviewAttempts.id })
          .from(reviewAttempts)
          .where(and(
            eq(reviewAttempts.workspaceId, workspaceId),
            eq(reviewAttempts.userId, userId),
            eq(reviewAttempts.reviewScheduleId, schedule.id),
            eq(reviewAttempts.status, "started"),
          ))
          .for("update");
        if (existingStarted) {
          reviewAttemptId = existingStarted.id;
        } else {
          const [newAttempt] = await tx
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
              keyPointId: resolvedReviewKeyPointId,
            })
            .onConflictDoNothing()
            .returning();
          if (newAttempt) {
            reviewAttemptId = newAttempt.id;
          } else {
            const [raced] = await tx
              .select({ id: reviewAttempts.id })
              .from(reviewAttempts)
              .where(and(
                eq(reviewAttempts.workspaceId, workspaceId),
                eq(reviewAttempts.userId, userId),
                eq(reviewAttempts.reviewScheduleId, schedule.id),
                eq(reviewAttempts.status, "started"),
              ));
            if (!raced) throw new SessionError("invalid_state_transition", "review attempt race without existing row");
            reviewAttemptId = raced.id;
          }
        }
      }

      // Check for existing non-terminal submission for this key point + context
      // (计划 §6.4: 同一 (workspace,user,key_point,context) 最多一个未终态 submission)
      // If found, resume it instead of creating a duplicate.
      const nonTerminalStatuses = [
        SubmissionStatus.QUESTION_PREPARING,
        SubmissionStatus.READY,
        SubmissionStatus.ANSWER_SAVED,
        SubmissionStatus.EVALUATION_PENDING,
        SubmissionStatus.QUESTION_RETRYABLE,
        SubmissionStatus.EVALUATION_RETRYABLE,
      ];
      const existingActive = await tx.query.validationSubmissions.findFirst({
        where: and(
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
          eq(validationSubmissions.keyPointId, keyPointId),
          eq(validationSubmissions.context, submissionContext),
          inArray(validationSubmissions.status, nonTerminalStatuses),
        ),
      });
      if (existingActive) {
        // Resume 前 fail-closed 校验绑定题目的有效期（计划 §6.2：resume 必须
        // 校验 expires_at；旧实现 resume 不检查，会把过期题目当 ready 返回）。
        // 过期时：同事务 active→expired + submission→stale（含 attempt 处理），
        // 然后落到下方"新建 submission"路径，保证学习连续性。
        const expiredOut = await expireResumedSubmissionIfDue(
          tx, existingActive, workspaceId, userId,
        );
        if (!expiredOut) {
          // Resume existing session (计划 §9.2: refresh/跨设备恢复同一 submission)
          const result = await formatStartResult(existingActive, tx, workspaceId);
          await completeActionCommand(tx, workspaceId, userId, "start", input.idempotencyKey, result as unknown as Record<string, unknown>);
          return result;
        }
        // fell through: expired → create a fresh submission below
      }

      // Create submission
      const [submission] = await tx
        .insert(validationSubmissions)
        .values({
          workspaceId,
          userId,
          cardId,
          keyPointId,
          context: submissionContext,
          status: SubmissionStatus.QUESTION_PREPARING,
          startIdempotencyKey: input.idempotencyKey,
          reviewAttemptId,
          inputScheduleId,
        })
        .onConflictDoNothing()
        .returning();

      if (!submission) {
        // Idempotent: submission already exists with this startIdempotencyKey
        const existing = await tx.query.validationSubmissions.findFirst({
          where: and(
            eq(validationSubmissions.workspaceId, workspaceId),
            eq(validationSubmissions.userId, userId),
            eq(validationSubmissions.startIdempotencyKey, input.idempotencyKey),
          ),
        });
        if (!existing) throw new SessionError("invalid_state_transition", "idempotency conflict without existing row");
        return formatStartResult(existing, tx, workspaceId);
      }

      // Try to find an existing active question for this keyPoint + fingerprint
      const existingQuestion = await tx.query.validationQuestions.findFirst({
        where: and(
          eq(validationQuestions.workspaceId, workspaceId),
          eq(validationQuestions.userId, userId),
          eq(validationQuestions.keyPointId, keyPointId),
          eq(validationQuestions.status, QuestionStatus.ACTIVE),
        ),
        orderBy: sql`${validationQuestions.createdAt} DESC`,
      });

      if (existingQuestion && existingQuestion.expiresAt && existingQuestion.expiresAt <= new Date()) {
        // 计划 §6.2：到期在 start 事务内原子 active→expired。不翻转就直接生成
        // 新题目的话，worker 会撞 (ws,user,kp,fingerprint) WHERE status='active'
        // 唯一索引 → 该 key point 永久 question_retryable。
        await expireQuestionTx(tx, existingQuestion.id, workspaceId);
      }

      if (existingQuestion && (!existingQuestion.expiresAt || existingQuestion.expiresAt > new Date())) {
        // Verify fingerprint matches current source (计划 §6.2: "新可信读取必须同时校验
        // user、status=active、expires_at > transaction_timestamp()、fingerprint 和 hard evidence")
        const currentFingerprint = await computeSourceFingerprintFromDb(
          tx, workspaceId, userId, keyPointId, cardId,
        );
        if (existingQuestion.sourceFingerprint !== currentFingerprint) {
          // Source has changed since question was created — don't reuse, generate new.
          // 同事务把旧 active 题目按 §7.5 标为 stale（保留 fingerprint 槽位卫生，
          // 避免旧题目无限期占用 active 状态）。
          await tx.update(validationQuestions).set({
            status: QuestionStatus.STALE,
            staleReason: "source_fingerprint_changed",
          }).where(and(
            eq(validationQuestions.id, existingQuestion.id),
            eq(validationQuestions.workspaceId, workspaceId),
            eq(validationQuestions.status, QuestionStatus.ACTIVE),
          ));
          // (fall through to question_preparing path below)
        } else {
        // Bind existing question
        await tx
          .update(validationSubmissions)
          .set({
            questionId: existingQuestion.id,
            status: SubmissionStatus.READY,
            sourceFingerprint: existingQuestion.sourceFingerprint,
            updatedAt: new Date(),
          })
          .where(eq(validationSubmissions.id, submission.id));

        const sanitized = await loadSanitizedQuestion(tx, existingQuestion.id, workspaceId);
        const result: StartSessionResult = {
          status: "ready",
          submissionId: submission.id,
          question: sanitized ?? undefined,
        };
        await completeActionCommand(tx, workspaceId, userId, "start", input.idempotencyKey, result as unknown as Record<string, unknown>);
        return result;
        }
      }

      // Need to generate a new question — create job outside transaction
      // We'll return question_preparing and create the job after commit
      const result: StartSessionResult = {
        status: "question_preparing",
        submissionId: submission.id,
      };
      // Action command will be completed after job creation (outside transaction)
      // so that responseSnapshot includes the correct jobId
      return result;
    },
  ).then(async (result) => {
    // After transaction commits, create generation job if needed.
    // SEC-01/RLS：post-commit 阶段一律走 withWorkspaceTransaction——裸 db 在
    // 生产 RLS 角色下读不到行（findFirst 返回 undefined）、UPDATE 静默 0 行、
    // INSERT 直接 42501，导致 submission 永久停在 question_preparing。
    if (result.status === "question_preparing" && result.submissionId) {
      const submissionId = result.submissionId;
      // Query submission to get resolved keyPointId (may differ from input.keyPointId)
      const sub = await withWorkspaceTransaction(
        { workspaceId, userId },
        (tx) => tx.query.validationSubmissions.findFirst({
          where: and(
            eq(validationSubmissions.id, submissionId),
            eq(validationSubmissions.workspaceId, workspaceId),
            eq(validationSubmissions.userId, userId),
          ),
        }),
      );

      // Guard against duplicate job creation on retry after partial failure
      if (sub?.currentGenerationJobId) {
        result.jobId = sub.currentGenerationJobId;
        await completeActionCommandDb(
          workspaceId, userId, "start", input.idempotencyKey,
          result as unknown as Record<string, unknown>,
        );
        return result;
      }

      const job = await createJob({
        type: JobType.GENERATE_VALIDATION_QUESTION,
        workspaceId,
        requestedBy: userId,
        payload: {
          cardId,
          keyPointId: sub?.keyPointId,
          submissionId,
          submissionIds: [submissionId],
          userId,
        },
        dedupe: {
          payloadField: "submissionId",
          value: submissionId,
        },
      });

      // Link job to submission + lineage + action command，同一 GUC 事务内完成
      await withWorkspaceTransaction(
        { workspaceId, userId },
        async (tx) => {
          await tx
            .update(validationSubmissions)
            .set({
              currentGenerationJobId: job.id,
              updatedAt: new Date(),
            })
            .where(and(
              eq(validationSubmissions.id, submissionId),
              eq(validationSubmissions.workspaceId, workspaceId),
              eq(validationSubmissions.userId, userId),
            ));

          await tx.insert(validationSubmissionJobs).values({
            submissionId,
            phase: "question_generation",
            phaseOrdinal: 1,
            jobId: job.id,
          }).onConflictDoNothing();

          result.jobId = job.id;

          await completeActionCommand(
            tx, workspaceId, userId, "start", input.idempotencyKey,
            result as unknown as Record<string, unknown>,
          );
        },
      );
    }
    return result;
  });
}

async function formatStartResult(
  submission: typeof validationSubmissions.$inferSelect,
  tx: ApiTransaction,
  workspaceId: string,
): Promise<StartSessionResult> {
    submission = await reconcilePendingJobProjection(tx, submission);
    const resumableStatuses = new Set<StartSessionResult["status"]>([
      "ready",
      "question_preparing",
      "answer_saved",
      "evaluation_pending",
      "question_retryable",
      "evaluation_retryable",
    ]);
    const status = submission.status as string;
    if (!resumableStatuses.has(status as StartSessionResult["status"])) {
      throw new SessionError("invalid_state_transition");
    }
    const resumableStatus = status as StartSessionResult["status"];

    if (submission.questionId) {
      const sanitized = await loadSanitizedQuestion(tx, submission.questionId, workspaceId);
      if (status === SubmissionStatus.READY) {
        return {
          status: "ready",
          submissionId: submission.id,
          question: sanitized ?? undefined,
        };
      }
      return {
        status: resumableStatus,
        submissionId: submission.id,
      };
    }
    return {
      status: resumableStatus,
      submissionId: submission.id,
    };
}

// ─── 2. Get ──────────────────────────────────────────────────────────────

export async function getValidationSession(
  submissionId: string,
  workspaceId: string,
  userId: string,
): Promise<GetSessionResult | null> {
  const session = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const [lockedSubmission] = await tx
        .select()
        .from(validationSubmissions)
        .where(and(
          eq(validationSubmissions.id, submissionId),
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
        ))
        .for("update");
      if (!lockedSubmission) return null;
      const submission = await reconcilePendingJobProjection(tx, lockedSubmission);
      let question: SanitizedQuestion | undefined;
      if (!submission.questionId) return { submission, question };

      // Keep the complete session read under the transaction-local workspace
      // and user GUCs. A direct db query here is invisible to FORCE RLS roles.
      const q = await tx.query.validationQuestions.findFirst({
        where: and(
          eq(validationQuestions.id, submission.questionId),
          eq(validationQuestions.workspaceId, workspaceId),
        ),
      });
      if (
        !q
        || q.status !== QuestionStatus.ACTIVE
        || (q.expiresAt !== null && q.expiresAt <= new Date())
      ) {
        // 计划 §6.2 fail-closed：过期/非 active 题目不得作为可作答题面返回
        // （GET 是只读路径，原子 active→expired 转移由 start/resume/submit/
        //  result-write 事务负责）。
        return { submission, question };
      }

      let keyPointOrdinal: number | undefined;
      if (q.keyPointId) {
        const kp = await tx.query.cardKeyPoints.findFirst({
          where: and(
            eq(cardKeyPoints.id, q.keyPointId),
            eq(cardKeyPoints.workspaceId, workspaceId),
          ),
        });
        keyPointOrdinal = kp?.ordinal ?? undefined;
      }
      question = {
        questionId: q.id,
        questionType: q.questionType,
        question: q.question,
        keyPointOrdinal,
      };
      return { submission, question };
    },
  );
  if (!session) return null;
  const { submission, question } = session;

  // Allow result reveal for both COMPLETED and STALE submissions.
  // STALE submissions have validation events saved as "stale 历史反馈" (计划 §8.6:
  // "允许保存 stale 历史反馈") and the user should be able to view the feedback.
  // 但在 submit/unable 之前就变 stale 的 submission 没有 validationEventId，
  // reveal-result 必然 404——resultAvailable 必须为 false，否则客户端会陷入
  // 永远失败的"查看结果"死循环。
  const resultAvailable = (submission.status === SubmissionStatus.COMPLETED
    || submission.status === SubmissionStatus.STALE)
    && submission.validationEventId !== null;
  const sourceAvailable = submission.assistanceLevel !== AssistanceLevel.NONE;

  return {
    submissionId: submission.id,
    status: submission.status,
    context: submission.context,
    keyPointId: submission.keyPointId,
    question,
    draftRevision: submission.draftRevision,
    draftAnswer: (submission.status === SubmissionStatus.COMPLETED || submission.status === SubmissionStatus.STALE) ? undefined : (submission.userAnswer ?? undefined),
    selfConfidence: submission.selfConfidence,
    assistanceLevel: submission.assistanceLevel,
    sourceAvailable,
    resultAvailable,
    jobId: submission.currentEvaluationJobId ?? submission.currentGenerationJobId,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
  };
}

// ─── 3. Draft ────────────────────────────────────────────────────────────

export async function draftAnswer(
  submissionId: string,
  workspaceId: string,
  userId: string,
  input: DraftAnswerInput,
): Promise<DraftResult> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const requestHash = hashRequest({ submissionId, ...input });
      const actionCheck = await checkActionCommand(
        tx, workspaceId, userId, "draft", input.idempotencyKey, requestHash,
      );
      if (actionCheck.exists && actionCheck.responseSnapshot) {
        return actionCheck.responseSnapshot as unknown as DraftResult;
      }

      const [submission] = await tx
        .select()
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.id, submissionId),
            eq(validationSubmissions.workspaceId, workspaceId),
            eq(validationSubmissions.userId, userId),
          ),
        )
        .for("update");

      if (!submission) throw new SessionError("not_found");
      await requireConsumableLearningCard(
        tx,
        submission.cardId,
        workspaceId,
      );

      // Only allow draft in ready or answer_saved states
      if (
        submission.status !== SubmissionStatus.READY &&
        submission.status !== SubmissionStatus.ANSWER_SAVED
      ) {
        throw new SessionError("invalid_state_transition");
      }

      // Revision CAS check
      if (submission.draftRevision !== input.baseRevision) {
        throw new SessionError("draft_conflict");
      }

      const newRevision = submission.draftRevision + 1;
      const answerHash = hashAnswer(input.answer);

      await tx
        .update(validationSubmissions)
        .set({
          userAnswer: input.answer,
          selfConfidence: input.selfConfidence ?? null,
          draftRevision: newRevision,
          answerHash,
          status: SubmissionStatus.ANSWER_SAVED,
          updatedAt: new Date(),
        })
        .where(eq(validationSubmissions.id, submissionId));

      const result: DraftResult = { revision: newRevision, answerHash };
      await completeActionCommand(tx, workspaceId, userId, "draft", input.idempotencyKey, result as unknown as Record<string, unknown>);
      return result;
    },
  );
}

// ─── 4. Reveal Source ────────────────────────────────────────────────────

export async function revealSource(
  submissionId: string,
  workspaceId: string,
  userId: string,
  input: RevealSourceInput,
): Promise<RevealSourceResult> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const requestHash = hashRequest({ submissionId, ...input });
      const actionCheck = await checkActionCommand(
        tx, workspaceId, userId, "source_reveal", input.idempotencyKey, requestHash,
      );
      if (actionCheck.exists && actionCheck.responseSnapshot) {
        return actionCheck.responseSnapshot as unknown as RevealSourceResult;
      }

      // 锁序（计划 §8.7）：先 learning-unit advisory lock，再 submission 行锁。
      // 先做一次无锁预读拿 keyPointId，取 advisory lock 后再 FOR UPDATE 重读，
      // 保证与 start/submit/unable 的全局锁序一致，避免交叉死锁。
      const preRead = await tx.query.validationSubmissions.findFirst({
        where: and(
          eq(validationSubmissions.id, submissionId),
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
        ),
      });
      if (!preRead) throw new SessionError("not_found");
      if (preRead.keyPointId) {
        await acquireLearningUnitLock(tx, workspaceId, userId, preRead.keyPointId);
      }

      const [submission] = await tx
        .select()
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.id, submissionId),
            eq(validationSubmissions.workspaceId, workspaceId),
            eq(validationSubmissions.userId, userId),
          ),
        )
        .for("update");

      if (!submission) throw new SessionError("not_found");
      await requireConsumableLearningCard(
        tx,
        submission.cardId,
        workspaceId,
      );

      // Only allow source reveal before submit (ready or answer_saved)
      if (
        submission.status !== SubmissionStatus.READY &&
        submission.status !== SubmissionStatus.ANSWER_SAVED
      ) {
        // 计划 §7.4：submit 先取得锁并完成状态迁移后，reveal 必须返回
        // 409 submission_locked（区别于其他非法状态迁移）。
        if (
          submission.status === SubmissionStatus.EVALUATION_PENDING ||
          submission.status === SubmissionStatus.COMPLETED
        ) {
          throw new SessionError("submission_locked");
        }
        throw new SessionError("invalid_state_transition");
      }

      if (!submission.keyPointId) throw new SessionError("no_key_point");

      const now = new Date();

      // Update submission assistance level (only first time)
      if (submission.assistanceLevel === AssistanceLevel.NONE) {
        await tx
          .update(validationSubmissions)
          .set({
            assistanceLevel: AssistanceLevel.SOURCE_VIEWED,
            assistanceSnapshotExposedAt: now,
            updatedAt: now,
          })
          .where(eq(validationSubmissions.id, submissionId));
      }

      // Always refresh exposure cooldown on every reveal (计划 §8.2: idempotent re-reveal
      // must re-verify RLS/version and refresh exposure each time)
      // Compute exposure fingerprint from real database data (计划 §6.7)
      const exposureFingerprint = await computeExposureFingerprintFromDb(
        tx, workspaceId, userId, submission.keyPointId, submission.cardId,
      );

      const cooldownEnd = computeUnassistedEligibleAfter(now, ASSISTANCE_COOLDOWN_HOURS);

      // Atomic upsert (计划 §6.4.2: "单调 upsert") — use onConflictDoUpdate
      // to handle concurrent exposure creation from different submissions
      // (e.g., initial_validation and review sessions for the same key point
      // revealing source simultaneously). The find-then-update/insert pattern
      // could fail with a unique index violation under concurrent access.
      await tx
        .insert(validationAssistanceExposures)
        .values({
          workspaceId,
          userId,
          keyPointId: submission.keyPointId,
          exposureFingerprint,
          lastExposureKind: ExposureKind.PRE_SUBMIT_SOURCE,
          firstExposedAt: now,
          lastExposedAt: now,
          unassistedEligibleAfter: cooldownEnd,
          lastOriginSubmissionId: submissionId,
        })
        .onConflictDoUpdate({
          target: [
            validationAssistanceExposures.workspaceId,
            validationAssistanceExposures.userId,
            validationAssistanceExposures.keyPointId,
            validationAssistanceExposures.exposureFingerprint,
          ],
          set: {
            lastExposureKind: ExposureKind.PRE_SUBMIT_SOURCE,
            lastExposedAt: now,
            unassistedEligibleAfter: cooldownEnd,
            lastOriginSubmissionId: submissionId,
            updatedAt: now,
          },
        });

      // 计划 §7.4：review 上下文中记录 evidence_revealed_at（仅首次）
      if (submission.context === SubmissionContext.REVIEW && submission.reviewAttemptId) {
        await tx.update(reviewAttempts).set({
          evidenceRevealedAt: now,
          updatedAt: now,
        }).where(and(
          eq(reviewAttempts.id, submission.reviewAttemptId),
          eq(reviewAttempts.workspaceId, workspaceId),
          eq(reviewAttempts.userId, userId),
          sql`${reviewAttempts.evidenceRevealedAt} IS NULL`,
        ));
      }

      const result: RevealSourceResult = {
        assistanceLevel: AssistanceLevel.SOURCE_VIEWED,
        sourceAvailable: true,
      };
      await completeActionCommand(tx, workspaceId, userId, "source_reveal", input.idempotencyKey, result as unknown as Record<string, unknown>);
      return result;
    },
  );
}

// ─── 5. Submit ───────────────────────────────────────────────────────────

export async function submitAnswer(
  submissionId: string,
  workspaceId: string,
  userId: string,
  input: SubmitAnswerInput,
): Promise<SubmitResult> {
  const txOutcome = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx): Promise<
      | { kind: "replay"; result: SubmitResult }
      | { kind: "proceed"; result: SubmitResult }
      | StaleTxError
    > => {
      const requestHash = hashRequest({ submissionId, ...input });
      const actionCheck = await checkActionCommand(
        tx, workspaceId, userId, "submit", input.idempotencyKey, requestHash,
      );
      if (actionCheck.exists && actionCheck.responseSnapshot) {
        // 回放：直接返回原响应，不重跑 post-commit（避免重复 funnel 事件
        // 与快照被覆盖——回放响应必须不可变）。
        return { kind: "replay", result: actionCheck.responseSnapshot as unknown as SubmitResult };
      }

      // 锁序（计划 §8.7）：advisory learning-unit lock 先于 submission 行锁。
      const preRead = await tx.query.validationSubmissions.findFirst({
        where: and(
          eq(validationSubmissions.id, submissionId),
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
        ),
      });
      if (!preRead) throw new SessionError("not_found");
      if (preRead.keyPointId) {
        await acquireLearningUnitLock(tx, workspaceId, userId, preRead.keyPointId);
      }

      const [submission] = await tx
        .select()
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.id, submissionId),
            eq(validationSubmissions.workspaceId, workspaceId),
            eq(validationSubmissions.userId, userId),
          ),
        )
        .for("update");

      if (!submission) throw new SessionError("not_found");
      await requireConsumableLearningCard(
        tx,
        submission.cardId,
        workspaceId,
      );

      // Only allow submit from ready or answer_saved
      if (
        submission.status !== SubmissionStatus.READY &&
        submission.status !== SubmissionStatus.ANSWER_SAVED
      ) {
        if (submission.status === SubmissionStatus.COMPLETED) {
          throw new SessionError("already_completed");
        }
        throw new SessionError("invalid_state_transition");
      }

      // Revision CAS check
      if (submission.draftRevision !== input.baseRevision) {
        throw new SessionError("draft_conflict");
      }

      if (!submission.questionId) throw new SessionError("question_not_ready");

      const now = new Date();

      // Lock and verify question with FOR UPDATE (计划 §8.6: 校验 question/user/fingerprint, §8.7: question lock)
      const [question] = await tx
        .select()
        .from(validationQuestions)
        .where(
          and(
            eq(validationQuestions.id, submission.questionId),
            eq(validationQuestions.workspaceId, workspaceId),
          ),
        )
        .for("update");
      if (!question) throw new SessionError("question_not_ready");

      // Verify source fingerprint matches (计划 §8.6: 再次校验 fingerprint)
      // Fail closed: null fingerprint is treated as mismatch (防御深度)
      // 注意：这些 stale 转移必须"提交后再抛错"——在事务回调里直接 throw 会
      // 回滚 STALE 写入，让 submission 卡在可重试却永远 422 的死循环里。
      if (question.sourceFingerprint !== submission.sourceFingerprint) {
        await markSubmissionStaleTx(tx, submission, workspaceId, userId, "submit", "fingerprint_mismatch", now);
        return staleTxError("question_expired", "source fingerprint mismatch");
      }

      if (question.status !== QuestionStatus.ACTIVE) {
        // Mark submission as stale — question is no longer active (stale/superseded/expired)
        // (计划 §7.5: stale 问题不能新建可升级 submission)
        await markSubmissionStaleTx(tx, submission, workspaceId, userId, "submit", "question_not_active", now);
        return staleTxError("question_expired", "question is no longer active");
      }
      if (question.expiresAt && question.expiresAt <= now) {
        // Mark submission as stale (计划 §7.5: expired question cannot upgrade)
        // 并在同事务把题目原子 active→expired（§6.2），释放 active 唯一槽位。
        await expireQuestionTx(tx, question.id, workspaceId);
        await markSubmissionStaleTx(tx, submission, workspaceId, userId, "submit", "question_expired", now);
        return staleTxError("question_expired");
      }

      // Re-read exposure fingerprint aggregation (计划 §7.4:
      // "submit 在写最终答案时重新读取 exposure_fingerprint 聚合行；若暴露先提交，
      //  则原子把 submission 提升为 source_viewed，并写 assistance_snapshot_exposed_at/answer_locked_at")
      // This catches cross-submission exposures (e.g., another tab/device revealed source).
      let promotedAssistanceLevel = submission.assistanceLevel;
      let promotedAssistanceSnapshotExposedAt = submission.assistanceSnapshotExposedAt;
      if (submission.keyPointId && submission.assistanceLevel === AssistanceLevel.NONE) {
        const existingExposure = await tx.query.validationAssistanceExposures.findFirst({
          where: and(
            eq(validationAssistanceExposures.workspaceId, workspaceId),
            eq(validationAssistanceExposures.userId, userId),
            eq(validationAssistanceExposures.keyPointId, submission.keyPointId),
          ),
          orderBy: sql`${validationAssistanceExposures.unassistedEligibleAfter} DESC`,
        });
        if (existingExposure && !isUnassistedEligible(existingExposure.unassistedEligibleAfter, now)) {
          // Exposure exists and cooldown hasn't elapsed — promote to source_viewed
          promotedAssistanceLevel = AssistanceLevel.SOURCE_VIEWED;
          promotedAssistanceSnapshotExposedAt = now;
        }
      }

      const answerHash = hashAnswer(input.answer);
      const newRevision = submission.draftRevision + 1;

      // Lock answer and transition to evaluation_pending
      // Include promoted assistance level and snapshot timestamp (计划 §7.4)
      await tx
        .update(validationSubmissions)
        .set({
          userAnswer: input.answer,
          selfConfidence: input.selfConfidence ?? null,
          draftRevision: newRevision,
          answerHash,
          answerLockedAt: now,
          assistanceLevel: promotedAssistanceLevel,
          assistanceSnapshotExposedAt: promotedAssistanceSnapshotExposedAt,
          status: SubmissionStatus.EVALUATION_PENDING,
          updatedAt: now,
        })
        .where(eq(validationSubmissions.id, submissionId));

      const result: SubmitResult = {
        status: "evaluation_pending",
        jobId: "", // Will be filled after job creation
      };
      // Action command will be completed after job creation (outside transaction)
      return { kind: "proceed", result };
    },
  );

  // stale 转移已提交，此处再向调用方抛出对应错误（fail-closed 且状态已持久化）
  if (isStaleTxError(txOutcome)) {
    throw new SessionError(txOutcome.code, txOutcome.detail);
  }
  // 回放：原响应不可变，直接返回
  if (txOutcome.kind === "replay") {
    return txOutcome.result;
  }
  const result = txOutcome.result;

  // SEC-01/RLS：post-commit 读写一律走 withWorkspaceTransaction（GUC 上下文）。
  // Guard against duplicate job creation on retry after partial failure
  const existingSub = await withWorkspaceTransaction(
    { workspaceId, userId },
    (tx) => tx.query.validationSubmissions.findFirst({
      where: and(
        eq(validationSubmissions.id, submissionId),
        eq(validationSubmissions.workspaceId, workspaceId),
        eq(validationSubmissions.userId, userId),
      ),
    }),
  );
  if (existingSub?.currentEvaluationJobId) {
    result.jobId = existingSub.currentEvaluationJobId;
    await completeActionCommandDb(
      workspaceId, userId, "submit", input.idempotencyKey,
      result as unknown as Record<string, unknown>,
    );
    recordFunnelEvent("validation_submitted");
    return result;
  }

  // Create evaluation job after transaction commit
  const job = await createJob({
    type: JobType.EVALUATE_VALIDATION,
    workspaceId,
    requestedBy: userId,
    payload: {
      submissionId,
      userId,
    },
    dedupe: {
      payloadField: "submissionId",
      value: submissionId,
    },
  });

  // Link job to submission + lineage + action command，同一 GUC 事务内完成
  await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      await tx
        .update(validationSubmissions)
        .set({
          currentEvaluationJobId: job.id,
          updatedAt: new Date(),
        })
        .where(and(
          eq(validationSubmissions.id, submissionId),
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
        ));

      await tx.insert(validationSubmissionJobs).values({
        submissionId,
        phase: "evaluation",
        phaseOrdinal: 1,
        jobId: job.id,
      }).onConflictDoNothing();

      result.jobId = job.id;

      await completeActionCommand(
        tx, workspaceId, userId, "submit", input.idempotencyKey,
        result as unknown as Record<string, unknown>,
      );
    },
  );

  recordFunnelEvent("validation_submitted");
  return result;
}

// ─── 6. Unable ───────────────────────────────────────────────────────────

export async function unableToAnswer(
  submissionId: string,
  workspaceId: string,
  userId: string,
  input: UnableInput,
): Promise<UnableResult> {
  const txOutcome = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx): Promise<UnableResult | StaleTxError> => {
      const requestHash = hashRequest({ submissionId, ...input });
      const actionCheck = await checkActionCommand(
        tx, workspaceId, userId, "unable", input.idempotencyKey, requestHash,
      );
      if (actionCheck.exists && actionCheck.responseSnapshot) {
        return actionCheck.responseSnapshot as unknown as UnableResult;
      }

      // 锁序（计划 §8.7）：advisory learning-unit lock 先于 submission 行锁。
      const preRead = await tx.query.validationSubmissions.findFirst({
        where: and(
          eq(validationSubmissions.id, submissionId),
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
        ),
      });
      if (!preRead) throw new SessionError("not_found");
      if (preRead.keyPointId) {
        await acquireLearningUnitLock(tx, workspaceId, userId, preRead.keyPointId);
      }

      const [submission] = await tx
        .select()
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.id, submissionId),
            eq(validationSubmissions.workspaceId, workspaceId),
            eq(validationSubmissions.userId, userId),
          ),
        )
        .for("update");

      if (!submission) throw new SessionError("not_found");
      await requireConsumableLearningCard(
        tx,
        submission.cardId,
        workspaceId,
      );

      // Only allow unable from ready or answer_saved
      if (
        submission.status !== SubmissionStatus.READY &&
        submission.status !== SubmissionStatus.ANSWER_SAVED
      ) {
        if (submission.status === SubmissionStatus.COMPLETED) {
          throw new SessionError("already_completed");
        }
        throw new SessionError("invalid_state_transition");
      }

      if (!submission.questionId) throw new SessionError("question_not_ready");

      const now = new Date();

      // ── Lock and verify question FIRST (计划 §8.6: 再次校验 fingerprint、question、expiry, §8.7: question lock) ──
      // Question verification must happen BEFORE writing artifact/assessments/reducer
      // to avoid unnecessary writes that would be rolled back on failure.
      const [question] = await tx
        .select()
        .from(validationQuestions)
        .where(
          and(
            eq(validationQuestions.id, submission.questionId),
            eq(validationQuestions.workspaceId, workspaceId),
          ),
        )
        .for("update");
      if (!question) throw new SessionError("question_not_ready");

      // Verify source fingerprint matches (计划 §8.6: 再次校验 fingerprint)
      // Fail closed: null fingerprint is treated as mismatch (防御深度)
      // stale 转移同样采用"提交后再抛错"模式（见 submitAnswer 注释）。
      if (question.sourceFingerprint !== submission.sourceFingerprint) {
        await markSubmissionStaleTx(tx, submission, workspaceId, userId, "unable", "fingerprint_mismatch", now);
        return staleTxError("question_expired", "source fingerprint mismatch");
      }

      // Check question expiry (计划 §7.5: expires_at check in result-write transaction)
      if (question.status !== QuestionStatus.ACTIVE) {
        await markSubmissionStaleTx(tx, submission, workspaceId, userId, "unable", "question_not_active", now);
        return staleTxError("question_expired", "question is no longer active");
      }
      if (question.expiresAt && question.expiresAt <= now) {
        await expireQuestionTx(tx, question.id, workspaceId);
        await markSubmissionStaleTx(tx, submission, workspaceId, userId, "unable", "question_expired", now);
        return staleTxError("question_expired");
      }

      // 计划 §8.6：unable 本身就是 result-write，必须用"当前"来源重新计算
      // fingerprint。question/submission 两个存量快照在绑定时互相拷贝，二者
      // 比较永远相等（vacuous）；evaluate-rubric 在 worker 事务里做了实时
      // 重算，unable 路径此前没有等价物——用户改写笔记/降级证据后仍可通过
      // unable 写入 understanding event 和真实 pending schedule。
      if (submission.keyPointId) {
        const liveFingerprint = await computeSourceFingerprintFromDb(
          tx, workspaceId, userId, submission.keyPointId, submission.cardId,
        );
        if (liveFingerprint !== submission.sourceFingerprint) {
          await markSubmissionStaleTx(tx, submission, workspaceId, userId, "unable", "source_changed", now);
          return staleTxError("question_expired", "source changed since question was bound");
        }
      }

      // Re-read exposure fingerprint aggregation (计划 §7.4:
      // "unable 与 submit 使用相同锁和幂等边界" — same exposure re-read requirement)
      // This catches cross-submission exposures (e.g., another tab/device revealed source).
      let promotedAssistanceLevel = submission.assistanceLevel;
      let promotedAssistanceSnapshotExposedAt = submission.assistanceSnapshotExposedAt;
      // PERF-37 修复：将 existingExposure 提升到 if 块外部，以便后续复用，避免重复查询
      let existingExposure: typeof validationAssistanceExposures.$inferSelect | null = null;
      if (submission.keyPointId && submission.assistanceLevel === AssistanceLevel.NONE) {
        existingExposure = (await tx.query.validationAssistanceExposures.findFirst({
          where: and(
            eq(validationAssistanceExposures.workspaceId, workspaceId),
            eq(validationAssistanceExposures.userId, userId),
            eq(validationAssistanceExposures.keyPointId, submission.keyPointId),
          ),
          orderBy: sql`${validationAssistanceExposures.unassistedEligibleAfter} DESC`,
        })) ?? null;
        if (existingExposure && !isUnassistedEligible(existingExposure.unassistedEligibleAfter, now)) {
          promotedAssistanceLevel = AssistanceLevel.SOURCE_VIEWED;
          promotedAssistanceSnapshotExposedAt = now;
        }
      }

      // Lock answer timestamp and freeze assistance snapshot
      await tx
        .update(validationSubmissions)
        .set({
          answerLockedAt: now,
          assistanceLevel: promotedAssistanceLevel,
          assistanceSnapshotExposedAt: promotedAssistanceSnapshotExposedAt,
          updatedAt: now,
        })
        .where(eq(validationSubmissions.id, submissionId));

      // ── Finalize as unable (计划 §8.6 mode=user_declared_unable) ──────

      // Load rubric items
      const rubricItems = await tx.query.validationQuestionRubricItems.findMany({
        where: and(
          eq(validationQuestionRubricItems.questionId, submission.questionId),
          eq(validationQuestionRubricItems.workspaceId, workspaceId),
        ),
        orderBy: sql`${validationQuestionRubricItems.ordinal} ASC`,
      });

      if (rubricItems.length === 0) {
        throw new SessionError("question_not_ready", "no rubric items found");
      }

      // PERF-37 修复：aiArtifacts 插入和 validationPointAssessments 插入之间无数据依赖，
      // 可以并行执行。原代码串行执行两次 INSERT，现在使用 Promise.all 并行化。
      // 注意：validationPointAssessments 不依赖 artifact.id（与 validationEvents 不同），
      // 因此可以安全并行。
      const [artifactRows] = await Promise.all([
        tx
          .insert(aiArtifacts)
          .values({
            workspaceId,
            type: ArtifactType.RUBRIC_EVALUATION, // 计划 §6.6: v0.6 unable path also writes point assessments and runs reducer
            inputRefs: {
              cardId: submission.cardId,
              keyPointId: submission.keyPointId ?? undefined,
              userId,
            },
            output: {
              mode: "user_declared_unable",
              submissionId,
              questionId: question.id,
              reducerVersion: RUBRIC_REDUCER_VERSION,
            },
            modelId: "system",
            promptVersion: "unable-v1",
            status: ArtifactStatus.READY,
            inputHash: createHash("sha256").update(JSON.stringify({ questionId: question.id, submissionId, mode: "user_declared_unable" }), "utf8").digest("hex"), // 计划 §6.6
            costTokens: null, // 计划 §6.6: no AI call for unable path
          })
          .returning(),
        // Write missing assessments for all rubric items（不依赖 artifact.id，可并行）
        tx.insert(validationPointAssessments).values(
          rubricItems.map((item) => ({
            workspaceId,
            userId,
            submissionId,
            rubricItemId: item.id,
            verdict: RubricVerdict.MISSING,
            assessmentSource: AssessmentSource.USER_DECLARED_UNABLE,
            confidence: 0,
            rationale: "User declared unable to answer",
            evidenceSnapshot: item.evidenceSnapshot,
          })),
        ),
      ]);
      const artifact = artifactRows[0]!;

      // Run reducer
      const reducerInputs: RubricItemInput[] = rubricItems.map((item) => ({
        key: item.id,
        weight: item.weight,
        required: item.required,
        verdict: RubricVerdict.MISSING,
      }));
      const reducerResult = reduceRubric(reducerInputs);
      const reviewOutcome = toReviewOutcome(reducerResult.outcome);

      // Write validation event
      const [ve] = await tx
        .insert(validationEvents)
        .values({
          workspaceId,
          userId,
          cardId: submission.cardId,
          keyPointId: submission.keyPointId,
          artifactId: artifact.id,
          question: question.question,
          questionType: question.questionType,
          userAnswer: submission.userAnswer ?? "",
          outcome: reducerResult.outcome,
          confidence: 0,
          feedback: {
            outcome: reducerResult.outcome,
            confidence: 0,
            coveredPoints: [],
            missingPoints: rubricItems.map((item) => item.criterion),
            misunderstandings: [],
            evidenceRefs: [],
            feedback: "User declared unable to answer. All rubric items marked as missing.",
          },
          submissionId,
          questionId: question.id,
          noteVersionId: question.noteVersionId, // 计划 §6.6: note_version_id
          rubricVersion: RUBRIC_REDUCER_VERSION,
          reducerVersion: RUBRIC_REDUCER_VERSION,
          sourceFingerprint: submission.sourceFingerprint,
          sourceStatus: question.status,
        })
        .returning();

      // ── Scheduling pre-checks (计划 §8.6 context branch steps 1-2) ──────
      // Understanding event and schedule must only be written if pre-check passes.
      // (计划 §8.6: "若公共步骤 2 失败，允许保存 stale 历史反馈，
      //  但 schedule 与 understanding 副作用均不得发生")
      let currentIntervalDays = 1;
      let inputScheduleGeneration = 0;
      let schedulingPreCheckFailed = false;
      let schedulingFailureCode = "scheduling_pre_check_failed";

      if (submission.context === SubmissionContext.INITIAL_VALIDATION) {
        // Step 1: Assert no review_attempt_id/input_schedule_id (计划 §8.6 initial branch step 1)
        if (submission.reviewAttemptId || submission.inputScheduleId) {
          schedulingPreCheckFailed = true;
          schedulingFailureCode = "invalid_context_state";
        }
        // Step 2: Check for existing pending schedule (计划 §8.6 initial branch step 2:
        // "若已经存在 pending schedule，判为并发冲突并置 stale，不覆盖既有 schedule")
        if (!schedulingPreCheckFailed && submission.keyPointId) {
          const existingPending = await tx.query.reviewSchedules.findFirst({
            where: and(
              eq(reviewSchedules.workspaceId, workspaceId),
              eq(reviewSchedules.userId, userId),
              eq(reviewSchedules.keyPointId, submission.keyPointId),
              eq(reviewSchedules.status, ReviewStatus.PENDING),
            ),
          });
          if (existingPending) {
            schedulingPreCheckFailed = true;
            schedulingFailureCode = "concurrent_schedule_conflict";
          }
        }
      } else if (submission.context === SubmissionContext.REVIEW && submission.reviewAttemptId && submission.inputScheduleId) {
        // Step 1: Lock review attempt (计划 §8.6 review branch step 1:
        // "断言并锁 review_attempt_id 与其精确的 input_schedule_id")
        const [reviewAttempt] = await tx
          .select()
          .from(reviewAttempts)
          .where(eq(reviewAttempts.id, submission.reviewAttemptId))
          .for("update");
        if (!reviewAttempt || reviewAttempt.status !== "started") {
          schedulingPreCheckFailed = true;
          schedulingFailureCode = "review_attempt_not_active";
        }
        // Step 2: Lock input schedule and verify still PENDING (计划 §8.6 review branch step 2:
        // "校验该 schedule 仍是当前 user/key point 唯一 pending 输入")
        const [lockedSchedule] = await tx
          .select()
          .from(reviewSchedules)
          .where(eq(reviewSchedules.id, submission.inputScheduleId))
          .for("update");
        currentIntervalDays = lockedSchedule?.intervalDays ?? 1;
        inputScheduleGeneration = lockedSchedule?.generation ?? 0;
        if (!lockedSchedule || lockedSchedule.status !== ReviewStatus.PENDING) {
          schedulingPreCheckFailed = true;
          schedulingFailureCode = "input_schedule_not_pending";
        }
      } else {
        // Invalid context — no valid branch
        schedulingPreCheckFailed = true;
        schedulingFailureCode = "invalid_context";
      }

      if (schedulingPreCheckFailed) {
        // Mark submission stale — no understanding event, no schedule
        // (计划 §8.6: "不进入任一 schedule 分支")
        // Link validation event so user can reveal stale history feedback (计划 §8.6: "允许保存 stale 历史反馈")
        await tx.update(validationSubmissions).set({
          status: SubmissionStatus.STALE,
          failureStage: "scheduling",
          failureCode: schedulingFailureCode,
          terminalReason: TerminalReason.SOURCE_STALE,
          validationEventId: ve.id,
          updatedAt: now,
        }).where(eq(validationSubmissions.id, submissionId));

        // 计划 §8.3/§8.7：review 上下文 stale 终态必须同事务把 started attempt
        // 置为 abandoned（input schedule 保持 pending）。
        if (submission.context === SubmissionContext.REVIEW && submission.reviewAttemptId) {
          await tx.update(reviewAttempts).set({
            status: "abandoned",
            abandonedAt: now,
            updatedAt: now,
          }).where(and(
            eq(reviewAttempts.id, submission.reviewAttemptId),
            eq(reviewAttempts.workspaceId, workspaceId),
            eq(reviewAttempts.userId, userId),
            eq(reviewAttempts.status, "started"),
          ));
        }

        const result: UnableResult = {
          status: "completed",
          resultAvailable: true,
        };
        await completeActionCommand(tx, workspaceId, userId, "unable", input.idempotencyKey, result as unknown as Record<string, unknown>);
        return result;
      }

      // PERF-37 修复：复用步骤 6 已查询的 rubricItems，避免重复 DB 查询。
      // 原代码在同一事务内重复查询 rubricItems（步骤 6 和步骤 11），
      // 由于在同一事务中，两次查询结果必然一致，直接复用即可。
      // 计划 §8.6 "再次校验 evidence" 的需求已通过同一事务快照满足：
      // 事务隔离级别保证步骤 6 的查询已看到最新的 committed 数据。
      const txHasHardEvidence = rubricItems.every((item) => item.evidenceId !== null);

      // Write understanding event (moved after scheduling pre-check — only if pre-check passes)
      // unable always produces "seen" eventType (no understanding upgrade),
      // but we include hasHardEvidence in payload for auditability (consistent with evaluate-rubric.ts)
      await tx.insert(understandingEvents).values({
        workspaceId,
        userId,
        subjectType: "validation",
        subjectId: ve.id,
        eventType: "seen",
        payload: {
          outcome: reducerResult.outcome,
          coverage: 0,
          reducerVersion: RUBRIC_REDUCER_VERSION,
          hasHardEvidence: txHasHardEvidence,
        },
      });

      // PERF-37 修复：复用步骤 4 已查询的 existingExposure，避免重复 DB 查询。
      // 原代码在同一事务内重复查询 exposure（步骤 4 和步骤 13），
      // 由于在同一事务中，两次查询结果必然一致，直接复用即可。
      const exposure = existingExposure;

      const assistanceOutcome = promotedAssistanceLevel === AssistanceLevel.SOURCE_VIEWED
        ? "source_viewed" as const
        : reviewOutcome;

      // Compute scheduling guards from verified state (not hardcoded)
      // hasValidServerQuestion: question is active, not expired, and fingerprint matches
      // (consistent with evaluate-rubric.ts)
      const hasValidServerQuestion = question.status === QuestionStatus.ACTIVE
        && (!question.expiresAt || question.expiresAt > now)
        && submission.sourceFingerprint === question.sourceFingerprint;

      // hasHardEvidence: use tx-in re-read rubric items (txRubricItems) to detect
      // evidence deletion via FK cascade onDelete: "set null" (consistent with evaluate-rubric.ts)
      const hasHardEvidence = txHasHardEvidence;

      const scheduleResult = calculateSchedule({
        currentIntervalDays,
        outcome: assistanceOutcome as string,
        hasValidServerQuestion,
        hasHardEvidence,
        now,
        unassistedEligibleAfter: exposure?.unassistedEligibleAfter ?? null,
      });

      if (scheduleResult.shouldMutateSchedule) {
        if (submission.context === SubmissionContext.INITIAL_VALIDATION) {
          // Create first pending schedule (计划 §8.6 initial branch step 4:
          // "按 discrete-v2 创建首条唯一 pending schedule")
          // No supersede — plan §8.6 step 2 says "不覆盖既有 schedule"
          await tx.insert(reviewSchedules).values({
            workspaceId,
            userId,
            subjectType: "key_point",
            subjectId: submission.keyPointId!,
            validationEventId: ve.id,
            status: ReviewStatus.PENDING,
            nextReviewAt: scheduleResult.nextReviewAt,
            intervalDays: scheduleResult.afterIntervalDays,
            keyPointId: submission.keyPointId,
            policyVersion: scheduleResult.policyVersion,
            reasonCode: scheduleResult.reasonCode,
          });
        } else if (
          submission.context === SubmissionContext.REVIEW &&
          submission.reviewAttemptId &&
          submission.inputScheduleId
        ) {
          // Complete input schedule (计划 §8.6 review branch step 4)
          await tx
            .update(reviewSchedules)
            .set({ status: ReviewStatus.COMPLETED })
            .where(
              and(
                eq(reviewSchedules.id, submission.inputScheduleId),
                eq(reviewSchedules.workspaceId, workspaceId),
              ),
            );

          // Create successor schedule (计划 §8.6 review branch step 4)
          const [nextSchedule] = await tx.insert(reviewSchedules).values({
            workspaceId,
            userId,
            subjectType: "key_point",
            subjectId: submission.keyPointId!,
            validationEventId: ve.id,
            status: ReviewStatus.PENDING,
            nextReviewAt: scheduleResult.nextReviewAt,
            intervalDays: scheduleResult.afterIntervalDays,
            keyPointId: submission.keyPointId,
            generation: inputScheduleGeneration + 1, // 计划 §6.6: generation increments for successor
            policyVersion: scheduleResult.policyVersion,
            reasonCode: scheduleResult.reasonCode,
            supersedesScheduleId: submission.inputScheduleId,
          }).returning({ id: reviewSchedules.id });

          // Complete review attempt (计划 §8.3: "原子完成 attempt/schedule")
          // 与 evaluate-rubric 的 finalizer 保持同构：写入完整的评估/调度投影，
          // 否则 unable 完成的 review attempt 无法审计（"same finalizer" 语义）。
          await tx
            .update(reviewAttempts)
            .set({
              validationEventId: ve.id,
              validationQuestionId: question.id,
              noteVersionId: question.noteVersionId,
              outcome: reducerResult.outcome,
              confidence: 0,
              scheduleBeforeIntervalDays: currentIntervalDays,
              scheduleAfterIntervalDays: scheduleResult.afterIntervalDays,
              scheduleReasonCode: scheduleResult.reasonCode,
              understandingEffect: scheduleResult.understandingEffect,
              nextReviewAt: scheduleResult.nextReviewAt,
              nextScheduleId: nextSchedule.id,
              evaluationArtifactId: artifact.id,
              evaluationStatus: SubmissionStatus.COMPLETED,
              assistanceLevel: promotedAssistanceLevel,
              policyVersion: scheduleResult.policyVersion,
              sourceFingerprint: submission.sourceFingerprint,
              status: "completed",
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(reviewAttempts.id, submission.reviewAttemptId),
                eq(reviewAttempts.status, "started"),
              ),
            );
        }
      }

      // FSRS shadow decision (计划 §6.8, §10.6)
      // Shadow writes do NOT affect the official schedule.
      // Only unassisted results produce valid training events.
      if (isFSRSShadowEnabled()) {
        const isUnassisted = promotedAssistanceLevel === AssistanceLevel.NONE;
        const fsrsInput: FSRSShadowInput = {
          workspaceId,
          userId,
          keyPointId: submission.keyPointId,
          sourceType: submission.context === SubmissionContext.REVIEW ? "review_attempt" : "validation_event",
          sourceId: submission.context === SubmissionContext.REVIEW && submission.reviewAttemptId
            ? submission.reviewAttemptId
            : ve.id,
          // 与 evaluate-rubric 一致：快照存"决策前"的正式区间，保证离线回放
          // 能从相同历史重算出相同的正式决策（§10.6）。
          currentIntervalDays,
          outcome: assistanceOutcome as "correct" | "partial" | "incorrect" | "unable" | "source_viewed" | "stale" | "provider_failure",
          now,
          isUnassisted,
        };
        const shadowDecision = computeFSRSShadowDecision(fsrsInput);
        if (shadowDecision) {
          await tx
            .insert(schedulingShadowDecisions)
            .values({
              workspaceId: shadowDecision.workspaceId,
              userId: shadowDecision.userId,
              keyPointId: shadowDecision.keyPointId,
              sourceType: shadowDecision.sourceType,
              sourceId: shadowDecision.sourceId,
              algorithm: shadowDecision.algorithm,
              algorithmVersion: shadowDecision.algorithmVersion,
              parametersVersion: shadowDecision.parametersVersion,
              inputSnapshot: shadowDecision.inputSnapshot,
              predictedDueAt: shadowDecision.predictedDueAt,
              stability: shadowDecision.stability,
              difficulty: shadowDecision.difficulty,
              retrievability: shadowDecision.retrievability,
            })
            .onConflictDoNothing();
        }
      }

      // Complete submission
      await tx
        .update(validationSubmissions)
        .set({
          status: SubmissionStatus.COMPLETED,
          validationEventId: ve.id,
          updatedAt: now,
        })
        .where(eq(validationSubmissions.id, submissionId));

      const result: UnableResult = {
        status: "completed",
        resultAvailable: true,
      };
      await completeActionCommand(tx, workspaceId, userId, "unable", input.idempotencyKey, result as unknown as Record<string, unknown>);
      return result;
    },
  );

  // stale 转移已提交，事务外抛出对应错误
  if (isStaleTxError(txOutcome)) {
    throw new SessionError(txOutcome.code, txOutcome.detail);
  }
  return txOutcome;
}

// ─── 7. Reveal Result ────────────────────────────────────────────────────

export async function revealResult(
  submissionId: string,
  workspaceId: string,
  userId: string,
  input: RevealResultInput,
): Promise<RevealResultResult> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const requestHash = hashRequest({ submissionId, ...input });
      const actionCheck = await checkActionCommand(
        tx, workspaceId, userId, "result_reveal", input.idempotencyKey, requestHash,
      );
      if (actionCheck.exists && actionCheck.responseSnapshot) {
        return actionCheck.responseSnapshot as unknown as RevealResultResult;
      }

      // 锁序（计划 §8.7）：advisory learning-unit lock 先于 submission 行锁。
      // revealResult 会写 exposure 聚合行，必须与 reveal/submit/unable/start
      // 在同一 learning-unit 锁下串行化。
      const preRead = await tx.query.validationSubmissions.findFirst({
        where: and(
          eq(validationSubmissions.id, submissionId),
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
        ),
      });
      if (!preRead) throw new SessionError("not_found");
      if (preRead.keyPointId) {
        await acquireLearningUnitLock(tx, workspaceId, userId, preRead.keyPointId);
      }

      const [submission] = await tx
        .select()
        .from(validationSubmissions)
        .where(and(
          eq(validationSubmissions.id, submissionId),
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
        ))
        .for("update");
      if (!submission) throw new SessionError("not_found");
      // Allow reveal for both COMPLETED and STALE submissions.
      // STALE submissions have validation events saved as "stale 历史反馈" (计划 §8.6:
      // "允许保存 stale 历史反馈") and the user should be able to view the feedback.
      if (
        submission.status !== SubmissionStatus.COMPLETED
        && submission.status !== SubmissionStatus.STALE
      ) {
        throw new SessionError("invalid_state_transition", "result not available yet");
      }
      if (!submission.validationEventId) throw new SessionError("not_found", "no validation event");

      // Record post-result exposure
      if (submission.keyPointId) {
        const now = new Date();
        const exposureFingerprint = await computeExposureFingerprintFromDb(
          tx, workspaceId, userId, submission.keyPointId, submission.cardId,
        );

        const cooldownEnd = computeUnassistedEligibleAfter(now, ASSISTANCE_COOLDOWN_HOURS);

        // Atomic upsert (计划 §6.4.2: "单调 upsert") — use onConflictDoUpdate
        // to handle concurrent exposure creation from different submissions.
        // Also fix: previously revealResult did not update lastOriginSubmissionId
        // on existing exposure rows, inconsistent with revealSource.
        await tx
          .insert(validationAssistanceExposures)
          .values({
            workspaceId,
            userId,
            keyPointId: submission.keyPointId,
            exposureFingerprint,
            lastExposureKind: ExposureKind.POST_RESULT_FEEDBACK,
            firstExposedAt: now,
            lastExposedAt: now,
            unassistedEligibleAfter: cooldownEnd,
            lastOriginSubmissionId: submissionId,
          })
          .onConflictDoUpdate({
            target: [
              validationAssistanceExposures.workspaceId,
              validationAssistanceExposures.userId,
              validationAssistanceExposures.keyPointId,
              validationAssistanceExposures.exposureFingerprint,
            ],
            set: {
              lastExposureKind: ExposureKind.POST_RESULT_FEEDBACK,
              lastExposedAt: now,
              unassistedEligibleAfter: cooldownEnd,
              lastOriginSubmissionId: submissionId,
              updatedAt: now,
            },
          });
      }

      // Load validation event with feedback
      const ve = await tx.query.validationEvents.findFirst({
        where: and(
          eq(validationEvents.id, submission.validationEventId),
          eq(validationEvents.workspaceId, workspaceId),
        ),
      });
      if (!ve) throw new SessionError("not_found", "validation event not found");

      // Load rubric items and assessments
      const rubricItems = submission.questionId
        ? await tx.query.validationQuestionRubricItems.findMany({
            where: and(
              eq(validationQuestionRubricItems.questionId, submission.questionId),
              eq(validationQuestionRubricItems.workspaceId, workspaceId),
            ),
            orderBy: sql`${validationQuestionRubricItems.ordinal} ASC`,
          })
        : [];

      const assessments = await tx.query.validationPointAssessments.findMany({
        where: and(
          eq(validationPointAssessments.submissionId, submissionId),
          eq(validationPointAssessments.workspaceId, workspaceId),
        ),
      });

      const rubricResults = rubricItems.map((item) => {
        const assessment = assessments.find((a) => a.rubricItemId === item.id);
        return {
          criterion: item.criterion,
          verdict: assessment?.verdict ?? "missing",
          rationale: assessment?.rationale ?? undefined,
        };
      });

      // Load evidence refs
      // BUG-39 修复：原代码对每个 rubricItem 的 evidenceId 逐个查询 evidences（N+1 查询）。
      // 如果有 5 个 rubricItem 且每个都有 evidenceId，会产生 5 次独立 DB 查询。
      // 改为批量查询所有需要的 evidenceId，用 Map 在内存中匹配。
      const evidenceIds = rubricItems
        .map((item) => item.evidenceId)
        .filter((id): id is string => id !== null);
      const evidenceMap = new Map<string, { quoteText: string; alignment: string }>();
      if (evidenceIds.length > 0) {
        const evRows = await tx.query.evidences.findMany({
          where: and(
            inArray(evidences.id, evidenceIds),
            eq(evidences.workspaceId, workspaceId),
          ),
        });
        for (const ev of evRows) {
          evidenceMap.set(ev.id, { quoteText: ev.quoteText, alignment: ev.alignment });
        }
      }
      const evidenceRefs: Array<{ quoteText: string; alignment: string }> = [];
      for (const item of rubricItems) {
        if (item.evidenceId) {
          const ev = evidenceMap.get(item.evidenceId);
          if (ev) {
            evidenceRefs.push(ev);
          }
        }
      }

      const result: RevealResultResult = {
        outcome: ve.outcome,
        feedback: ve.feedback,
        rubricItems: rubricResults,
        userAnswer: ve.userAnswer,
        evidenceRefs,
      };
      await completeActionCommand(tx, workspaceId, userId, "result_reveal", input.idempotencyKey, result as unknown as Record<string, unknown>);
      return result;
    },
  );
}

// ─── 8. Retry Question ───────────────────────────────────────────────────

export async function retryQuestion(
  submissionId: string,
  workspaceId: string,
  userId: string,
  input: RetryQuestionInput,
): Promise<RetryResult> {
  const result = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const requestHash = hashRequest({ submissionId, ...input });
      const actionCheck = await checkActionCommand(
        tx, workspaceId, userId, "retry", input.idempotencyKey, requestHash,
      );
      if (actionCheck.exists && actionCheck.responseSnapshot) {
        return actionCheck.responseSnapshot as unknown as RetryResult;
      }

      const [submission] = await tx
        .select()
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.id, submissionId),
            eq(validationSubmissions.workspaceId, workspaceId),
            eq(validationSubmissions.userId, userId),
          ),
        )
        .for("update");

      if (!submission) throw new SessionError("not_found");
      await requireConsumableLearningCard(
        tx,
        submission.cardId,
        workspaceId,
      );

      const canTakeOverOrphanedPending =
        submission.status === SubmissionStatus.QUESTION_PREPARING &&
        submission.currentGenerationJobId === null;
      if (
        submission.status !== SubmissionStatus.QUESTION_RETRYABLE &&
        !canTakeOverOrphanedPending
      ) {
        throw new SessionError("not_retryable");
      }

      const now = new Date();
      // Clear old generation job ID so the post-commit guard can correctly
      // detect whether a NEW job was already created by a previous retry attempt.
      // Without this, the guard would always see the old (failed) job ID and
      // return it instead of creating a new job.
      await tx
        .update(validationSubmissions)
        .set({
          status: SubmissionStatus.QUESTION_PREPARING,
          currentGenerationJobId: null,
          failureStage: null,
          failureCode: null,
          updatedAt: now,
        })
        .where(eq(validationSubmissions.id, submissionId));

      const result: RetryResult = {
        status: "question_preparing",
        jobId: "",
      };
      // Action command will be completed after job creation (outside transaction)
      return result;
    },
  );

  // Create generation job after commit
  // SEC-01/RLS：post-commit 读写走 withWorkspaceTransaction（GUC 上下文）
  const sub = await withWorkspaceTransaction(
    { workspaceId, userId },
    (tx) => tx.query.validationSubmissions.findFirst({
      where: and(
        eq(validationSubmissions.id, submissionId),
        eq(validationSubmissions.workspaceId, workspaceId),
        eq(validationSubmissions.userId, userId),
      ),
    }),
  );

  // Guard against duplicate job creation on retry after partial failure
  if (sub?.currentGenerationJobId) {
    result.jobId = sub.currentGenerationJobId;
    await completeActionCommandDb(
      workspaceId, userId, "retry", input.idempotencyKey,
      result as unknown as Record<string, unknown>,
    );
    return result;
  }

  const job = await createJob({
    type: JobType.GENERATE_VALIDATION_QUESTION,
    workspaceId,
    requestedBy: userId,
    payload: {
      cardId: sub?.cardId,
      keyPointId: sub?.keyPointId,
      submissionId,
      submissionIds: [submissionId],
      userId,
    },
    dedupe: {
      payloadField: "submissionId",
      value: submissionId,
    },
  });

  await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // 2026-08-11：并发竞态修复——先锁定 submission 行（FOR UPDATE）再计算
      // phaseOrdinal。此前 MAX+1 计算与 INSERT 之间无锁：并发 retry 同一
      // submission 会算出相同 ordinal，唯一索引
      // val_sub_jobs_phase_idx(submissionId, phase, phaseOrdinal) 冲突被
      // onConflictDoNothing 吞掉 → retry 的 job 记录（含 retryOfJobId 链）
      // 静默丢失。
      await tx.select({ id: validationSubmissions.id })
        .from(validationSubmissions)
        .where(eq(validationSubmissions.id, submissionId))
        .for("update");

      // Determine phase ordinal
      const existingJobs = await tx.query.validationSubmissionJobs.findMany({
        where: and(
          eq(validationSubmissionJobs.submissionId, submissionId),
          eq(validationSubmissionJobs.phase, "question_generation"),
        ),
        orderBy: sql`${validationSubmissionJobs.phaseOrdinal} ASC`,
      });
      const nextOrdinal = Math.max(0, ...existingJobs.map((j) => j.phaseOrdinal)) + 1;

      await tx.insert(validationSubmissionJobs).values({
        submissionId,
        phase: "question_generation",
        phaseOrdinal: nextOrdinal,
        jobId: job.id,
        retryOfJobId: existingJobs[existingJobs.length - 1]?.jobId,
      }).onConflictDoNothing();

      await tx
        .update(validationSubmissions)
        .set({
          currentGenerationJobId: job.id,
          updatedAt: new Date(),
        })
        .where(and(
          eq(validationSubmissions.id, submissionId),
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
        ));

      result.jobId = job.id;

      await completeActionCommand(
        tx, workspaceId, userId, "retry", input.idempotencyKey,
        result as unknown as Record<string, unknown>,
      );
    },
  );

  return result;
}

// ─── 9. Retry Evaluation ─────────────────────────────────────────────────

export async function retryEvaluation(
  submissionId: string,
  workspaceId: string,
  userId: string,
  input: RetryEvaluationInput,
): Promise<RetryResult> {
  const result = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const requestHash = hashRequest({ submissionId, ...input });
      const actionCheck = await checkActionCommand(
        tx, workspaceId, userId, "retry", input.idempotencyKey, requestHash,
      );
      if (actionCheck.exists && actionCheck.responseSnapshot) {
        return actionCheck.responseSnapshot as unknown as RetryResult;
      }

      const [submission] = await tx
        .select()
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.id, submissionId),
            eq(validationSubmissions.workspaceId, workspaceId),
            eq(validationSubmissions.userId, userId),
          ),
        )
        .for("update");

      if (!submission) throw new SessionError("not_found");
      await requireConsumableLearningCard(
        tx,
        submission.cardId,
        workspaceId,
      );

      const canTakeOverOrphanedPending =
        submission.status === SubmissionStatus.EVALUATION_PENDING &&
        submission.currentEvaluationJobId === null;
      if (
        submission.status !== SubmissionStatus.EVALUATION_RETRYABLE &&
        !canTakeOverOrphanedPending
      ) {
        throw new SessionError("not_retryable");
      }

      const now = new Date();
      // Clear old evaluation job ID so the post-commit guard can correctly
      // detect whether a NEW job was already created by a previous retry attempt.
      // Without this, the guard would always see the old (failed) job ID and
      // return it instead of creating a new job.
      await tx
        .update(validationSubmissions)
        .set({
          status: SubmissionStatus.EVALUATION_PENDING,
          currentEvaluationJobId: null,
          failureStage: null,
          failureCode: null,
          updatedAt: now,
        })
        .where(eq(validationSubmissions.id, submissionId));

      const result: RetryResult = {
        status: "evaluation_pending",
        jobId: "",
      };
      // Action command will be completed after job creation (outside transaction)
      return result;
    },
  );

  // SEC-01/RLS：post-commit 读写走 withWorkspaceTransaction（GUC 上下文）
  // Guard against duplicate job creation on retry after partial failure
  const existingSub = await withWorkspaceTransaction(
    { workspaceId, userId },
    (tx) => tx.query.validationSubmissions.findFirst({
      where: and(
        eq(validationSubmissions.id, submissionId),
        eq(validationSubmissions.workspaceId, workspaceId),
        eq(validationSubmissions.userId, userId),
      ),
    }),
  );
  if (existingSub?.currentEvaluationJobId) {
    result.jobId = existingSub.currentEvaluationJobId;
    await completeActionCommandDb(
      workspaceId, userId, "retry", input.idempotencyKey,
      result as unknown as Record<string, unknown>,
    );
    return result;
  }

  // Create evaluation job after commit
  const job = await createJob({
    type: JobType.EVALUATE_VALIDATION,
    workspaceId,
    requestedBy: userId,
    payload: {
      submissionId,
      userId,
    },
    dedupe: {
      payloadField: "submissionId",
      value: submissionId,
    },
  });

  await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // Determine phase ordinal
      const existingJobs = await tx.query.validationSubmissionJobs.findMany({
        where: and(
          eq(validationSubmissionJobs.submissionId, submissionId),
          eq(validationSubmissionJobs.phase, "evaluation"),
        ),
        orderBy: sql`${validationSubmissionJobs.phaseOrdinal} ASC`,
      });
      const nextOrdinal = Math.max(0, ...existingJobs.map((j) => j.phaseOrdinal)) + 1;

      await tx.insert(validationSubmissionJobs).values({
        submissionId,
        phase: "evaluation",
        phaseOrdinal: nextOrdinal,
        jobId: job.id,
        retryOfJobId: existingJobs[existingJobs.length - 1]?.jobId,
      }).onConflictDoNothing();

      await tx
        .update(validationSubmissions)
        .set({
          currentEvaluationJobId: job.id,
          updatedAt: new Date(),
        })
        .where(and(
          eq(validationSubmissions.id, submissionId),
          eq(validationSubmissions.workspaceId, workspaceId),
          eq(validationSubmissions.userId, userId),
        ));

      result.jobId = job.id;

      await completeActionCommand(
        tx, workspaceId, userId, "retry", input.idempotencyKey,
        result as unknown as Record<string, unknown>,
      );
    },
  );

  return result;
}

// ─── 10. Abandon ─────────────────────────────────────────────────────────

export async function abandonSession(
  submissionId: string,
  workspaceId: string,
  userId: string,
  input: AbandonInput,
): Promise<AbandonResult> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const requestHash = hashRequest({ submissionId, ...input });
      const actionCheck = await checkActionCommand(
        tx, workspaceId, userId, "abandon", input.idempotencyKey, requestHash,
      );
      if (actionCheck.exists && actionCheck.responseSnapshot) {
        return actionCheck.responseSnapshot as unknown as AbandonResult;
      }

      const [submission] = await tx
        .select()
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.id, submissionId),
            eq(validationSubmissions.workspaceId, workspaceId),
            eq(validationSubmissions.userId, userId),
          ),
        )
        .for("update");

      if (!submission) throw new SessionError("not_found");

      // Allow abandon from non-terminal states
      const abandonableStatuses: string[] = [
        SubmissionStatus.QUESTION_PREPARING,
        SubmissionStatus.QUESTION_RETRYABLE,
        SubmissionStatus.READY,
        SubmissionStatus.ANSWER_SAVED,
        SubmissionStatus.EVALUATION_RETRYABLE,
      ];
      if (!abandonableStatuses.includes(submission.status)) {
        throw new SessionError("not_abandonable");
      }

      const now = new Date();
      await tx
        .update(validationSubmissions)
        .set({
          status: SubmissionStatus.ABANDONED,
          terminalReason: TerminalReason.USER_ABANDON,
          updatedAt: now,
        })
        .where(eq(validationSubmissions.id, submissionId));

      // If review context, also abandon the attempt
      if (submission.reviewAttemptId) {
        await tx
          .update(reviewAttempts)
          .set({
            status: "abandoned",
            abandonedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(reviewAttempts.id, submission.reviewAttemptId),
              eq(reviewAttempts.status, "started"),
            ),
          );
      }

      const result: AbandonResult = { status: "abandoned" };
      await completeActionCommand(tx, workspaceId, userId, "abandon", input.idempotencyKey, result as unknown as Record<string, unknown>);
      return result;
    },
  );
}

// ─── §8.4 Quality Signal (Should) ─────────────────────────────────────────

export type QualitySignalResult = {
  signalId: string;
  status: "saved";
};

/**
 * Submit a user-private quality signal for a validation event (计划 §8.4 Should).
 *
 * v0.6 只保存 user-private 信号、关联版本并避免有争议结果继续被当作高可信样本；
 * 完整分流、修正提案和处理后台进入 v0.7。
 *
 * The signal is user-private (RLS-enforced) and records version metadata
 * for auditability. It does NOT modify the validation event, schedule, or
 * understanding state — it only serves as a signal for future quality analysis.
 */
export async function submitQualitySignal(
  validationEventId: string,
  workspaceId: string,
  userId: string,
  input: QualitySignalInput,
): Promise<QualitySignalResult> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // Verify the validation event exists and belongs to this user
      const ve = await tx.query.validationEvents.findFirst({
        where: and(
          eq(validationEvents.id, validationEventId),
          eq(validationEvents.workspaceId, workspaceId),
          eq(validationEvents.userId, userId),
        ),
      });
      if (!ve) throw new SessionError("not_found", "validation event not found");

      // Find the associated submission (if any) for linking
      let submissionId: string | null = null;
      if (ve.submissionId) {
        submissionId = ve.submissionId;
      }

      // Insert the quality signal with version metadata
      const [signal] = await tx
        .insert(validationQualitySignals)
        .values({
          workspaceId,
          userId,
          validationEventId,
          submissionId,
          reason: input.reason,
          comment: input.comment ?? null,
          sourceFingerprint: ve.sourceFingerprint ?? null,
          rubricVersion: ve.rubricVersion ?? null,
          reducerVersion: ve.reducerVersion ?? null,
          policyVersion: null, // policy version is on the schedule, not the event
        })
        .returning();

      return {
        signalId: signal.id,
        status: "saved" as const,
      };
    },
  );
}
