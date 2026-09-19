import { describe, expect, it } from "vitest";
import {
  WINDOW_LIVE2D_ASSETS,
  WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS,
  isApprovedWindowLive2DManifest,
  motionForWindowLive2DEmotion,
  motionForWindowLive2D,
  parameterValuesForWindowLive2D,
} from "./window-live2d-contract";

/** 读一个参数，省掉每个用例都写一遍 find。 */
function parameterValue(
  values: readonly { readonly parameter: string; readonly value: number }[],
  parameter: string,
): number | undefined {
  return values.find((value) => value.parameter === parameter)?.value;
}

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

  describe("「看向手边」（方案 §5 第 9 项）", () => {
    const idleBodyAngleX = (nowMs: number) => Math.sin(nowMs / 2_400) * 2;

    it("没有冲量时 ParamBodyAngleX 逐帧等于静息摇摆（本次改动不改变既有画面）", () => {
      for (const nowMs of [0, 600, 1_000, 2_400, 5_000]) {
        const values = parameterValuesForWindowLive2D({
          presentation: "idle",
          nowMs,
          voiceLevel: 0,
        });
        expect(parameterValue(values, "ParamBodyAngleX")).toBeCloseTo(idleBodyAngleX(nowMs));
      }
    });

    it("工具刚开始执行时侧身 3 度，并在 1.5s 内二次缓出回到静息值", () => {
      const atMs = 0;
      // 起点：冲量满幅，静息摇摆此刻正好是 0。
      expect(parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle", nowMs: 0, voiceLevel: 0, toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX")).toBeCloseTo(-3);

      // 中点：(1 - 0.5)^2 = 0.25，偏移收窄到 -0.75。
      const half = WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS / 2;
      expect(parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle", nowMs: half, voiceLevel: 0, toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX")).toBeCloseTo(idleBodyAngleX(half) - 0.75);
    });

    it("冲量窗口结束时与静息摇摆严丝合缝，不会回弹", () => {
      const atMs = 0;
      const lastFrame = WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS - 1;
      const atEnd = parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle", nowMs: lastFrame, voiceLevel: 0, toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX");
      const afterEnd = parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle",
        nowMs: WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS,
        voiceLevel: 0,
        toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX");

      expect(atEnd).toBeCloseTo(idleBodyAngleX(lastFrame), 3);
      expect(afterEnd).toBeCloseTo(idleBodyAngleX(WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS));
    });

    it("未来时间戳与非有限值都当作没有冲量，不写入非法参数", () => {
      for (const toolAttentionAtMs of [Number.NaN, Number.POSITIVE_INFINITY, 4_000]) {
        const values = parameterValuesForWindowLive2D({
          presentation: "idle", nowMs: 1_000, voiceLevel: 0, toolAttentionAtMs,
        });
        expect(parameterValue(values, "ParamBodyAngleX")).toBeCloseTo(idleBodyAngleX(1_000));
        expect(values.every((value) => Number.isFinite(value.value))).toBe(true);
      }
    });

    it("冲量不与口型/表情抢参数：它只动 ParamBodyAngleX", () => {
      const withImpulse = parameterValuesForWindowLive2D({
        presentation: "speak", nowMs: 0, voiceLevel: 0.6, toolAttentionAtMs: 0,
      });
      expect(parameterValue(withImpulse, "ParamA")).toBeCloseTo(0.6);
      expect(parameterValue(withImpulse, "ParamBodyAngleX")).toBeCloseTo(-3);
    });
  });
});
