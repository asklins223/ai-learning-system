import { describe, expect, it } from "vitest";
import {
  clampCompanionAnchorToPolygon,
  companionPointerHasPrimaryContact,
  companionPositionForProjectedFootAnchor,
  companionProjectedFootPoint,
  companionSafeInset,
  companionSeatTarget,
  companionSemanticTravelDuration,
  companionTouchKindAt,
  companionTranslationBounds,
  companionViewportCorrection,
  companionWorldAnchorFromProjectedFoot,
  shouldCommitCompanionDrag,
} from "./companion-home-placement";

describe("Home V2 companion placement", () => {
  it("corrects a transformed companion into the zoomed viewport safe area", () => {
    const frame = { left: 0, right: 512, top: 0, bottom: 350 };
    const companion = { left: 430, right: 565, top: 150, bottom: 339 };
    const safe = companionSafeInset({ width: 512, height: 350 });

    expect(safe).toBe(9);
    expect(companionViewportCorrection(frame, companion, safe)).toEqual({ x: -62, y: 0 });
  });

  it("round-trips an arbitrary room-space foot through a transformed camera", () => {
    const world = { left: -286, right: 2_024, top: -174, bottom: 1_126 };
    const root = { left: 0, right: 1_672, top: 0, bottom: 941 };
    const anchor = { x: 0.374, y: 0.713 };
    const foot = companionProjectedFootPoint(anchor, world);

    expect(companionWorldAnchorFromProjectedFoot(foot, world)).toEqual(anchor);
    expect(companionPositionForProjectedFootAnchor(anchor, world, root, { width: 186, height: 260 })).toEqual({
      x: foot.x - 93,
      y: foot.y - 260,
    });
  });

  it("clamps an off-room drop while preserving every in-room coordinate", () => {
    const world = { left: 100, right: 900, top: 50, bottom: 500 };
    expect(companionWorldAnchorFromProjectedFoot({ x: 332, y: 311 }, world)).toEqual({
      x: 0.29,
      y: 0.58,
    });
    expect(companionWorldAnchorFromProjectedFoot({ x: -40, y: 900 }, world)).toEqual({ x: 0, y: 1 });
  });

  it("preserves a legal foot point and projects an illegal drop to the nearest floor edge", () => {
    const floor = [[0.2, 0.4], [0.8, 0.4], [0.7, 0.9], [0.3, 0.9]] as const;
    expect(clampCompanionAnchorToPolygon({ x: 0.5, y: 0.7 }, floor)).toEqual({ x: 0.5, y: 0.7 });
    expect(clampCompanionAnchorToPolygon({ x: 0.5, y: 0.1 }, floor)).toEqual({ x: 0.5, y: 0.4 });
  });

  it("centers an oversized visual instead of producing inverted drag bounds", () => {
    const frame = { left: 0, right: 320, top: 0, bottom: 240 };
    const companion = { left: -30, right: 350, top: -20, bottom: 260 };

    expect(companionViewportCorrection(frame, companion, 10)).toEqual({ x: 0, y: 0 });
    expect(companionTranslationBounds({ x: 18, y: -4 }, frame, companion, 10)).toEqual({
      minX: 18,
      maxX: 18,
      minY: -4,
      maxY: -4,
    });
  });

  it("gives long semantic moves enough visible travel time without slowing short nudges", () => {
    expect(companionSemanticTravelDuration(24, "full")).toBeCloseTo(0.42);
    expect(companionSemanticTravelDuration(800, "full")).toBeGreaterThan(0.8);
    expect(companionSemanticTravelDuration(2_000, "full")).toBe(0.86);
    expect(companionSemanticTravelDuration(800, "lite")).toBe(0.34);
    expect(companionSemanticTravelDuration(800, "off")).toBe(0);
  });

  it("never turns an interrupted or stale pointer gesture into a user placement", () => {
    expect(companionPointerHasPrimaryContact(1)).toBe(true);
    expect(companionPointerHasPrimaryContact(0)).toBe(false);
    expect(companionPointerHasPrimaryContact(2)).toBe(false);

    expect(shouldCommitCompanionDrag("pointerup", true, true)).toBe(true);
    expect(shouldCommitCompanionDrag("pointerup", true, false)).toBe(false);
    expect(shouldCommitCompanionDrag("pointercancel", true, true)).toBe(false);
    expect(shouldCommitCompanionDrag("lostpointercapture", true, true)).toBe(false);
  });

  it("separates head and body touches by the visible height ratio", () => {
    expect(companionTouchKindAt(120, 100, 200)).toBe("head");
    expect(companionTouchKindAt(200, 100, 200)).toBe("body");
  });
});

describe("Task-page companion seat target", () => {
  const frame = { width: 1_024, height: 700 };
  const companion = { width: 190, height: 280 };

  it("seats the left seat past the directory-rail gutter and the right seat at the window edge", () => {
    const left = companionSeatTarget("left", frame, companion);
    const right = companionSeatTarget("right", frame, companion);

    // 1024 * 0.015 = 15.36 inset; left seat = 80px rail column + inset.
    expect(left.x).toBeCloseTo(80 + 15.36, 5);
    expect(right.x).toBeCloseTo(1_024 - 190 - 15.36, 5);
    // One shared bottom inset on both seats, so the bust crops at the same height.
    expect(left.y).toBeCloseTo(right.y, 5);
    expect(left.y).toBeCloseTo(700 - 280 - 10.5, 5);
  });

  it("keeps both seats fully inside the frame on small windows", () => {
    const small = { width: 420, height: 360 };
    for (const seat of ["left", "right"] as const) {
      const target = companionSeatTarget(seat, small, companion);
      expect(target.x).toBeGreaterThanOrEqual(0);
      expect(target.y).toBeGreaterThanOrEqual(0);
      expect(target.x + companion.width).toBeLessThanOrEqual(small.width);
      expect(target.y + companion.height).toBeLessThanOrEqual(small.height);
    }
  });
});
