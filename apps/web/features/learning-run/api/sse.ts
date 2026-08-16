/**
 * LearningRun SSE 订阅（§13.1 GET /learning-runs/:runId/events）。
 *
 * EventSource 不支持 Authorization header，因此用 fetch stream 消费
 * text/event-stream，Last-Event-ID 重放（断线后从最后收到的 sequence 续订）。
 */

import { API_URL, getToken } from "@/lib/api";

export interface LearningRunStreamEvent {
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface LearningRunStreamSubscription {
  close: () => void;
}

/** 解析单个 SSE block（id/event/data 三字段）。 */
function parseSseBlock(block: string): LearningRunStreamEvent | null {
  let id = "";
  let eventType = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (id === "" || eventType === "") return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = data ? (JSON.parse(data) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  return {
    sequence: Number(id),
    eventType,
    payload,
    occurredAt: new Date().toISOString(),
  };
}

/** 解析一段 SSE 文本（id/event/data 三字段，空行分隔）。 */
export function parseSseChunk(buffer: string): LearningRunStreamEvent[] {
  const events: LearningRunStreamEvent[] = [];
  for (const block of buffer.split(/\n\n/)) {
    const event = parseSseBlock(block);
    if (event) events.push(event);
  }
  return events;
}

/**
 * 订阅 Run 事件流。断线由调用方重新订阅（本函数只提供单条流生命周期）；
 * onEvent 以 sequence 单调回调。
 */
export async function subscribeLearningRunEvents(
  runId: string,
  onEvent: (event: LearningRunStreamEvent) => void,
  options: { lastEventId?: number; signal?: AbortSignal } = {},
): Promise<LearningRunStreamSubscription> {
  const query = options.lastEventId && options.lastEventId > 0
    ? `?lastEventId=${options.lastEventId}`
    : "";
  const token = getToken();
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;

  // 同源订阅（next rewrite）。dev 下 rewrite 对 SSE 缓冲时流不实时——
  // useLearningRun 的 2s 快照轮询兜底（SSE 仅作加速，失败静默）。
  const response = await fetch(`${API_URL}/learning-runs/${encodeURIComponent(runId)}/events${query}`, {
    credentials: "include",
    headers,
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`learning run events stream failed: ${response.status}`);
  }
  let closed = false;
  const close = () => {
    closed = true;
    void reader.cancel().catch(() => {});
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // 增量解析：仅保留未完成块（tail），每块最多 split 一次并直接按块解析，
  // 避免对整段累计 buffer 反复 split/join/再 split 的 O(n^2) 开销。
  let tail = "";
  void (async () => {
    while (!closed) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      tail += decoder.decode(value, { stream: true });
      const blocks = tail.split(/\n\n/);
      tail = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event) onEvent(event);
      }
    }
    if (tail.trim().length > 0) {
      const event = parseSseBlock(tail);
      if (event) onEvent(event);
    }
  })();
  return { close };
}
