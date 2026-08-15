// 15 方案 §5 待办 6：emotion-vad 状态机单测。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EmotionVadController } from "./emotion-vad.ts";

test("初始状态：无事件 → neutral/0", () => {
  const vad = new EmotionVadController();
  const out = vad.update(0);
  assert.deepEqual(out, { emotion: null, intensity: 0 });
});

test("事件后：emotion 立即生效，强度按指数逼近收敛", () => {
  const vad = new EmotionVadController();
  vad.push({ emotion: "happy", intensity: 1, at: 0 });
  // 第一帧（hold 期内）：emotion 切换立即生效，强度 = 0 + (1-0)*0.25
  const first = vad.update(16);
  assert.equal(first.emotion, "happy");
  assert.ok(first.intensity > 0.2 && first.intensity < 0.3, `alpha=0.25 首帧 ≈ 0.25，实际 ${first.intensity}`);
  // 持续逼近（hold 期内）
  let out = first;
  for (let i = 0; i < 30; i++) out = vad.update(16 * (i + 2));
  assert.ok(out.intensity > 0.99, `收敛到接近 1，实际 ${out.intensity}`);
});

test("情绪切换：新事件立即接管 emotion，强度从新目标逼近", () => {
  const vad = new EmotionVadController();
  vad.push({ emotion: "happy", intensity: 1, at: 0 });
  for (let i = 0; i < 10; i++) vad.update(16 * (i + 1));
  vad.push({ emotion: "sad", intensity: 0.8, at: 200 });
  const out = vad.update(216);
  assert.equal(out.emotion, "sad", "切换立即生效");
  // 从 1.0 向 0.8 收敛：继续逼近后应接近 0.8（指数渐近，用容差）
  let cur = out;
  for (let i = 0; i < 40; i++) cur = vad.update(216 + 16 * (i + 1));
  assert.ok(Math.abs(cur.intensity - 0.8) < 0.01, `强度收敛到 0.8 附近，实际 ${cur.intensity}`);
  assert.equal(cur.emotion, "sad");
});

test("静默衰减：超过 holdMs 无事件 → 强度衰减并最终归零（emotion 保持期间不消失）", () => {
  const vad = new EmotionVadController({ holdMs: 100, approachAlpha: 0.5 });
  vad.push({ emotion: "excited", intensity: 1, at: 0 });
  vad.update(16); // 进入 excited
  // 超过 holdMs（100ms）后：target 回落 neutral，强度衰减
  const t = 200;
  const decaying = vad.update(t);
  assert.equal(decaying.emotion, "excited", "衰减期 emotion 保持（情绪保持）");
  assert.ok(decaying.intensity < 1, "强度开始衰减");
  // 持续衰减 → 低于 minIntensity 归零
  let out = decaying;
  for (let i = 0; i < 200; i++) out = vad.update(t + 16 * (i + 1));
  assert.deepEqual(out, { emotion: null, intensity: 0 }, "最终归零 neutral");
});

test("hold 期内持续事件不衰减", () => {
  const vad = new EmotionVadController({ holdMs: 10_000 });
  vad.push({ emotion: "happy", intensity: 0.6, at: 0 });
  let out = vad.update(16);
  for (let i = 0; i < 20; i++) {
    out = vad.update(16 * (i + 2));
  }
  assert.equal(out.emotion, "happy");
  assert.ok(out.intensity >= 0.55, "hold 期内强度保持目标附近");
});

test("无效输入：强度 ≤0 或空 emotion 忽略", () => {
  const vad = new EmotionVadController();
  vad.push({ emotion: "happy", intensity: 0, at: 0 });
  vad.push({ emotion: "", intensity: 0.8, at: 0 });
  assert.deepEqual(vad.update(16), { emotion: null, intensity: 0 });
});

test("intensity 越界 clamp 到 0..1", () => {
  const vad = new EmotionVadController();
  vad.push({ emotion: "happy", intensity: 5, at: 0 });
  const out = vad.update(16);
  assert.ok(out.intensity <= 1);
});
