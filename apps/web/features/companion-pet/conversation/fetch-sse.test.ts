import { test } from "node:test";
import assert from "node:assert/strict";
import { openCompanionSse } from "./fetch-sse.ts";

// openCompanionSse 依赖 window.location.origin 构造 URL；node 测试环境补一个。
(globalThis as unknown as { window: unknown }).window = {
  location: { origin: "http://test.local" },
};

const enc = new TextEncoder();

async function flush(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** mock fetch：返回可控流；外部 signal abort 时让流 error（模拟真实 fetch 的
 *  abort 传播——body reader.read() 会 reject，openCompanionSse 才能收尾）。 */
function installSseFetchMock(build: (controller: ReadableStreamDefaultController<Uint8Array>) => {
  onAbort?: () => void;
} | null): () => void {
  let currentController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let currentAbort: (() => void) | null = null;
  (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        currentController = controller;
        const hooks = build(controller) ?? null;
        currentAbort = hooks?.onAbort ?? null;
      },
    });
    init?.signal?.addEventListener("abort", () => {
      currentAbort?.();
      try {
        currentController?.error(new Error("aborted"));
      } catch {
        /* already errored */
      }
    }, { once: true });
    return sseResponse(stream);
  };
  return () => { (globalThis as { fetch: unknown }).fetch = undefined; };
}

test("15a 新反馈：SSE 空闲看门狗——超时无任何字节 → network 错误（避免永久卡 thinking）", async () => {
  const restore = installSseFetchMock(() => null); // 永不发数据：模拟 api 挂起/网络半开
  const abort = new AbortController();
  const errors: string[] = [];
  const promise = openCompanionSse({
    conversationId: "c1",
    after: 0,
    lastEventId: null,
    signal: abort.signal,
    idleTimeoutMs: 40,
    callbacks: {
      onEvent: () => { throw new Error("不应有事件"); },
      onError: (error) => errors.push(error.kind),
    },
  });
  await flush(120);
  assert.deepEqual(errors, ["network"], "idle 超时上报 network（仅一次）");
  abort.abort();
  await promise;
  restore();
});

test("15a 新反馈：心跳/数据到达会重置看门狗（连接健康时不误报）", async () => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const restore = installSseFetchMock((controller) => {
    timer = setInterval(() => {
      try {
        controller.enqueue(enc.encode(": ping\n\n"));
      } catch {
        /* stream closed */
      }
    }, 25);
    return { onAbort: () => { if (timer) clearInterval(timer); } };
  });
  const abort = new AbortController();
  const errors: string[] = [];
  const promise = openCompanionSse({
    conversationId: "c2",
    after: 0,
    lastEventId: null,
    signal: abort.signal,
    idleTimeoutMs: 50,
    callbacks: {
      onEvent: () => { /* 心跳是 comment，不应产生事件 */ },
      onError: (error) => errors.push(error.kind),
    },
  });
  await flush(150);
  assert.deepEqual(errors, [], "心跳持续到达 → 不触发 idle 错误");
  abort.abort();
  await promise;
  restore();
});
