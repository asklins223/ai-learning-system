/**
 * Journey V2 真实 API client（文档 16 §10.1）。
 *
 * 只在 Electron Pet 窗口消费（window.desktopAPI 存在时）；浏览器/Web 路径
 * 不调用（桌宠默认不做 web 端）。
 */

import {
  companionInvitationActionRequestSchema,
  companionInvitationSchema,
  companionJourneyActionRequestSchema,
  companionJourneyBootstrapSchema,
  companionJourneySchema,
  type CompanionInvitationV2,
  type CompanionJourneyBootstrapV2,
  type CompanionJourneyV2,
} from "@ailearn/shared";
import { getCsrfToken } from "@/lib/api";

export type { CompanionInvitationV2, CompanionJourneyBootstrapV2, CompanionJourneyV2 };

export class JourneyClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "JourneyClientError";
    this.status = status;
    this.code = code;
  }
}

function csrfHeaders(): Record<string, string> {
  const csrf = getCsrfToken();
  return csrf ? { "x-csrf-token": csrf } : {};
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function expectJson(response: Response, label: string): Promise<unknown> {
  const body = await readJson(response);
  if (!response.ok) {
    const code =
      typeof body === "object" && body && "error" in body && typeof body.error === "string"
        ? body.error
        : "JOURNEY_REQUEST_FAILED";
    const message =
      typeof body === "object" && body && "message" in body && typeof body.message === "string"
        ? body.message
        : `${label} 失败`;
    throw new JourneyClientError(response.status, code, message);
  }
  return body;
}

export async function fetchJourneyBootstrap(): Promise<CompanionJourneyBootstrapV2> {
  const response = await fetch("/api/companion/journey/bootstrap", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const body = await expectJson(response, "旅程状态");
  const parsed = companionJourneyBootstrapSchema.safeParse(body);
  if (!parsed.success) throw new JourneyClientError(502, "INVALID_BOOTSTRAP", "旅程状态响应非法");
  return parsed.data;
}

export async function sendInvitationAction(input: {
  expectedRevision: number;
  action: { kind: "defer"; deferredUntil: string }
    | { kind: "skip" }
    | { kind: "start_journey"; workspaceId: string; branch: "own_material" | "blank_note" | "sandbox_sample" }
    | { kind: "replay"; workspaceId: string; branch: "own_material" | "blank_note" | "sandbox_sample" };
  idempotencyKey: string;
}): Promise<CompanionInvitationV2> {
  const request = companionInvitationActionRequestSchema.parse({
    version: 2,
    expectedRevision: input.expectedRevision,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
  });
  const response = await fetch("/api/companion/invitation/actions", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeaders(),
    },
    body: JSON.stringify(request),
  });
  const body = await expectJson(response, "邀请操作");
  const parsed = companionInvitationSchema.safeParse(body);
  if (!parsed.success) throw new JourneyClientError(502, "INVALID_INVITATION", "邀请响应非法");
  return parsed.data;
}

export async function sendJourneyAction(
  journeyId: string,
  input: {
    expectedRevision: number;
    action: { kind: "pause" }
      | { kind: "resume"; resumeToken: string | null }
      | { kind: "dismiss_step_narration"; step: string }
      | { kind: "skip" }
      | { kind: "retry" }
      | { kind: "switch_branch"; branch: "own_material" | "blank_note" | "sandbox_sample" };
    idempotencyKey: string;
  },
): Promise<CompanionJourneyV2> {
  const request = companionJourneyActionRequestSchema.parse({
    version: 2,
    expectedRevision: input.expectedRevision,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
  });
  const response = await fetch(`/api/companion/journeys/${encodeURIComponent(journeyId)}/actions`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeaders(),
    },
    body: JSON.stringify(request),
  });
  const body = await expectJson(response, "旅程操作");
  const parsed = companionJourneySchema.safeParse(body);
  if (!parsed.success) throw new JourneyClientError(502, "INVALID_JOURNEY", "旅程响应非法");
  return parsed.data;
}

export function journeyIdempotencyKey(prefix: string): string {
  return `${prefix}:${new Date().toISOString().slice(0, 10)}:${crypto.randomUUID()}`;
}

/** 邀请"稍后"的默认延期：30 天（账号级；到期前不重弹）。 */
export function deferredUntilDefault(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}
