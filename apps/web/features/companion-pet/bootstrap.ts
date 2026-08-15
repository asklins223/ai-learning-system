import {
  companionAccountGlobalOffEventV1Schema,
  companionAccountStateV1Schema,
} from "@ailearn/shared";
import { companionBootstrapFeaturesV1Schema } from "@ailearn/shared";
import type { CompanionBootstrapFeaturesV1 } from "@ailearn/shared";

/** Poll fallback for account-wide revocation when the account SSE is unavailable. */
export const COMPANION_BOOTSTRAP_POLL_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CompanionBootstrapV1 {
  version: 1;
  userId: string;
  workspaceId: string;
  account?: {
    globalEnabled?: boolean;
    epoch?: number;
    animationOff?: boolean;
    voiceOff?: boolean;
  };
  features: CompanionBootstrapFeaturesV1;
  serverTime: string;
}

export class CompanionBootstrapError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`companion bootstrap failed: ${status}`);
    this.name = "CompanionBootstrapError";
    this.status = status;
  }
}

export function parseCompanionBootstrap(body: unknown): CompanionBootstrapV1 {
  if (!body || typeof body !== "object") throw new CompanionBootstrapError(500);
  const record = body as Record<string, unknown>;
  const features = companionBootstrapFeaturesV1Schema.safeParse(record.features);
  const account = record.account === undefined
    ? { success: true as const, data: undefined }
    : companionAccountStateV1Schema.safeParse(record.account);
  if (
    (record.version !== 1) ||
    (typeof record.userId !== "string" || !UUID_PATTERN.test(record.userId)) ||
    (typeof record.workspaceId !== "string" || !UUID_PATTERN.test(record.workspaceId)) ||
    (typeof record.serverTime !== "string" || Number.isNaN(Date.parse(record.serverTime))) ||
    !features.success ||
    !account.success
  ) {
    throw new CompanionBootstrapError(500);
  }
  return {
    version: 1,
    userId: record.userId,
    workspaceId: record.workspaceId,
    account: account.data
      ? {
          globalEnabled: account.data.globalEnabled,
          epoch: account.data.epoch,
          animationOff: account.data.animationOff,
          voiceOff: account.data.voiceOff,
        }
      : undefined,
    features: features.data,
    serverTime: record.serverTime,
  };
}

export async function fetchCompanionBootstrap(): Promise<CompanionBootstrapV1> {
  const response = await fetch("/api/companion/bootstrap", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new CompanionBootstrapError(response.status);
  return parseCompanionBootstrap(await response.json());
}

/**
 * Opens the account-wide revocation stream. Native EventSource reconnects on
 * transient failures; the bootstrap poll remains the authoritative fallback.
 */
export function openCompanionAccountEventStream(args: {
  userId: string;
  after: number;
  onGlobalOff(epoch: number): void;
}): () => void {
  if (typeof window === "undefined" || typeof window.EventSource === "undefined") return () => {};
  const url = new URL("/api/me/companion/events", window.location.origin);
  url.searchParams.set("after", String(Number.isInteger(args.after) && args.after >= 0 ? args.after : 0));
  const source = new window.EventSource(url.toString(), { withCredentials: true });
  const onAccountEvent = (event: Event) => {
    const data = (event as MessageEvent<string>).data;
    if (typeof data !== "string") return;
    try {
      const parsed = companionAccountGlobalOffEventV1Schema.safeParse(JSON.parse(data));
      if (!parsed.success || parsed.data.userId.toLowerCase() !== args.userId.toLowerCase()) return;
      args.onGlobalOff(parsed.data.epoch);
    } catch {
      // Malformed account events are ignored; bootstrap polling remains active.
    }
  };
  source.addEventListener("companion.account", onAccountEvent);
  return () => {
    source.removeEventListener("companion.account", onAccountEvent);
    source.close();
  };
}
