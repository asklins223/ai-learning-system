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

// ─── 15 方案 emotion 表现层：facs 由 emotion 接管，presentation 兜底 ─────

test("emotion 驱动：有情绪信号时 facs 用 emotion 参数（intensity 缩放）", () => {
  const requests = parameterRequestsForLive2DFrame({
    presentation: "celebrate",
    nowMs: 5000,
    voiceLevel: 0,
    emotion: { emotion: "sad", intensity: 0.5 },
  });
  const facs = requests.filter((r) => r.layer === "facs");
  assert.ok(facs.length > 0, "有 facs 参数");
  // sad 映射含 ParamMouthDown（celebrate 没有）→ 证明 facs 来自 emotion
  assert.ok(
    facs.some((r) => r.parameter === "ParamMouthDown"),
    "facs 来自 emotion 映射（sad → MouthDown）",
  );
  // celebrate 的微笑参数不应出现（facs 被 emotion 接管）
  assert.ok(
    !facs.some((r) => r.parameter === "ParamCheek"),
    "presentation facs 被 emotion 接管",
  );
  // intensity 缩放
  const mouth = facs.find((r) => r.parameter === "ParamMouthDown");
  assert.ok(mouth && mouth.value <= 0.25 * 0.5 + 1e-9, "值按 intensity 缩放");
});

test("emotion 兜底：无情绪信号时保持原 presentation facs 行为", () => {
  const requests = parameterRequestsForLive2DFrame({
    presentation: "celebrate",
    nowMs: 5000,
    voiceLevel: 0,
    emotion: null,
  });
  const facs = requests.filter((r) => r.layer === "facs");
  assert.ok(facs.some((r) => r.parameter === "ParamCheek"), "presentation facs 兜底");
});

test("emotion 为 neutral/空 emotion 时同样回落 presentation facs", () => {
  const neutral = parameterRequestsForLive2DFrame({
    presentation: "think",
    nowMs: 5000,
    voiceLevel: 0,
    emotion: { emotion: null, intensity: 0.5 },
  });
  const facs = neutral.filter((r) => r.layer === "facs");
  assert.ok(facs.some((r) => r.parameter === "ParamBrowLY"), "neutral 回落 presentation");
});
