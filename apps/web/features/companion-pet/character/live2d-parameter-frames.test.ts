import assert from "node:assert/strict";
import test from "node:test";
import { parameterRequestsForLive2DFrame } from "./live2d-parameter-frames";
import { arbitrateLive2DParameters } from "./live2d-priority";

test("P4 参数帧包含 idle breath、blink 和中性 gaze", () => {
  const requests = parameterRequestsForLive2DFrame({
    presentation: "idle",
    nowMs: 1000,
    voiceLevel: 0,
  });
  assert.ok(requests.some((r) => r.parameter === "ParamBreath" && r.layer === "idle"));
  assert.ok(requests.some((r) => r.parameter === "ParamEyeLOpen" && r.layer === "blink"));
  assert.ok(requests.some((r) => r.parameter === "ParamEyeBallX" && r.value === 0));
});

test("P4 参数帧的 lipsync 覆盖表情层并随音量闭合", () => {
  const speaking = parameterRequestsForLive2DFrame({
    presentation: "speak",
    nowMs: 1000,
    voiceLevel: 0.75,
  });
  const mouth = arbitrateLive2DParameters(speaking).find((r) => r.parameter === "ParamMouthUp");
  assert.ok(Math.abs((mouth?.value ?? 0) - 0.15) < 1e-9, "lipsync 应覆盖同参数的低优先级表情值");

  const quiet = parameterRequestsForLive2DFrame({
    presentation: "speak",
    nowMs: 1000,
    voiceLevel: 0,
  });
  assert.equal(
    arbitrateLive2DParameters(quiet).find((r) => r.parameter === "ParamA")?.value,
    0,
    "停止播放后 ParamA 必须回到闭嘴值",
  );
});

test("P4 情绪状态只产生白名单中的高层意图", () => {
  const requests = parameterRequestsForLive2DFrame({
    presentation: "celebrate",
    nowMs: 5000,
    voiceLevel: 0,
  });
  assert.ok(requests.some((r) => r.layer === "facs" && r.parameter === "ParamCheek"));
  assert.ok(requests.every((r) => r.layer !== "lipsync"));
});
