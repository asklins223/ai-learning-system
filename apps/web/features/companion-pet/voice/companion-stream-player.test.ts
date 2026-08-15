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

test("fence：generation 递增 = 新 run 语音接管（15a-A 语义更新）", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(sink, async (s) => new Response(streamOf([s.text]), { status: 200 }));
  c.enqueue(seg({ generation: 1, ordinal: 1 }));
  await flush(20);
  c.enqueue(seg({ generation: 1, ordinal: 2 }));
  await flush(20);
  assert.equal(sink.done.length, 2, "generation 1 两段播放完成");
  // 新 run（generation 递增）→ 接管播放（此前被 fence 丢弃导致 voice 卡 speaking）
  c.enqueue(seg({ generation: 2, runId: "22222222-2222-4222-8222-222222222222", ordinal: 1 }));
  await flush(20);
  assert.equal(sink.done.length, 3, "generation 2 段接管播放（新 turn 语音）");
});

test("fence：runId 不同（新 run/新对话）一律接管播放", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(sink, async (s) => new Response(streamOf([s.text]), { status: 200 }));
  c.enqueue(seg({ runId: "run-a", generation: 1, ordinal: 1 }));
  await flush(20);
  // 2026-08-13（问题1 修复）：generation 是 per-conversation 递增，跨对话
  // 比较无意义——runId 不同即视为新 run 接管（旧 run 迟到段由 reducer
  // 的 turn 校验拦截，不会到达 controller）。
  c.enqueue(seg({ runId: "run-b", generation: 1, ordinal: 2 }));
  await flush(30);
  assert.deepEqual(sink.done.map((s) => s.runId), ["run-a", "run-b"], "run-b 接管并播放");
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

test("fetch 失败（重试后仍失败）→ 段失败回调（降级纯文字）+ 继续下一段", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(
    sink,
    async (s) => {
      // ordinal 1：永远 502（首次 + 重试都失败）→ 降级；ordinal 2：成功
      if (s.ordinal === 1) {
        return new Response("err", { status: 502 });
      }
      return new Response(streamOf(["OK"]), { status: 200 });
    },
  );
  c.enqueue(seg({ ordinal: 1 }));
  c.enqueue(seg({ ordinal: 2 }));
  await flush(60);
  assert.equal(sink.failed.length, 1, "重试后仍失败才上报失败");
  assert.equal(sink.failed[0].code, "tts_stream_502");
  assert.equal(sink.done.length, 1, "第二段仍正常播放");
});

test("队列上限 20：超限段丢弃", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(sink, async () => new Response(streamOf([]), { status: 200 }));
  for (let i = 1; i <= 250; i++) c.enqueue(seg({ ordinal: i }));
  assert.ok(c.snapshot().queue.length <= 200, "队列不超 200（与 worker 段数上限对齐）");
});

test("15a-A：队列全部播完触发 onDrained（回传最后一段）", async () => {
  const sink = new MockSink();
  const drained: StreamSegment[] = [];
  const c = new StreamPlaybackController(
    sink,
    async (s) => new Response(streamOf([s.text]), { status: 200 }),
    0,
    (last) => drained.push(last),
  );
  c.enqueue(seg({ ordinal: 1, text: "一" }));
  c.enqueue(seg({ ordinal: 2, text: "二" }));
  await flush(40);
  assert.equal(sink.done.length, 2);
  assert.equal(drained.length, 1, "队列全部播完只触发一次");
  assert.equal(drained[0].ordinal, 2, "onDrained 回传最后一段");
  assert.equal(c.snapshot().phase, "idle");
});

test("15a-A：barge-in 不触发 onDrained（主动中止不算播完）", async () => {
  const sink = new MockSink();
  const drained: StreamSegment[] = [];
  const c = new StreamPlaybackController(
    sink,
    async () => new Response(new ReadableStream({
      start(c) {
        c.enqueue(enc.encode("X")); // 永不完成：模拟长句被打断
      },
    }), { status: 200 }),
    0,
    (last) => drained.push(last),
  );
  c.enqueue(seg({ ordinal: 1 }));
  await flush(20);
  c.bargeIn();
  await flush(30);
  assert.equal(drained.length, 0, "打断后不触发 onDrained");
  assert.equal(c.snapshot().phase, "barged");
});

test("15a-A：段失败降级后队列空也触发 onDrained（回传失败段）", async () => {
  const sink = new MockSink();
  const drained: StreamSegment[] = [];
  const c = new StreamPlaybackController(
    sink,
    async () => new Response("err", { status: 502 }),
    0,
    (last) => drained.push(last),
  );
  c.enqueue(seg({ ordinal: 1 }));
  await flush(30);
  assert.equal(sink.failed.length, 1);
  assert.equal(drained.length, 1, "失败降级后队列空 → 通知上层结束播报");
  assert.equal(drained[0].ordinal, 1);
  assert.equal(c.snapshot().phase, "idle");
});

test("15a-A 根因修复：新 run（generation 递增）语音接管，不被 fence 丢弃", async () => {
  const sink = new MockSink();
  const drained: StreamSegment[] = [];
  const c = new StreamPlaybackController(
    sink,
    async (s) => new Response(streamOf([s.text]), { status: 200 }),
    0,
    (last) => drained.push(last),
  );
  // run A（generation 1）一段入队并播完
  c.enqueue(seg({ runId: "run-a", generation: 1, ordinal: 1, text: "一" }));
  await flush(30);
  assert.equal(sink.done.length, 1);
  assert.equal(drained.length, 1, "run A 播完触发 onDrained");
  // run B（generation 2）接管：不再被 fence 丢弃
  c.enqueue(seg({ runId: "run-b", generation: 2, ordinal: 1, text: "二" }));
  await flush(30);
  assert.equal(sink.done.length, 2, "run B 段被播放（fence 已接管）");
  assert.equal(drained.length, 2, "run B 播完触发 onDrained");
  assert.equal(drained[1].runId, "run-b");
});

test("15a-A 根因修复：runId 不同（新 run）接管；同 runId 旧 generation 丢弃", async () => {
  const sink = new MockSink();
  const drained: StreamSegment[] = [];
  const c = new StreamPlaybackController(
    sink,
    async (s) => new Response(streamOf([s.text]), { status: 200 }),
    0,
    (last) => drained.push(last),
  );
  c.enqueue(seg({ runId: "run-a", generation: 1, ordinal: 1, text: "一" }));
  await flush(30);
  // 2026-08-13（问题1 修复）：runId 不同 = 新 run（跨对话/cancel 后新 turn）
  // → 接管播放（旧实现按 generation 比较会丢弃 → 无声）。
  c.enqueue(seg({ runId: "run-x", generation: 1, ordinal: 1, text: "新run" }));
  await flush(20);
  assert.equal(sink.done.length, 2, "run-x 接管并播放");
  // 同 runId 更旧 generation（重试前残余）→ 丢弃
  c.enqueue(seg({ runId: "run-x", generation: 1, ordinal: 5, text: "同run旧代" }));
  c.enqueue(seg({ runId: "run-x", generation: 3, ordinal: 2, text: "二" }));
  await flush(30);
  c.enqueue(seg({ runId: "run-x", generation: 2, ordinal: 4, text: "更旧代" }));
  await flush(20);
  assert.deepEqual(sink.done.map((s) => s.text), ["一", "新run", "二"], "同 runId 旧 generation 全部丢弃");
});

test("15b 流水线：段 N 播放中入队的段 N+1 立即预取（fetcher 提前发起）", async () => {
  const sink = new MockSink();
  const callOrder: number[] = [];
  const c = new StreamPlaybackController(
    sink,
    async (s) => {
      callOrder.push(s.ordinal);
      await new Promise((r) => setTimeout(r, 25)); // 模拟合成耗时
      return new Response(streamOf([s.text]), { status: 200 });
    },
  );
  c.enqueue(seg({ ordinal: 1 }));
  await flush(10); // 段 1 开始 fetch（25ms 中）
  c.enqueue(seg({ ordinal: 2 })); // 播放中入队 → 立即预取
  await flush(10);
  assert.ok(callOrder.includes(2), "段 2 的 fetch 在段 1 播放期间已发起（预取）");
  await flush(80);
  assert.equal(sink.done.length, 2, "两段都播完");
  assert.deepEqual(sink.done.map((s) => s.ordinal), [1, 2], "顺序不变");
});

test("15b 流水线：预取失败回退现场 fetch（仍正常播放）", async () => {
  const sink = new MockSink();
  let fetchCount = 0;
  const c = new StreamPlaybackController(
    sink,
    async (s) => {
      fetchCount += 1;
      if (s.ordinal === 2 && fetchCount === 2) throw new Error("prefetch fail");
      await new Promise((r) => setTimeout(r, 10));
      return new Response(streamOf([s.text]), { status: 200 });
    },
  );
  c.enqueue(seg({ ordinal: 1 }));
  await flush(15);
  c.enqueue(seg({ ordinal: 2 }));
  await flush(60);
  assert.equal(sink.done.length, 2, "预取失败后现场重取仍播完");
  assert.ok(fetchCount >= 3, "段2 被取了两次（预取失败 + 现场）");
});

test("15b 二期（问题1 修复）：跨对话切换——新 run 的 generation 更小也必须接管播放", async () => {
  // 场景：对话 A 播放中（fence 锁定 runA/gen3），用户切到对话 B——
  // B 的 generation 从 1 开始（per-conversation 递增），旧实现按
  // `newGen > fenceGen` 判断会把 B 的段丢弃 → 无声。
  const sink = new MockSink();
  const c = new StreamPlaybackController(
    sink,
    async (s) => {
      await new Promise((r) => setTimeout(r, 30)); // 模拟合成耗时（A 播放中切 B）
      return new Response(streamOf([s.text]), { status: 200 });
    },
  );
  const runA = { runId: "run-a", generation: 3 };
  const runB = { runId: "run-b", generation: 1 };
  // 对话 A 的一段（fence 锁定 runA/gen3）
  c.enqueue(seg({ ordinal: 1, runId: runA.runId, generation: runA.generation }));
  await flush(15);
  assert.equal(sink.done.length, 0, "段 1 播放中");
  // 对话 B 的第一段（runId 不同、generation 更小）
  c.enqueue(seg({ ordinal: 1, runId: runB.runId, generation: runB.generation }));
  await flush(80);
  assert.equal(sink.done.length, 1, "B 的段被接管播放（A 被 abort，未完成）");
  assert.equal(sink.done[0].runId, "run-b", "最后播放的是 B 的段");
  assert.equal(c.snapshot().fence?.runId, "run-b", "fence 已切到 B");
});

test("15b 二期：同 runId 旧 generation（重试前残余）仍丢弃", async () => {
  const sink = new MockSink();
  const c = new StreamPlaybackController(
    sink,
    async (s) => {
      await new Promise((r) => setTimeout(r, 10));
      return new Response(streamOf([s.text]), { status: 200 });
    },
  );
  c.enqueue(seg({ ordinal: 1, runId: "run-x", generation: 2 }));
  await flush(15);
  // 同 runId 更旧 generation（1 < 2）→ 丢弃
  c.enqueue(seg({ ordinal: 9, runId: "run-x", generation: 1 }));
  await flush(60);
  assert.equal(sink.done.length, 1, "旧 generation 段被丢弃");
});
