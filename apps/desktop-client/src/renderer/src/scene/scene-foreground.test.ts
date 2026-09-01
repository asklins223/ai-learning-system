import { describe, expect, it } from "vitest";
import {
  resolveSceneForegroundMotionPolicy,
  sceneForegroundPointerOffset,
  SEARCH_FOREGROUND_MOTION_LIMIT,
} from "./scene-foreground";

describe("scene foreground motion", () => {
  const base = {
    assetReady: true,
    compact: false,
    motionMode: "full" as const,
    scenePhase: "task" as const,
    windowVisible: true,
  };

  it("enables only the settled full-motion desktop path", () => {
    expect(resolveSceneForegroundMotionPolicy(base)).toMatchObject({
      enabled: true,
      reason: "active",
      maxOffsetX: 6,
      maxOffsetY: 3,
    });
    expect(resolveSceneForegroundMotionPolicy({ ...base, assetReady: false }).reason).toBe("asset-not-ready");
    expect(resolveSceneForegroundMotionPolicy({ ...base, compact: true }).reason).toBe("compact");
    expect(resolveSceneForegroundMotionPolicy({ ...base, motionMode: "lite" }).reason).toBe("motion-off");
    expect(resolveSceneForegroundMotionPolicy({ ...base, scenePhase: "focusing" }).reason).toBe("scene-not-settled");
    expect(resolveSceneForegroundMotionPolicy({ ...base, windowVisible: false }).reason).toBe("window-hidden");
  });

  it("maps the frame center to rest and clamps desktop input to the D6 limit", () => {
    const frameBounds = { left: 100, top: 40, width: 800, height: 400 };
    expect(sceneForegroundPointerOffset({
      clientX: 500,
      clientY: 240,
      pointerType: "mouse",
      frameBounds,
      ...SEARCH_FOREGROUND_MOTION_LIMIT,
    })).toEqual([0, 0]);
    expect(sceneForegroundPointerOffset({
      clientX: -1000,
      clientY: 1000,
      pointerType: "mouse",
      frameBounds,
      ...SEARCH_FOREGROUND_MOTION_LIMIT,
    })).toEqual([6, -3]);
  });

  it("does not synthesize motion for touch or invalid geometry", () => {
    const frameBounds = { left: 0, top: 0, width: 100, height: 100 };
    expect(sceneForegroundPointerOffset({
      clientX: 10,
      clientY: 10,
      pointerType: "touch",
      frameBounds,
      ...SEARCH_FOREGROUND_MOTION_LIMIT,
    })).toEqual([0, 0]);
    expect(sceneForegroundPointerOffset({
      clientX: Number.NaN,
      clientY: 10,
      pointerType: "mouse",
      frameBounds,
      ...SEARCH_FOREGROUND_MOTION_LIMIT,
    })).toEqual([0, 0]);
    expect(sceneForegroundPointerOffset({
      clientX: 10,
      clientY: 10,
      pointerType: "mouse",
      frameBounds: { left: 0, top: 0, width: 0, height: 100 },
      ...SEARCH_FOREGROUND_MOTION_LIMIT,
    })).toEqual([0, 0]);
  });
});
