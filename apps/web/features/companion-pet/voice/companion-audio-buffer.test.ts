/**
 * P6 顺序 1：BoundedAudioBuffer 单元测试。
 * - push/read 环形语义（顺序、回绕）；
 * - 满时丢弃最旧（保最新）；
 * - fillRatio/availableSamples 水位；
 * - clear 重置；
 * - 非法容量拒绝；空 chunk 无害。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedAudioBuffer, defaultCaptureBuffer } from "./companion-audio-buffer.ts";

test("push/read 按序往返（无回绕）", () => {
  const b = new BoundedAudioBuffer({ capacitySamples: 8 });
  b.push(new Float32Array([1, 2, 3]));
  b.push(new Float32Array([4, 5]));
  assert.equal(b.availableSamples, 5);
  const out = b.read(3);
  assert.deepEqual(Array.from(out), [1, 2, 3]);
  assert.equal(b.availableSamples, 2);
  assert.deepEqual(Array.from(b.read(10)), [4, 5]);
  assert.equal(b.availableSamples, 0);
});

test("环形回绕：读写指针跨容量边界", () => {
  const b = new BoundedAudioBuffer({ capacitySamples: 4 });
  b.push(new Float32Array([1, 2, 3, 4])); // write 回绕到 0
  b.read(2); // 读 1,2 → read=2
  b.push(new Float32Array([5, 6])); // write 2,3 → write=0（回绕）
  assert.deepEqual(Array.from(b.read(10)), [3, 4, 5, 6]);
  assert.equal(b.availableSamples, 0);
});

test("满时丢弃最旧（保最新）", () => {
  const b = new BoundedAudioBuffer({ capacitySamples: 3 });
  b.push(new Float32Array([1, 2, 3]));
  const dropped = b.push(new Float32Array([4, 5]));
  assert.equal(dropped, 2); // 丢 1,2
  assert.equal(b.availableSamples, 3);
  assert.deepEqual(Array.from(b.read(10)), [3, 4, 5]);
});

test("fillRatio/availableSamples 水位（供 backpressure）", () => {
  const b = new BoundedAudioBuffer({ capacitySamples: 10 });
  assert.equal(b.fillRatio, 0);
  b.push(new Float32Array(5));
  assert.equal(b.availableSamples, 5);
  assert.ok(Math.abs(b.fillRatio - 0.5) < 1e-9);
  b.clear();
  assert.equal(b.availableSamples, 0);
  assert.equal(b.fillRatio, 0);
});

test("clear 重置读写与水位", () => {
  const b = new BoundedAudioBuffer({ capacitySamples: 4 });
  b.push(new Float32Array([1, 2, 3, 4]));
  b.read(1);
  b.clear();
  assert.equal(b.availableSamples, 0);
  b.push(new Float32Array([7]));
  assert.deepEqual(Array.from(b.read(10)), [7]);
});

test("非法容量拒绝；空 chunk 无害；默认 16s@48k", () => {
  assert.throws(() => new BoundedAudioBuffer({ capacitySamples: 0 }), /positive/);
  assert.throws(() => new BoundedAudioBuffer({ capacitySamples: -1 }), /positive/);
  const b = new BoundedAudioBuffer({ capacitySamples: 4 });
  assert.equal(b.push(new Float32Array(0)), 0);
  assert.equal(b.availableSamples, 0);
  const d = defaultCaptureBuffer(48_000, 16);
  assert.equal(d.capacitySamples, 48_000 * 16);
});
