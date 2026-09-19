/**
 * §8.2 真实流式测试：OpenAICompatibleProvider.chatCompletionStream 的 SSE
 * 解析（delta 顺序 / [DONE] / abort / HTTP 错误 / 空输出），以及
 * MockProvider.chatCompletionStream 的分片拼接与 abort 中断。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OpenAICompatibleProvider,
} from "../lib/providers/openai-compatible.ts";
import type { PublicJsonRequester, PublicStreamingRequester } from "@ailearn/shared/public-json-http";
import { MockProvider } from "../lib/providers/mock.ts";
import { ProviderRequestError } from "../lib/provider-request-error.ts";

/** 测试专用：把 globalThis.fetch（被 withFetchMock 替换）包成非流式 requester。 */
function fetchJsonRequester(): PublicJsonRequester {
  return async (url, headers, body, signal) => {
    const response = await globalThis.fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      body: text ? JSON.parse(text) : null,
    };
  };
}

function fetchStreamingRequester(): PublicStreamingRequester {
  return async (url, headers, body, signal) => {
    const response = await globalThis.fetch(url, {
      method: "POST",
      headers: { ...headers },
      body: JSON.stringify(body),
      signal,
    });
    const responseStream = response.body;
    if (!responseStream) {
      throw new Error("mock streaming response has no body");
    }
    const readable = responseStream as ReadableStream<Uint8Array>;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      const reader = readable.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    return {
      status: response.status,
      statusText: response.statusText,
      body: chunks(),
      cancel: () => { void readable.cancel().catch(() => undefined); },
    };
  };
}

function makeProvider(
  request?: ConstructorParameters<typeof OpenAICompatibleProvider>[0]["request"],
  streamRequest?: PublicStreamingRequester,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    ...(request ? { request } : {}),
    ...(streamRequest ? { streamRequest } : {}),
  });
}

/** 在 fetch mock 生效期间执行 fn，结束后还原全局 fetch。 */
async function withFetchMock(fetchImpl: typeof globalThis.fetch, fn: () => Promise<unknown>): Promise<void> {
  const prev = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function sseLine(payload: string): string {
  return `data: ${payload}\n\n`;
}

const CHAT_MESSAGES = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }];

test("chatCompletionStream：SSE delta 按序回调并拼接还原全文", async () => {
  await withFetchMock(async (url, init) => {
    assert.equal(String(url), "https://example.test/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true, "stream: true 必须发送");
    assert.equal(body.response_format.type, "json_object", "默认调用保持结构化 JSON 兼容性");
    return sseResponse([
      sseLine(JSON.stringify({ choices: [{ delta: { content: "你好" } }] })),
      sseLine(JSON.stringify({ choices: [{ delta: { content: "，" } }] })),
      sseLine(JSON.stringify({ choices: [{ delta: { content: "世界" } }] })),
      "data: [DONE]\n\n",
    ]);
  }, async () => {
    const deltas: string[] = [];
    const result = await makeProvider(undefined, fetchStreamingRequester())
      .chatCompletionStream(CHAT_MESSAGES, {}, undefined, (d) => deltas.push(d));
    assert.equal(result.content, "你好，世界");
    assert.deepEqual(deltas, ["你好", "，", "世界"]);
  });
});

test("chatCompletionStream：responseFormat=text 不强制 JSON mode", async () => {
  await withFetchMock(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal("response_format" in body, false);
    return sseResponse([
      sseLine(JSON.stringify({ choices: [{ delta: { content: "自然语言" } }] })),
      "data: [DONE]\n\n",
    ]);
  }, async () => {
    const result = await makeProvider(undefined, fetchStreamingRequester()).chatCompletionStream(
      CHAT_MESSAGES,
      { responseFormat: "text" },
      undefined,
      () => undefined,
    );
    assert.equal(result.content, "自然语言");
  });
});

test("chatCompletionStream（④-b）：发出 tools/tool_choice，并把分片 tool_calls 归并成完整调用", async () => {
  // 带工具的一步走流式的前提：**工具定义要发出去**（否则模型永远不返回 tool_calls），
  // 且 `delta.tool_calls` 是按 index 分片到达的——`arguments` 必须拼完整串再解析。
  await withFetchMock(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].function.name, "companion_open_review");
    assert.equal(body.tool_choice, "auto");
    assert.equal("response_format" in body, false, "带工具的一步同样不强制 JSON mode");
    return sseResponse([
      sseLine(JSON.stringify({ choices: [{ delta: { content: "好，这就带你过去。" } }] })),
      sseLine(JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "companion_open_review", arguments: "{\"card" } }] } }],
      })),
      sseLine(JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "Id\": \"abc\"}" } }] }, finish_reason: "tool_calls" }],
      })),
      "data: [DONE]\n\n",
    ]);
  }, async () => {
    const deltas: string[] = [];
    const result = await makeProvider(undefined, fetchStreamingRequester()).chatCompletionStream(
      CHAT_MESSAGES,
      {
        responseFormat: "text",
        tools: [{
          name: "companion_open_review",
          description: "打开复习页面。",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        }],
      },
      undefined,
      (d) => deltas.push(d),
    );
    assert.equal(result.content, "好，这就带你过去。");
    assert.deepEqual(deltas, ["好，这就带你过去。"]);
    assert.deepEqual(result.toolCalls, [
      { id: "call_1", name: "companion_open_review", arguments: { cardId: "abc" } },
    ]);
    assert.equal(result.finishReason, "tool_calls");
  });
});

test("chatCompletionStream（④-b）：只回 tool_calls、一个字都不说的那一步不算空输出", async () => {
  // 旧判据只看 `content`，于是"模型决定直接发起调用"的那一步会被误判成
  // stream_empty 并抛错 → 白白退化成整段取回（那一步就永远不流式）。
  await withFetchMock(async () => sseResponse([
    sseLine(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "companion_read_context", arguments: "{}" } }] } }],
    })),
    "data: [DONE]\n\n",
  ]), async () => {
    const result = await makeProvider(undefined, fetchStreamingRequester()).chatCompletionStream(
      CHAT_MESSAGES,
      { responseFormat: "text" },
      undefined,
      () => undefined,
    );
    assert.equal(result.content, "");
    assert.deepEqual(result.toolCalls, [
      { id: "call_9", name: "companion_read_context", arguments: {} },
    ]);
  });
});

test("chatCompletionStream（④-b）：arguments 是坏 JSON 时不当作「空参数成功调用」", async () => {
  // 截断/损坏的调用必须留下可见痕迹：arguments 保持空对象，由上层 schema 校验
  // 拒绝并记审计——绝不静默执行一个模型没真正提出的调用。
  await withFetchMock(async () => sseResponse([
    sseLine(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_bad", function: { name: "companion_open_card", arguments: "{\"cardId\":" } }] } }],
    })),
    "data: [DONE]\n\n",
  ]), async () => {
    const result = await makeProvider(undefined, fetchStreamingRequester()).chatCompletionStream(
      CHAT_MESSAGES,
      { responseFormat: "text" },
      undefined,
      () => undefined,
    );
    assert.deepEqual(result.toolCalls, [
      { id: "call_bad", name: "companion_open_card", arguments: {} },
    ]);
  });
});

test("chatCompletion：responseFormat=text 在非流式 fallback 也不强制 JSON mode", async () => {
  await withFetchMock(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, false);
    assert.equal("response_format" in body, false);
    return new Response(JSON.stringify({ choices: [{ message: { content: "非流式文本" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }, async () => {
    const result = await makeProvider(fetchJsonRequester())
      .chatCompletion(CHAT_MESSAGES, { responseFormat: "text" });
    assert.equal(result.content, "非流式文本");
  });
});

test("chatCompletionStream：忽略空 delta 与无法解析的 SSE 行", async () => {
  await withFetchMock(async () => sseResponse([
    sseLine(JSON.stringify({ choices: [{ delta: { content: "" } }] })),
    ": heartbeat comment\n\n",
    "data: not-json\n\n",
    sseLine(JSON.stringify({ choices: [{ delta: { content: "ok" } }] })),
    "data: [DONE]\n\n",
  ]), async () => {
    const deltas: string[] = [];
    const result = await makeProvider(undefined, fetchStreamingRequester())
      .chatCompletionStream(CHAT_MESSAGES, {}, undefined, (d) => deltas.push(d));
    assert.equal(result.content, "ok");
    assert.deepEqual(deltas, ["ok"]);
  });
});

test("chatCompletionStream：网关无 [DONE] 且最后一行无换行时仍保留末尾 delta", async () => {
  await withFetchMock(async () => sseResponse([
    sseLine(JSON.stringify({ choices: [{ delta: { content: "前半" } }] })),
    `data: ${JSON.stringify({ choices: [{ delta: { content: "后半" } }] })}`,
  ]), async () => {
    const deltas: string[] = [];
    const result = await makeProvider(undefined, fetchStreamingRequester())
      .chatCompletionStream(CHAT_MESSAGES, {}, undefined, (d) => deltas.push(d));
    assert.equal(result.content, "前半后半");
    assert.deepEqual(deltas, ["前半", "后半"]);
  });
});

test("chatCompletionStream：abort 中断流式读取并抛 abortError", async () => {
  const controller = new AbortController();
  await withFetchMock(async (_url, init) => {
    const signal = init?.signal as AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sseLine(JSON.stringify({ choices: [{ delta: { content: "半句" } }] }))));
        // 挂起：不 close，等待 abort
        signal?.addEventListener("abort", () => c.error(signal.reason));
      },
    });
    return new Response(stream, { status: 200 });
  }, async () => {
    const deltas: string[] = [];
    const pending = makeProvider(undefined, fetchStreamingRequester())
      .chatCompletionStream(CHAT_MESSAGES, {}, controller.signal, (d) => deltas.push(d));
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    await assert.rejects(() => pending, /aborted|cancelled/);
    assert.deepEqual(deltas, ["半句"]);
  });
});

test("chatCompletionStream：HTTP 非 2xx 抛 ProviderRequestError", async () => {
  await withFetchMock(async () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  }), async () => {
    await assert.rejects(
      () => makeProvider(undefined, fetchStreamingRequester())
        .chatCompletionStream(CHAT_MESSAGES, {}, undefined, () => undefined),
      (err: unknown) => err instanceof ProviderRequestError && err.status === 429,
    );
  });
});

test("chatCompletionStream：空输出抛错（fail closed）", async () => {
  await withFetchMock(async () => sseResponse(["data: [DONE]\n\n"]), async () => {
    await assert.rejects(
      () => makeProvider(undefined, fetchStreamingRequester())
        .chatCompletionStream(CHAT_MESSAGES, {}, undefined, () => undefined),
      /empty streaming output/,
    );
  });
});

test("MockProvider.chatCompletionStream：分片回调、拼接还原全文", async () => {
  const deltas: string[] = [];
  const mock = new MockProvider();
  const result = await mock.chatCompletionStream(CHAT_MESSAGES, {}, undefined, (d) => deltas.push(d));
  assert.ok(result.content.length > 0, "mock 有输出");
  assert.equal(deltas.join(""), result.content, "分片拼接还原全文");
  assert.ok(deltas.length > 1, "mock 流式产生多个分片");
  for (const d of deltas) assert.ok(d.length > 0, "分片非空");
});

test("MockProvider.chatCompletionStream：abort 后抛错（fail closed）", async () => {
  const controller = new AbortController();
  const mock = new MockProvider();
  const pending = mock.chatCompletionStream(CHAT_MESSAGES, {}, controller.signal, () => undefined);
  setTimeout(() => controller.abort(new Error("stopped")), 3);
  await assert.rejects(() => pending, /aborted/);
});
