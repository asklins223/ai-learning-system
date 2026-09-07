import { describe, expect, it } from "vitest";
import {
  AUTH_AMBIENT_PERFORMANCE_BUDGET,
  resolveAuthAmbientPolicy,
} from "./auth-ambient-policy";

describe("auth ambient policy", () => {
  it("only enables the Pixi enhancement for full motion on a non-compact viewport", () => {
    expect(resolveAuthAmbientPolicy({ motionMode: "full", compact: false })).toEqual({
      enabled: true,
      reason: "enabled",
    });
    expect(resolveAuthAmbientPolicy({ motionMode: "full", compact: true }).enabled).toBe(false);
    expect(resolveAuthAmbientPolicy({ motionMode: "lite", compact: false }).enabled).toBe(false);
    expect(resolveAuthAmbientPolicy({ motionMode: "off", compact: false }).enabled).toBe(false);
  });

  it("keeps the decorative renderer inside the registered auth budget", () => {
    expect(AUTH_AMBIENT_PERFORMANCE_BUDGET).toEqual({
      maxParticles: 24,
      maxDayLeaves: 9,
      maxLampMotes: 10,
      maxFps: 24,
      maxResolution: 1.5,
    });
  });
});
