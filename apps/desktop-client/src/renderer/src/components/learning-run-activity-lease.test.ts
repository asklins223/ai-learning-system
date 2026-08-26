import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LEASE_INTERVAL_MS,
  buildActivityLeaseWindow,
  isActivityLeaseEligible,
} from "./learning-run-activity-lease";

describe("learning run activity lease", () => {
  it("requires an active, focused, visible current Task", () => {
    expect(ACTIVITY_LEASE_INTERVAL_MS).toBe(15_000);
    expect(isActivityLeaseEligible({ phase: "active", hasActiveTask: true, visibilityState: "visible", documentFocused: true })).toBe(true);
    expect(isActivityLeaseEligible({ phase: "paused", hasActiveTask: true, visibilityState: "visible", documentFocused: true })).toBe(false);
    expect(isActivityLeaseEligible({ phase: "active", hasActiveTask: false, visibilityState: "visible", documentFocused: true })).toBe(false);
    expect(isActivityLeaseEligible({ phase: "active", hasActiveTask: true, visibilityState: "hidden", documentFocused: true })).toBe(false);
    expect(isActivityLeaseEligible({ phase: "active", hasActiveTask: true, visibilityState: "visible", documentFocused: false })).toBe(false);
  });

  it("creates an ISO window and clamps a future end to the observed time", () => {
    expect(buildActivityLeaseWindow(1_000, 16_000, 15_000)).toEqual({
      startedAt: "1970-01-01T00:00:01.000Z",
      endedAt: "1970-01-01T00:00:15.000Z",
    });
  });

  it("fails closed for empty or invalid windows", () => {
    expect(buildActivityLeaseWindow(1_000, 1_000, 2_000)).toBeNull();
    expect(buildActivityLeaseWindow(2_000, 1_000, 3_000)).toBeNull();
    expect(buildActivityLeaseWindow(Number.NaN, 1_000, 2_000)).toBeNull();
    expect(buildActivityLeaseWindow(5_000, 6_000, 4_000)).toBeNull();
  });
});
