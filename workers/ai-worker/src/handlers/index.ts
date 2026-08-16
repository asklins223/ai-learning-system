import { and, asc, eq, sql, inArray, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { evaluateValidationViaChat } from "../lib/business-ai-ops.ts";
import { alignQuote } from "../lib/align.ts";
// N-011: AI 治理 — 同意门禁 + 审计日志
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
// OPS-01: Provider 指标（ADR-0006 §2）
import {
  providerCallsTotal,
  providerCallDurationSeconds,
  providerErrorsTotal,
  categorizeError,
} from "../lib/metrics.ts";
import {
  ArtifactType,
  ArtifactStatus,
  ValidationOutcome,
  ReviewStatus,
  type ValidationFeedback,
} from "@ailearn/shared";

export interface JobPayload {
  id: string;
  workspaceId: string;
  /** Trusted actor copied from jobs.requested_by by the claim function. */
  requestedBy: string | null;
  payload: Record<string, unknown>;
  /** Immutable lease token assigned by the claim transaction. */
  leaseToken: string;
  /** R-007: AbortSignal for timeout cancellation */
  signal?: AbortSignal;
}

export function requireAuditUserId(
  job: Pick<JobPayload, "requestedBy" | "payload">,
): string {
  const userId = job.requestedBy;
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("missing trusted requestedBy actor; refusing to fabricate AI audit attribution");
  }
  const legacyPayloadUserId = job.payload.userId;
  if (
    legacyPayloadUserId !== undefined
    && (
      typeof legacyPayloadUserId !== "string"
      || legacyPayloadUserId.trim().toLowerCase() !== userId.toLowerCase()
    )
  ) {
    throw new Error("payload userId does not match trusted requestedBy actor");
  }
  return userId;
}

function leaseContext(job: JobPayload): JobLeaseContext {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    requestedBy: job.requestedBy,
    leaseToken: job.leaseToken,
    signal: job.signal,
  };
}

export async function runAlignEvidence(job: JobPayload) {
  const keyPointId = job.payload.keyPointId as string | undefined;
  if (!keyPointId) throw new Error("missing keyPointId in payload");
  await assertJobLease(leaseContext(job));

  const kp = await db.query.cardKeyPoints.findFirst({
    where: and(
      eq(schema.cardKeyPoints.id, keyPointId),
      eq(schema.cardKeyPoints.workspaceId, job.workspaceId),
    ),
  });
  if (!kp) throw new Error(`key point ${keyPointId} not found in workspace`);

  // R-007: 幂等检查 — 如果该 keyPoint 已有 evidence，说明前一次执行已成功
  // 支持 force=true 跳过幂等检查，用于强制重新对齐（如 note 内容变更后）
  const forceRealign = job.payload.force === true;
  const existingEvidence = await db.query.evidences.findFirst({
    where: and(
      eq(schema.evidences.keyPointId, kp.id),
      eq(schema.evidences.workspaceId, job.workspaceId),
    ),
  });
  if (existingEvidence && !forceRealign) {
    logger.info({ keyPointId }, "align_evidence skipped — evidence already exists for this keyPoint");
    return;
  }

  const card = await db.query.learningCards.findFirst({
    where: and(
      eq(schema.learningCards.id, kp.cardId),
      eq(schema.learningCards.workspaceId, job.workspaceId),
    ),
  });
  if (!card) throw new Error(`card ${kp.cardId} not found in workspace`);

  const blocks = await db.query.noteBlocks.findMany({
    where: and(
      eq(schema.noteBlocks.versionId, card.noteVersionId),
      eq(schema.noteBlocks.workspaceId, job.workspaceId),
    ),
    orderBy: asc(schema.noteBlocks.ordinal),
  });

  const result = alignQuote(
    kp.quoteText,
    blocks
      .filter((b) => b.type !== "image")
      .map((b) => ({ blockId: b.id, blockOrdinal: b.ordinal, text: b.content })),
  );

  // N-006: 在事务中原子删除旧 evidence 和插入新 evidence
  const newEvidenceData: Array<{
    blockId: string | null;
    blockOrdinal: number | null;
    quoteText: string;
    alignment: string;
    alignmentScore: number;
    alignmentMethod: string;
  }> = [];

  let bestAlignment = "unaligned";
  let bestScore = 0;
  let bestMethod = "fuzzy";

  if (!result.best) {
    newEvidenceData.push({
      blockId: null,
      blockOrdinal: null,
      quoteText: kp.quoteText,
      alignment: "unaligned",
      alignmentScore: 0,
      alignmentMethod: "fuzzy",
    });
  } else {
    const best = result.best;
    bestAlignment =
      best.score >= 85 ? "aligned" : best.score >= 60 ? "soft" : "unaligned";
    bestScore = best.score;
    bestMethod = best.method;

    newEvidenceData.push({
      blockId: best.blockId,
      blockOrdinal: best.blockOrdinal,
      quoteText: kp.quoteText,
      alignment: bestAlignment,
      alignmentScore: best.score,
      alignmentMethod: best.method,
    });

    if (result.candidates.length > 1 && bestAlignment === "aligned") {
      const alt = result.candidates.slice(1, 3);
      for (const c of alt) {
        newEvidenceData.push({
          blockId: c.blockId,
          blockOrdinal: c.blockOrdinal,
          quoteText: kp.quoteText,
          alignment: "soft",
          alignmentScore: c.score,
          alignmentMethod: c.method,
        });
      }
    }
  }

  const committed = await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, leaseContext(job));
    // Multiple jobs for the same key point can pass the fast idempotency read
    // concurrently. Serialize their replace transactions before reading the
    // old rows so they cannot both insert a complete evidence set.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`evidence-align:${kp.id}`}, 0)
      )
    `);

    const oldEvidences = await tx
      .select()
      .from(schema.evidences)
      .where(and(
        eq(schema.evidences.keyPointId, kp.id),
        eq(schema.evidences.workspaceId, job.workspaceId),
      ))
      .for("update");

    if (oldEvidences.length > 0 && !forceRealign) {
      logger.info({ keyPointId }, "align_evidence skipped — concurrent result already exists");
      return false;
    }

    // Read overrides after locking their parent evidence rows. This prevents a
    // concurrent override write from being silently lost to ON DELETE CASCADE.
    const oldEvidenceIds = oldEvidences.map((e) => e.id);
    const oldUserOverrides = oldEvidenceIds.length > 0
      ? await tx
          .select()
          .from(schema.evidenceOverrides)
          .where(inArray(schema.evidenceOverrides.evidenceId, oldEvidenceIds))
          .for("update")
      : [];
    const oldEvidenceById = new Map(oldEvidences.map((e) => [e.id, e]));
    const oldOverrides = new Map<string, string>();
    for (const ev of oldEvidences) {
      if (ev.userOverride) oldOverrides.set(ev.blockId ?? ev.quoteText, ev.userOverride);
    }
    const oldUserOverrideMap = new Map<string, Array<{ userId: string; override: string }>>();
    for (const userOverride of oldUserOverrides) {
      const parentEvidence = oldEvidenceById.get(userOverride.evidenceId);
      if (!parentEvidence) continue;
      const key = parentEvidence.blockId ?? parentEvidence.quoteText;
      const overrides = oldUserOverrideMap.get(key) ?? [];
      overrides.push({ userId: userOverride.userId, override: userOverride.override });
      oldUserOverrideMap.set(key, overrides);
    }

    await tx.delete(schema.evidences).where(and(
      eq(schema.evidences.keyPointId, kp.id),
      eq(schema.evidences.workspaceId, job.workspaceId),
    ));

    // 插入新 evidence
    const inserted = [];
    for (const data of newEvidenceData) {
      // N-006: 恢复人工 override（如果有匹配的旧 override）
      const overrideKey = data.blockId ?? data.quoteText;
      const restoredOverride = oldOverrides.get(overrideKey) ?? null;

      const [row] = await tx.insert(schema.evidences).values({
        workspaceId: kp.workspaceId,
        keyPointId: kp.id,
        blockId: data.blockId,
        blockOrdinal: data.blockOrdinal,
        quoteText: data.quoteText,
        alignment: data.alignment,
        alignmentScore: data.alignmentScore,
        alignmentMethod: data.alignmentMethod,
        ...(restoredOverride ? { userOverride: restoredOverride } : {}),
      }).returning();
      inserted.push(row);

      if (restoredOverride) {
        logger.info({ evidenceId: row.id, override: restoredOverride }, "restored legacy userOverride after re-align");
      }

      // N-006: 恢复用户级 evidence_overrides
      const userOverrideKey = data.blockId ?? data.quoteText;
      const userOverridesToRestore = oldUserOverrideMap.get(userOverrideKey);
      if (userOverridesToRestore) {
        for (const uo of userOverridesToRestore) {
          await tx.insert(schema.evidenceOverrides).values({
            evidenceId: row.id,
            userId: uo.userId,
            workspaceId: kp.workspaceId,
            override: uo.override,
          }).onConflictDoNothing();
        }
        logger.info(
          { evidenceId: row.id, restoredCount: userOverridesToRestore.length },
          "restored user-level evidence_overrides after re-align",
        );
      }
    }

    if (oldEvidenceIds.length > 0) {
      await tx
        .delete(schema.searchDocuments)
        .where(and(
          eq(schema.searchDocuments.workspaceId, job.workspaceId),
          eq(schema.searchDocuments.objectType, "evidence"),
          inArray(schema.searchDocuments.objectId, oldEvidenceIds),
        ));
    }

    for (const ev of inserted) {
      const indexedAt = new Date();
      await tx
        .insert(schema.searchDocuments)
        .values({
          workspaceId: job.workspaceId,
          objectType: "evidence",
          objectId: ev.id,
          title: kp.claim,
          body: kp.quoteText,
          metadata: {
            keyPointId: kp.id,
            cardId: card.id,
            alignment: ev.alignment,
          },
          indexedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.searchDocuments.workspaceId,
            schema.searchDocuments.objectType,
            schema.searchDocuments.objectId,
          ],
          set: {
            title: kp.claim,
            body: kp.quoteText,
            metadata: {
              keyPointId: kp.id,
              cardId: card.id,
              alignment: ev.alignment,
            },
            indexedAt,
          },
        });
    }
    throwIfJobAborted(job);
    return true;
  });

  if (!committed) return;

  logger.info(
    { keyPointId, alignment: bestAlignment, score: bestScore, method: bestMethod },
    "evidence aligned",
  );

}

/**
 * 离散档位复习调度（对齐 V0 文档 §10 + 评审意见 A.3#3）。
 * 按 validation outcome 选档，不用连续函数。
 */
function intervalForOutcome(outcome: ValidationOutcome): number {
  switch (outcome) {
    case ValidationOutcome.PRELIMINARY_UNDERSTANDING:
      return 3;
    case ValidationOutcome.UNCLEAR_EXPRESSION:
      return 0;
    case ValidationOutcome.MISUNDERSTANDING:
      return 0;
    case ValidationOutcome.UNKNOWN:
    default:
      return 1;
  }
}

/**
 * 理解验证判定 handler（V0.1b 核心）。
 * 1. 读 keyPoint + 关联 evidence block（作为参考答案上下文）
 * 2. 调 evaluateValidationViaChat(provider, input) → chatCompletion + zod 校验
 * 3. 写 ai_artifacts(type=validation_feedback)
 * 4. 写 validation_events（outcome/confidence/feedback）
 * 5. 写 understanding_events（validated / misunderstood）
 * 6. 旧 pending review 标记 superseded，写新 review_schedules（离散档位）
 */
export async function runEvaluateValidation(job: JobPayload) {
  const cardId = job.payload.cardId as string | undefined;
  const keyPointId = job.payload.keyPointId as string | undefined;
  const questionType = job.payload.questionType as string | undefined;
  const question = job.payload.question as string | undefined;
  const userAnswer = job.payload.userAnswer as string | undefined;
  const userId = requireAuditUserId(job);
  // N-003: 从 payload 获取 questionId，用于绑定服务端持久化的题目
  const questionId = job.payload.questionId as string | undefined;
  if (!cardId) throw new Error("missing cardId in payload");
  if (!questionType) throw new Error("missing questionType in payload");
  if (!question) throw new Error("missing question in payload");
  if (!userAnswer) throw new Error("missing userAnswer in payload");
  await assertJobLease(leaseContext(job));
  logger.info({ cardId, keyPointId }, "running evaluate_validation");

  // 幂等检查 — 合并为单次 OR 查询：by jobId 或 by input 组合
  // 避免对 validationEvents 表的两次串行查询。
  const existingValidation = await db.query.validationEvents.findFirst({
    where: and(
      eq(schema.validationEvents.workspaceId, job.workspaceId),
      or(
        eq(schema.validationEvents.jobId, job.id),
        and(
          eq(schema.validationEvents.cardId, cardId),
          eq(schema.validationEvents.userId, userId),
          eq(schema.validationEvents.question, question),
          eq(schema.validationEvents.userAnswer, userAnswer),
          ...(keyPointId ? [eq(schema.validationEvents.keyPointId, keyPointId)] : []),
        ),
      ),
    ),
  });
  if (existingValidation) {
    logger.info(
      { jobId: job.id, validationEventId: existingValidation.id },
      existingValidation.jobId === job.id
        ? "evaluate_validation skipped — result already exists for this job"
        : "evaluate_validation skipped — validation event already exists for this input",
    );
    return;
  }

  // 并行查询 card + keyPoint + AI 治理上下文，减少串行 DB 往返
  const [card, kpRow, govCtx] = await Promise.all([
    db.query.learningCards.findFirst({
      where: and(
        eq(schema.learningCards.id, cardId),
        eq(schema.learningCards.workspaceId, job.workspaceId),
      ),
    }),
    keyPointId
      ? db.query.cardKeyPoints.findFirst({
          where: and(
            eq(schema.cardKeyPoints.id, keyPointId),
            eq(schema.cardKeyPoints.cardId, cardId),
            eq(schema.cardKeyPoints.workspaceId, job.workspaceId),
          ),
        })
      : db.query.cardKeyPoints.findFirst({
          where: and(
            eq(schema.cardKeyPoints.cardId, cardId),
            eq(schema.cardKeyPoints.workspaceId, job.workspaceId),
          ),
        }),
    resolveAIGovernanceContext(job.workspaceId, userId),
  ]);
  if (!card) throw new Error(`card ${cardId} not found in workspace`);
  const kp = kpRow ?? null;
  if (!kp) throw new Error(keyPointId ? `key point ${keyPointId} not found in card ${cardId}` : `card ${cardId} has no key points to validate`);

  // 取 keyPoint 对应的 evidence block 内容，作为参考答案上下文
  // N-004: 使用 SQL 排序选取最高分有效硬证据，避免全量加载后 JS 排序
  // 优先级：aligned > soft > 其他，同级按 alignmentScore 降序
  // 使用 LEFT JOIN note_blocks 一次性获取 block 内容，消除额外串行查询
  const evidenceRows = await db.execute<{ id: string; block_id: string | null; alignment: string; alignment_score: number; user_override: string | null; block_content: string | null }>(sql`
    SELECT e.id, e.block_id, e.alignment, e.alignment_score, e.user_override, nb.content AS block_content
    FROM evidences e
    LEFT JOIN note_blocks nb ON nb.id = e.block_id AND nb.workspace_id = e.workspace_id
    WHERE e.key_point_id = ${kp.id}
      AND e.workspace_id = ${job.workspaceId}
    ORDER BY
      CASE
        WHEN e.user_override = 'rejected' THEN 3
        WHEN e.user_override = 'downgraded' THEN 1
        WHEN e.user_override = 'confirmed' OR e.alignment = 'aligned' THEN 0
        WHEN e.alignment = 'soft' THEN 1
        ELSE 2
      END,
      e.alignment_score DESC
    LIMIT 1
  `);
  const ev = evidenceRows[0];
  const referenceText = ev?.block_content ?? "";
  if (!govCtx.consentOk) {
    throw new AIConsentRequiredError();
  }

  // R3: Route text_generation tasks to a potentially different (cheaper) provider
  const textRes = resolveProviderForTask(govCtx, "evaluate_validation");

  // 隐私治理 — 使用预解析的 policy，避免重复查 workspaces
  const governanceResult = enforcePrivacyGovernanceWithPolicy(
    govCtx.policy,
    job.workspaceId,
    ["question", "user_answer", "claim", "quote"],
    { question, questionType, claim: kp.claim, quote: referenceText || kp.quoteText, userAnswer },
    textRes.providerName,
  );
  if (!governanceResult.allowed) {
    // 2026-08-12+（15a 根因修复）：policy 拒绝 → 引导用户去设置页签署协议。
    throw new AIConsentRequiredError();
  }

  const provider = createProvider(textRes.providerName, textRes.providerConfig);

  // N-011: 审计日志
  const aiCallStart = Date.now();
  const inputDataSize = JSON.stringify({ question, userAnswer, claim: kp.claim, quote: referenceText || kp.quoteText }).length;

  // N-011: 使用脱敏后的数据
  const sanitizedInput = governanceResult.sanitizedData as {
    question: string;
    questionType: string;
    claim: string;
    quote: string;
    userAnswer: string;
  };

  let output;
  let evalUsage: { totalTokens?: number | null } | null = null;
  try {
    const result = await evaluateValidationViaChat(provider, sanitizedInput, job.signal);
    output = result.output;
    evalUsage = result.usage;
    // OPS-01: Provider 成功指标
    providerCallsTotal.labels("evaluate_validation", "success").inc();
    providerCallDurationSeconds.labels("evaluate_validation").observe((Date.now() - aiCallStart) / 1000);
  } catch (err) {
    // OPS-01: Provider 失败指标
    providerCallsTotal.labels("evaluate_validation", "failed").inc();
    providerCallDurationSeconds.labels("evaluate_validation").observe((Date.now() - aiCallStart) / 1000);
    providerErrorsTotal.labels("evaluate_validation", categorizeError(err)).inc();
    // N-011: 写入审计日志（失败）
    if (await isJobLeaseActive(leaseContext(job))) {
      await logAICall({
        workspaceId: job.workspaceId,
        userId,
        jobId: job.id,
        provider: provider.id,
        modelId: provider.modelId,
        operation: "evaluate_validation",
        dataCategories: ["question", "user_answer", "claim", "quote"],
        dataSizeBytes: inputDataSize,
        costTokens: evalUsage?.totalTokens ?? null, // R5: usage from return value
        durationMs: Date.now() - aiCallStart,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      }, { policy: govCtx.policy });
    }
    throw err;
  }

  // R-007: 模型调用后检查是否已 abort，避免写入不可幂等副作用
  await assertJobLease(leaseContext(job));

  // 把 snake_case → camelCase 写入 ValidationFeedback jsonb
  const feedback: ValidationFeedback = {
    outcome: output.outcome as ValidationOutcome,
    confidence: output.confidence,
    coveredPoints: output.covered_points ?? [],
    missingPoints: output.missing_points ?? [],
    misunderstandings: output.misunderstandings ?? [],
    evidenceRefs: output.evidence_refs ?? [],
    feedback: output.feedback,
  };

  const intervalDays = intervalForOutcome(feedback.outcome);
  const nextReviewAt = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000);

  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, leaseContext(job));
    // 输入维度 advisory lock：当 QUEUE_CONCURRENCY > 1 时，两个不同 jobId 但
    // 相同输入（cardId + keyPointId + userId + question + userAnswer）的 job 可能
    // 同时通过事务外的幂等读检查。输入维度锁让第二个事务等待，然后观察到第一个
    // validation event 并返回，避免重复写入。validation_events.job_id 查询仍是最终不变量。
    const validationLockKey = `${job.workspaceId}:${cardId}:${keyPointId ?? ""}:${userId}:${question}:${userAnswer}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${validationLockKey}, 0))`);
    // 输入维度锁已确保此前相同输入的并发事务已提交。此处查重必须同时检查
    // jobId（防重试重复）和输入组合（防不同 jobId 相同输入的并发重复），
    // 否则第二个 job 无法观察到第一个 job 已写入的 validation event。
    const committedResult = await tx.query.validationEvents.findFirst({
      where: and(
        eq(schema.validationEvents.workspaceId, job.workspaceId),
        or(
          eq(schema.validationEvents.jobId, job.id),
          and(
            eq(schema.validationEvents.cardId, cardId),
            eq(schema.validationEvents.userId, userId),
            eq(schema.validationEvents.question, question),
            eq(schema.validationEvents.userAnswer, userAnswer),
            ...(keyPointId ? [eq(schema.validationEvents.keyPointId, keyPointId)] : []),
          ),
        ),
      ),
    });
    if (committedResult) {
      logger.info(
        { jobId: job.id, validationEventId: committedResult.id },
        committedResult.jobId === job.id
          ? "evaluate_validation side effects skipped — result already exists for this job"
          : "evaluate_validation side effects skipped — concurrent result already committed for same input",
      );
      return;
    }

    // 1. ai_artifacts
    // SEC-01: validation_feedback artifacts carry an exact actor binding in
    // input_refs.userId so the RLS actor guard can enforce user-private access
    // once ROW LEVEL SECURITY is activated.  Without this binding the Worker
    // write would be rejected by sec01_v1_ai_artifacts_validation_actor_guard.
    const [artifact] = await tx
      .insert(schema.aiArtifacts)
      .values({
        workspaceId: job.workspaceId,
        type: ArtifactType.VALIDATION_FEEDBACK,
        inputRefs: { cardId, keyPointId: kp!.id, userId },
        output,
        modelId: provider.modelId,
        promptVersion: provider.promptVersion,
        status: ArtifactStatus.READY,
        inputHash: createHash("sha256").update(JSON.stringify(sanitizedInput), "utf8").digest("hex"), // 计划 §6.6
        costTokens: evalUsage?.totalTokens ?? null, // R5: usage from return value
      })
      .returning();

    // 2. validation_events
    // N-003: 绑定 questionId 和 jobId，确保异步结果可追溯
    const [ve] = await tx
      .insert(schema.validationEvents)
      .values({
        workspaceId: job.workspaceId,
        userId,
        cardId,
        keyPointId: kp!.id,
        artifactId: artifact.id,
        question,
        questionType,
        userAnswer,
        outcome: feedback.outcome,
        confidence: Math.round(Math.max(0, Math.min(1, feedback.confidence)) * 100), // 0-1 → 0-100，clamp 防越界
        feedback,
        // N-003: 绑定服务端持久化的题目和 job
        ...(questionId ? { questionId } : {}),
        jobId: job.id,
      })
      .returning();

    // 3. understanding_events
    const eventType =
      feedback.outcome === ValidationOutcome.MISUNDERSTANDING
        ? "misunderstood"
        : feedback.outcome === ValidationOutcome.PRELIMINARY_UNDERSTANDING
          ? "validated"
          : "seen";
    await tx.insert(schema.understandingEvents).values({
      workspaceId: job.workspaceId,
      userId,
      subjectType: "validation",
      subjectId: ve.id,
      eventType,
      payload: { outcome: feedback.outcome, confidence: feedback.confidence },
    });

    // 4. 旧 pending review 标记 superseded（按 keyPoint + userId 维度）。
    //    R-006: 仅 supersede 当前用户的 pending review，不影响其他用户的复习计划。
    //    N-002: 只 supersede 同一 keyPoint 的 pending review。
    //    后一个 keyPoint 的成功验证不再覆盖前一个 keyPoint 的误解复习计划。
    await tx
      .update(schema.reviewSchedules)
      .set({ status: ReviewStatus.SUPERSEDED })
      .where(
        and(
          eq(schema.reviewSchedules.workspaceId, job.workspaceId),
          eq(schema.reviewSchedules.userId, userId),
          eq(schema.reviewSchedules.status, ReviewStatus.PENDING),
          sql`subject_type = 'validation' AND subject_id IN
               (SELECT id FROM validation_events WHERE card_id = ${cardId} AND key_point_id = ${kp!.id})`,
        ),
      );

    // 5. 写新 review_schedules
    await tx.insert(schema.reviewSchedules).values({
      workspaceId: job.workspaceId,
      userId,
      subjectType: "validation",
      subjectId: ve.id,
      validationEventId: ve.id,
      keyPointId: kp!.id,
      status: ReviewStatus.PENDING,
      nextReviewAt,
      intervalDays,
    });

    throwIfJobAborted(job);
    logger.info(
      { validationEventId: ve.id, outcome: feedback.outcome, intervalDays, nextReviewAt },
      "validation evaluated + review scheduled",
    );
  });

  // N-011: only record success after all validation side effects commit.
  if (await isJobLeaseActive(leaseContext(job))) {
    await logAICall({
      workspaceId: job.workspaceId,
      userId,
      jobId: job.id,
      provider: provider.id,
      modelId: provider.modelId,
      operation: "evaluate_validation",
      dataCategories: ["question", "user_answer", "claim", "quote"],
      dataSizeBytes: inputDataSize,
      costTokens: evalUsage?.totalTokens ?? null, // R5: usage from return value
      durationMs: Date.now() - aiCallStart,
      status: "success",
    }, { policy: govCtx.policy });
  }
}
