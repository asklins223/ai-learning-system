import {
  cardGenerationCandidateListV1Schema,
  cardGenerationCandidateV1Schema,
  cardGenerationActiveSummaryListV1Schema,
  cardGenerationCloseResultV1Schema,
  cardGenerationJobAcceptedV1Schema,
  cardGenerationPlanServerViewV2Schema,
  cardGenerationReviewResultV1Schema,
  cardGenerationRunServerViewV2Schema,
  cardGenerationRunSnapshotV1Schema,
  cardGenerationCancelResultV1Schema,
  cardGenerationRecoveryProjectionV1Schema,
  projectCardGenerationRunSnapshotV1,
  type CardGenerationRunServerViewV2,
  type CardGenerationCandidateListV1,
  type CardGenerationCloseResultV1,
  type CardGenerationJobAcceptedV1,
  type CardGenerationReviewResultV1,
  type CardGenerationRunSnapshotV1,
  type CardGenerationCancelResultV1,
} from "@ailearn/shared/card-generation-desktop-contracts";
import { cardActivationReceiptV2Schema, candidateRevealV2Schema } from "@ailearn/shared/card-generation-v2-contracts";
import type { CardPlanV2 } from "@ailearn/shared/card-generation-v2-contracts";
import { z } from "zod";

type CardGenerationRecoveryInput = Pick<
  CardGenerationRunServerViewV2,
  "runId" | "noteId" | "noteVersionId" | "status" | "sourceOutdated" | "error"
>;

const recoveryRunStatuses = new Set(["needs_attention", "failed", "stale"]);

function publicRecoveryReason(value: CardGenerationRecoveryInput) {
  if (value.status === "stale" || value.sourceOutdated) return "source_outdated" as const;
  const errorCode = value.error?.code.toLowerCase() ?? "";
  if (/(provider|credential|model|ai_)/.test(errorCode)) return "provider_unavailable" as const;
  if (/(quality|grounding|pedagogy|evidence|critic)/.test(errorCode)) return "quality_gate_failed" as const;
  if (value.status === "failed") return "run_failed" as const;
  if (value.status === "needs_attention") return "attention_required" as const;
  return "unknown" as const;
}

export function projectCardGenerationRecoveryV1(value: CardGenerationRecoveryInput) {
  if (!recoveryRunStatuses.has(value.status)) return null;
  const sourceRef = { noteId: value.noteId, noteVersionId: value.noteVersionId };
  return cardGenerationRecoveryProjectionV1Schema.parse({
    version: 1,
    publicReasonCode: publicRecoveryReason(value),
    // The desktop contract intentionally exposes resync-only recovery until a
    // validated latest-note target and a new-run setup command are available.
    // It never turns a failed run into an implicit same-run retry.
    retryability: "resync_required",
    allowedActions: [
      { kind: "refresh_status", runId: value.runId },
      { kind: "return_note", route: "note.detail", sourceRef },
    ],
  });
}

export function projectCardGenerationJobAcceptedV1(value: unknown): CardGenerationJobAcceptedV1 {
  const server = cardGenerationJobAcceptedV1Schema.omit({ version: true }).parse(value);
  return cardGenerationJobAcceptedV1Schema.parse({
    version: 1,
    runId: server.runId,
    status: server.status,
  });
}

export function projectCardGenerationRunSnapshotV1FromServer(value: unknown): CardGenerationRunSnapshotV1 {
  const server = cardGenerationRunServerViewV2Schema.parse(value);
  return cardGenerationRunSnapshotV1Schema.parse(projectCardGenerationRunSnapshotV1(server));
}

export function parseCardGenerationRunServerViewV2(value: unknown) {
  return cardGenerationRunServerViewV2Schema.parse(value);
}

export function parseCardGenerationPlanV2(value: unknown): CardPlanV2 {
  return cardGenerationPlanServerViewV2Schema.parse(value);
}

export function projectCardGenerationCandidatesV1(runId: string, value: unknown): CardGenerationCandidateListV1 {
  const candidates = z.array(cardGenerationCandidateV1Schema.omit({ version: true })).max(1000).parse(value);
  return cardGenerationCandidateListV1Schema.parse({
    version: 1,
    runId,
    candidates: candidates.map((candidate) => cardGenerationCandidateV1Schema.parse({ version: 1, ...candidate })),
  });
}

export function projectCardGenerationActiveSummaryListV1(value: unknown) {
  const runs = z.array(cardGenerationRunServerViewV2Schema).max(20).parse(value);
  return cardGenerationActiveSummaryListV1Schema.parse({
    version: 1,
    items: runs.map((run) => ({
      version: 1,
      runId: run.runId,
      noteId: run.noteId,
      noteVersionId: run.noteVersionId,
      status: run.status,
      currentPlanVersion: run.currentPlanVersion,
      reviewDraftRevision: run.reviewDraftRevision,
      updatedAt: run.updatedAt,
      recovery: run.recovery,
      route: { kind: "note.cardGeneration", cardGenerationRunId: run.runId },
    })),
  });
}

export function projectCardGenerationReviewResultV1(value: unknown): CardGenerationReviewResultV1 {
  const server = cardGenerationReviewResultV1Schema.omit({ version: true }).parse(value);
  return cardGenerationReviewResultV1Schema.parse({
    version: 1,
    runId: server.runId,
    actionType: server.actionType,
    reviewDraftRevision: server.reviewDraftRevision,
    ...(server.candidateId ? { candidateId: server.candidateId } : {}),
    ...(server.feedbackReasonCodes ? { feedbackReasonCodes: server.feedbackReasonCodes } : {}),
  });
}

export function projectCardGenerationCancelResultV1(value: unknown): CardGenerationCancelResultV1 {
  const server = cardGenerationCancelResultV1Schema.omit({ version: true }).parse(value);
  return cardGenerationCancelResultV1Schema.parse({
    version: 1,
    runId: server.runId,
    status: server.status,
  });
}

export function projectCardGenerationCloseResultV1(value: unknown): CardGenerationCloseResultV1 {
  const server = cardGenerationCloseResultV1Schema.omit({ version: true }).parse(value);
  return cardGenerationCloseResultV1Schema.parse({
    version: 1,
    runId: server.runId,
    status: server.status,
    reviewDraftRevision: server.reviewDraftRevision,
  });
}

export function parseCardActivationReceiptV2(value: unknown) {
  return cardActivationReceiptV2Schema.parse(value);
}

export function parseCandidateRevealV2(value: unknown) {
  return candidateRevealV2Schema.parse(value);
}
