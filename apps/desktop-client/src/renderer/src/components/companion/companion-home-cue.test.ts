import { describe, expect, it } from "vitest";
import {
  COMPANION_ORDINARY_CUE_INTERVAL_MS,
  companionCueAllowed,
  companionCueRank,
  isCompanionActiveness,
  shouldCompanionBorrowPlacement,
  type CompanionCuePriority,
} from "./companion-home-placement";

const PRIORITY_ORDER: readonly CompanionCuePriority[] = [
  "ordinary",
  "due-review",
  "active-learning",
  "interrupted-task",
  "sync-error",
];

describe("companion cue arbitration", () => {
  it("ranks the five priorities as sync-error > interrupted-task > active-learning > due-review > ordinary", () => {
    const ranks = PRIORITY_ORDER.map(companionCueRank);
    for (let index = 1; index < ranks.length; index += 1) {
      expect(ranks[index]).toBeGreaterThan(ranks[index - 1]);
    }
  });
});

describe("companion proactive budget", () => {
  it("keeps quiet personas silent and gives moderate/active their frozen intervals", () => {
    expect(COMPANION_ORDINARY_CUE_INTERVAL_MS.quiet).toBeNull();
    expect(COMPANION_ORDINARY_CUE_INTERVAL_MS.moderate).toBe(10 * 60_000);
    expect(COMPANION_ORDINARY_CUE_INTERVAL_MS.active).toBe(5 * 60_000);
  });

  it("never rate limits a key reminder, even for a quiet persona", () => {
    for (const priority of PRIORITY_ORDER.filter((entry) => entry !== "ordinary")) {
      expect(companionCueAllowed({
        activeness: "quiet",
        priority,
        lastOrdinaryCueAt: Date.now(),
        now: Date.now(),
      })).toBe(true);
    }
  });

  it("suppresses ordinary cues for quiet, and gates them by interval otherwise", () => {
    const now = 1_000_000_000;
    expect(companionCueAllowed({ activeness: "quiet", priority: "ordinary", lastOrdinaryCueAt: 0, now })).toBe(false);
    expect(companionCueAllowed({ activeness: "moderate", priority: "ordinary", lastOrdinaryCueAt: now - 9 * 60_000, now })).toBe(false);
    expect(companionCueAllowed({ activeness: "moderate", priority: "ordinary", lastOrdinaryCueAt: now - 10 * 60_000, now })).toBe(true);
    expect(companionCueAllowed({ activeness: "active", priority: "ordinary", lastOrdinaryCueAt: now - 5 * 60_000, now })).toBe(true);
    expect(companionCueAllowed({ activeness: "active", priority: "ordinary", lastOrdinaryCueAt: 0, now })).toBe(true);
  });

  it("recognises exactly the three persona activeness values", () => {
    expect(["quiet", "moderate", "active"].every(isCompanionActiveness)).toBe(true);
    expect(isCompanionActiveness("loud")).toBe(false);
    expect(isCompanionActiveness(null)).toBe(false);
  });
});

describe("companion placement borrowing", () => {
  it("never borrows a user-chosen world position, including for key reminders", () => {
    expect(shouldCompanionBorrowPlacement({ priority: "due-review", placementOwner: "user", dragging: false })).toBe(false);
    expect(shouldCompanionBorrowPlacement({ priority: "sync-error", placementOwner: "user", dragging: false })).toBe(false);
    expect(shouldCompanionBorrowPlacement({ priority: "ordinary", placementOwner: "user", dragging: false })).toBe(false);
  });

  it("never borrows while a semantic anchor owns placement or a pointer is active", () => {
    expect(shouldCompanionBorrowPlacement({ priority: "due-review", placementOwner: "semantic", dragging: false })).toBe(false);
    expect(shouldCompanionBorrowPlacement({ priority: "due-review", placementOwner: "user", dragging: true })).toBe(false);
  });
});
