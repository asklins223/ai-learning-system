/**
 * Card Generation V2 — Candidate Reveal（方案 20 §17.6）。
 *
 * Exposure-first：先持久化 Exposure，再返回答案。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import type { ApiTransaction } from "../../db/client.ts";
import {
  cardGenerationCandidatesV2,
  cardExposureLedgerV2,
  evidenceSnapshotsV2,
} from "../../db/schema/card-generation-v2.ts";
import { noteBlocks } from "../../db/schema/note.ts";
import {
  parseCandidateRevealV2,
  type CandidateRevealV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import {
  CardGenerationV2ServiceError,
  insertEvent,
  type RunContext,
} from "./helpers.ts";

/**
 * CARD-GEN-EXPOSURE-PROJECTION-01：读取 current user + exact candidate
 * revision 的公开 exposure/eligibility 状态。答案和 evidence 绝不进入此 DTO。
 */
export async function getCandidateExposureEligibilityV2(
  ctx: RunContext,
  runId: string,
  candidateId: string,
  revision: number,
) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const candidateRows = await tx.select().from(cardGenerationCandidatesV2)
      .where(and(
        eq(cardGenerationCandidatesV2.runId, runId),
        eq(cardGenerationCandidatesV2.candidateId, candidateId),
        eq(cardGenerationCandidatesV2.revision, revision),
        eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
      ))
      .limit(1);
    if (candidateRows.length === 0) return null;

    const candidate = candidateRows[0];
    const exposures = await tx.select().from(cardExposureLedgerV2)
      .where(and(
        eq(cardExposureLedgerV2.workspaceId, ctx.workspaceId),
        eq(cardExposureLedgerV2.userId, ctx.userId),
        eq(cardExposureLedgerV2.subjectKind, "candidate"),
        eq(cardExposureLedgerV2.subjectCandidateId, candidateId),
        eq(cardExposureLedgerV2.subjectCandidateRevision, revision),
        inArray(cardExposureLedgerV2.exposureKind, ["answer_reveal", "evidence_reveal", "answer_editor_view"]),
      ))
      .orderBy(desc(cardExposureLedgerV2.exposedAt), desc(cardExposureLedgerV2.id))
      .limit(1);
    const lastExposure = exposures[0];
    const exposed = Boolean(lastExposure);
    return {
      version: 1 as const,
      runId,
      candidateId,
      candidateRevisionId: candidate.candidateRevisionId,
      revision,
      exposureStatus: exposed ? "exposed" as const : "not_exposed" as const,
      initialValidationPolicyEffect: exposed
        ? "wait_for_initial_validation" as const
        : "eligible" as const,
      lastExposedAt: lastExposure?.exposedAt.toISOString() ?? null,
    };
  });
}

export async function revealCandidateV2(
  ctx: RunContext,
  runId: string,
  candidateId: string,
  expectedRevision: number,
  expectedRevisionHash: string,
  idempotencyKey: string,
): Promise<CandidateRevealV2> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    // CARD-GEN-CANDIDATE-COMMANDS-01：同一 domain key 串行化，
    // 让 overlap loser 在 winner 提交后读取同一 exposure，而不是撞唯一约束。
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`v2-reveal:${ctx.workspaceId}:${ctx.userId}:${idempotencyKey}`}, 0)
      )
    `);

    // Idempotency: same key returns the same exposure only for the exact
    // candidate/revision request. A reused key with changed routing or
    // revision is a conflict, never a second exposure.
    const existing = await tx.select().from(cardExposureLedgerV2)
      .where(and(
        eq(cardExposureLedgerV2.workspaceId, ctx.workspaceId),
        eq(cardExposureLedgerV2.userId, ctx.userId),
        eq(cardExposureLedgerV2.idempotencyKey, idempotencyKey),
      ))
      .limit(1);

    if (existing.length > 0) {
      const exp = existing[0];
      if (
        exp.subjectCandidateId !== candidateId ||
        exp.subjectCandidateRevision !== expectedRevision
      ) {
        throw new CardGenerationV2ServiceError(
          "idempotency_conflict",
          409,
          "幂等键已用于不同的 reveal 请求",
        );
      }
      // 修复：幂等查询后应用 subjectCandidateId + subjectCandidateRevision 来定位候选
      // subjectCandidateId 存的是 candidateId（不是 candidateRevisionId）
      // subjectCandidateRevision 存的是 revision 号
      const candidates = await tx.select().from(cardGenerationCandidatesV2)
        .where(and(
          eq(cardGenerationCandidatesV2.candidateId, exp.subjectCandidateId ?? ""),
          eq(cardGenerationCandidatesV2.revision, exp.subjectCandidateRevision ?? 0),
          eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      if (candidates.length === 0) {
        throw new CardGenerationV2ServiceError("candidate_not_found", 404, "候选不存在");
      }
      if (candidates[0].runId !== runId || candidates[0].candidateRevisionHash !== expectedRevisionHash) {
        throw new CardGenerationV2ServiceError(
          "idempotency_conflict",
          409,
          "幂等键已用于不同的 reveal 请求",
        );
      }
      return await buildCandidateReveal(tx, ctx.workspaceId, candidates[0], exp.exposureId, exp.exposedAt.toISOString());
    }

    const candidates = await tx.select().from(cardGenerationCandidatesV2)
      .where(and(
        eq(cardGenerationCandidatesV2.runId, runId),
        eq(cardGenerationCandidatesV2.candidateId, candidateId),
        eq(cardGenerationCandidatesV2.revision, expectedRevision),
        eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
      ))
      .limit(1);

    if (candidates.length === 0) {
      throw new CardGenerationV2ServiceError("candidate_not_found", 404, "候选不存在");
    }

    const candidate = candidates[0];
    if (candidate.candidateRevisionHash !== expectedRevisionHash) {
      throw new CardGenerationV2ServiceError("stale_revision", 409, "候选版本已更新，请刷新");
    }

    // Write exposure BEFORE returning answer
    const exposureId = randomUUID();
    const contextHash = hashCanonicalV2("candidate-reveal-v2", {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      candidateRevisionId: candidate.candidateRevisionId,
      candidateRevisionHash: candidate.candidateRevisionHash,
      revealPolicyVersion: "pre-run-reveal-policy-v1",
    });

    await tx.insert(cardExposureLedgerV2).values({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      exposureId,
      subjectKind: "candidate",
      subjectCandidateId: candidate.candidateId,
      subjectCandidateRevision: candidate.revision,
      exposureKind: "answer_reveal",
      contextHash,
      idempotencyKey,
    });

    await insertEvent(tx, ctx.workspaceId, runId, "card_candidate.revealed", {
      candidateId, candidateRevisionId: candidate.candidateRevisionId, exposureId,
    });

    return await buildCandidateReveal(tx, ctx.workspaceId, candidate, exposureId, new Date().toISOString());
  });
}

/**
 * 构造候选 reveal 响应（§17.6）。
 *
 * 原文依据（evidencePreviews）不是占位空数组：候选 objectiveDraft.evidenceRefIds
 * 引用 sealed evidence snapshot，正文按 blockId 从 note_blocks 原文按
 * [startOffset, endOffset) 切片（与 worker loadSealedEvidence 同源），
 * 取前 2000 字符作为预览。引用缺失/正文不可得时如实返回空数组
 * （前端显示"暂无原文依据预览"）。
 */
async function buildCandidateReveal(
  tx: ApiTransaction,
  workspaceId: string,
  candidate: typeof cardGenerationCandidatesV2.$inferSelect,
  exposureId: string,
  exposedAt: string,
): Promise<CandidateRevealV2> {
  const obj = candidate.objectiveDraft as {
    canonicalAnswer: CandidateRevealV2["canonicalAnswer"];
    learningSupport: {
      explanation: string;
      boundary?: string;
      misconception?: string;
      workedExample?: string;
    };
    evidenceRefIds?: string[];
  };
  const reveal: CandidateRevealV2 = {
    version: 2,
    candidateId: candidate.candidateId,
    candidateRevisionId: candidate.candidateRevisionId,
    revision: candidate.revision,
    exposureId,
    canonicalAnswer: obj.canonicalAnswer,
    explanation: obj.learningSupport.explanation,
    boundary: obj.learningSupport.boundary || undefined,
    misconception: obj.learningSupport.misconception || undefined,
    workedExample: obj.learningSupport.workedExample || undefined,
    evidencePreviews: await loadEvidencePreviews(tx, workspaceId, obj.evidenceRefIds ?? []),
    exposedAt,
  };
  return parseCandidateRevealV2(reveal);
}

/** 按 evidenceRefIds 取 sealed 证据原文切片作为预览（最多 20 条，每条 ≤2000 字符）。 */
async function loadEvidencePreviews(
  tx: ApiTransaction,
  workspaceId: string,
  refIds: string[],
): Promise<CandidateRevealV2["evidencePreviews"]> {
  const ids = [...new Set(refIds)].slice(0, 20);
  if (ids.length === 0) return [];

  const rows = await tx.select().from(evidenceSnapshotsV2)
    .where(and(
      eq(evidenceSnapshotsV2.workspaceId, workspaceId),
      inArray(evidenceSnapshotsV2.evidenceSnapshotId, ids),
    ))
    .limit(20);
  if (rows.length === 0) return [];

  const blockIds = [...new Set(
    rows.map((r) => r.blockId).filter((b): b is string => Boolean(b)),
  )];
  const blockTextById = new Map<string, string>();
  if (blockIds.length > 0) {
    const blockRows = await tx.select().from(noteBlocks)
      .where(and(
        eq(noteBlocks.workspaceId, workspaceId),
        inArray(noteBlocks.id, blockIds),
      ));
    for (const b of blockRows) blockTextById.set(b.id, b.content);
  }

  const previews: CandidateRevealV2["evidencePreviews"] = [];
  for (const row of rows) {
    const blockText = row.blockId ? blockTextById.get(row.blockId) ?? "" : "";
    const start = Math.max(0, row.startOffset ?? 0);
    const end = Math.min(blockText.length, row.endOffset ?? blockText.length);
    const preview = blockText.slice(start, end).trim();
    if (!preview) continue;
    previews.push({
      evidenceSnapshotId: row.evidenceSnapshotId,
      preview: preview.slice(0, 2000),
      sourceLabel: null,
    });
  }
  return previews;
}
