/**
 * v0.6 Handler: evaluate_rubric (计划 §8.1, §8.6)
 *
 * 流程：
 * 1. 从 submission 读取锁定的答案、question 和 rubric items
 * 2. 调用 evaluateRubricViaChat(provider, input) → chatCompletion + zod 校验
 * 3. 校验输出（一一对应、无未知 ID、answerExcerpt 是真实子串）
 * 4. 运行 reduceRubric 确定性 reducer 计算 outcome
 * 5. 事务内：写 assessments、validation event、understanding event 和 schedule
 *
 * 失败处理：
 * - Provider/契约失败 → evaluation_retryable，保留答案，不写 assessment
 * - unable 不调用 Provider，直接写 missing assessments + reducer
 */

import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { evaluateRubricViaChat } from "../lib/business-ai-ops.ts";
import {
  AIConsentRequiredError,
  enforcePrivacyGovernanceWithPolicy,
  logAICall,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import {
  assertJobLease,
  isJobLeaseActive,
  lockJobLease,
  throwIfJobAborted,
  withJobTransaction,
  type JobLeaseContext,
} from "../lib/job-lease.ts";
import {
  providerCallsTotal,
  providerCallDurationSeconds,
  providerErrorsTotal,
  categorizeError,
} from "../lib/metrics.ts";
import { ArtifactType, ArtifactStatus, CardStatus, ReviewStatus, ValidationOutcome, AssessmentSource, SubmissionStatus, TerminalReason, QuestionStatus, isRubricEvaluationEnabled, isEffectiveHardEvidence, type ValidationFeedback,  } from "@ailearn/shared";
import { computeSourceFingerprint } from "@ailearn/shared/fingerprint";
import {
  evaluateRubricOutputSchema,
  reduceRubric,
  toReviewOutcome,
  calculateSchedule,
  RUBRIC_REDUCER_VERSION,
  type EvaluateRubricInput,
  type EvaluateRubricOutput,
  type RubricItemInput,
} from "@ailearn/shared";
import type { JobPayload } from "./index.ts";
import {
  computeFSRSShadowDecision,
  isFSRSShadowEnabled,
  type FSRSShadowInput,
} from "../lib/fsrs-shadow.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";

const QUESTION_PROMPT_VERSION = "question-v1";

// ─── Main Handler ────────────────────────────────────────────────────────

/**
 * 计划 §8.3/§8.7：review 上下文 submission 进入 stale 终态时，同事务把仍处于
 * started 的 review attempt 置为 abandoned（input schedule 保持 pending）。
 */
async function abandonStartedAttemptForSubmission(
  tx: Parameters<Parameters<typeof withJobTransaction>[1]>[0],
  workspaceId: string,
  submission: { context: string; reviewAttemptId: string | null },
): Promise<void> {
  if (submission.context !== "review" || !submission.reviewAttemptId) return;
  const now = new Date();
  await tx
    .update(schema.reviewAttempts)
    .set({ status: "abandoned", abandonedAt: now, updatedAt: now })
    .where(and(
      eq(schema.reviewAttempts.id, submission.reviewAttemptId),
      eq(schema.reviewAttempts.workspaceId, workspaceId),
      eq(schema.reviewAttempts.status, "started"),
    ));
}

export async function runEvaluateRubric(job: JobPayload) {
  const submissionId = job.payload.submissionId as string | undefined;
  if (!submissionId) throw new Error("missing submissionId in payload");

const userId = requireAuditUserId(job);
  await assertJobLease(leaseContext(job));
  logger.info({ submissionId }, "running evaluate_rubric");

  // ── 1. Read submission, question, rubric items ────────────────────────

  const submission = await db.query.validationSubmissions.findFirst({
    where: and(
      eq(schema.validationSubmissions.id, submissionId),
      eq(schema.validationSubmissions.workspaceId, job.workspaceId),
      eq(schema.validationSubmissions.userId, userId),
    ),
  });

  if (!submission) throw new Error(`submission ${submissionId} not found`);
  if (submission.status !== SubmissionStatus.EVALUATION_PENDING) {
    logger.info({ submissionId, status: submission.status }, "evaluate_rubric skipped — submission not in evaluation_pending");
    return;
  }

  if (!submission.userAnswer) throw new Error("submission has no locked user answer");
  if (!submission.questionId) throw new Error("submission has no question bound");

  const question = await db.query.validationQuestions.findFirst({
    where: and(
      eq(schema.validationQuestions.id, submission.questionId),
      eq(schema.validationQuestions.workspaceId, job.workspaceId),
    ),
  });
  if (!question) throw new Error(`question ${submission.questionId} not found`);

  // Load rubric items
  const rubricItems = await db.query.validationQuestionRubricItems.findMany({
    where: and(
      eq(schema.validationQuestionRubricItems.questionId, question.id),
      eq(schema.validationQuestionRubricItems.workspaceId, job.workspaceId),
    ),
    orderBy: sql`${schema.validationQuestionRubricItems.ordinal} ASC`,
  });

  if (rubricItems.length === 0) {
    throw new Error(`no rubric items found for question ${question.id}`);
  }

  // ── 2. Build provider input (净化：不含 expectedConcept) ────────────────

  const providerRubricItems: EvaluateRubricInput["rubricItems"] = rubricItems.map((item) => ({
    rubricItemId: item.id,
    criterion: item.criterion,
    weight: item.weight,
    required: item.required,
  }));

  const providerInput: EvaluateRubricInput = {
    question: question.question,
    questionType: question.questionType,
    userAnswer: submission.userAnswer,
    rubricItems: providerRubricItems,
  };

  // ── 3. Resolve governance and call provider (gated by RUBRIC_EVALUATION_V1_ENABLED, 计划 §12.2) ──

  // Feature flag: when RUBRIC_EVALUATION_V1_ENABLED=false, fail closed —
  // enter evaluation_retryable without calling the AI provider.
  // The user's answer is preserved; no assessment/outcome/schedule is written.
  // (计划 §12.2: "不能恢复客户端 outcome 的升级权力")
  if (!isRubricEvaluationEnabled()) {
    logger.info({ submissionId }, "RUBRIC_EVALUATION_V1_ENABLED is false — entering evaluation_retryable (fail closed)");
    await markEvaluationRetryable(job, submissionId, "rubric_evaluation_disabled");
    throw new Error("RUBRIC_EVALUATION_V1_ENABLED is false — rubric evaluation is disabled");
  }

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) {
    throw new AIConsentRequiredError();
  }

  // R3: Route text_generation tasks to a potentially different (cheaper) provider
  const textRes = resolveProviderForTask(govCtx, "evaluate_rubric");

  const governanceResult = enforcePrivacyGovernanceWithPolicy(
    govCtx.policy,
    job.workspaceId,
    ["question", "user_answer", "claim"],
    {
      question: question.question,
      questionType: question.questionType,
      userAnswer: submission.userAnswer,
    },
    textRes.providerName,
  );
  if (!governanceResult.allowed) {
    // 2026-08-12+（15a 根因修复）：policy 拒绝（sendToExternal=false 等）本质
    // 是"用户未在设置里开启 AI 数据发送/签署协议"——抛 AIConsentRequiredError
    //（code=ai_consent_required，不可重试），前端据此引导用户去设置页。
    throw new AIConsentRequiredError();
  }

  const provider = createProvider(textRes.providerName, textRes.providerConfig);
  const aiCallStart = Date.now();

  let evalOutput: EvaluateRubricOutput | null = null;
  let aiError: Error | null = null;
  let rubricUsage: { totalTokens?: number | null } | null = null;

  try {
    const result = await runWithAbortBudget(
      (signal) => evaluateRubricViaChat(provider, providerInput, signal),
      job.signal,
      resolveProviderCallTimeout("evaluate_validation"),
      (lateError) => logger.warn(
        { submissionId, err: lateError },
        "rubric provider settled after its call budget expired",
      ),
    );
    rubricUsage = result.usage;
    const parsed = evaluateRubricOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`evaluateRubric output schema validation failed: ${parsed.error.message}`);
    }
    evalOutput = parsed.data;
    providerCallsTotal.labels("evaluate_rubric", "success").inc();
    providerCallDurationSeconds.labels("evaluate_rubric").observe((Date.now() - aiCallStart) / 1000);
  } catch (err) {
    aiError = err instanceof Error ? err : new Error(String(err));
    providerCallsTotal.labels("evaluate_rubric", "failed").inc();
    providerCallDurationSeconds.labels("evaluate_rubric").observe((Date.now() - aiCallStart) / 1000);
    providerErrorsTotal.labels("evaluate_rubric", categorizeError(err)).inc();
  }

  // ── 4. Validate output: one-to-one correspondence ─────────────────────

  if (evalOutput) {
    const inputIds = new Set(rubricItems.map((item) => item.id));
    const outputIds = new Set(evalOutput.itemResults.map((r) => r.rubricItemId));

    // Check for unknown IDs
    for (const result of evalOutput.itemResults) {
      if (!inputIds.has(result.rubricItemId)) {
        logger.error(
          // 隐私门禁：unknownId 是模型原始输出，不落原文，只记录前 8 位前缀
          { submissionId, unknownIdPrefix: String(result.rubricItemId).slice(0, 8) },
          "evaluate_rubric: unknown rubricItemId in output",
        );
        evalOutput = null; // Treat as failure
        break;
      }
    }

    // Check for duplicate IDs: itemResults.length must equal the distinct
    // rubric item count. A duplicated rubricItemId would otherwise shadow a
    // second verdict for the same item (`.find()` keeps only the first), so a
    // dropped `contradicted` could silently upgrade understanding (计划 §7.2
    // "没有未知、重复或遗漏 ID"; §7.3 每项恰好一个 assessment).
    if (evalOutput && evalOutput.itemResults.length !== rubricItems.length) {
      logger.error(
        {
          submissionId,
          inputCount: rubricItems.length,
          outputLength: evalOutput.itemResults.length,
        },
        "evaluate_rubric: duplicate rubricItemId in output — rejecting",
      );
      evalOutput = null;
    }

    // Check for missing IDs
    if (evalOutput && outputIds.size !== inputIds.size) {
      logger.error(
        { submissionId, inputCount: inputIds.size, outputCount: outputIds.size },
        "evaluate_rubric: output item count mismatch",
      );
      evalOutput = null;
    }

    // Check answerExcerpt is a real substring of userAnswer. An invented
    // excerpt is a provider contract failure; silently dropping it would hide
    // a grounding violation and still allow an understanding upgrade.
    if (evalOutput) {
      for (const result of evalOutput.itemResults) {
        if (result.answerExcerpt && !submission.userAnswer.includes(result.answerExcerpt)) {
          logger.warn(
            { submissionId, rubricItemId: result.rubricItemId },
            "evaluate_rubric: answerExcerpt is not a substring of userAnswer — rejecting output",
          );
          evalOutput = null;
          break;
        }
      }
    }
  }

  // ── 5. Handle failure → evaluation_retryable ──────────────────────────

  if (!evalOutput) {
    logger.warn(
      { submissionId, error: aiError?.message },
      "evaluate_rubric failed — entering evaluation_retryable",
    );
    await markEvaluationRetryable(
      job,
      submissionId,
      aiError ? categorizeError(aiError) : "contract_violation",
    );

    if (await isJobLeaseActive(leaseContext(job))) {
      await logAICall({
        workspaceId: job.workspaceId,
        userId,
        jobId: job.id,
        provider: provider.id,
        modelId: provider.modelId,
        operation: "evaluate_rubric",
      dataCategories: ["question", "user_answer"],
      dataSizeBytes: JSON.stringify(providerInput).length,
      costTokens: rubricUsage?.totalTokens ?? null,
      durationMs: Date.now() - aiCallStart,
      status: "failed",
      errorMessage: aiError?.message ?? "contract violation",
      }, { policy: govCtx.policy });
    }
    throw aiError ?? new Error("evaluate_rubric contract violation");
  }

  // ── 6. Run deterministic reducer ──────────────────────────────────────

  const reducerInputs: RubricItemInput[] = rubricItems.map((item) => {
    const result = evalOutput!.itemResults.find((r) => r.rubricItemId === item.id)!;
    return {
      key: item.id,
      weight: item.weight,
      required: item.required,
      verdict: result.verdict as "covered" | "partial" | "missing" | "contradicted" | "not_assessable",
    };
  });

  const reducerResult = reduceRubric(reducerInputs);
  const reviewOutcome = toReviewOutcome(reducerResult.outcome);

  logger.info(
    {
      submissionId,
      outcome: reducerResult.outcome,
      reviewOutcome,
      coverage: reducerResult.weightedCoverage,
      hasContradiction: reducerResult.hasContradiction,
    },
    "evaluate_rubric: reducer computed outcome",
  );

  // ── 7. Persist in lease-fenced transaction (计划 §8.6) ────────────────

  await assertJobLease(leaseContext(job));

  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, leaseContext(job));
    const transactionNow = new Date();

    // Re-verify submission state
    const [currentSub] = await tx
      .select()
      .from(schema.validationSubmissions)
      .where(and(
        eq(schema.validationSubmissions.id, submissionId),
        eq(schema.validationSubmissions.workspaceId, job.workspaceId),
        eq(schema.validationSubmissions.userId, userId),
        eq(schema.validationSubmissions.currentEvaluationJobId, job.id),
      ))
      .for("update");
    if (!currentSub || currentSub.status !== SubmissionStatus.EVALUATION_PENDING) {
      logger.info({ submissionId, status: currentSub?.status }, "evaluate_rubric: submission state changed, skipping");
      return;
    }

    // Re-read question inside transaction with FOR UPDATE (计划 §8.6: 再次校验 question)
    // The pre-tx `question` snapshot may be stale if the question was marked
    // stale/superseded between the pre-tx read and the transaction.
    const [currentQuestion] = await tx
      .select()
      .from(schema.validationQuestions)
      .where(and(
        eq(schema.validationQuestions.id, currentSub.questionId!),
        eq(schema.validationQuestions.workspaceId, job.workspaceId),
        eq(schema.validationQuestions.userId, userId),
      ))
      .for("update");

    if (!currentQuestion) {
      await tx
        .update(schema.validationSubmissions)
        .set({
          status: SubmissionStatus.STALE,
          failureStage: "evaluation",
          failureCode: "question_not_found",
          terminalReason: TerminalReason.SOURCE_STALE,
          updatedAt: new Date(),
        })
        .where(eq(schema.validationSubmissions.id, submissionId));
      await abandonStartedAttemptForSubmission(tx, job.workspaceId, currentSub);
      logger.warn({ submissionId }, "evaluate_rubric: question not found — marking stale");
      return;
    }

    // Re-verify fingerprint and question validity using transaction-in snapshot
    if (currentSub.sourceFingerprint !== currentQuestion.sourceFingerprint) {
      // Source has changed — mark stale
      await tx
        .update(schema.validationSubmissions)
        .set({
          status: SubmissionStatus.STALE,
          failureStage: "evaluation",
          failureCode: "fingerprint_mismatch",
          terminalReason: TerminalReason.SOURCE_STALE,
          updatedAt: new Date(),
        })
        .where(eq(schema.validationSubmissions.id, submissionId));
      await abandonStartedAttemptForSubmission(tx, job.workspaceId, currentSub);
      logger.warn({ submissionId }, "evaluate_rubric: fingerprint mismatch — marking stale");
      return;
    }

    // Check question expiry using transaction-in snapshot (计划 §7.5: expires_at check in result-write transaction)
    if (currentQuestion.status !== QuestionStatus.ACTIVE) {
      await tx
        .update(schema.validationSubmissions)
        .set({
          status: SubmissionStatus.STALE,
          failureStage: "evaluation",
          failureCode: "question_not_active",
          terminalReason: TerminalReason.SOURCE_STALE,
          updatedAt: new Date(),
        })
        .where(eq(schema.validationSubmissions.id, submissionId));
      await abandonStartedAttemptForSubmission(tx, job.workspaceId, currentSub);
      logger.warn({ submissionId, questionStatus: currentQuestion.status }, "evaluate_rubric: question no longer active — marking stale");
      return;
    }
    if (currentQuestion.expiresAt && currentQuestion.expiresAt <= transactionNow) {
      await tx
        .update(schema.validationSubmissions)
        .set({
          status: SubmissionStatus.STALE,
          failureStage: "evaluation",
          failureCode: "question_expired",
          terminalReason: TerminalReason.SOURCE_STALE,
          updatedAt: new Date(),
        })
        .where(eq(schema.validationSubmissions.id, submissionId));
      await abandonStartedAttemptForSubmission(tx, job.workspaceId, currentSub);
      logger.warn({ submissionId, expiresAt: currentQuestion.expiresAt }, "evaluate_rubric: question expired — marking stale");
      return;
    }

    // Rebuild the question fingerprint from current source state. Comparing
    // only submission.sourceFingerprint to the stored question fingerprint is
    // insufficient because both are immutable snapshots and can agree after
    // the underlying claim/evidence has changed.
    const txRubricItems = await tx.query.validationQuestionRubricItems.findMany({
      where: and(
        eq(schema.validationQuestionRubricItems.questionId, currentQuestion.id),
        eq(schema.validationQuestionRubricItems.workspaceId, job.workspaceId),
      ),
      orderBy: sql`${schema.validationQuestionRubricItems.ordinal} ASC`,
    });
    const [currentKeyPoint, currentCard] = await Promise.all([
      currentQuestion.keyPointId
        ? tx.query.cardKeyPoints.findFirst({
            where: and(
              eq(schema.cardKeyPoints.id, currentQuestion.keyPointId),
              eq(schema.cardKeyPoints.cardId, currentQuestion.cardId),
              eq(schema.cardKeyPoints.workspaceId, job.workspaceId),
            ),
          })
        : undefined,
      tx.query.learningCards.findFirst({
        where: and(
          eq(schema.learningCards.id, currentQuestion.cardId),
          eq(schema.learningCards.workspaceId, job.workspaceId),
          eq(schema.learningCards.status, CardStatus.ACTIVE),
        ),
      }),
    ]);

    if (!currentKeyPoint || !currentCard || currentSub.keyPointId !== currentQuestion.keyPointId) {
      await tx
        .update(schema.validationSubmissions)
        .set({
          status: SubmissionStatus.STALE,
          failureStage: "evaluation",
          failureCode: "source_mutated",
          terminalReason: TerminalReason.SOURCE_STALE,
          updatedAt: transactionNow,
        })
        .where(eq(schema.validationSubmissions.id, submissionId));
      await abandonStartedAttemptForSubmission(tx, job.workspaceId, currentSub);
      logger.warn({ submissionId }, "evaluate_rubric: source missing or rebound — marking stale");
      return;
    }

    const currentEvidenceRows = await tx.execute<{
      id: string;
      block_id: string | null;
      quote_text: string;
      alignment: string;
      effective_override: string | null;
    }>(sql`
      SELECT e.id, e.block_id, e.quote_text, e.alignment,
             COALESCE(eo.override, e.user_override) AS effective_override
      FROM evidences e
      LEFT JOIN evidence_overrides eo
        ON eo.evidence_id = e.id
       AND eo.user_id = ${userId}
       AND eo.workspace_id = e.workspace_id
      WHERE e.key_point_id = ${currentKeyPoint.id}
        AND e.workspace_id = ${job.workspaceId}
    `);
    const currentHardEvidence = currentEvidenceRows.filter((evidence) =>
      isEffectiveHardEvidence(evidence.alignment, evidence.effective_override)
    );
    const currentFingerprint = computeSourceFingerprint({
      workspaceId: job.workspaceId,
      userId,
      cardId: currentQuestion.cardId,
      keyPointId: currentKeyPoint.id,
      claim: currentKeyPoint.claim,
      quote: currentKeyPoint.quoteText,
      noteVersionId: currentCard.noteVersionId,
      noteContentHash: currentCard.noteVersionId,
      evidence: currentHardEvidence.map((evidence) => ({
        evidenceId: evidence.id,
        blockId: evidence.block_id,
        quoteHash: createHash("sha256").update(evidence.quote_text, "utf8").digest("hex"),
        alignment: "aligned",
        override: evidence.effective_override,
      })),
      questionPromptVersion: QUESTION_PROMPT_VERSION,
      rubricPolicyVersion: RUBRIC_REDUCER_VERSION,
    });

    if (currentFingerprint !== currentQuestion.sourceFingerprint) {
      await tx
        .update(schema.validationSubmissions)
        .set({
          status: SubmissionStatus.STALE,
          failureStage: "evaluation",
          failureCode: "source_fingerprint_changed",
          terminalReason: TerminalReason.SOURCE_STALE,
          updatedAt: transactionNow,
        })
        .where(eq(schema.validationSubmissions.id, submissionId));
      await abandonStartedAttemptForSubmission(tx, job.workspaceId, currentSub);
      logger.warn({ submissionId }, "evaluate_rubric: live source fingerprint changed — marking stale");
      return;
    }

    const hardEvidenceIds = new Set(currentHardEvidence.map((evidence) => evidence.id));
    const hasHardEvidence = txRubricItems.length > 0 && txRubricItems.every(
      (item) => item.evidenceId !== null && hardEvidenceIds.has(item.evidenceId),
    );

    // 7a. Write validation feedback artifact (use currentSub for tx-in snapshot)
    // 计划 §6.6: 开始真实写入 input_hash
    const inputHash = createHash("sha256").update(JSON.stringify(providerInput), "utf8").digest("hex");
    const [artifact] = await tx
      .insert(schema.aiArtifacts)
      .values({
        workspaceId: job.workspaceId,
        type: ArtifactType.RUBRIC_EVALUATION, // 计划 §6.6: v0.6 rubric evaluation uses RUBRIC_EVALUATION, not legacy VALIDATION_FEEDBACK
        inputRefs: {
          cardId: currentSub.cardId,
          keyPointId: currentSub.keyPointId ?? undefined,
          userId,
        },
        output: {
          submissionId,
          questionId: currentQuestion.id,
          itemResults: evalOutput.itemResults,
          feedback: evalOutput.feedback,
          reducerResult,
          reviewOutcome,
        },
        modelId: provider.modelId,
        promptVersion: provider.promptVersion,
        status: ArtifactStatus.READY,
        inputHash, // 计划 §6.6: 输入指纹，用于幂等去重
        costTokens: rubricUsage?.totalTokens ?? null, // R5: usage from return value
      })
      .returning();

    // 7b. Write point assessments
    await tx.insert(schema.validationPointAssessments).values(
      rubricItems.map((item) => {
        const result = evalOutput!.itemResults.find((r) => r.rubricItemId === item.id)!;
        return {
          workspaceId: job.workspaceId,
          userId,
          submissionId,
          rubricItemId: item.id,
          verdict: result.verdict,
          assessmentSource: AssessmentSource.AI,
          confidence: Math.round(result.confidence * 100),
          rationale: result.rationale,
          answerExcerpt: result.answerExcerpt ?? null,
          evidenceSnapshot: item.evidenceSnapshot,
        };
      }),
    );

      // 7c. Write validation event (use currentSub and currentQuestion for tx-in snapshot)
    const feedback: ValidationFeedback = {
      outcome: reducerResult.outcome as ValidationOutcome,
      confidence: Math.round(reducerResult.weightedCoverage * 100),
      coveredPoints: evalOutput.itemResults
        .filter((r) => r.verdict === "covered")
        .map((r) => r.rationale.slice(0, 100)),
      missingPoints: evalOutput.itemResults
        .filter((r) => r.verdict === "missing" || r.verdict === "partial")
        .map((r) => r.rationale.slice(0, 100)),
      misunderstandings: evalOutput.itemResults
        .filter((r) => r.verdict === "contradicted")
        .map((r) => r.rationale.slice(0, 100)),
      evidenceRefs: [],
      feedback: evalOutput.feedback,
    };

    const [ve] = await tx
      .insert(schema.validationEvents)
      .values({
        workspaceId: job.workspaceId,
        userId,
        cardId: currentSub.cardId,
        keyPointId: currentSub.keyPointId,
        artifactId: artifact.id,
        question: currentQuestion.question,
        questionType: currentQuestion.questionType,
        userAnswer: currentSub.userAnswer ?? "",
        outcome: reducerResult.outcome,
        confidence: Math.round(reducerResult.weightedCoverage * 100),
        feedback,
        submissionId,
        questionId: currentQuestion.id,
        noteVersionId: currentQuestion.noteVersionId, // 计划 §6.6: note_version_id
        rubricVersion: RUBRIC_REDUCER_VERSION,
        reducerVersion: RUBRIC_REDUCER_VERSION,
        sourceFingerprint: currentSub.sourceFingerprint,
        sourceStatus: currentQuestion.status,
        jobId: job.id,
      })
      .returning();

    // 7d. Scheduling pre-checks (计划 §8.6 context branch steps 1-2)
    // Understanding event and schedule must only be written if pre-check passes.
    // (计划 §8.6: "若公共步骤 2 失败，允许保存 stale 历史反馈，
    //  但 schedule 与 understanding 副作用均不得发生")
    let currentIntervalDays = 1;
    let inputSchedule: typeof schema.reviewSchedules.$inferSelect | undefined;
    let schedulingPreCheckFailed = false;
    let schedulingFailureCode = "scheduling_pre_check_failed";

    if (currentSub.context === "initial_validation") {
      // Step 1: Assert no review_attempt_id/input_schedule_id (计划 §8.6 initial branch step 1)
      if (currentSub.reviewAttemptId || currentSub.inputScheduleId) {
        schedulingPreCheckFailed = true;
        schedulingFailureCode = "invalid_context_state";
      }
      // Step 2: Check for existing pending schedule (计划 §8.6 initial branch step 2:
      // "若已经存在 pending schedule，判为并发冲突并置 stale，不覆盖既有 schedule")
      if (!schedulingPreCheckFailed && currentSub.keyPointId) {
        const existingPending = await tx.query.reviewSchedules.findFirst({
          where: and(
            eq(schema.reviewSchedules.workspaceId, job.workspaceId),
            eq(schema.reviewSchedules.userId, userId),
            eq(schema.reviewSchedules.keyPointId, currentSub.keyPointId),
            eq(schema.reviewSchedules.status, ReviewStatus.PENDING),
          ),
        });
        if (existingPending) {
          schedulingPreCheckFailed = true;
          schedulingFailureCode = "concurrent_schedule_conflict";
        }
      }
    } else if (currentSub.context === "review" && currentSub.reviewAttemptId && currentSub.inputScheduleId) {
      // Step 1: Lock review attempt (计划 §8.6 review branch step 1:
      // "断言并锁 review_attempt_id 与其精确的 input_schedule_id")
      const [reviewAttempt] = await tx
        .select()
        .from(schema.reviewAttempts)
        .where(eq(schema.reviewAttempts.id, currentSub.reviewAttemptId))
        .for("update");
      if (!reviewAttempt || reviewAttempt.status !== "started") {
        schedulingPreCheckFailed = true;
        schedulingFailureCode = "review_attempt_not_active";
      } else if (reviewAttempt.reviewScheduleId !== currentSub.inputScheduleId) {
        // 计划 §8.6 review 分支 step 1：断言 attempt 绑定的正是本 submission 的
        // 精确 input schedule；不一致时若继续，后续按 reviewScheduleId 过滤的
        // completion UPDATE 会命中 0 行，attempt 将永远停留在 started。
        schedulingPreCheckFailed = true;
        schedulingFailureCode = "review_attempt_schedule_mismatch";
      }
      // Step 2: Lock input schedule and verify still PENDING (计划 §8.6 review branch step 2:
      // "校验该 schedule 仍是当前 user/key point 唯一 pending 输入")
      const [lockedSchedule] = await tx
        .select()
        .from(schema.reviewSchedules)
        .where(eq(schema.reviewSchedules.id, currentSub.inputScheduleId))
        .for("update");
      inputSchedule = lockedSchedule;
      currentIntervalDays = lockedSchedule?.intervalDays ?? 1;
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
      await tx
        .update(schema.validationSubmissions)
        .set({
          status: SubmissionStatus.STALE,
          failureStage: "scheduling",
          failureCode: schedulingFailureCode,
          terminalReason: TerminalReason.SOURCE_STALE,
          validationEventId: ve.id,
          updatedAt: new Date(),
        })
        .where(eq(schema.validationSubmissions.id, submissionId));
      await abandonStartedAttemptForSubmission(tx, job.workspaceId, currentSub);
      logger.warn(
        { submissionId, failureCode: schedulingFailureCode },
        "evaluate_rubric: scheduling pre-check failed — marking stale",
      );
      return;
    }

    // 7e-pre. Compute hasHardEvidence BEFORE writing understanding event
    // (计划 §4.1: "0 次无当前用户有效硬证据的理解升级" — must check evidence
    // validity before determining understanding event type, otherwise a
    // "validated" event could be written when evidence was deleted after
    // question generation, violating the invariant).
    //
    // hasHardEvidence: re-read rubric items inside transaction to get tx-in evidenceId
    // (计划 §8.6: "再次校验 evidence" — pre-tx rubricItems may have stale evidenceId
    // if evidence was deleted between pre-tx read and transaction execution, since
    // the FK has onDelete: "set null")

    // 7e. Write understanding event (moved after scheduling pre-check — only if pre-check passes)
    // If hasHardEvidence is false, downgrade eventType to "seen" to prevent
    // understanding upgrade without valid hard evidence (计划 §4.1 不变量).
    const reducerEventType =
      reducerResult.outcome === ValidationOutcome.MISUNDERSTANDING
        ? "misunderstood"
        : reducerResult.outcome === ValidationOutcome.PRELIMINARY_UNDERSTANDING
          ? "validated"
          : "seen";
    // Downgrade to "seen" when (a) no current valid hard evidence (计划 §4.1
    // "0 次无当前用户有效硬证据的理解升级"), or (b) the submission is assisted
    // (source_viewed): 计划 §7.4 要求 assisted 结果 understandingEffect=unchanged，
    // 之前只降级了 schedule 分支，understanding event 仍会写 validated。
    const isAssisted = currentSub.assistanceLevel != null
      && currentSub.assistanceLevel !== "none";
    const eventType = (reducerEventType === "validated" && (!hasHardEvidence || isAssisted))
      ? "seen"  // Downgrade: no hard evidence / assisted → no understanding upgrade
      : reducerEventType;
    await tx.insert(schema.understandingEvents).values({
      workspaceId: job.workspaceId,
      userId,
      subjectType: "validation",
      subjectId: ve.id,
      eventType,
      payload: {
        outcome: reducerResult.outcome,
        coverage: reducerResult.weightedCoverage,
        reducerVersion: RUBRIC_REDUCER_VERSION,
        hasHardEvidence,  // Record evidence state for auditability
      },
    });

    // 7f. Apply scheduling based on context (initial_validation or review)
    // Load assistance exposure for cooldown gate
    let unassistedEligibleAfter: Date | null = null;
    if (currentSub.keyPointId) {
      const exposure = await tx.query.validationAssistanceExposures.findFirst({
        where: and(
          eq(schema.validationAssistanceExposures.workspaceId, job.workspaceId),
          eq(schema.validationAssistanceExposures.userId, userId),
          eq(schema.validationAssistanceExposures.keyPointId, currentSub.keyPointId),
        ),
        orderBy: sql`${schema.validationAssistanceExposures.unassistedEligibleAfter} DESC`,
      });
      unassistedEligibleAfter = exposure?.unassistedEligibleAfter ?? null;
    }

    // Map assistance level to scheduling outcome (计划 §8.6 step 5)
    // source_viewed → understanding unchanged, due not earlier than max(now+1d, unassisted_eligible_after)
    // Use currentSub (FOR UPDATE re-read) instead of submission (pre-tx snapshot)
    const scheduleOutcome = currentSub.assistanceLevel === "source_viewed"
      ? "source_viewed" as const
      : reviewOutcome as "correct" | "partial" | "incorrect" | "unable" | "source_viewed" | "later" | "stale" | "provider_failure";

    // Compute scheduling guards from verified state (using transaction-in snapshot)
    // Use a single captured `now` for consistency across all time-dependent checks
    // (计划 §8.6: result-write transaction must use consistent timestamp)
    const schedulingNow = transactionNow;
    const hasValidServerQuestion = currentQuestion.status === QuestionStatus.ACTIVE
      && (!currentQuestion.expiresAt || currentQuestion.expiresAt > schedulingNow)
      && currentSub.sourceFingerprint === currentQuestion.sourceFingerprint;

    const scheduleResult = calculateSchedule({
      currentIntervalDays,
      outcome: scheduleOutcome as string,
      hasValidServerQuestion,
      hasHardEvidence,
      now: schedulingNow,
      unassistedEligibleAfter,
    });

    if (scheduleResult.shouldMutateSchedule) {
      if (currentSub.context === "initial_validation") {
        // Create first pending schedule (计划 §8.6 initial branch step 4:
        // "按 discrete-v2 创建首条唯一 pending schedule")
        // No supersede — plan §8.6 step 2 says "不覆盖既有 schedule"
        await tx.insert(schema.reviewSchedules).values({
          workspaceId: job.workspaceId,
          userId,
          subjectType: "key_point",
          subjectId: currentSub.keyPointId!,
          validationEventId: ve.id,
          status: ReviewStatus.PENDING,
          nextReviewAt: scheduleResult.nextReviewAt,
          intervalDays: scheduleResult.afterIntervalDays,
          keyPointId: currentSub.keyPointId,
          policyVersion: scheduleResult.policyVersion,
          reasonCode: scheduleResult.reasonCode,
        });
      } else if (currentSub.context === "review" && currentSub.reviewAttemptId && currentSub.inputScheduleId) {
        // Complete input schedule (计划 §8.6 review branch step 4)
        await tx
          .update(schema.reviewSchedules)
          .set({
            status: ReviewStatus.COMPLETED,
          })
          .where(
            and(
              eq(schema.reviewSchedules.id, currentSub.inputScheduleId),
              eq(schema.reviewSchedules.workspaceId, job.workspaceId),
            ),
          );

        // Create successor schedule (计划 §8.6 review branch step 4)
        const [nextSchedule] = await tx
          .insert(schema.reviewSchedules)
          .values({
            workspaceId: job.workspaceId,
            userId,
            subjectType: "key_point",
            subjectId: currentSub.keyPointId!,
            validationEventId: ve.id,
            status: ReviewStatus.PENDING,
            nextReviewAt: scheduleResult.nextReviewAt,
            intervalDays: scheduleResult.afterIntervalDays,
            keyPointId: currentSub.keyPointId,
            generation: (inputSchedule?.generation ?? 0) + 1, // 计划 §6.6: generation increments for successor
            policyVersion: scheduleResult.policyVersion,
            reasonCode: scheduleResult.reasonCode,
            supersedesScheduleId: currentSub.inputScheduleId,
          })
          .returning({ id: schema.reviewSchedules.id });

        // Complete the attempt with the immutable evaluation and scheduling
        // projection required by reveal/history/export. Persisting only status
        // left the completed review impossible to audit.
        await tx
          .update(schema.reviewAttempts)
          .set({
            validationEventId: ve.id,
            validationQuestionId: currentQuestion.id,
            noteVersionId: currentQuestion.noteVersionId,
            outcome: reducerResult.outcome,
            confidence: Math.round(reducerResult.weightedCoverage * 100),
            scheduleBeforeIntervalDays: currentIntervalDays,
            scheduleAfterIntervalDays: scheduleResult.afterIntervalDays,
            scheduleReasonCode: scheduleResult.reasonCode,
            understandingEffect: scheduleResult.understandingEffect,
            nextReviewAt: scheduleResult.nextReviewAt,
            nextScheduleId: nextSchedule.id,
            evaluationArtifactId: artifact.id,
            evaluationStatus: SubmissionStatus.COMPLETED,
            assistanceLevel: currentSub.assistanceLevel,
            policyVersion: scheduleResult.policyVersion,
            sourceFingerprint: currentSub.sourceFingerprint,
            status: "completed",
            completedAt: schedulingNow,
            updatedAt: schedulingNow,
          })
          .where(
            and(
              eq(schema.reviewAttempts.id, currentSub.reviewAttemptId),
              eq(schema.reviewAttempts.workspaceId, job.workspaceId),
              eq(schema.reviewAttempts.userId, userId),
              eq(schema.reviewAttempts.reviewScheduleId, currentSub.inputScheduleId),
              eq(schema.reviewAttempts.status, "started"),
            ),
          );
      }
    }

    // 7f-bis. FSRS shadow decision (计划 §6.8, §10.6)
    // Shadow writes do NOT affect the official schedule.
    // Only unassisted results produce valid training events.
    if (isFSRSShadowEnabled()) {
      const isUnassisted = currentSub.assistanceLevel === "none";
      const fsrsInput: FSRSShadowInput = {
        workspaceId: job.workspaceId,
        userId,
        keyPointId: currentSub.keyPointId,
        sourceType: currentSub.context === "review" ? "review_attempt" : "validation_event",
        sourceId: currentSub.context === "review" && currentSub.reviewAttemptId
          ? currentSub.reviewAttemptId
          : ve.id,
        // 快照必须存"决策前"的正式区间：离线对比报告把 currentIntervalDays
        // 作为 pre-event interval 重放 discrete-v2；存 after 值会导致相同历史
        // 重放出不同的正式决策（§10.6 回放语义）。
        currentIntervalDays,
        outcome: scheduleOutcome as "correct" | "partial" | "incorrect" | "unable" | "source_viewed" | "stale" | "provider_failure",
        now: schedulingNow,
        isUnassisted,
      };
      const shadowDecision = computeFSRSShadowDecision(fsrsInput);
      if (shadowDecision) {
        await tx
          .insert(schema.schedulingShadowDecisions)
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

    // 7g. Complete submission
    await tx
      .update(schema.validationSubmissions)
      .set({
        status: SubmissionStatus.COMPLETED,
        validationEventId: ve.id,
        currentEvaluationJobId: job.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.validationSubmissions.id, submissionId));

    throwIfJobAborted(job);
    logger.info(
      {
        submissionId,
        validationEventId: ve.id,
        outcome: reducerResult.outcome,
        reviewOutcome,
        intervalDays: scheduleResult.afterIntervalDays,
        nextReviewAt: scheduleResult.nextReviewAt,
      },
      "evaluate_rubric: submission completed",
    );
  });

  // ── 8. Log success ────────────────────────────────────────────────────

  if (await isJobLeaseActive(leaseContext(job))) {
    await logAICall({
      workspaceId: job.workspaceId,
      userId,
      jobId: job.id,
      provider: provider.id,
      modelId: provider.modelId,
      operation: "evaluate_rubric",
      dataCategories: ["question", "user_answer"],
      dataSizeBytes: JSON.stringify(providerInput).length,
      costTokens: rubricUsage?.totalTokens ?? null,
      durationMs: Date.now() - aiCallStart,
      status: "success",
    }, { policy: govCtx.policy });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function leaseContext(job: JobPayload): JobLeaseContext {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    requestedBy: job.requestedBy,
    leaseToken: job.leaseToken,
    signal: job.signal,
  };
}

function requireAuditUserId(
  job: Pick<JobPayload, "requestedBy" | "payload">,
): string {
  const userId = job.requestedBy;
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("missing trusted requestedBy actor; refusing to fabricate AI audit attribution");
  }
  return userId;
}

async function markEvaluationRetryable(
  job: JobPayload,
  submissionId: string,
  failureCode: string,
): Promise<void> {
  const userId = requireAuditUserId(job);
  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, leaseContext(job));
    await tx
      .update(schema.validationSubmissions)
      .set({
        status: SubmissionStatus.EVALUATION_RETRYABLE,
        failureStage: "evaluation",
        failureCode,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.validationSubmissions.id, submissionId),
        eq(schema.validationSubmissions.workspaceId, job.workspaceId),
        eq(schema.validationSubmissions.userId, userId),
        eq(schema.validationSubmissions.status, SubmissionStatus.EVALUATION_PENDING),
        eq(schema.validationSubmissions.currentEvaluationJobId, job.id),
      ));
  });
}
