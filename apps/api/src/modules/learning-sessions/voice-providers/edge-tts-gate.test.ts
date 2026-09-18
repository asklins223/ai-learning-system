/**
 * edge-tts 并发闸测试（AI P2，2026-09-15 审计）。
 *
 * 覆盖：
 * - 有界并发：limit=1 时第二个请求必须等第一个结束才进入 fetch
 * - 流式：名额保持到流被读完，读完即释放（不提前释放、不永久占用）
 * - 错误路径：fetch 抛错后名额释放，不泄漏
 * - 限额解析：非法值回退 4
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  edgeTtsActiveRequestCount,
  edgeTtsSynthesize,
  edgeTtsSynthesizeStream,
  resetEdgeTtsGateForTests,
  resolveEdgeTtsMaxConcurrency,
} from "./edge-tts.ts";

const originalLimit = process.env.EDGE_TTS_MAX_CONCURRENCY;

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

function audioResponse(body: BodyInit): Response {
  return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
}

beforeEach(() => {
  resetEdgeTtsGateForTests();
});

afterEach(() => {
  resetEdgeTtsGateForTests();
  if (originalLimit === undefined) delete process.env.EDGE_TTS_MAX_CONCURRENCY;
  else process.env.EDGE_TTS_MAX_CONCURRENCY = originalLimit;
});

test("有界并发：limit=1 时第二个请求等第一个完成后才发起", async () => {
  process.env.EDGE_TTS_MAX_CONCURRENCY = "1";
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  // 明确断言赋值（TS 的控制流分析看不到 Promise executor 内部的赋值）：
  // 用 `!` 声明为函数类型，避免调用点被收窄成 null。
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const fetchImpl = async (): Promise<Response> => {
    calls += 1;
    const isFirst = calls === 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`start${calls}`);
    if (isFirst) await firstGate;
    inFlight -= 1;
    order.push(`end${calls}`);
    return audioResponse(new Uint8Array([1, 2, 3]));
  };

  const first = edgeTtsSynthesize("a", "v", { fetchImpl: fetchImpl as never });
  const second = edgeTtsSynthesize("b", "v", { fetchImpl: fetchImpl as never });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["start1"], "第二个请求在名额释放前不得进入 fetch");

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(order, ["start1", "end1", "start2", "end2"]);
  assert.equal(maxInFlight, 1, "同一时刻至多一个在途请求");
  assert.equal(edgeTtsActiveRequestCount(), 0, "全部完成后名额归零");
});

test("流式：名额保持到流读完才释放", async () => {
  process.env.EDGE_TTS_MAX_CONCURRENCY = "1";
  const fetchImpl = async (): Promise<Response> => audioResponse(streamOf(["AA", "BB"]));
  const result = await edgeTtsSynthesizeStream("x", "v", { fetchImpl: fetchImpl as never });

  assert.equal(edgeTtsActiveRequestCount(), 1, "流未读完时名额仍被占用");

  const reader = result.stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.equal(text, "AABB");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(edgeTtsActiveRequestCount(), 0, "流读完后名额释放");
});

test("流被取消时也释放名额", async () => {
  process.env.EDGE_TTS_MAX_CONCURRENCY = "1";
  const fetchImpl = async (): Promise<Response> => audioResponse(streamOf(["AA", "BB", "CC"]));
  const result = await edgeTtsSynthesizeStream("x", "v", { fetchImpl: fetchImpl as never });
  assert.equal(edgeTtsActiveRequestCount(), 1);

  await result.stream.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(edgeTtsActiveRequestCount(), 0, "取消后名额必须释放，否则会永久泄漏");
});

test("fetch 抛错后名额不泄漏", async () => {
  process.env.EDGE_TTS_MAX_CONCURRENCY = "1";
  const fetchImpl = async (): Promise<Response> => {
    throw new Error("boom");
  };
  await assert.rejects(() => edgeTtsSynthesize("x", "v", { fetchImpl: fetchImpl as never }));
  assert.equal(edgeTtsActiveRequestCount(), 0);
});

test("限额解析：非法/缺失回退 4，正整数生效", () => {
  assert.equal(resolveEdgeTtsMaxConcurrency(undefined), 4);
  assert.equal(resolveEdgeTtsMaxConcurrency("abc"), 4);
  assert.equal(resolveEdgeTtsMaxConcurrency("0"), 4);
  assert.equal(resolveEdgeTtsMaxConcurrency("-2"), 4);
  assert.equal(resolveEdgeTtsMaxConcurrency("2"), 2);
});
