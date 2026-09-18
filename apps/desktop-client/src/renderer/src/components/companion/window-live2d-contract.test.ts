import { describe, expect, it } from "vitest";
import {
  WINDOW_LIVE2D_ASSETS,
  isApprovedWindowLive2DManifest,
  motionForWindowLive2DEmotion,
  motionForWindowLive2D,
  parameterValuesForWindowLive2D,
} from "./window-live2d-contract";

describe("window Live2D policy", () => {
  it("fails closed when bundled model license approval is absent", () => {
    const approved = {
      schemaVersion: 1,
      modelId: "companion-live2d-mao-pro-v1",
      status: "production",
      ownerApproved: { by: "Owner", date: "2026-08-11" },
      modelLicense: {
        name: "Live2D Free Material License Agreement and Terms of Use",
        acceptanceRequired: true,
        commercialReleaseAllowed: true,
      },
    };
    expect(isApprovedWindowLive2DManifest(approved)).toBe(true);
    expect(isApprovedWindowLive2DManifest({ ...approved, ownerApproved: null })).toBe(false);
    expect(isApprovedWindowLive2DManifest({
      ...approved,
      modelLicense: { ...approved.modelLicense, commercialReleaseAllowed: false },
    })).toBe(false);

    expect(isApprovedWindowLive2DManifest({
      schemaVersion: 1,
      modelId: "companion-live2d-seethrough-v2",
      status: "development",
      ownerApproved: { by: "User", date: "2026-09-15" },
      modelLicense: {
        name: "User-provided artwork; license confirmation required before redistribution",
        acceptanceRequired: true,
        commercialReleaseAllowed: false,
      },
    })).toBe(false);
  });

  it("只声明 Live2D 资产：orb / 替身立绘已随 2026-09-16 裁决移除", () => {
    const assetPaths = [
      WINDOW_LIVE2D_ASSETS.manifest,
      WINDOW_LIVE2D_ASSETS.model,
      ...WINDOW_LIVE2D_ASSETS.vendorScripts,
    ];
    expect(Object.keys(WINDOW_LIVE2D_ASSETS)).toEqual([
      "manifest",
      "model",
      "vendorScripts",
    ]);
    for (const path of assetPaths) {
      expect(path).not.toContain("orb");
      expect(path).not.toContain("half-idle");
    }
  });

  it("maps the public presentation contract to the exported PSD2Live motion groups", () => {
    expect(motionForWindowLive2D("idle")).toEqual({ group: "Idle", index: 0 });
    expect(motionForWindowLive2D("invite")).toEqual({ group: "", index: 0 });
    expect(motionForWindowLive2D("think")).toEqual({ group: "", index: 2 });
    expect(motionForWindowLive2D("celebrate")).toEqual({ group: "", index: 3 });
    expect(motionForWindowLive2D("uncertain")).toEqual({ group: "", index: 1 });
    expect(motionForWindowLive2D("hidden")).toBeNull();
    expect(motionForWindowLive2DEmotion("excited")).toEqual({ group: "", index: 3 });
    expect(motionForWindowLive2DEmotion("surprised")).toEqual({ group: "", index: 1 });
    expect(motionForWindowLive2DEmotion("neutral")).toBeNull();
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

  it("lets an emotion own FACS while lipsync still owns the mouth", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "celebrate",
      nowMs: 1_000,
      voiceLevel: 0.75,
      emotion: { emotion: "concerned", intensity: 0.5 },
    });

    expect(values.find((value) => value.parameter === "ParamMouthUp")?.value).toBeCloseTo(0.15);
    expect(values.find((value) => value.parameter === "ParamA")?.value).toBeCloseTo(0.75);
  });

  it("does not inject Seethrough-only parameters into Mao", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "idle",
      nowMs: 1_000,
      voiceLevel: 0,
      emotion: null,
    });

    expect(values.some((value) => value.parameter === "ParamMouthOpenY")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamMouthForm")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamA")).toBe(false);
  });
});
