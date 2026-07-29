import { and, asc, count, eq, sql, inArray, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { alignQuote } from "../lib/align.ts";
import { assessCardOutput } from "../lib/card-quality.ts";
import type { CardAssessmentResult } from "../lib/card-quality.ts";
// N-011: AI 治理 — 同意门禁 + 审计日志
import {
  enforcePrivacyGovernanceWithPolicy,
  logAICall,
  resolveAIGovernanceContext,
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
  beginCardGenerationPublish,
  completeCardGenerationRun,
  completeExistingCardGenerationRun,
  generationRunIdFromPayload,
  startCardGenerationRun,
} from "../lib/card-generation-run.ts";
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
  CardStatus,
  CardRepairState,
  ValidationOutcome,
  ReviewStatus,
  MAX_PENDING_JOBS_PER_WORKSPACE,
  isCardRepairEnabled,
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
  const lease = leaseContext(job);
  await assertJobLease(lease);
  const generationRunId = generationRunIdFromPayload(job.payload);
  const generationRunStart = generationRunId
    ? await startCardGenerationRun(lease, { runId: generationRunId, noteVersionId })
    : null;
  if (generationRunStart?.state === "skip") {
    logger.info(
      { noteVersionId, generationRunId, reason: generationRunStart.reason },
      "generate_card skipped by generation run start fence",
    );
    return;
  }
  const activeGenerationRun = generationRunStart?.state === "active"
    ? generationRunStart.run
    : null;
  const oldCardId = job.payload.oldCardId as string | undefined;
  logger.info({ noteVersionId, oldCardId, generationRunId }, "running generate_card");

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
    if (generationRunId) {
      await completeExistingCardGenerationRun(lease, {
        runId: generationRunId,
        noteVersionId,
        cardId: existingCard.id,
      });
    }
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
      if (generationRunId) {
        await completeExistingCardGenerationRun(lease, {
          runId: generationRunId,
          noteVersionId,
          cardId: existingCard.id,
        });
      }
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

  // 并行查询 note+version (JOIN)、noteBlocks 和 AI 治理上下文，减少串行 DB 往返
  const [versionNoteRow, blocks, govCtx] = await Promise.all([
    db.select({ version: schema.noteVersions, note: schema.notes })
      .from(schema.noteVersions)
      .innerJoin(schema.notes, eq(schema.notes.id, schema.noteVersions.noteId))
      .where(and(
        eq(schema.noteVersions.id, noteVersionId),
        eq(schema.noteVersions.workspaceId, job.workspaceId),
        eq(schema.notes.workspaceId, job.workspaceId),
      ))
      .limit(1),
    db.query.noteBlocks.findMany({
      where: and(
        eq(schema.noteBlocks.versionId, noteVersionId),
        eq(schema.noteBlocks.workspaceId, job.workspaceId),
      ),
      orderBy: asc(schema.noteBlocks.ordinal),
    }),
    resolveAIGovernanceContext(job.workspaceId, auditUserId),
  ]);
  const version = versionNoteRow[0]?.version;
  const note = versionNoteRow[0]?.note;
  if (!version) throw new Error(`note version ${noteVersionId} not found in workspace`);
  if (!note) throw new Error(`note not found in workspace`);
  if (!govCtx.consentOk) {
    throw new Error("AI consent not signed for this workspace. Owner must sign AI consent before using external AI providers.");
  }

  // 过滤 image block 并提取 alt text，避免将图片 URL 发送给 AI provider。
  // 有 alt text 的图片转为 paragraph 保留语义价值；无 alt text 的丢弃。
  // 此步骤在 enforcePrivacyGovernanceWithPolicy 之前执行，使 PII 检测只需处理文本内容。
  const textBlocks = blocks
    .map((b) => {
      if (b.type === "image") {
        const altMatch = /^!\[([^\]]*)\]\([^)]+\)/.exec(b.content);
        const alt = altMatch?.[1]?.trim();
        return alt ? { ordinal: b.ordinal, type: "paragraph" as const, content: `（图片：${alt}）` } : null;
      }
      return { ordinal: b.ordinal, type: b.type, content: b.content };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  // 隐私治理 — 使用预解析的 policy，避免重复查 workspaces
  const governanceResult = enforcePrivacyGovernanceWithPolicy(
    govCtx.policy,
    job.workspaceId,
    ["note_content"],
    {
      noteTitle: activeGenerationRun?.titleSnapshot ?? note.title,
      blocks: textBlocks,
    },
    govCtx.providerName,
  );
  if (!governanceResult.allowed) {
    throw new Error(governanceResult.reason ?? "AI privacy governance blocked this request");
  }

  const provider = createProvider(govCtx.providerName, govCtx.providerConfig);

  // N-011: 使用脱敏后的数据
  const sanitizedInput = governanceResult.sanitizedData as {
    noteTitle: string;
    blocks: Array<{ ordinal: number; type: string; content: string }>;
  };

  const aiCallStart = Date.now();
  // 计划 §6.6: 开始真实写入 input_hash 与 cost_tokens — capture before AI call
  const cardInputHash = createHash("sha256").update(JSON.stringify(sanitizedInput), "utf8").digest("hex");
  let cardCostTokens: number | null = null;

  let output;
  try {
    output = await provider.generateCard(sanitizedInput, job.signal);
    // OPS-01: Provider 成功指标
    providerCallsTotal.labels("generate_card", "success").inc();
    providerCallDurationSeconds.labels("generate_card").observe((Date.now() - aiCallStart) / 1000);
    // 计划 §6.6: capture cost tokens from original generateCard call before potential repair
    cardCostTokens = provider.getLastUsage()?.totalTokens ?? null;
  } catch (err) {
    // OPS-01: Provider 失败指标
    providerCallsTotal.labels("generate_card", "failed").inc();
    providerCallDurationSeconds.labels("generate_card").observe((Date.now() - aiCallStart) / 1000);
    providerErrorsTotal.labels("generate_card", categorizeError(err)).inc();
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
        dataSizeBytes: JSON.stringify(textBlocks).length,
        costTokens: provider.getLastUsage()?.totalTokens ?? null, // 计划 §6.6: cost tracking
        durationMs: Date.now() - aiCallStart,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }

  // R-007: 模型调用后检查是否已 abort，避免写入学果
  await assertJobLease(leaseContext(job));

  // v0.6 CARD-02: Post-generation quality assessment with conditional repair.
  // assessCardOutput returns structured issue reason codes; hard triggers
  // (quote_not_in_source, claim_quote_unrelated, insufficient_valid_key_points,
  // schema_invalid_bounded) drive a single conditional repair call (计划 §7.7).
  // Terminal schema failure (schema_unparseable) fails the job without repair.
  const originalCount = output.key_points.length;
  const sourceBlockContents = sanitizedInput.blocks.map((b) => b.content);
  let assessment: CardAssessmentResult = assessCardOutput(output, sourceBlockContents);

  // Check for terminal schema failure — do not enter repair
  if (assessment.hardFailure) {
    throw new Error(
      `card generation failed: terminal schema failure (${assessment.issues.map((i) => i.code).join(", ")})`,
    );
  }

  // v0.6 CARD-02: Conditional repair — at most one, same Provider/model
  // Trigger rules (计划 §7.7):
  // - hard trigger: quote_not_in_source, claim_quote_unrelated, insufficient_valid_key_points, schema_invalid_bounded, usedFallback
  // - soft trigger (only if CARD_REPAIR_V1_ENABLED): duplicate_key_point, coverage_too_low
  //
  // 计划 §12.2: CARD_REPAIR_V1_ENABLED gates ALL repair behavior.
  // When false, fall back to single sanitizeCardOutput (no repair call).
  const hardTriggers = assessment.issues.filter((i) => i.severity === "hard");
  const repairEnabled = isCardRepairEnabled();

  // Save draft artifact for lineage if repair occurs (计划 §7.7:
  // "Draft artifact 在发生修复时保存为 dismissed，final artifact 指向 parent")
  let draftArtifactId: string | null = null;
  let repairInputHash: string | null = null;

  if (repairEnabled && (hardTriggers.length > 0 || assessment.usedFallback)) {
    logger.info(
      {
        originalCount,
        sanitizedCount: assessment.sanitized.key_points.length,
        hardTriggerCount: hardTriggers.length,
        usedFallback: assessment.usedFallback,
        issueCodes: assessment.issues.map((i) => i.code),
      },
      "card quality issues detected — attempting conditional repair (CARD-02)",
    );

    // 计划 §7.7: Persist repair state CAS none → claimed before calling Provider.
    // This ensures crash/lease-lost prevents a second repair call.
    // Job retry after crash will see repair_state=claimed and fail closed.
    // CAS 必须 lease-fenced：附带 lease_token + status='running' 条件，防止
    // lease 已被收割的旧 worker 赢得 claim 并发起唯一一次 repair 调用
    // （计划 §7.7 "lease-fenced CAS"）。同时在调用 Provider 之前就把
    // repair_attempt_count 置 1——失败/超时的付费调用也必须留下持久痕迹
    // （计划 §7.7 "调用前持久化 request attempt"）。
    const [claimedJob] = await db
      .update(schema.jobs)
      .set({
        repairState: CardRepairState.CLAIMED,
        repairAttemptCount: 1,
      })
      .where(
        and(
          eq(schema.jobs.id, job.id),
          eq(schema.jobs.workspaceId, job.workspaceId),
          eq(schema.jobs.repairState, CardRepairState.NONE),
          eq(schema.jobs.status, "running"),
          eq(schema.jobs.leaseToken, job.leaseToken),
        ),
      )
      .returning();
    if (!claimedJob) {
      // repair_state was not 'none' — either already claimed or completed —
      // or this worker's lease is no longer current.
      // Fail closed: do not attempt repair again (计划 §7.7:
      // "崩溃或 lease 丢失后不得再次发起 repair，只能保守失败")
      throw new Error(
        "card repair already attempted or lease no longer current — refusing to repair",
      );
    }

    // Save draft artifact as dismissed for lineage (计划 §7.7:
    // "Draft artifact 在发生修复时保存为 dismissed，final artifact 指向 parent")
    const [draftArtifact] = await db
      .insert(schema.aiArtifacts)
      .values({
        workspaceId: version.workspaceId,
        type: "learning_card",
        inputRefs: { noteVersionId },
        output: assessment.sanitized,
        modelId: provider.modelId,
        promptVersion: provider.promptVersion,
        status: ArtifactStatus.DISMISSED,
        inputHash: cardInputHash, // 计划 §6.6: input_hash for draft artifact
        costTokens: cardCostTokens, // 计划 §6.6: cost_tokens from original generateCard call
      })
      .returning();
    draftArtifactId = draftArtifact.id;

    // Repair uses the same Provider/model and governance context.
    // Provider/SDK transport layer maxAttempts=1, no implicit auto-retry.
    const repairStart = Date.now();
    // Capture repair input size before output is reassigned to repaired output.
    // This ensures dataSizeBytes reflects the actual data sent to the Provider.
    const repairInputStr = JSON.stringify({ draft: output, sourceBlocks: sourceBlockContents, issues: assessment.issues });
    const repairInputSize = repairInputStr.length;
    repairInputHash = createHash("sha256").update(repairInputStr, "utf8").digest("hex");
    try {
      const repairedOutput = await provider.repairCard(
        {
          draft: output,
          sourceBlocks: sourceBlockContents,
          issues: assessment.issues,
        },
        job.signal,
      );

      // R-007: Check lease after repair call
      await assertJobLease(leaseContext(job));

      // Re-run the same assessor on the repaired output (计划 §7.7)
      const reAssessment = assessCardOutput(repairedOutput, sourceBlockContents);

      // If repair itself has hard failure, fail the job — do not activate card
      if (reAssessment.hardFailure) {
        throw new Error(
          `card repair failed: terminal schema failure after repair (${reAssessment.issues.map((i) => i.code).join(", ")})`,
        );
      }

      // If repair still has hard triggers, it's a hard failure — don't activate
      const remainingHardTriggers = reAssessment.issues.filter((i) => i.severity === "hard");
      if (remainingHardTriggers.length > 0) {
        throw new Error(
          `card repair did not resolve all hard triggers: ${remainingHardTriggers.map((i) => i.code).join(", ")}`,
        );
      }

      // Repair succeeded — persist repair_state=completed（attempt count 已在
      // claim 时写入）。同样 lease-fenced 且以 claimed 为前置状态。
      await db
        .update(schema.jobs)
        .set({
          repairState: CardRepairState.COMPLETED,
        })
        .where(and(
          eq(schema.jobs.id, job.id),
          eq(schema.jobs.workspaceId, job.workspaceId),
          eq(schema.jobs.repairState, CardRepairState.CLAIMED),
          eq(schema.jobs.leaseToken, job.leaseToken),
        ));

      // Repair succeeded — use the repaired output
      logger.info(
        {
          originalIssues: assessment.issues.length,
          repairedIssues: reAssessment.issues.length,
          repairDurationMs: Date.now() - repairStart,
        },
        "card repair succeeded — using repaired output",
      );

      output = reAssessment.sanitized;
      assessment = reAssessment;

      // OPS-01: Provider success metrics for repair
      providerCallsTotal.labels("generate_card_repair", "success").inc();
      providerCallDurationSeconds.labels("generate_card_repair").observe((Date.now() - repairStart) / 1000);

      // N-011: Log repair call separately for cost/usage traceability (计划 §10.5)
      // Includes costTokens for Provider usage tracking (计划 §6.6, §10.5)
      if (await isJobLeaseActive(leaseContext(job))) {
        await logAICall({
          workspaceId: job.workspaceId,
          userId: auditUserId,
          jobId: job.id,
          provider: provider.id,
          modelId: provider.modelId,
          operation: "generate_card_repair",
          dataCategories: ["note_content"],
          dataSizeBytes: repairInputSize,
          costTokens: provider.getLastUsage()?.totalTokens ?? null,
          durationMs: Date.now() - repairStart,
          status: "success",
        });
      }
    } catch (repairErr) {
      // OPS-01: Provider failure metrics for repair
      providerCallsTotal.labels("generate_card_repair", "failed").inc();
      providerCallDurationSeconds.labels("generate_card_repair").observe((Date.now() - repairStart) / 1000);
      providerErrorsTotal.labels("generate_card_repair", categorizeError(repairErr)).inc();

      // N-011: Log repair failure
      // Includes costTokens for Provider usage tracking (计划 §6.6, §10.5)
      if (await isJobLeaseActive(leaseContext(job))) {
        await logAICall({
          workspaceId: job.workspaceId,
          userId: auditUserId,
          jobId: job.id,
          provider: provider.id,
          modelId: provider.modelId,
          operation: "generate_card_repair",
          dataCategories: ["note_content"],
          dataSizeBytes: repairInputSize,
          costTokens: provider.getLastUsage()?.totalTokens ?? null,
          durationMs: Date.now() - repairStart,
          status: "failed",
          errorMessage: repairErr instanceof Error ? repairErr.message : String(repairErr),
        });
      }

      // Repair failed — if the original assessment had hard triggers,
      // we cannot safely activate the card. Fail the job.
      if (hardTriggers.length > 0) {
        throw new Error(
          `card generation failed after repair: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`,
        );
      }

      // If repair failed but only soft triggers existed, use the original
      // sanitized output (soft triggers don't block card activation)
      logger.warn(
        { repairError: repairErr instanceof Error ? repairErr.message : String(repairErr) },
        "card repair failed but only soft triggers — using original sanitized output",
      );
    }
  } else if (assessment.issues.length > 0) {
    // 注意：flag 关闭时 hard trigger 也会走到这里——分别记录 hard/soft 数量，
    // 避免灰度观察期把"被 flag 挡下的 hard 缺陷 draft"误读成只有 soft 问题。
    logger.info(
      {
        originalCount,
        sanitizedCount: assessment.sanitized.key_points.length,
        hardIssueCount: hardTriggers.length,
        softIssueCount: assessment.issues.filter((i) => i.severity === "soft").length,
        issueCodes: assessment.issues.map((i) => i.code),
        repairEnabled,
      },
      repairEnabled
        ? "card output sanitized — soft issues only, no repair needed"
        : "card output sanitized — repair disabled by flag (hard triggers, if any, were not repaired)",
    );
  }

  output = assessment.sanitized;

  const cardBody = [output.summary, ...output.key_points.map((kp) => kp.claim)].join("\n");

  // Persist the card and its search projection in the same lease-fenced
  // transaction. A timed-out handler must not mutate search_documents after
  // the outer worker has released the lease for a retry.
  const publication = await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, lease);
    // Serialize card completion with API enqueue/dedupe/quota checks for this
    // workspace. This closes the window where a completed job disappears from
    // the active-job query immediately before its card becomes observable.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${job.workspaceId}`}, 0)
      )
    `);

    const runPublishing = activeGenerationRun
      ? await beginCardGenerationPublish(tx, {
          runId: activeGenerationRun.id,
          workspaceId: job.workspaceId,
          noteVersionId,
        })
      : null;
    if (runPublishing?.state === "skip") {
      return { published: false as const, reason: runPublishing.reason };
    }

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
  // 计划 §7.7: 若发生修复，final artifact 指向 parent (draftArtifactId)
  // 计划 §6.6: 开始真实写入 input_hash 与 cost_tokens
  const finalInputHash = draftArtifactId ? repairInputHash : cardInputHash;
  const finalCostTokens = draftArtifactId ? (provider.getLastUsage()?.totalTokens ?? null) : cardCostTokens;
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
        parentArtifactId: draftArtifactId,
        inputHash: finalInputHash, // 计划 §6.6
        costTokens: finalCostTokens, // 计划 §6.6
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
        priority: 10,
        resourceClass: "maintenance",
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

    // 回滚一致性：legacy 发布替换了 v2 卡组的成员卡后，卡组本身也必须同事务
    // 置为 superseded 并清理其 card_set 搜索投影。否则回滚后重新生成会留下
    // 一个"active 但成员全部 superseded"的卡组（产品面 split-brain，runbook
    // §5.5 的 overview 计数检查也测不出来）。
    const staleActiveSets = await tx
      .select({ id: schema.learningCardSets.id })
      .from(schema.learningCardSets)
      .where(and(
        eq(schema.learningCardSets.workspaceId, version.workspaceId),
        eq(schema.learningCardSets.noteId, version.noteId),
        eq(schema.learningCardSets.status, "active"),
      ))
      .for("update");
    if (staleActiveSets.length > 0) {
      const staleSetIds = staleActiveSets.map((set) => set.id);
      await tx
        .update(schema.learningCardSets)
        .set({ status: "superseded", supersededAt: new Date() })
        .where(and(
          eq(schema.learningCardSets.workspaceId, version.workspaceId),
          inArray(schema.learningCardSets.id, staleSetIds),
          eq(schema.learningCardSets.status, "active"),
        ));
      await tx
        .delete(schema.searchDocuments)
        .where(and(
          eq(schema.searchDocuments.workspaceId, version.workspaceId),
          eq(schema.searchDocuments.objectType, "card_set"),
          inArray(schema.searchDocuments.objectId, staleSetIds),
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
    if (runPublishing?.state === "active") {
      await completeCardGenerationRun(tx, {
        run: runPublishing.run,
        cardId: card.id,
      });
    }
    throwIfJobAborted(job);
    logger.info({ cardId: card.id, keyPoints: kps.length }, "card persisted");

    return { published: true as const };
  });

  if (!publication.published) {
    logger.info(
      { noteVersionId, generationRunId, reason: publication.reason },
      "generate_card result was not published by generation run fence",
    );
  }

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
      dataSizeBytes: JSON.stringify(textBlocks).length,
      costTokens: cardCostTokens, // 计划 §6.6: cost tracking for generate_card
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
    throw new Error("AI consent not signed for this workspace. Owner must sign AI consent before using external AI providers.");
  }

  // 隐私治理 — 使用预解析的 policy，避免重复查 workspaces
  const governanceResult = enforcePrivacyGovernanceWithPolicy(
    govCtx.policy,
    job.workspaceId,
    ["question", "user_answer", "claim", "quote"],
    { question, questionType, claim: kp.claim, quote: referenceText || kp.quoteText, userAnswer },
    govCtx.providerName,
  );
  if (!governanceResult.allowed) {
    throw new Error(governanceResult.reason ?? "AI privacy governance blocked this request");
  }

  const provider = createProvider(govCtx.providerName, govCtx.providerConfig);

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
        costTokens: provider.getLastUsage()?.totalTokens ?? null, // 计划 §6.6: cost tracking
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
        costTokens: provider.getLastUsage()?.totalTokens ?? null, // 计划 §6.6
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
      costTokens: provider.getLastUsage()?.totalTokens ?? null, // 计划 §6.6: cost tracking
      durationMs: Date.now() - aiCallStart,
      status: "success",
    });
  }
}
