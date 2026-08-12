/**
 * P6 §13：双路径录音控制器单元测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOUNDED_RECORDING_LIMIT,
  DualCaptureController,
  type DualCaptureSink,
} from "./companion-dual-capture.ts";

class MockSink implements DualCaptureSink {
  chunks: number[] = [];
  localSuccess = false;
  localFailure = false;
  uploads: string[] = [];
  uploadResult = true;
  onRecorderChunk = (bytes: number) => { this.chunks.push(bytes); };
  onLocalSuccess = () => { this.localSuccess = true; };
  onLocalFailure = () => { this.localFailure = true; };
  upload = async (ref: string) => { this.uploads.push(ref); return this.uploadResult; };
}

test("录音：MediaRecorder 分块有界（bytes 上限截断）", () => {
  const sink = new MockSink();
  const c = new DualCaptureController(sink);
  c.startRecording();
  c.onRecorderChunk(BOUNDED_RECORDING_LIMIT.maxBytes - 100);
  c.onRecorderChunk(1000);
  assert.equal(c.snapshot().recordingBytes, BOUNDED_RECORDING_LIMIT.maxBytes, "不超过 5MB 上限");
});

test("本地成功 → 立即丢弃副本（零上传）", async () => {
  const sink = new MockSink();
  const c = new DualCaptureController(sink);
  c.startRecording();
  c.onRecorderChunk(1000);
  c.onLocalSuccess();
  await c.finish();
  assert.equal(c.snapshot().phase, "discarded");
  assert.equal(c.snapshot().recordingBytes, 0, "副本已删除");
  assert.equal(sink.uploads.length, 0, "无上传");
});

test("本地失败 + 未告知 → 不静默上传（failed，text_only 语义）", async () => {
  const sink = new MockSink();
  const c = new DualCaptureController(sink);
  c.startRecording();
  c.onRecorderChunk(1000);
  c.onLocalFailure();
  await c.finish();
  assert.equal(c.snapshot().phase, "failed");
  assert.equal(c.snapshot().pendingUploadRef, null);
  assert.equal(sink.uploads.length, 0, "未同意不上传");
});

test("本地失败 + 已告知 → 上传副本；上传成功 → discarded", async () => {
  const sink = new MockSink();
  const c = new DualCaptureController(sink, () => 1_000);
  c.setUploadConsent(true);
  c.startRecording();
  c.onRecorderChunk(2000);
  c.onLocalFailure();
  await c.finish();
  assert.equal(c.snapshot().phase, "discarded");
  assert.equal(sink.uploads.length, 1, "上传一次");
  assert.equal(sink.uploads[0], "recording:1000");
  assert.equal(c.snapshot().recordingBytes, 0, "上传后副本清除");
});

test("上传失败 → failed（副本引用保留，可重试）", async () => {
  const sink = new MockSink();
  sink.uploadResult = false;
  const c = new DualCaptureController(sink, () => 2_000);
  c.setUploadConsent(true);
  c.startRecording();
  c.onRecorderChunk(500);
  c.onLocalFailure();
  await c.finish();
  assert.equal(c.snapshot().phase, "failed");
  assert.equal(c.snapshot().pendingUploadRef, "recording:2000");
});

test("本地成功（即使未告知）→ 丢弃副本（本地识别不依赖云端）", async () => {
  const sink = new MockSink();
  const c = new DualCaptureController(sink);
  c.startRecording();
  c.onRecorderChunk(100);
  c.onLocalSuccess();
  await c.finish();
  assert.equal(c.snapshot().phase, "discarded");
  assert.equal(sink.uploads.length, 0);
});
