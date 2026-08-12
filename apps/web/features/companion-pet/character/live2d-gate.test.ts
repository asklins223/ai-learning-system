import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldLoadLive2D, shouldRunLive2DLoop } from "./live2d-gate.ts";

test("reducedMotion 完全绕过 Live2D（即使 live2dEnabled）", () => {
  assert.equal(shouldLoadLive2D({ live2dEnabled: true, reducedMotion: true, animationOff: false }), false);
  assert.equal(shouldLoadLive2D({ live2dEnabled: true, reducedMotion: false, animationOff: false }), true);
});

test("animationOff 完全绕过 Live2D", () => {
  assert.equal(shouldLoadLive2D({ live2dEnabled: true, reducedMotion: false, animationOff: true }), false);
});

test("服务端未授权 P4（live2dEnabled=false）不加载 Live2D", () => {
  assert.equal(shouldLoadLive2D({ live2dEnabled: false, reducedMotion: false, animationOff: false }), false);
});

test("已加载时循环表现同样受 reducedMotion/animationOff 门控", () => {
  assert.equal(shouldRunLive2DLoop({ reducedMotion: false, animationOff: false }), true);
  assert.equal(shouldRunLive2DLoop({ reducedMotion: true, animationOff: false }), false);
  assert.equal(shouldRunLive2DLoop({ reducedMotion: false, animationOff: true }), false);
});
