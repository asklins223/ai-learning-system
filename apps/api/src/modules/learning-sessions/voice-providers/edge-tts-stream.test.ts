/**
 * P6 §13：edgeTtsSynthesizeStream 透传测试（不 arrayBuffer 全量缓冲）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  edgeTtsSynthesize,
  edgeTtsSynthesizeStream,
  EdgeTtsError,
} from "./edge-tts.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

test("edgeTtsSynthesizeStream：透传 chunked body（分块读取，不 arrayBuffer）", async () => {
  const fetchImpl = async () =>
    new Response(streamOf(["AAAA", "BBBB", "CCCC"]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  const result = await edgeTtsSynthesizeStream("你好", "zh-CN-XiaoxiaoNeural", { fetchImpl });
  assert.equal(result.contentType, "audio/mpeg");
  const reader = result.stream.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  assert.equal(out, "AAAABBBBCCCC");
});

test("edgeTtsSynthesizeStream：请求打到 /v1/audio/speech/stream + token 头", async () => {
  let seenUrl = "";
  let seenToken = "";
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenToken = (init?.headers as Record<string, string>)?.["X-Edge-TTS-Token"] ?? "";
    return new Response(streamOf(["X"]), { status: 200 });
  };
  await edgeTtsSynthesizeStream("你好", "v", {
    baseUrl: "http://edge-tts:8080",
    authToken: "tok-1",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.ok(seenUrl.endsWith("/v1/audio/speech/stream"), seenUrl);
  assert.equal(seenToken, "tok-1");
});

test("edgeTtsSynthesizeStream：上游非 2xx → UPSTREAM_ERROR（fail closed）", async () => {
  const fetchImpl = async () => new Response("bad", { status: 400 });
  await assert.rejects(
    edgeTtsSynthesizeStream("你好", "v", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    (err: Error) => err instanceof EdgeTtsError && err.code === "UPSTREAM_ERROR",
  );
});

test("edgeTtsSynthesizeStream：空文本 → INVALID_ARGUMENT", async () => {
  await assert.rejects(
    edgeTtsSynthesizeStream("", "v", {}),
    (err: Error) => err instanceof EdgeTtsError && err.code === "INVALID_ARGUMENT",
  );
});

test("edgeTtsSynthesizeStream：无响应体 → EMPTY_AUDIO（fail closed）", async () => {
  const fetchImpl = async () => new Response(null, { status: 200 });
  await assert.rejects(
    edgeTtsSynthesizeStream("你好", "v", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    (err: Error) => err instanceof EdgeTtsError && err.code === "EMPTY_AUDIO",
  );
});

test("edgeTtsSynthesize 仍全量返回（兼容既有非流式路径）", async () => {
  const fetchImpl = async () =>
    new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  const result = await edgeTtsSynthesize("你好", "v", { fetchImpl: fetchImpl as unknown as typeof fetch });
  assert.equal(result.audio.length, 3);
});
