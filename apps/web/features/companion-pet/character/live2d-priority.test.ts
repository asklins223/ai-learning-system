import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arbitrateLive2DParameters,
  layerHasActiveRequests,
  overriddenByHigherLayer,
  LIVE2D_LAYER_PRIORITY,
  type Live2DParameterRequest,
} from "./live2d-priority.ts";

test("优先级：lipsync > facs > gaze > blink > idle（同参数高优先级胜出）", () => {
  const r = arbitrateLive2DParameters([
    { layer: "blink", parameter: "ParamEyeLOpen", value: 0 },
    { layer: "facs", parameter: "ParamEyeLOpen", value: 0.9 },
    { layer: "gaze", parameter: "ParamEyeBallX", value: -0.5 },
    { layer: "lipsync", parameter: "ParamMouthUp", value: 0.8 },
    { layer: "idle", parameter: "ParamEyeLOpen", value: 1 },
  ]);
  const eye = r.find((x) => x.parameter === "ParamEyeLOpen");
  assert.equal(eye?.value, 0.9, "facs 胜出 blink/idle");
  assert.ok(r.find((x) => x.parameter === "ParamEyeBallX")?.value === -0.5);
  assert.ok(r.find((x) => x.parameter === "ParamMouthUp")?.value === 0.8);
  // 每参数唯一
  assert.equal(new Set(r.map((x) => x.parameter)).size, r.length);
});

test("同层同参数：后者胜（时间序最新意图）", () => {
  const r = arbitrateLive2DParameters([
    { layer: "blink", parameter: "ParamEyeLOpen", value: 0 },
    { layer: "blink", parameter: "ParamEyeLOpen", value: 1 },
  ]);
  assert.equal(r.find((x) => x.parameter === "ParamEyeLOpen")?.value, 1);
});

test("恢复：移除高层请求后低层值重新生效（无永久覆盖）", () => {
  // 说话中：lipsync 覆盖眨眼
  const speaking: Live2DParameterRequest[] = [
    { layer: "blink", parameter: "ParamEyeLOpen", value: 0 },
    { layer: "lipsync", parameter: "ParamEyeLOpen", value: 1 },
  ];
  assert.equal(
    arbitrateLive2DParameters(speaking).find((x) => x.parameter === "ParamEyeLOpen")?.value,
    1,
  );
  // 说完：移除 lipsync → blink 恢复
  const recovered = arbitrateLive2DParameters([speaking[0]]);
  assert.equal(
    recovered.find((x) => x.parameter === "ParamEyeLOpen")?.value,
    0,
    "低层 blink 恢复",
  );
});

test("overriddenByHigherLayer：高层覆盖参数集合；空请求集返回空", () => {
  const over = overriddenByHigherLayer([
    { layer: "blink", parameter: "ParamEyeLOpen", value: 0 },
    { layer: "facs", parameter: "ParamEyeLOpen", value: 0.9 },
    { layer: "facs", parameter: "ParamBrowLY", value: 0.5 },
  ]);
  assert.ok(over.has("ParamEyeLOpen"), "blink 的 ParamEyeLOpen 被 facs 覆盖");
  assert.ok(!over.has("ParamBrowLY"), "facs 最高层参数不被覆盖");
  assert.equal(overriddenByHigherLayer([]).size, 0);
});

test("layerHasActiveRequests + 层优先级常量完整", () => {
  assert.ok(layerHasActiveRequests([{ layer: "gaze", parameter: "x", value: 0 }], "gaze"));
  assert.ok(!layerHasActiveRequests([], "blink"));
  assert.equal(LIVE2D_LAYER_PRIORITY.lipsync, 4);
  assert.equal(LIVE2D_LAYER_PRIORITY.idle, 0);
});
