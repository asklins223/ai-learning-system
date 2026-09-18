import { describe, expect, it } from "vitest";
import {
  arbitrateLive2DParameters,
  LIVE2D_PARAMETER_LAYER_PRIORITY,
} from "./live2d-parameter-priority";

describe("Live2D parameter arbitration", () => {
  it("lets lipsync win over FACS, and FACS win over blink", () => {
    const values = arbitrateLive2DParameters([
      { layer: "blink", parameter: "ParamEyeLOpen", value: 0 },
      { layer: "facs", parameter: "ParamEyeLOpen", value: 0.9 },
      { layer: "facs", parameter: "ParamMouthUp", value: 0.25 },
      { layer: "lipsync", parameter: "ParamMouthUp", value: 0.8 },
    ]);

    expect(values.find((value) => value.parameter === "ParamEyeLOpen")?.value).toBe(0.9);
    expect(values.find((value) => value.parameter === "ParamMouthUp")?.value).toBe(0.8);
    expect(new Set(values.map((value) => value.parameter)).size).toBe(values.length);
  });

  it("uses the later request for a same-layer collision", () => {
    const values = arbitrateLive2DParameters([
      { layer: "facs", parameter: "ParamBrowLY", value: 0.1 },
      { layer: "facs", parameter: "ParamBrowLY", value: 0.4 },
    ]);
    expect(values).toEqual([{ parameter: "ParamBrowLY", value: 0.4 }]);
    expect(LIVE2D_PARAMETER_LAYER_PRIORITY.lipsync).toBeGreaterThan(LIVE2D_PARAMETER_LAYER_PRIORITY.facs);
  });
});
