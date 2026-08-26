export const ACTIVITY_LEASE_INTERVAL_MS = 15_000;

export type ActivityLeaseEligibility = {
  readonly phase: string;
  readonly hasActiveTask: boolean;
  readonly visibilityState: "hidden" | "visible";
  readonly documentFocused: boolean;
};

export type ActivityLeaseWindow = {
  readonly startedAt: string;
  readonly endedAt: string;
};

export function isActivityLeaseEligible(input: ActivityLeaseEligibility): boolean {
  return input.phase === "active"
    && input.hasActiveTask
    && input.visibilityState === "visible"
    && input.documentFocused;
}

export function buildActivityLeaseWindow(
  startedAtMs: number,
  endedAtMs: number,
  nowMs = Date.now(),
): ActivityLeaseWindow | null {
  if (![startedAtMs, endedAtMs, nowMs].every(Number.isFinite)) return null;

  const started = Math.min(startedAtMs, endedAtMs);
  const ended = Math.min(endedAtMs, nowMs);
  if (ended <= started) return null;

  return {
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
  };
}
