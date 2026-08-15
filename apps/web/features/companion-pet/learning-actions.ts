import {
  companionLearningContextV1Schema,
  createMenuProposalResponseV1Schema,
  proposalDecisionResponseV1Schema,
  type CompanionLearningContextV1,
  type CreateMenuProposalResponseV1,
  type ProposalDecisionResponseV1,
} from "@ailearn/shared/companion-conversation-contracts";
import { getCsrfToken } from "@/lib/api";

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
  candidateId: "resume_current" | "start_short" | "learning_run_resume" | "learning_run_start";
  contextRevision: string;
  payloadSha256: string;
  sourceSurface: "pet" | "main" | "web_fallback";
  conversationId?: string;
  idempotencyKey?: string;
  clientMessageId?: string;
}): Promise<CreateMenuProposalResponseV1> {
  const idempotencyKey = args.idempotencyKey ?? crypto.randomUUID();
  const clientMessageId = args.clientMessageId ?? crypto.randomUUID();
  // 2026-08-12+（15a 根因修复）：cookie 鉴权的非 GET 请求必须带 x-csrf-token
  //（api requireSession → hasValidCookieCsrf，缺失返回 403 "csrf token required"）
  // ——此前漏传导致学习快捷方式一直"提交失败/登录过期"（E 节错误码透传把
  // 403 显示成"登录状态已过期"）。与 companion-transcribe-api 同款注入。
  const csrfToken = getCsrfToken();
  const response = await fetch("/api/companion/menu-proposals", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
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
  // 2026-08-12+（15a 根因修复）：decision 也是 cookie 鉴权 POST，同样需要
  // x-csrf-token（缺失 → 403 → 确认/拒绝学习动作失败）。
  const csrfToken = getCsrfToken();
  const response = await fetch(`/api/companion/proposals/${encodeURIComponent(args.proposalId)}/decision`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
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
