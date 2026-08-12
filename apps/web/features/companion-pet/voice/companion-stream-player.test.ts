/**
 * P6 §13：StreamPlaybackController 单元测试（mock fetcher + sink）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamPlaybackController, type StreamSegment, type StreamPlaybackSink } from "./companion-stream-player.ts";

const enc = new TextEncoder();
const seg = (over: Partial<StreamSegment> = {}): StreamSegment => ({
  runId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
  ordinal: 1,
  segmentId: "a".repeat(64),
  text: "你好",
  ...over,
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

class MockSink implements StreamPlaybackSink {
  played: Array<{ chunk: string; segment: StreamSegment }> = [];
  stopped = 0;
  failed: Array<{ segment: StreamSegment; code: string }> = [];
  done: StreamSegment[] = [];
  play = async (chunk: Uint8Array, segment: StreamSegment) => {
    this.played.push({ chunk: new TextDecoder().decode(chunk), segment });
  };
  stop = () => { this.stopped += 1; };
  onSegmentFailed = (segment: StreamSegment, code: string) => { this.failed.push({ segment, code }); };
  onSegmentDone = (segment: StreamSegment) => { this.done.push(segment); };
}

async function flush(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test("顺序播放：chunk 流式传给 sink，段完成回调", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(sink, async () => new Response(streamOf(["A", "B"]), { status: 200 }));
  c.enqueue(seg({ ordinal: 1 }));
  await flush(30);
  assert.equal(sink.played.length, 2);
  assert.equal(sink.played[0].chunk, "A");
  assert.equal(sink.played[1].chunk, "B");
  assert.equal(sink.done.length, 1);
  assert.equal(c.snapshot().phase, "idle");
});

test("多段顺序播放（队列先进先出）", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(sink, async (s) => new Response(streamOf([s.text]), { status: 200 }));
  c.enqueue(seg({ ordinal: 1, text: "一" }));
  c.enqueue(seg({ ordinal: 2, text: "二" }));
  await flush(40);
  assert.equal(sink.done.length, 2);
  assert.deepEqual(sink.done.map((s) => s.ordinal), [1, 2]);
});

test("fence：旧 generation 段丢弃不播放", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(sink, async (s) => new Response(streamOf([s.text]), { status: 200 }));
  c.enqueue(seg({ generation: 1, ordinal: 1 }));
  await flush(20);
  c.enqueue(seg({ generation: 1, ordinal: 2 }));
  // 新 run（generation 不同）→ 旧 generation 段丢弃
  c.enqueue(seg({ generation: 2, runId: "22222222-2222-4222-8222-222222222222", ordinal: 1 }));
  await flush(20);
  assert.equal(sink.done.length, 2, "只播 generation 1 的两段，generation 2 被 fence 丢弃");
});

test("fence：同 generation 的其他 run 也丢弃", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(sink, async (s) => new Response(streamOf([s.text]), { status: 200 }));
  c.enqueue(seg({ runId: "run-a", generation: 1, ordinal: 1 }));
  await flush(20);
  c.enqueue(seg({ runId: "run-b", generation: 1, ordinal: 2 }));
  await flush(20);
  assert.deepEqual(sink.done.map((s) => s.runId), ["run-a"]);
});

test("barge-in：abort fetch + 停播放器 + 清队 + 递增 fence", async () => {
  let aborted = false;
  const sink = new MockSink();
  const c = new StreamPlaybackController(
    sink,
    async (s, signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      // ordinal 1：永不完成的流（模拟长句被打断）；ordinal 3：正常完成
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(enc.encode("X"));
          if (s.ordinal >= 3) c.close();
        },
      }), { status: 200 });
    },
  );
  c.enqueue(seg({ ordinal: 1 }));
  await flush(20);
  c.enqueue(seg({ ordinal: 2 }));
  assert.equal(c.snapshot().queue.length, 1, "第二段入队");
  c.bargeIn();
  await flush(20);
  assert.ok(aborted, "fetch 已 abort");
  assert.equal(sink.stopped, 1, "播放器已停止");
  assert.equal(c.snapshot().queue.length, 0, "队列已清空");
  assert.equal(c.snapshot().phase, "barged");
  assert.equal(c.snapshot().fence?.generation, 1, "fence 是 run 边界（打断不变）");
  // 打断后同 run 新段仍可播放（fence 不丢）
  c.enqueue(seg({ ordinal: 3, generation: 1 }));
  await flush(20);
  assert.equal(sink.done.length, 1, "barge-in 后同 run 新段照播");
});

test("fetch 失败 → 段失败回调（降级纯文字）+ 继续下一段", async () => {
  const sink = new MockSink();
  let failFirst = true;
  const c = new StreamPlaybackController(
    sink,
    async (s) => {
      if (failFirst && s.ordinal === 1) {
        failFirst = false;
        return new Response("err", { status: 502 });
      }
      return new Response(streamOf(["OK"]), { status: 200 });
    },
  );
  c.enqueue(seg({ ordinal: 1 }));
  c.enqueue(seg({ ordinal: 2 }));
  await flush(40);
  assert.equal(sink.failed.length, 1);
  assert.equal(sink.failed[0].code, "tts_stream_502");
  assert.equal(sink.done.length, 1, "第二段仍正常播放");
});

test("队列上限 20：超限段丢弃", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(sink, async () => new Response(streamOf([]), { status: 200 }));
  for (let i = 1; i <= 25; i++) c.enqueue(seg({ ordinal: i }));
  assert.ok(c.snapshot().queue.length <= 20, "队列不超 20");
});
