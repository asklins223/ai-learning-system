import { describe, expect, it } from "vitest";
import {
  LIVE2D_EMOTION_PARAMETERS,
  parameterRequestsForLive2DEmotion,
} from "./live2d-emotion-map";

describe("Live2D emotion parameter map", () => {
  it("covers the bounded cue emotions and common voice labels", () => {
    for (const emotion of ["neutral", "happy", "curious", "concerned", "surprised"]) {
      expect(LIVE2D_EMOTION_PARAMETERS).toHaveProperty(emotion);
    }
    for (const emotion of ["excited", "sad", "angry", "tired", "crying", "amazed"]) {
      expect(LIVE2D_EMOTION_PARAMETERS).toHaveProperty(emotion);
    }
  });

  it("scales known parameters and fails closed for unknown or neutral labels", () => {
    const full = parameterRequestsForLive2DEmotion("happy", 1);
    const half = parameterRequestsForLive2DEmotion("HAPPY", 0.5);
    expect(full.length).toBeGreaterThan(0);
    expect(full.every((request) => request.layer === "facs")).toBe(true);
    expect(half.find((request) => request.parameter === "ParamMouthUp")?.value).toBe(0.375);
    expect(parameterRequestsForLive2DEmotion("neutral", 1)).toEqual([]);
    expect(parameterRequestsForLive2DEmotion("unknown", 1)).toEqual([]);
    expect(parameterRequestsForLive2DEmotion("very fast", 1)).toEqual([]);
  });

  it("uses the exported Mao mouth parameters and leaves blinking to the blink layer", () => {
    const surprised = parameterRequestsForLive2DEmotion("surprised", 1);
    const tired = parameterRequestsForLive2DEmotion("tired", 1);

    expect(surprised.find((request) => request.parameter === "ParamMouthUp")?.value).toBe(0.05);
    expect(tired.some((request) => request.parameter === "ParamEyeLOpen")).toBe(false);
    expect(tired.some((request) => request.parameter === "ParamEyeROpen")).toBe(false);
  });
});
