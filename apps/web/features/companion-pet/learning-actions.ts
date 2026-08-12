import {
  companionLearningContextV1Schema,
  createMenuProposalResponseV1Schema,
  proposalDecisionResponseV1Schema,
  type CompanionLearningContextV1,
  type CreateMenuProposalResponseV1,
  type ProposalDecisionResponseV1,
} from "@ailearn/shared/companion-conversation-contracts";

export class LearningActionClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`learning action request failed: ${status} ${code}`);
    this.name = "LearningActionClientError";
    this.status = status;
    this.code = code;
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function fetchLearningContext(): Promise<CompanionLearningContextV1> {
  const response = await fetch("/api/companion/learning-context", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const body = await readJson(response);
  if (!response.ok) {
    const code = typeof body === "object" && body && "error" in body && typeof body.error === "string"
      ? body.error
      : "CONTEXT_LOAD_FAILED";
    throw new LearningActionClientError(response.status, code);
  }
  const parsed = companionLearningContextV1Schema.safeParse(body);
  if (!parsed.success) throw new LearningActionClientError(502, "INVALID_CONTEXT_RESPONSE");
  return parsed.data;
}

export async function createLearningMenuProposal(args: {
  candidateId: "resume_current" | "start_short";
  contextRevision: string;
  payloadSha256: string;
  sourceSurface: "pet" | "main" | "web_fallback";
  conversationId?: string;
  idempotencyKey?: string;
  clientMessageId?: string;
}): Promise<CreateMenuProposalResponseV1> {
  const idempotencyKey = args.idempotencyKey ?? crypto.randomUUID();
  const clientMessageId = args.clientMessageId ?? crypto.randomUUID();
  const response = await fetch("/api/companion/menu-proposals", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      version: 1,
      conversationId: args.conversationId,
      clientMessageId,
      candidateId: args.candidateId,
      expectedContextRevision: args.contextRevision,
      expectedPayloadSha256: args.payloadSha256,
      sourceSurface: args.sourceSurface,
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const code = typeof body === "object" && body && "error" in body && typeof body.error === "string"
      ? body.error
      : "PROPOSAL_CREATE_FAILED";
    throw new LearningActionClientError(response.status, code);
  }
  const parsed = createMenuProposalResponseV1Schema.safeParse(body);
  if (!parsed.success) throw new LearningActionClientError(502, "INVALID_PROPOSAL_RESPONSE");
  return parsed.data;
}

export async function decideLearningProposal(args: {
  proposalId: string;
  decision: "confirm" | "reject";
  idempotencyKey?: string;
}): Promise<ProposalDecisionResponseV1> {
  const idempotencyKey = args.idempotencyKey ?? crypto.randomUUID();
  const response = await fetch(`/api/companion/proposals/${encodeURIComponent(args.proposalId)}/decision`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ version: 1, proposalId: args.proposalId, decision: args.decision, idempotencyKey }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const code = typeof body === "object" && body && "error" in body && typeof body.error === "string"
      ? body.error
      : "PROPOSAL_DECISION_FAILED";
    throw new LearningActionClientError(response.status, code);
  }
  const parsed = proposalDecisionResponseV1Schema.safeParse(body);
  if (!parsed.success) throw new LearningActionClientError(502, "INVALID_DECISION_RESPONSE");
  return parsed.data;
}
