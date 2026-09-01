import { describe, expect, it } from "vitest";
import {
  doorEntryMotionProfile,
  doorEntryPlaybackState,
  motionBudgetSnapshot,
  resolveSceneMotionMode,
  sceneMotionDuration,
  scenePhaseForIntent,
  settledScenePhase,
  shouldSettleAfterMotionPreferenceChange,
} from "./scene-motion";

describe("scene motion contract", () => {
  it("uses one budget table for full, lite and off", () => {
    expect(sceneMotionDuration("full", "camera")).toBe(0.64);
    expect(sceneMotionDuration("lite", "camera")).toBe(0.3);
    expect(sceneMotionDuration("off", "camera")).toBe(0);
    expect(motionBudgetSnapshot().full.surfaceEnter).toBeGreaterThan(motionBudgetSnapshot().lite.surfaceEnter);
  });

  it("reduces the optional door entry without changing its legal endpoint", () => {
    const full = doorEntryMotionProfile("full");
    const lite = doorEntryMotionProfile("lite");
    const off = doorEntryMotionProfile("off");

    expect(full).toEqual({ durationScale: 1, swing: 1, interior: 1, camera: 1 });
    expect(lite.durationScale).toBeLessThan(full.durationScale);
    expect(lite.swing).toBeLessThan(full.swing);
    expect(lite.camera).toBeLessThan(full.camera);
    expect(off.durationScale).toBe(0);
  });

  it("pauses the door timeline and renderer while the window is hidden", () => {
    expect(doorEntryPlaybackState("hidden", false)).toEqual({
      timelinePaused: true,
      rendererRunning: false,
    });
    expect(doorEntryPlaybackState("visible", false)).toEqual({
      timelinePaused: false,
      rendererRunning: true,
    });
    expect(doorEntryPlaybackState("visible", true)).toEqual({
      timelinePaused: true,
      rendererRunning: true,
    });
  });

  it("maps intent and settled route to a presentational phase", () => {
    expect(scenePhaseForIntent("continue", null)).toBe("focusing");
    expect(scenePhaseForIntent("home", "study")).toBe("returning");
    expect(scenePhaseForIntent("home", null)).toBe("idle");
    expect(settledScenePhase("notebook")).toBe("task");
    expect(settledScenePhase(null)).toBe("idle");
  });

  it("lets system reduced motion override the saved visual preference", () => {
    expect(resolveSceneMotionMode("full", true)).toBe("off");
    expect(resolveSceneMotionMode("lite", true)).toBe("off");
    expect(resolveSceneMotionMode("full", false)).toBe("full");
  });

  it("settles a focus phase when a motion preference update tears down its timeline", () => {
    expect(shouldSettleAfterMotionPreferenceChange({
      routeChanged: false,
      modeChanged: true,
      scenePhase: "focusing",
    })).toBe(true);
    expect(shouldSettleAfterMotionPreferenceChange({
      routeChanged: false,
      modeChanged: true,
      scenePhase: "task",
    })).toBe(false);
    expect(shouldSettleAfterMotionPreferenceChange({
      routeChanged: true,
      modeChanged: true,
      scenePhase: "focusing",
    })).toBe(false);
  });
});
