// 15 方案 §5 待办 6：emotion → Live2D 参数映射单测。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMOTION_FACS_PARAMETERS,
  parameterRequestsForEmotion,
} from "./emotion-expression-map.ts";

test("已知 emotion：返回 facs 层参数（intensity=1 时值不变）", () => {
  const happy = parameterRequestsForEmotion("happy", 1);
  assert.ok(happy.length > 0, "happy 有参数");
  for (const req of happy) {
    assert.equal(req.layer, "facs");
  }
  // happy 应含微笑参数
  const smile = happy.find((r) => r.parameter === "ParamEyeLSmile");
  assert.ok(smile, "happy 含 ParamEyeLSmile");
});

test("intensity 缩放：0.5 时值减半，0 时为空", () => {
  const half = parameterRequestsForEmotion("excited", 0.5);
  const full = parameterRequestsForEmotion("excited", 1);
  assert.equal(half.length, full.length);
  for (const req of half) {
    const base = full.find((f) => f.parameter === req.parameter);
    assert.ok(base, "参数一一对应");
    assert.ok(Math.abs(req.value - base.value * 0.5) < 1e-9, "值按 0.5 缩放");
  }
  assert.deepEqual(parameterRequestsForEmotion("excited", 0), []);
});

test("未知 emotion / neutral / null → 空（neutral 表现）", () => {
  assert.deepEqual(parameterRequestsForEmotion("unknown-emotion", 1), []);
  assert.deepEqual(parameterRequestsForEmotion("neutral", 1), []);
  assert.deepEqual(parameterRequestsForEmotion(null, 1), []);
  assert.deepEqual(parameterRequestsForEmotion(undefined, 1), []);
});

test("节奏类标签（very fast/very slow）→ 空（无固定表情）", () => {
  assert.deepEqual(parameterRequestsForEmotion("very fast", 1), []);
  assert.deepEqual(parameterRequestsForEmotion("very slowly", 1), []);
});

test("intensity 越界 clamp 到 0..1", () => {
  const reqs = parameterRequestsForEmotion("sad", 2);
  for (const req of reqs) assert.ok(req.value <= 1);
});

test("映射表覆盖 cue 五类 emotion + 常用标签 emotion", () => {
  for (const emotion of ["neutral", "happy", "curious", "concerned", "surprised"]) {
    assert.ok(emotion in EMOTION_FACS_PARAMETERS, `cue emotion ${emotion} 有映射`);
  }
  for (const emotion of ["excited", "sad", "angry", "tired", "crying", "amazed"]) {
    assert.ok(emotion in EMOTION_FACS_PARAMETERS, `标签 emotion ${emotion} 有映射`);
  }
});
