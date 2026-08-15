/**
 * v0.6 Handler: generate_validation_question (计划 §8.1, §8.5)
 *
 * 流程：
 * 1. 读取 keyPoint、evidence、note version 数据
 * 2. 组装 GenerateValidationQuestionInput（opaque evidence refs）
 * 3. 调用 generateValidationQuestionViaChat(provider, input) → chatCompletion + zod 校验
 * 4. 用 schema 校验输出
 * 5. 运行 assessQuestionOutput 安全门禁
 * 6. 安全门禁失败 → 切到 deterministic fallback
 * 7. fallback 也失败 → 标记 submission 为 question_blocked
 * 8. 事务内：写 artifact、question、rubric items，推进 submission 到 ready
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { generateValidationQuestionViaChat } from "../lib/business-ai-ops.ts";
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
import {
  ArtifactType,
  ArtifactStatus,
  CardStatus,
  GeneratorKind,
  QuestionStatus,
  SubmissionStatus,
  TerminalReason,
  isAIQuestionEnabled,
  isEffectiveHardEvidence,
} from "@ailearn/shared";
import { generateValidationQuestionOutputSchema, assessQuestionOutput, generateDeterministicQuestion, RUBRIC_REDUCER_VERSION, type GenerateValidationQuestionOutput, type GenerateValidationQuestionInput, type QuestionSafetyReport,  } from "@ailearn/shared";
import { computeSourceFingerprint } from "@ailearn/shared/fingerprint";
import type { JobPayload } from "./index.ts";
import type { WorkerTransaction } from "../db.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";

// ─── Constants ───────────────────────────────────────────────────────────

const QUESTION_PROMPT_VERSION = "question-v1";
const RUBRIC_VERSION = "rubric-v1";

// ─── Main Handler ────────────────────────────────────────────────────────

export async function runGenerateValidationQuestion(job: JobPayload) {
  const keyPointId = job.payload.keyPointId as string | undefined;
  const cardId = job.payload.cardId as string | undefined;
  const userId = requireAuditUserId(job);
  const submissionIds = (job.payload.submissionIds as string[] | undefined) ?? [];

  if (!keyPointId) throw new Error("missing keyPointId in payload");
  if (!cardId) throw new Error("missing cardId in payload");

  await assertJobLease(leaseContext(job));
  logger.info({ keyPointId, cardId, submissionIds }, "running generate_validation_question");

  // ── 1. Query key point, card, evidence, and governance context ────────

  const [kp, card, govCtx] = await Promise.all([
    db.query.cardKeyPoints.findFirst({
      where: and(
        eq(schema.cardKeyPoints.id, keyPointId),
        eq(schema.cardKeyPoints.workspaceId, job.workspaceId),
        eq(schema.cardKeyPoints.cardId, cardId),
      ),
    }),
    db.query.learningCards.findFirst({
      where: and(
        eq(schema.learningCards.id, cardId),
        eq(schema.learningCards.workspaceId, job.workspaceId),
        eq(schema.learningCards.status, CardStatus.ACTIVE),
      ),
    }),
    resolveAIGovernanceContext(job.workspaceId, userId),
  ]);

  if (!kp) throw new Error(`key point ${keyPointId} not found in workspace`);
  if (!card) throw new Error(`card ${cardId} not found or not active in workspace`);
  if (!govCtx.consentOk) {
    throw new AIConsentRequiredError();
  }

  // Query hard evidence for this key point and user
  // Priority: aligned > soft, then by alignment_score desc
  // Exclude rejected/downgraded evidence
  // N-005: Join with evidence_overrides table to respect per-user overrides
  const evidenceRows = await db.execute<{
    id: string;
    block_id: string | null;
    alignment: string;
    alignment_score: number;
    user_override: string | null;
    effective_override: string | null;
    quote_text: string;
    block_content: string | null;
  }>(sql`
    SELECT e.id, e.block_id, e.alignment, e.alignment_score, e.user_override,
           COALESCE(eo.override, e.user_override) AS effective_override,
           e.quote_text, nb.content AS block_content
    FROM evidences e
    LEFT JOIN note_blocks nb ON nb.id = e.block_id AND nb.workspace_id = e.workspace_id
    LEFT JOIN evidence_overrides eo ON eo.evidence_id = e.id AND eo.user_id = ${userId}
    WHERE e.key_point_id = ${keyPointId}
      AND e.workspace_id = ${job.workspaceId}
    ORDER BY
      CASE
        WHEN COALESCE(eo.override, e.user_override) = 'confirmed' OR e.alignment = 'aligned' THEN 0
        WHEN e.alignment = 'soft' THEN 1
        ELSE 2
      END,
      e.alignment_score DESC
  `);

  const validEvidence = evidenceRows.filter((e) =>
    isEffectiveHardEvidence(e.alignment, e.effective_override)
  );

  if (validEvidence.length === 0) {
    // No hard evidence — fail closed
    logger.warn({ keyPointId }, "no hard evidence for key point — failing closed");
    await markSubmissionsStale(job, submissionIds, "no_hard_evidence");
    return;
  }

  // ── 2. Build provider input with opaque evidence refs ─────────────────

  const evidenceRefMap = new Map<string, {
    evidenceId: string;
    blockId: string | null;
    quoteText: string;
    alignment: "aligned";
    userOverride: string | null;
  }>();
  const evidenceRefs: GenerateValidationQuestionInput["evidenceRefs"] = validEvidence.slice(0, 5).map((ev, idx) => {
    const refId = `ev_${idx + 1}`;
    evidenceRefMap.set(refId, {
      evidenceId: ev.id,
      blockId: ev.block_id,
      quoteText: ev.quote_text,
      alignment: "aligned",
      userOverride: ev.effective_override,
    });
    return {
      refId,
      quoteText: ev.quote_text,
      alignment: "aligned",
    };
  });

  const quote = validEvidence[0].block_content ?? validEvidence[0].quote_text;

  const providerInput: GenerateValidationQuestionInput = {
    claim: kp.claim,
    quote,
    evidenceRefs,
  };

  // ── 3. Compute source fingerprint ─────────────────────────────────────

  const sourceFingerprint = computeSourceFingerprint({
    workspaceId: job.workspaceId,
    userId,
    cardId,
    keyPointId,
    claim: kp.claim,
    quote: kp.quoteText,
    noteVersionId: card.noteVersionId,
    noteContentHash: card.noteVersionId, // Use noteVersionId as content hash proxy; full content hash not available in worker
    evidence: validEvidence.map((ev) => ({
      evidenceId: ev.id,
      blockId: ev.block_id,
      quoteHash: createHash("sha256").update(ev.quote_text, "utf8").digest("hex"),
      alignment: "aligned",
      override: ev.effective_override,
    })),
    questionPromptVersion: QUESTION_PROMPT_VERSION,
    rubricPolicyVersion: RUBRIC_REDUCER_VERSION,
  });

  // ── 4. Call AI provider (gated by AI_QUESTION_V1_ENABLED, 计划 §12.2) ──

  // R3: Route text_generation tasks to a potentially different (cheaper) provider
  const textRes = resolveProviderForTask(govCtx, "generate_question");
  const provider = createProvider(textRes.providerName, textRes.providerConfig);
  const aiCallStart = Date.now();

  let aiOutput: GenerateValidationQuestionOutput | null = null;
  let aiError: Error | null = null;
  let usedFallback = false;
  let questionUsage: { totalTokens?: number | null } | null = null;

  // Feature flag: when AI_QUESTION_V1_ENABLED=false, skip AI provider call
  // and use deterministic fallback only (计划 §12.2: "可以回到...确定性题目")
  const aiQuestionEnabled = isAIQuestionEnabled();

  if (aiQuestionEnabled) {
    // Privacy governance
    const governanceResult = enforcePrivacyGovernanceWithPolicy(
      govCtx.policy,
      job.workspaceId,
      ["claim", "quote"],
      { claim: kp.claim, quote },
      textRes.providerName,
    );
    if (!governanceResult.allowed) {
      // 2026-08-12+（15a 根因修复）：policy 拒绝 → 引导用户去设置页签署协议。
      throw new AIConsentRequiredError();
    }

    try {
      const result = await runWithAbortBudget(
        (signal) => generateValidationQuestionViaChat(provider, providerInput, signal),
        job.signal,
        resolveProviderCallTimeout("generate_validation_question"),
        (lateError) => logger.warn(
          { keyPointId, err: lateError },
          "question provider settled after its call budget expired",
        ),
      );
      questionUsage = result.usage;
      // Validate with schema
      const parsed = generateValidationQuestionOutputSchema.safeParse(result.output);
      if (!parsed.success) {
        throw new Error(`AI question output schema validation failed: ${parsed.error.message}`);
      }
      aiOutput = parsed.data;
      providerCallsTotal.labels("generate_validation_question", "success").inc();
      providerCallDurationSeconds.labels("generate_validation_question").observe((Date.now() - aiCallStart) / 1000);
    } catch (err) {
      aiError = err instanceof Error ? err : new Error(String(err));
      providerCallsTotal.labels("generate_validation_question", "failed").inc();
      providerCallDurationSeconds.labels("generate_validation_question").observe((Date.now() - aiCallStart) / 1000);
      providerErrorsTotal.labels("generate_validation_question", categorizeError(err)).inc();
      logger.warn({ keyPointId, error: aiError.message }, "AI question generation failed — trying deterministic fallback");
    }
  } else {
    logger.info({ keyPointId }, "AI_QUESTION_V1_ENABLED is false — using deterministic fallback only");
  }

  // ── 5. Safety gate + fallback logic ───────────────────────────────────

  let finalOutput: GenerateValidationQuestionOutput;
  let safetyReport: QuestionSafetyReport;
  let generatorKind: string;

  if (aiOutput) {
    // Run safety gate on AI output
    const safetyResult = assessQuestionOutput({
      output: aiOutput,
      claim: kp.claim,
      quote,
      allowedEvidenceRefIds: Array.from(evidenceRefMap.keys()),
    });

    if (safetyResult.passed) {
      finalOutput = aiOutput;
      safetyReport = safetyResult;
      generatorKind = GeneratorKind.AI;
    } else {
      // AI output failed safety — try deterministic fallback
      logger.warn(
        { keyPointId, reasonCodes: safetyResult.reasonCodes },
        "AI question failed safety gate — using deterministic fallback",
      );
      const fallbackOutput = generateDeterministicQuestion(providerInput);
      const fallbackSafety = assessQuestionOutput({
        output: fallbackOutput,
        claim: kp.claim,
        quote,
        allowedEvidenceRefIds: Array.from(evidenceRefMap.keys()),
      });

      if (!fallbackSafety.passed) {
        // Deterministic fallback also failed — this is a release-level bug
        logger.error(
          { keyPointId, reasonCodes: fallbackSafety.reasonCodes },
          "deterministic fallback also failed safety gate — entering question_blocked",
        );
        await markSubmissionsBlocked(job, submissionIds, "unsafe_fallback");
        await logAICall({
          workspaceId: job.workspaceId,
          userId,
          jobId: job.id,
          provider: provider.id,
          modelId: provider.modelId,
          operation: "generate_validation_question",
          dataCategories: ["claim", "quote"],
          dataSizeBytes: JSON.stringify(providerInput).length,
          durationMs: Date.now() - aiCallStart,
          status: "failed",
          errorMessage: "deterministic fallback failed safety gate",
        });
        return;
      }

      finalOutput = fallbackOutput;
      safetyReport = fallbackSafety;
      generatorKind = GeneratorKind.DETERMINISTIC;
      usedFallback = true;
    }
  } else {
    // AI call failed — use deterministic fallback
    const fallbackOutput = generateDeterministicQuestion(providerInput);
    const fallbackSafety = assessQuestionOutput({
      output: fallbackOutput,
      claim: kp.claim,
      quote,
      allowedEvidenceRefIds: Array.from(evidenceRefMap.keys()),
    });

    if (!fallbackSafety.passed) {
      logger.error(
        { keyPointId, reasonCodes: fallbackSafety.reasonCodes, aiError: aiError?.message },
        "deterministic fallback failed safety gate after AI failure — entering question_blocked",
      );
      await markSubmissionsBlocked(job, submissionIds, "unsafe_fallback");
      await logAICall({
        workspaceId: job.workspaceId,
        userId,
        jobId: job.id,
        provider: provider.id,
        modelId: provider.modelId,
        operation: "generate_validation_question",
        dataCategories: ["claim", "quote"],
        dataSizeBytes: JSON.stringify(providerInput).length,
        durationMs: Date.now() - aiCallStart,
        status: "failed",
        errorMessage: `AI failed and deterministic fallback failed safety gate: ${aiError?.message}`,
      });
      return;
    }

    finalOutput = fallbackOutput;
    safetyReport = fallbackSafety;
    generatorKind = GeneratorKind.DETERMINISTIC;
    usedFallback = true;
  }

  // R-007: Check lease after AI call
  await assertJobLease(leaseContext(job));

  // ── 6. Persist in lease-fenced transaction (计划 §8.5) ────────────────

  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, leaseContext(job));

    // Re-compute fingerprint inside transaction (计划 §8.5 step 1)
    // Re-query key point, card, and evidence to detect source mutations
    const [txKp, txCard] = await Promise.all([
      tx.query.cardKeyPoints.findFirst({
        where: and(
          eq(schema.cardKeyPoints.id, keyPointId),
          eq(schema.cardKeyPoints.workspaceId, job.workspaceId),
          eq(schema.cardKeyPoints.cardId, cardId),
        ),
      }),
      tx.query.learningCards.findFirst({
        where: and(
          eq(schema.learningCards.id, cardId),
          eq(schema.learningCards.workspaceId, job.workspaceId),
          eq(schema.learningCards.status, CardStatus.ACTIVE),
        ),
      }),
    ]);

    if (!txKp || !txCard) {
      // Source was deleted or card is no longer active — mark submissions stale
      logger.warn({ keyPointId, cardId }, "source changed during question generation — marking submissions stale");
      await markSubmissionsStale(job, submissionIds, "source_mutated", tx);
      return;
    }

    // Re-query evidence inside transaction
    // N-005: Join with evidence_overrides to respect per-user overrides
    const txEvidenceRows = await tx.execute<{
      id: string;
      block_id: string | null;
      alignment: string;
      alignment_score: number;
      user_override: string | null;
      effective_override: string | null;
      quote_text: string;
    }>(sql`
      SELECT e.id, e.block_id, e.alignment, e.alignment_score, e.user_override,
             COALESCE(eo.override, e.user_override) AS effective_override,
             e.quote_text
      FROM evidences e
      LEFT JOIN evidence_overrides eo ON eo.evidence_id = e.id AND eo.user_id = ${userId}
      WHERE e.key_point_id = ${keyPointId}
        AND e.workspace_id = ${job.workspaceId}
      ORDER BY
        CASE
          WHEN COALESCE(eo.override, e.user_override) = 'confirmed' OR e.alignment = 'aligned' THEN 0
          WHEN e.alignment = 'soft' THEN 1
          ELSE 2
        END,
        e.alignment_score DESC
    `);

    const txValidEvidence = txEvidenceRows.filter((e) =>
      isEffectiveHardEvidence(e.alignment, e.effective_override)
    );

    if (txValidEvidence.length === 0) {
      logger.warn({ keyPointId }, "hard evidence lost during question generation — marking submissions stale");
      await markSubmissionsStale(job, submissionIds, "no_hard_evidence", tx);
      return;
    }

    const txFingerprint = computeSourceFingerprint({
      workspaceId: job.workspaceId,
      userId,
      cardId,
      keyPointId,
      claim: txKp.claim,
      quote: txKp.quoteText,
      noteVersionId: txCard.noteVersionId,
      noteContentHash: txCard.noteVersionId,
      evidence: txValidEvidence.map((ev) => ({
        evidenceId: ev.id,
        blockId: ev.block_id,
        quoteHash: createHash("sha256").update(ev.quote_text, "utf8").digest("hex"),
        alignment: "aligned",
        override: ev.effective_override,
      })),
      questionPromptVersion: QUESTION_PROMPT_VERSION,
      rubricPolicyVersion: RUBRIC_REDUCER_VERSION,
    });

    // If fingerprint changed, source was mutated — discard output and mark stale (计划 §8.5 step 2)
    if (txFingerprint !== sourceFingerprint) {
      logger.warn(
        { keyPointId, oldFingerprint: sourceFingerprint.slice(0, 16), newFingerprint: txFingerprint.slice(0, 16) },
        "source fingerprint changed during question generation — marking submissions stale",
      );
      await markSubmissionsStale(job, submissionIds, "fingerprint_changed", tx);
      return;
    }

    // 6a. Write AI artifact (question draft + safety report)
    // 计划 §6.6: 开始真实写入 input_hash（同 input_hash 的 artifact 可复用而不重复调用模型）
    const inputHash = createHash("sha256").update(JSON.stringify(providerInput), "utf8").digest("hex");
    const [artifact] = await tx
      .insert(schema.aiArtifacts)
      .values({
        workspaceId: job.workspaceId,
        // 计划 §6.6: v0.6 question artifacts use VALIDATION_QUESTION (AI) or DETERMINISTIC_QUESTION (fallback)
        type: generatorKind === GeneratorKind.AI ? ArtifactType.VALIDATION_QUESTION : ArtifactType.DETERMINISTIC_QUESTION,
        inputRefs: {
          cardId,
          keyPointId,
          userId,
        },
        output: {
          ...finalOutput,
          safetyReport,
          generatorKind,
          usedFallback,
        },
        modelId: usedFallback ? "deterministic" : provider.modelId,
        promptVersion: usedFallback ? "deterministic-v1" : provider.promptVersion,
        status: ArtifactStatus.READY,
        inputHash, // 计划 §6.6: 输入指纹，用于幂等去重
        costTokens: usedFallback ? null : (questionUsage?.totalTokens ?? null), // R5: usage from return value
      })
      .returning();

    // 6b. Write validation question
    const [question] = await tx
      .insert(schema.validationQuestions)
      .values({
        workspaceId: job.workspaceId,
        cardId,
        keyPointId,
        noteVersionId: txCard.noteVersionId,
        questionType: finalOutput.questionType,
        question: finalOutput.question,
        createdBy: userId,
        userId,
        artifactId: artifact.id,
        generationJobId: job.id,
        generatorKind,
        status: QuestionStatus.ACTIVE,
        rubricVersion: RUBRIC_VERSION,
        sourceFingerprint: txFingerprint,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30-day expiry (计划 §16 默认)
      })
      .returning();

    // 6c. Write rubric items
    const rubricItemRows = await tx
      .insert(schema.validationQuestionRubricItems)
      .values(
        finalOutput.rubricItems.map((item, idx) => {
          const evidenceInfo = evidenceRefMap.get(item.evidenceRefId);
          return {
            workspaceId: job.workspaceId,
            questionId: question.id,
            ordinal: idx,
            criterion: item.criterion,
            expectedConcept: item.expectedConcept,
            weight: item.weight,
            required: item.required,
            evidenceId: evidenceInfo?.evidenceId ?? null,
            evidenceSnapshot: evidenceInfo
              ? {
                  quoteText: evidenceInfo.quoteText,
                  alignment: evidenceInfo.alignment,
                  noteVersionId: txCard.noteVersionId,
                  blockId: evidenceInfo.blockId ?? undefined,
                  userOverride: evidenceInfo.userOverride ?? undefined,
                }
              : null,
          };
        }),
      )
      .returning();

    // 6d. Advance waiting submissions from question_preparing → ready
    if (submissionIds.length > 0) {
      await tx
        .update(schema.validationSubmissions)
        .set({
          questionId: question.id,
          status: SubmissionStatus.READY,
          sourceFingerprint: txFingerprint,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.validationSubmissions.workspaceId, job.workspaceId),
            inArray(schema.validationSubmissions.id, submissionIds),
            eq(schema.validationSubmissions.status, SubmissionStatus.QUESTION_PREPARING),
            eq(schema.validationSubmissions.currentGenerationJobId, job.id),
          ),
        );
    }

    throwIfJobAborted(job);
    logger.info(
      {
        questionId: question.id,
        rubricItems: rubricItemRows.length,
        generatorKind,
        usedFallback,
        submissionIds,
      },
      "validation question persisted",
    );
  });

  // ── 7. Log success ────────────────────────────────────────────────────

  if (await isJobLeaseActive(leaseContext(job))) {
    await logAICall({
      workspaceId: job.workspaceId,
      userId,
      jobId: job.id,
      provider: usedFallback ? "deterministic" : provider.id,
      modelId: usedFallback ? "deterministic" : provider.modelId,
      operation: "generate_validation_question",
      dataCategories: ["claim", "quote"],
      dataSizeBytes: JSON.stringify(providerInput).length,
      costTokens: usedFallback ? null : (questionUsage?.totalTokens ?? null),
      durationMs: Date.now() - aiCallStart,
      status: "success",
    });
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

/**
 * Mark submissions as stale (e.g., when hard evidence is no longer available).
 * Accepts an optional transaction client for use inside withJobTransaction.
 */
/**
 * 计划 §8.3/§8.7：review 上下文的 submission 进入 stale/question_blocked 终态时，
 * 必须同事务把仍处于 started 的 review attempt 置为 abandoned（input schedule
 * 保持 pending）。否则 attempt 永远停留在 started，阻塞
 * review_attempts_active_started_unique_idx 且审计轨迹错误。
 */
async function abandonStartedAttemptsForSubmissions(
  tx: WorkerTransaction,
  job: JobPayload,
  submissionIds: string[],
): Promise<void> {
  if (submissionIds.length === 0) return;
  const subs = await tx
    .select({ reviewAttemptId: schema.validationSubmissions.reviewAttemptId })
    .from(schema.validationSubmissions)
    .where(and(
      inArray(schema.validationSubmissions.id, submissionIds),
      eq(schema.validationSubmissions.workspaceId, job.workspaceId),
    ));
  const attemptIds = subs
    .map((row) => row.reviewAttemptId)
    .filter((value): value is string => value !== null);
  if (attemptIds.length === 0) return;
  const now = new Date();
  await tx
    .update(schema.reviewAttempts)
    .set({ status: "abandoned", abandonedAt: now, updatedAt: now })
    .where(and(
      inArray(schema.reviewAttempts.id, attemptIds),
      eq(schema.reviewAttempts.workspaceId, job.workspaceId),
      eq(schema.reviewAttempts.status, "started"),
    ));
}

async function markSubmissionsStale(
  job: JobPayload,
  submissionIds: string[],
  reason: string,
  tx?: WorkerTransaction,
) {
  if (submissionIds.length === 0) return;
  if (!tx) {
    await withJobTransaction(job, async (innerTx) => {
      await lockJobLease(innerTx, leaseContext(job));
      await markSubmissionsStale(job, submissionIds, reason, innerTx);
    });
    return;
  }
  const client = tx ?? db;
  await client
    .update(schema.validationSubmissions)
    .set({
      status: SubmissionStatus.STALE,
      failureStage: "question_generation",
      failureCode: reason,
      terminalReason: TerminalReason.SOURCE_STALE,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(schema.validationSubmissions.id, submissionIds),
        eq(schema.validationSubmissions.workspaceId, job.workspaceId),
        eq(schema.validationSubmissions.status, SubmissionStatus.QUESTION_PREPARING),
        eq(schema.validationSubmissions.currentGenerationJobId, job.id),
      ),
    );
  await abandonStartedAttemptsForSubmissions(tx, job, submissionIds);
}

/**
 * Mark submissions as question_blocked (deterministic fallback failed safety gate).
 * This is a non-retryable terminal state.
 * Accepts an optional transaction client for use inside withJobTransaction.
 */
async function markSubmissionsBlocked(
  job: JobPayload,
  submissionIds: string[],
  reason: string,
  tx?: WorkerTransaction,
) {
  if (submissionIds.length === 0) return;
  if (!tx) {
    await withJobTransaction(job, async (innerTx) => {
      await lockJobLease(innerTx, leaseContext(job));
      await markSubmissionsBlocked(job, submissionIds, reason, innerTx);
    });
    return;
  }
  const client = tx ?? db;
  await client
    .update(schema.validationSubmissions)
    .set({
      status: SubmissionStatus.QUESTION_BLOCKED,
      failureStage: "question_generation",
      failureCode: reason,
      terminalReason: TerminalReason.UNSAFE_FALLBACK,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(schema.validationSubmissions.id, submissionIds),
        eq(schema.validationSubmissions.workspaceId, job.workspaceId),
        eq(schema.validationSubmissions.status, SubmissionStatus.QUESTION_PREPARING),
        eq(schema.validationSubmissions.currentGenerationJobId, job.id),
      ),
    );
  await abandonStartedAttemptsForSubmissions(tx, job, submissionIds);
}
