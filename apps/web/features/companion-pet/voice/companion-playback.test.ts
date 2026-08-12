import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialPlaybackState,
  playbackReducer,
  assertMicStoppedBeforeSpeaking,
  nextSegmentToPlay,
  PLAYBACK_COOLDOWN_MS,
  type PlaybackSegment,
} from "./companion-playback.ts";

const seg = (ordinal: number, runId = "run-1", generation = 1): PlaybackSegment => ({
  conversationId: "123e4567-e89b-12d3-a456-426614174000",
  runId,
  generation,
  ordinal,
  segmentId: "a".repeat(64),
  text: `第${ordinal}段`,
});

test("segments → 开始播放 ordinal 1；done 后按序播放", () => {
  let s = playbackReducer(
    initialPlaybackState,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(1), seg(2), seg(3)] },
    0,
  );
  assert.equal(s.phase.phase, "playing");
  if (s.phase.phase === "playing") assert.equal(s.phase.ordinal, 1);
  assert.equal(nextSegmentToPlay(s)?.ordinal, 1);

  s = playbackReducer(s, { type: "segment.done" }, 0);
  assert.equal(s.phase.phase, "playing");
  if (s.phase.phase === "playing") assert.equal(s.phase.ordinal, 2);

  s = playbackReducer(s, { type: "segment.done" }, 0);
  if (s.phase.phase === "playing") assert.equal(s.phase.ordinal, 3);
});

test("重连重复段不重复入队，且 cooldown 中到达的后续段会恢复播放", () => {
  let s = playbackReducer(
    initialPlaybackState,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(2), seg(1)] },
    0,
  );
  s = playbackReducer(
    s,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(2), seg(3)] },
    0,
  );
  assert.deepEqual(s.queue.map((segment) => segment.ordinal), [1, 2, 3]);

  s = playbackReducer(s, { type: "segment.done" }, 0);
  s = playbackReducer(s, { type: "segment.done" }, 0);
  assert.equal(s.phase.phase, "playing");
  if (s.phase.phase === "playing") assert.equal(s.phase.ordinal, 3);

  s = playbackReducer(s, { type: "segment.done" }, 100);
  assert.equal(s.phase.phase, "cooldown");
  s = playbackReducer(
    s,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(4)] },
    101,
  );
  assert.equal(s.phase.phase, "playing");
  if (s.phase.phase === "playing") assert.equal(s.phase.ordinal, 4);
});

test("全部播放完 → cooldown（初始 600ms）；cooldown.done 后 idle", () => {
  let s = playbackReducer(
    initialPlaybackState,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(1)] },
    0,
  );
  s = playbackReducer(s, { type: "segment.done" }, 1000);
  assert.equal(s.phase.phase, "cooldown");
  if (s.phase.phase === "cooldown") assert.equal(s.phase.until, 1000 + PLAYBACK_COOLDOWN_MS);

  // 未到时间不切 idle
  s = playbackReducer(s, { type: "cooldown.done", now: 1000 + PLAYBACK_COOLDOWN_MS - 1 }, 1000 + PLAYBACK_COOLDOWN_MS - 1);
  assert.equal(s.phase.phase, "cooldown");

  s = playbackReducer(s, { type: "cooldown.done", now: 1000 + PLAYBACK_COOLDOWN_MS }, 1000 + PLAYBACK_COOLDOWN_MS);
  assert.equal(s.phase.phase, "idle");
});

test("§11.4 barge-in：清空 queue + 立即 idle（可请求 listening）", () => {
  let s = playbackReducer(
    initialPlaybackState,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(1), seg(2), seg(3)] },
    0,
  );
  s = playbackReducer(s, { type: "barge_in" }, 0);
  assert.equal(s.phase.phase, "idle");
  assert.deepEqual(s.queue, []);
  assert.equal(nextSegmentToPlay(s), null);
});

test("§11.5 旧 generation 的段只丢弃不播放（fence）", () => {
  const s = playbackReducer(
    initialPlaybackState,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(1), seg(2)] },
    0,
  );
  // 新 run 的段到来（fence 不同）→ 丢弃
  const s2 = playbackReducer(s, { type: "segments", runId: "run-2", generation: 2, segments: [seg(1, "run-2", 2)] }, 0);
  // 原样丢弃（fence 不同不消费）
  assert.equal(s2.phase.phase, "playing");
  if (s2.phase.phase === "playing") assert.equal(s2.phase.ordinal, 1);
  assert.deepEqual(s2.queue.map((x) => x.ordinal), [1, 2]);
  assert.equal(s2.fence?.runId, "run-1");
});

test("段失败：跳过继续下一段（文字已显示），全失败也照常走完", () => {
  let s = playbackReducer(
    initialPlaybackState,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(1), seg(2)] },
    0,
  );
  s = playbackReducer(s, { type: "segment.failed" }, 0);
  assert.equal(s.phase.phase, "playing");
  if (s.phase.phase === "playing") assert.equal(s.phase.ordinal, 2);
  s = playbackReducer(s, { type: "segment.failed" }, 0);
  assert.equal(s.phase.phase, "cooldown");
});

test("§11.5 speaking 前 mic tracks 必须停止", () => {
  let stopped = 0;
  const live = { readyState: "live", stop: () => { stopped += 1; } } as const;
  const ended = { readyState: "ended", stop: () => { stopped += 1; } } as const;
  assertMicStoppedBeforeSpeaking([live, ended]);
  assert.equal(stopped, 1, "仅 live track 被 stop");
  assertMicStoppedBeforeSpeaking([]);
});

test("voiceOff：停止播放 + 清空 queue → idle", () => {
  let s = playbackReducer(
    initialPlaybackState,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(1), seg(2), seg(3)] },
    0,
  );
  s = playbackReducer(s, { type: "voice_off" }, 0);
  assert.equal(s.phase.phase, "idle");
  assert.deepEqual(s.queue, []);
  assert.equal(nextSegmentToPlay(s), null);
});

test("voiceOff 后同一 run 的迟到段不复活", () => {
  let s = playbackReducer(
    initialPlaybackState,
    { type: "segments", runId: "run-1", generation: 1, segments: [seg(1)] },
    0,
  );
  s = playbackReducer(s, { type: "voice_off" }, 0);
  // 同一 run 再推段（不应复活——接线层只在 run 终态后推送，voiceOff 后不推）
  const s2 = playbackReducer(s, { type: "segments", runId: "run-1", generation: 1, segments: [seg(1)] }, 0);
  assert.equal(s2.phase.phase, "idle");
  assert.deepEqual(s2.queue, []);
});
