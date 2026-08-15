/**
 * Card Generation V2 — Candidate Reveal（方案 20 §17.6）。
 *
 * Exposure-first：先持久化 Exposure，再返回答案。
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  cardGenerationCandidatesV2,
  cardExposureLedgerV2,
} from "../../db/schema/card-generation-v2.ts";
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

export async function revealCandidateV2(
  ctx: RunContext,
  runId: string,
  candidateId: string,
  expectedRevision: number,
  expectedRevisionHash: string,
  idempotencyKey: string,
): Promise<CandidateRevealV2> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    // Idempotency: same key returns same exposure
    const existing = await tx.select().from(cardExposureLedgerV2)
      .where(and(
        eq(cardExposureLedgerV2.workspaceId, ctx.workspaceId),
        eq(cardExposureLedgerV2.userId, ctx.userId),
        eq(cardExposureLedgerV2.idempotencyKey, idempotencyKey),
      ))
      .limit(1);

    if (existing.length > 0) {
      const exp = existing[0];
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
      return buildCandidateReveal(candidates[0], exp.exposureId, exp.exposedAt.toISOString());
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

    return buildCandidateReveal(candidate, exposureId, new Date().toISOString());
  });
}

function buildCandidateReveal(
  candidate: typeof cardGenerationCandidatesV2.$inferSelect,
  exposureId: string,
  exposedAt: string,
): CandidateRevealV2 {
  const obj = candidate.objectiveDraft as {
    canonicalAnswer: CandidateRevealV2["canonicalAnswer"];
    learningSupport: {
      explanation: string;
      boundary?: string;
      misconception?: string;
      workedExample?: string;
    };
  };
  const reveal: CandidateRevealV2 = {
    version: 2,
    candidateId: candidate.candidateId,
    candidateRevisionId: candidate.candidateRevisionId,
    revision: candidate.revision,
    exposureId,
    canonicalAnswer: obj.canonicalAnswer,
    explanation: obj.learningSupport.explanation,
    boundary: obj.learningSupport.boundary,
    misconception: obj.learningSupport.misconception,
    workedExample: obj.learningSupport.workedExample,
    evidencePreviews: [],
    exposedAt,
  };
  return parseCandidateRevealV2(reveal);
}
