import { describe, expect, it } from "vitest";
import {
  motionForWindowLive2D,
  parameterValuesForWindowLive2D,
  shouldUseWindowLive2D,
} from "./window-live2d-contract";

describe("window Live2D policy", () => {
  it("loads the frame-loop runtime only for active full-motion surfaces", () => {
    expect(shouldUseWindowLive2D({
      active: true,
      motionMode: "full",
      prefersReducedMotion: false,
    })).toBe(true);
    expect(shouldUseWindowLive2D({
      active: false,
      motionMode: "full",
      prefersReducedMotion: false,
    })).toBe(false);
    expect(shouldUseWindowLive2D({
      active: true,
      motionMode: "lite",
      prefersReducedMotion: false,
    })).toBe(false);
    expect(shouldUseWindowLive2D({
      active: true,
      motionMode: "off",
      prefersReducedMotion: false,
    })).toBe(false);
    expect(shouldUseWindowLive2D({
      active: true,
      motionMode: "full",
      prefersReducedMotion: true,
    })).toBe(false);
  });

  it("maps the public presentation contract to existing Mao PRO motions", () => {
    expect(motionForWindowLive2D("idle")).toEqual({ group: "Idle", index: 0 });
    expect(motionForWindowLive2D("invite")).toEqual({ group: "", index: 0 });
    expect(motionForWindowLive2D("think")).toEqual({ group: "", index: 2 });
    expect(motionForWindowLive2D("celebrate")).toEqual({ group: "", index: 3 });
  });

  it("clamps external voice amplitude before it reaches Cubism Core", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "speak",
      nowMs: 1_000,
      voiceLevel: 12,
    });

    expect(values.find((value) => value.parameter === "ParamA")?.value).toBe(1);
    expect(values.every((value) => Number.isFinite(value.value))).toBe(true);
  });
});
