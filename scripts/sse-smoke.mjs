#!/usr/bin/env node
/**
 * SSE 并发冒烟脚本（方案 16 遗留 #1 收敛工具）。
 *
 * 用法：
 *   SSE_BASE_URL=http://localhost:4000 \
 *   SSE_COOKIE="ailearn_session=..." \
 *   SSE_RUN_ID=<run-uuid> \
 *   SSE_CONCURRENCY=10 \
 *   SSE_DURATION_MS=10000 \
 *   node scripts/sse-smoke.mjs
 *
 * 只读流：不会创建/修改任何数据；用于观察断开/重连/写失败是否冒泡为 500。
 */

const BASE_URL = process.env.SSE_BASE_URL ?? "http://localhost:4000";
const COOKIE = process.env.SSE_COOKIE ?? "";
const RUN_ID = process.env.SSE_RUN_ID ?? "";
const CONCURRENCY = Number(process.env.SSE_CONCURRENCY ?? 5);
const DURATION_MS = Number(process.env.SSE_DURATION_MS ?? 10_000);

if (!RUN_ID) {
  console.error("SSE_RUN_ID is required");
  process.exit(1);
}

const url = `${BASE_URL}/api/learning-runs/${encodeURIComponent(RUN_ID)}/events`;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), DURATION_MS);
timer.unref?.();

async function oneConnection(index) {
  const started = Date.now();
  let events = 0;
  let chunks = 0;
  let error = null;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/event-stream",
        ...(COOKIE ? { Cookie: COOKIE } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      error = `HTTP ${res.status}`;
      return { index, started, events, chunks, error, ok: false };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      const text = decoder.decode(value, { stream: true });
      events += (text.match(/^event:/gm) ?? []).length;
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      // 正常结束
    } else {
      error = err?.message ?? String(err);
    }
  }
  return {
    index,
    started,
    durationMs: Date.now() - started,
    events,
    chunks,
    error,
    ok: !error,
  };
}

const results = await Promise.all(
  Array.from({ length: CONCURRENCY }, (_, i) => oneConnection(i)),
);

const ok = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify(
    {
      url,
      concurrency: CONCURRENCY,
      durationMs: DURATION_MS,
      ok,
      failed: failed.length,
      totalEvents: results.reduce((s, r) => s + r.events, 0),
      totalChunks: results.reduce((s, r) => s + r.chunks, 0),
      failures: failed.map((r) => ({ index: r.index, error: r.error })),
    },
    null,
    2,
  ),
);
