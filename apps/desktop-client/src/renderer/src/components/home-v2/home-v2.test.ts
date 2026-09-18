import { describe, expect, it } from "vitest";
import {
  HOME_V2_CAMERA_PRESETS,
  homeV2CameraCss,
  homeV2CameraDuration,
  shouldRunHomeV2Ambient,
} from "./home-v2";

describe("home V2 finite room camera", () => {
  it("exposes only the five approved room compositions", () => {
    expect(Object.keys(HOME_V2_CAMERA_PRESETS)).toEqual(["wide", "desk", "shelf", "window", "rest"]);
  });

  it("keeps full motion in the 420–520ms contract and removes it in off mode", () => {
    expect(homeV2CameraDuration("full")).toBeGreaterThanOrEqual(0.42);
    expect(homeV2CameraDuration("full")).toBeLessThanOrEqual(0.52);
    expect(homeV2CameraDuration("lite")).toBeLessThan(homeV2CameraDuration("full"));
    expect(homeV2CameraDuration("off")).toBe(0);
  });

  it("maps a named camera preset to the existing shared CSS camera variables", () => {
    expect(homeV2CameraCss(HOME_V2_CAMERA_PRESETS.desk)).toEqual({
      "--scene-camera-scale": 1.252,
      "--scene-camera-x-percent": "12.5%",
      "--scene-camera-y-percent": "1.5%",
    });
  });

  it.each(Object.entries(HOME_V2_CAMERA_PRESETS))(
    "keeps the %s composition covering every canonical frame edge",
    (_zone, preset) => {
      const halfOverflow = (preset.scale - 1) / 2;
      const x = preset.xPercent / 100;
      const y = preset.yPercent / 100;

      expect(-halfOverflow + x).toBeLessThanOrEqual(0);
      expect(halfOverflow + x).toBeGreaterThanOrEqual(0);
      expect(-halfOverflow + y).toBeLessThanOrEqual(0);
      expect(halfOverflow + y).toBeGreaterThanOrEqual(0);
    },
  );

  it("leaves the wide camera unzoomed and gives translated cameras a sub-pixel cover bleed", () => {
    expect(HOME_V2_CAMERA_PRESETS.wide.scale).toBe(1);
    for (const preset of Object.values(HOME_V2_CAMERA_PRESETS).filter((candidate) => candidate !== HOME_V2_CAMERA_PRESETS.wide)) {
      const exactCoverScale = 1 + (Math.max(Math.abs(preset.xPercent), Math.abs(preset.yPercent)) * 2) / 100;
      expect(preset.scale).toBeGreaterThan(exactCoverScale);
    }
  });

  it("keeps every cancellable camera retarget covered between presets", () => {
    const presets = Object.values(HOME_V2_CAMERA_PRESETS);
    for (const from of presets) {
      for (const to of presets) {
        for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
          const scale = from.scale + (to.scale - from.scale) * progress;
          const x = (from.xPercent + (to.xPercent - from.xPercent) * progress) / 100;
          const y = (from.yPercent + (to.yPercent - from.yPercent) * progress) / 100;
          const halfOverflow = (scale - 1) / 2;
          expect(Math.abs(x)).toBeLessThanOrEqual(halfOverflow);
          expect(Math.abs(y)).toBeLessThanOrEqual(halfOverflow);
        }
      }
    }
  });
});

describe("home V2 ambience gate", () => {
  it("runs only after a user gesture in a visible, unmuted idle room", () => {
    const ready = { unlocked: true, masterMuted: false, surfaceOpen: false, windowVisible: true };
    expect(shouldRunHomeV2Ambient(ready)).toBe(true);
    expect(shouldRunHomeV2Ambient({ ...ready, unlocked: false })).toBe(false);
    expect(shouldRunHomeV2Ambient({ ...ready, masterMuted: true })).toBe(false);
    expect(shouldRunHomeV2Ambient({ ...ready, surfaceOpen: true })).toBe(false);
    expect(shouldRunHomeV2Ambient({ ...ready, windowVisible: false })).toBe(false);
  });
});
