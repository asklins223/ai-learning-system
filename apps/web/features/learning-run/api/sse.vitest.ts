/**
 * §8.5/§20.2 恢复：subscribeLearningRunEvents（Last-Event-ID 重放 / 断线重连语义）。
 *
 * 本函数用 fetch stream 消费 text/event-stream（EventSource 不支持
 * Authorization header）；断线重连由调用方（useLearningRun）以
 * Last-Event-ID 重新订阅。覆盖：lastEventId 参数、流解析、HTTP 失败、
 * close 取消、abort。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  subscribeLearningRunEvents,
  type LearningRunStreamEvent,
} from "./sse";

function streamOf(chunks: Array<Uint8Array | null>): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      if (chunk === null) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array>, ok = true, status = 200): Response {
  return { ok, status, body } as unknown as Response;
}

const ENC = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subscribeLearningRunEvents（§8.5 恢复）", () => {
  it("lastEventId > 0 → 拼接 ?lastEventId= 重放参数并解析事件", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      sseResponse(streamOf([ENC.encode("id:5\nevent:learning_run.started\ndata:{}\n\n")])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const events: LearningRunStreamEvent[] = [];
    const sub = await subscribeLearningRunEvents("run-1", (e) => events.push(e), { lastEventId: 7 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    sub.close();
    const url = (fetchMock.mock.calls[0]?.[0] ?? "") as unknown as string;
    expect(url).toContain("/learning-runs/run-1/events?lastEventId=7");
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(5);
    expect(events[0].eventType).toBe("learning_run.started");
  });

  it("断线重连：记住 last sequence → 重新订阅只带 lastEventId", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      sseResponse(streamOf([ENC.encode("id:1\nevent:learning_run.started\ndata:{}\n\nid:2\nevent:learning_run.prepared\ndata:{}\n\n")])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first: LearningRunStreamEvent[] = [];
    const sub1 = await subscribeLearningRunEvents("run-1", (e) => first.push(e), {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    sub1.close();
    expect(first[first.length - 1]?.sequence).toBe(2);
    // 调用方（useLearningRun）以最后 sequence 重订
    const sub2 = await subscribeLearningRunEvents("run-1", () => {}, { lastEventId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    sub2.close();
    const url2 = (fetchMock.mock.calls[1]?.[0] ?? "") as unknown as string;
    expect(url2).toContain("?lastEventId=2");
  });

  it("HTTP 失败 → 抛错（调用方延迟重试）", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => sseResponse(streamOf([]), false, 500)));
    await expect(subscribeLearningRunEvents("run-1", () => {}, {})).rejects.toThrow(
      "learning run events stream failed: 500",
    );
  });

  it("close() → reader.cancel（流停止消费）", async () => {
    let cancelled = false;
    const fetchMock = vi.fn(async (_url: string) =>
      sseResponse(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(ENC.encode("id:1\nevent:x\ndata:{}\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sub = await subscribeLearningRunEvents("run-1", () => {}, {});
    sub.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
  });
});
