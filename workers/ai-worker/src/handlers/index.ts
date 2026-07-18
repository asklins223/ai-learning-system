import { and, asc, count, eq, sql, inArray, desc, or } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { createProvider, resolveProviderSelection } from "../lib/ai-provider.ts";
import { alignQuote } from "../lib/align.ts";
// N-011: AI 治理 — 同意门禁 + 审计日志
import { checkAIConsent, logAICall, enforcePrivacyGovernance } from "../lib/governance.ts";
import {
  assertJobLease,
  isJobLeaseActive,
  lockJobLease,
  throwIfJobAborted,
  withJobTransaction,
  type JobLeaseContext,
} from "../lib/job-lease.ts";
import {
  ArtifactType,
  ArtifactStatus,
  CardStatus,
  ValidationOutcome,
  ReviewStatus,
  MAX_PENDING_JOBS_PER_WORKSPACE,
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

export async function runGenerateCard(job: JobPayload) {
  const noteVersionId = job.payload.noteVersionId as string | undefined;
  if (!noteVersionId) throw new Error("missing noteVersionId in payload");
  await assertJobLease(leaseContext(job));
  const oldCardId = job.payload.oldCardId as string | undefined;
  logger.info({ noteVersionId, oldCardId }, "running generate_card");

  // R-007: 幂等检查 — 如果该 noteVersionId 已有 active card，说明前一次执行已成功
  // N-010: 如果是 regeneration (oldCardId 存在)，则不跳过 — 旧卡将在事务中原子切换
  const existingCard = await db.query.learningCards.findFirst({
    where: and(
      eq(schema.learningCards.noteVersionId, noteVersionId),
      eq(schema.learningCards.workspaceId, job.workspaceId),
      eq(schema.learningCards.status, CardStatus.ACTIVE),
    ),
  });
  if (existingCard && !oldCardId) {
    logger.info({ noteVersionId, cardId: existingCard.id }, "generate_card skipped — active card already exists");
    return;
  }
  if (existingCard && oldCardId) {
    const oldCard = await db.query.learningCards.findFirst({
      where: and(
        eq(schema.learningCards.id, oldCardId),
        eq(schema.learningCards.workspaceId, job.workspaceId),
      ),
    });
    if (oldCard?.supersededByCardId === existingCard.id) {
      logger.info(
        { noteVersionId, cardId: existingCard.id, oldCardId },
        "generate_card regeneration skipped — this replacement already committed",
      );
      return;
    }
  }

  // Legacy jobs that already produced their card can remain idempotent without
  // inventing an operator. Any job that still needs an AI call must carry the
  // initiating user explicitly for audit attribution.
  const auditUserId = requireAuditUserId(job);

  const version = await db.query.noteVersions.findFirst({
    where: and(
      eq(schema.noteVersions.id, noteVersionId),
      eq(schema.noteVersions.workspaceId, job.workspaceId),
    ),
  });
  if (!version) throw new Error(`note version ${noteVersionId} not found in workspace`);

  const note = await db.query.notes.findFirst({
    where: and(
      eq(schema.notes.id, version.noteId),
      eq(schema.notes.workspaceId, job.workspaceId),
    ),
  });
  if (!note) throw new Error(`note ${version.noteId} not found in workspace`);

  const blocks = await db.query.noteBlocks.findMany({
    where: and(
      eq(schema.noteBlocks.versionId, noteVersionId),
      eq(schema.noteBlocks.workspaceId, job.workspaceId),
    ),
    orderBy: asc(schema.noteBlocks.ordinal),
  });

  // Resolve once so consent, policy checks, and the eventual call all refer to
  // the same provider/configuration snapshot.
  const providerSelection = await resolveProviderSelection(job.workspaceId, auditUserId);

  // N-011: AI 同意门禁 — 未签署同意的工作区不能调用外部 AI provider
  const consentOk = await checkAIConsent(job.workspaceId, providerSelection.providerName);
  if (!consentOk) {
    throw new Error("AI consent not signed for this workspace. Owner must sign AI consent before using external AI providers.");
  }

  // N-011: 隐私治理 — sendToExternal 门禁 + PII 检测/脱敏
  const governanceResult = await enforcePrivacyGovernance(
    job.workspaceId,
    ["note_content"],
    { noteTitle: note.title, blocks: blocks.map((b) => ({ ordinal: b.ordinal, type: b.type, content: b.content })) },
    providerSelection.providerName,
  );
  if (!governanceResult.allowed) {
    throw new Error(governanceResult.reason ?? "AI privacy governance blocked this request");
  }

  const provider = createProvider(providerSelection.providerName, providerSelection.config);

  // N-011: 使用脱敏后的数据
  const sanitizedInput = governanceResult.sanitizedData as {
    noteTitle: string;
    blocks: Array<{ ordinal: number; type: string; content: string }>;
  };

  const aiCallStart = Date.now();

  let output;
  try {
    output = await provider.generateCard(sanitizedInput, job.signal);
  } catch (err) {
    // N-011: 写入审计日志（失败）
    if (await isJobLeaseActive(leaseContext(job))) {
      await logAICall({
        workspaceId: job.workspaceId,
        userId: auditUserId,
        jobId: job.id,
        provider: provider.id,
        modelId: provider.modelId,
        operation: "generate_card",
        dataCategories: ["note_content"],
        dataSizeBytes: JSON.stringify(blocks).length,
        durationMs: Date.now() - aiCallStart,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }

  // R-007: 模型调用后检查是否已 abort，避免写入学果
  await assertJobLease(leaseContext(job));

  const cardBody = [output.summary, ...output.key_points.map((kp) => kp.claim)].join("\n");

  // Persist the card and its search projection in the same lease-fenced
  // transaction. A timed-out handler must not mutate search_documents after
  // the outer worker has released the lease for a retry.
  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, leaseContext(job));
    // Serialize card completion with API enqueue/dedupe/quota checks for this
    // workspace. This closes the window where a completed job disappears from
    // the active-job query immediately before its card becomes observable.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${job.workspaceId}`}, 0)
      )
    `);

    // A note may have an active card from an older version. Supersede every
    // active card for the note, not only cards on the target version; otherwise
    // “generate newer card” leaves the old card/reviews/search projection live.
    const oldActiveCardRows = await tx
      .select({ card: schema.learningCards })
      .from(schema.learningCards)
      .innerJoin(
        schema.noteVersions,
        eq(schema.noteVersions.id, schema.learningCards.noteVersionId),
      )
      .where(and(
        eq(schema.learningCards.workspaceId, job.workspaceId),
        eq(schema.learningCards.status, CardStatus.ACTIVE),
        eq(schema.noteVersions.noteId, version.noteId),
      ));
    const oldActiveCards = oldActiveCardRows.map((row) => row.card);
    if (oldCardId && !oldActiveCards.some((card) => card.id === oldCardId)) {
      const explicitOldCard = await tx.query.learningCards.findFirst({
        where: and(
          eq(schema.learningCards.id, oldCardId),
          eq(schema.learningCards.workspaceId, job.workspaceId),
          eq(schema.learningCards.status, CardStatus.ACTIVE),
        ),
      });
      if (explicitOldCard) {
        const explicitOldVersion = await tx.query.noteVersions.findFirst({
          where: and(
            eq(schema.noteVersions.id, explicitOldCard.noteVersionId),
            eq(schema.noteVersions.workspaceId, job.workspaceId),
          ),
        });
        if (!explicitOldVersion || explicitOldVersion.noteId !== version.noteId) {
          throw new Error(`old card ${oldCardId} does not belong to the target note`);
        }
        oldActiveCards.push(explicitOldCard);
      }
    }
    if (oldActiveCards.length > 0) {
      await tx
        .update(schema.learningCards)
        .set({ status: CardStatus.SUPERSEDED, updatedAt: new Date() })
        .where(
          and(
            eq(schema.learningCards.workspaceId, job.workspaceId),
            inArray(schema.learningCards.id, oldActiveCards.map((card) => card.id)),
            eq(schema.learningCards.status, CardStatus.ACTIVE),
          ),
        );

      // N-010: 在事务中原子取消旧卡的 pending review
      for (const oldCard of oldActiveCards) {
        await tx
          .update(schema.reviewSchedules)
          .set({ status: ReviewStatus.SUPERSEDED })
          .where(
            and(
              eq(schema.reviewSchedules.workspaceId, job.workspaceId),
              eq(schema.reviewSchedules.status, ReviewStatus.PENDING),
              sql`(${sql.identifier("subject_type")} = 'card' AND ${sql.identifier("subject_id")} = ${oldCard.id}
                   OR ${sql.identifier("subject_type")} = 'validation' AND ${sql.identifier("subject_id")} IN
                     (SELECT id FROM validation_events WHERE card_id = ${oldCard.id}))`,
            ),
          );
      }
    }

    // B8: artifact status 设为 ready（而非 accepted），等待用户手动 accept
    const [artifact] = await tx
      .insert(schema.aiArtifacts)
      .values({
        workspaceId: version.workspaceId,
        type: "learning_card",
        inputRefs: { noteVersionId },
        output,
        modelId: provider.modelId,
        promptVersion: provider.promptVersion,
        status: ArtifactStatus.READY,
      })
      .returning();

    const [card] = await tx
      .insert(schema.learningCards)
      .values({
        noteVersionId: version.id,
        workspaceId: version.workspaceId,
        status: "active",
        schemaJson: { title: output.title, summary: output.summary },
        artifactId: artifact.id,
      })
      .returning();

    // B2/B9: 所有被替换的 active card（包括跨版本显式 oldCardId）都回填
    // replacement，并在事务提交后清理对应搜索投影。
    for (const oldCard of oldActiveCards) {
      await tx
        .update(schema.learningCards)
        .set({ supersededByCardId: card.id, updatedAt: new Date() })
        .where(and(
          eq(schema.learningCards.id, oldCard.id),
          eq(schema.learningCards.workspaceId, job.workspaceId),
        ));
    }

    const kps = await tx
      .insert(schema.cardKeyPoints)
      .values(
        output.key_points.map((kp) => ({
          cardId: card.id,
          workspaceId: version.workspaceId,
          ordinal: kp.ordinal,
          claim: kp.claim,
          quoteText: kp.quote_text,
        })),
      )
      .returning();

    const [pendingRow] = await tx
      .select({ count: count() })
      .from(schema.jobs)
      .where(and(
        eq(schema.jobs.workspaceId, version.workspaceId),
        eq(schema.jobs.status, "pending"),
      ));
    const pendingCount = Number(pendingRow?.count ?? 0);
    if (pendingCount + kps.length > MAX_PENDING_JOBS_PER_WORKSPACE) {
      throw new Error(
        `workspace pending-job quota would be exceeded: ${pendingCount} + ${kps.length} > ${MAX_PENDING_JOBS_PER_WORKSPACE}`,
      );
    }

    if (kps.length > 0) {
      await tx.insert(schema.jobs).values(kps.map((kp) => ({
        type: "align_evidence",
        workspaceId: version.workspaceId,
        requestedBy: auditUserId,
        payload: { keyPointId: kp.id, noteVersionId },
        status: "pending",
      })));
    }

    const oldCardIds = oldActiveCards.map((card) => card.id);
    if (oldCardIds.length > 0) {
      await tx
        .delete(schema.searchDocuments)
        .where(and(
          eq(schema.searchDocuments.workspaceId, version.workspaceId),
          or(
            and(
              eq(schema.searchDocuments.objectType, "card"),
              inArray(schema.searchDocuments.objectId, oldCardIds),
            ),
            and(
              eq(schema.searchDocuments.objectType, "evidence"),
              inArray(
                sql<string>`${schema.searchDocuments.metadata}->>'cardId'`,
                oldCardIds,
              ),
            ),
          ),
        ));
    }

    const indexedAt = new Date();
    await tx
      .insert(schema.searchDocuments)
      .values({
        workspaceId: version.workspaceId,
        objectType: "card",
        objectId: card.id,
        title: output.title,
        body: cardBody,
        metadata: { noteVersionId: version.id },
        indexedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.searchDocuments.workspaceId,
          schema.searchDocuments.objectType,
          schema.searchDocuments.objectId,
        ],
        set: {
          title: output.title,
          body: cardBody,
          metadata: { noteVersionId: version.id },
          indexedAt,
        },
      });

    throwIfJobAborted(job);
    logger.info({ cardId: card.id, keyPoints: kps.length }, "card persisted");

  });

  // N-011: only record a successful call after the card transaction commits.
  // This avoids claiming success when persistence was rolled back.
  if (await isJobLeaseActive(leaseContext(job))) {
    await logAICall({
      workspaceId: job.workspaceId,
      userId: auditUserId,
      jobId: job.id,
      provider: provider.id,
      modelId: provider.modelId,
      operation: "generate_card",
      dataCategories: ["note_content"],
      dataSizeBytes: JSON.stringify(blocks).length,
      durationMs: Date.now() - aiCallStart,
      status: "success",
    });
  }
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
    blocks.map((b) => ({ blockId: b.id, blockOrdinal: b.ordinal, text: b.content })),
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
 * 2. 调 provider.evaluateValidation → zod 校验输出
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

  // The job id is the primary idempotency key. This avoids another provider
  // call on ordinary redelivery/replay after the result transaction committed.
  const existingJobValidation = await db.query.validationEvents.findFirst({
    where: and(
      eq(schema.validationEvents.workspaceId, job.workspaceId),
      eq(schema.validationEvents.jobId, job.id),
    ),
  });
  if (existingJobValidation) {
    logger.info(
      { jobId: job.id, validationEventId: existingJobValidation.id },
      "evaluate_validation skipped — result already exists for this job",
    );
    return;
  }

  // R-007: 兼容旧记录（job_id 为空）的输入级幂等检查。
  // 匹配条件：同 cardId + keyPointId + question + userAnswer + userId
  const existingValidation = await db.query.validationEvents.findFirst({
    where: and(
      eq(schema.validationEvents.workspaceId, job.workspaceId),
      eq(schema.validationEvents.cardId, cardId),
      eq(schema.validationEvents.userId, userId),
      eq(schema.validationEvents.question, question),
      eq(schema.validationEvents.userAnswer, userAnswer),
      ...(keyPointId ? [eq(schema.validationEvents.keyPointId, keyPointId)] : []),
    ),
  });
  if (existingValidation) {
    logger.info(
      { cardId, keyPointId, validationEventId: existingValidation.id },
      "evaluate_validation skipped — validation event already exists for this input",
    );
    return;
  }

  const card = await db.query.learningCards.findFirst({
    where: and(
      eq(schema.learningCards.id, cardId),
      eq(schema.learningCards.workspaceId, job.workspaceId),
    ),
  });
  if (!card) throw new Error(`card ${cardId} not found in workspace`);

  let kp = null as typeof schema.cardKeyPoints.$inferSelect | null;
  if (keyPointId) {
    kp = (await db.query.cardKeyPoints.findFirst({
      where: and(
        eq(schema.cardKeyPoints.id, keyPointId),
        eq(schema.cardKeyPoints.cardId, cardId),
        eq(schema.cardKeyPoints.workspaceId, job.workspaceId),
      ),
    })) ?? null;
    if (!kp) throw new Error(`key point ${keyPointId} not found in card ${cardId}`);
  } else {
    kp = (await db.query.cardKeyPoints.findFirst({
      where: and(
        eq(schema.cardKeyPoints.cardId, cardId),
        eq(schema.cardKeyPoints.workspaceId, job.workspaceId),
      ),
    })) ?? null;
  }
  if (!kp) throw new Error(`card ${cardId} has no key points to validate`);

  // 取 keyPoint 对应的 evidence block 内容，作为参考答案上下文
  // N-004: 使用确定性排序选取最高分有效硬证据
  const allEvs = await db.query.evidences.findMany({
    where: and(
      eq(schema.evidences.keyPointId, kp.id),
      eq(schema.evidences.workspaceId, job.workspaceId),
    ),
    orderBy: [desc(schema.evidences.alignmentScore)],
  });
  // N-004: 确定性选取 — 优先 aligned（含 confirmed override），然后 soft，最后其他
  const evidencePriority = (alignment: string, userOverride: string | null): number => {
    let eff = alignment;
    if (userOverride === "rejected") return 3;
    if (userOverride === "downgraded") eff = "soft";
    if (userOverride === "confirmed") eff = "aligned";
    switch (eff) {
      case "aligned": return 0;
      case "soft": return 1;
      default: return 2;
    }
  };
  const ev = allEvs.sort((a, b) => {
    const pdiff = evidencePriority(a.alignment, a.userOverride) - evidencePriority(b.alignment, b.userOverride);
    if (pdiff !== 0) return pdiff;
    return b.alignmentScore - a.alignmentScore;
  })[0];
  let referenceText = "";
  if (ev?.blockId) {
    const blk = await db.query.noteBlocks.findFirst({
      where: and(
        eq(schema.noteBlocks.id, ev.blockId),
        eq(schema.noteBlocks.workspaceId, job.workspaceId),
      ),
    });
    if (blk) referenceText = blk.content;
  }

  // Resolve once so consent, policy checks, and the eventual call all refer to
  // the same provider/configuration snapshot.
  const providerSelection = await resolveProviderSelection(job.workspaceId, userId);

  // N-011: AI 同意门禁 — 未签署同意的工作区不能调用外部 AI provider
  const consentOk = await checkAIConsent(job.workspaceId, providerSelection.providerName);
  if (!consentOk) {
    throw new Error("AI consent not signed for this workspace. Owner must sign AI consent before using external AI providers.");
  }

  // N-011: 隐私治理 — sendToExternal 门禁 + PII 检测/脱敏
  const governanceResult = await enforcePrivacyGovernance(
    job.workspaceId,
    ["question", "user_answer", "claim", "quote"],
    { question, questionType, claim: kp.claim, quote: referenceText || kp.quoteText, userAnswer },
    providerSelection.providerName,
  );
  if (!governanceResult.allowed) {
    throw new Error(governanceResult.reason ?? "AI privacy governance blocked this request");
  }

  const provider = createProvider(providerSelection.providerName, providerSelection.config);

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
  try {
    output = await provider.evaluateValidation(sanitizedInput, job.signal);
  } catch (err) {
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
        durationMs: Date.now() - aiCallStart,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
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
    // Serialize the final side effects for this job. A lease may expire after
    // the model call and let a second worker execute the same job concurrently;
    // the advisory transaction lock makes the second transaction wait, then
    // observe the first validation event and return without creating another
    // artifact, understanding event, or review schedule. The DB unique index on
    // validation_events.job_id remains the final invariant.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${job.id}, 0))`);
    const committedResult = await tx.query.validationEvents.findFirst({
      where: and(
        eq(schema.validationEvents.workspaceId, job.workspaceId),
        eq(schema.validationEvents.jobId, job.id),
      ),
    });
    if (committedResult) {
      logger.info(
        { jobId: job.id, validationEventId: committedResult.id },
        "evaluate_validation side effects skipped — concurrent result already committed",
      );
      return;
    }

    // 1. ai_artifacts
    const [artifact] = await tx
      .insert(schema.aiArtifacts)
      .values({
        workspaceId: job.workspaceId,
        type: ArtifactType.VALIDATION_FEEDBACK,
        inputRefs: { cardId, keyPointId: kp!.id },
        output,
        modelId: provider.modelId,
        promptVersion: provider.promptVersion,
        status: ArtifactStatus.READY,
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
      durationMs: Date.now() - aiCallStart,
      status: "success",
    });
  }
}
