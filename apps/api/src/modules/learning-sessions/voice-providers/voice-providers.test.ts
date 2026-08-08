import { test } from "node:test";
import assert from "node:assert/strict";
import { siliconFlowTranscribe, SiliconFlowAsrError } from "./siliconflow-asr.js";
import { edgeTtsSynthesize, EdgeTtsError } from "./edge-tts.js";
import {
  openAiCompatibleAsr,
  openAiCompatibleTts,
  OpenAiCompatibleError,
} from "./openai-compatible.js";
import {
  createAsrProvider,
  createTtsProvider,
} from "./index.js";

// ─── mock fetch 工具 ─────────────────────────────────────────────────────

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bytesResponse(bytes: Uint8Array, contentType = "audio/mpeg", status = 200): Response {
  return new Response(bytes as BodyInit, { status, headers: { "content-type": contentType } });
}

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

// ─── SiliconFlow ASR ─────────────────────────────────────────────────────

test("siliconFlowTranscribe：真实请求形状（multipart + Bearer + model）并解析 text", async () => {
  let captured: { url: string; headers?: Record<string, string>; body?: Uint8Array } | undefined;
  const fetchImpl = mockFetch(async (url, init) => {
    captured = {
      url,
      headers: init.headers as Record<string, string>,
      body: init.body instanceof Uint8Array ? (init.body as Uint8Array) : undefined,
    };
    return jsonResponse({ text: "测试语音。" });
  });
  const result = await siliconFlowTranscribe(MP3_BYTES, "test.mp3", {
    apiKey: "sk-test",
    fetchImpl,
  });
  assert.equal(result.text, "测试语音。");
  assert.equal(captured?.url, "https://api.siliconflow.cn/v1/audio/transcriptions");
  assert.equal(captured?.headers?.Authorization, "Bearer sk-test");
  assert.match(captured?.headers?.["Content-Type"] ?? "", /multipart\/form-data; boundary=/);
  assert.ok((captured?.body?.length ?? 0) > 0, "body 包含 multipart 字段");
});

test("siliconFlowTranscribe：缺 API key → fail closed", async () => {
  await assert.rejects(
    () => siliconFlowTranscribe(MP3_BYTES, "a.mp3", { apiKey: "", fetchImpl: mockFetch(async () => jsonResponse({})) }),
    (err: unknown) => err instanceof SiliconFlowAsrError && (err as SiliconFlowAsrError).code === "MISSING_API_KEY",
  );
});

test("siliconFlowTranscribe：上游非 2xx → UPSTREAM_ERROR", async () => {
  await assert.rejects(
    () =>
      siliconFlowTranscribe(MP3_BYTES, "a.mp3", {
        apiKey: "sk",
        fetchImpl: mockFetch(async () => new Response("boom", { status: 500 })),
      }),
    (err: unknown) => err instanceof SiliconFlowAsrError && (err as SiliconFlowAsrError).code === "UPSTREAM_ERROR",
  );
});

test("siliconFlowTranscribe：空 transcript → fail closed", async () => {
  await assert.rejects(
    () =>
      siliconFlowTranscribe(MP3_BYTES, "a.mp3", {
        apiKey: "sk",
        fetchImpl: mockFetch(async () => jsonResponse({ text: "" })),
      }),
    (err: unknown) => err instanceof SiliconFlowAsrError && (err as SiliconFlowAsrError).code === "EMPTY_TRANSCRIPT",
  );
});

// ─── edge-tts（Docker 容器） ─────────────────────────────────────────────

test("edgeTtsSynthesize：调用容器 /v1/audio/speech（OpenAI 协议）并返回 mp3", async () => {
  let captured: { url: string; body?: string } | undefined;
  const fetchImpl = mockFetch(async (url, init) => {
    captured = { url, body: typeof init.body === "string" ? init.body : undefined };
    return bytesResponse(MP3_BYTES);
  });
  const result = await edgeTtsSynthesize("你好", "zh-CN-XiaoxiaoNeural", {
    baseUrl: "http://edge-tts:8080",
    fetchImpl,
  });
  assert.equal(result.audio.length, MP3_BYTES.length);
  assert.equal(captured?.url, "http://edge-tts:8080/v1/audio/speech");
  assert.ok(captured?.body?.includes('"input":"你好"'), "body 含 input");
  assert.ok(captured?.body?.includes('"voice":"zh-CN-XiaoxiaoNeural"'), "body 含 voice");
});

test("edgeTtsSynthesize：baseUrl 尾斜杠 strip + authToken 鉴权头", async () => {
  let captured: { url: string; headers?: Record<string, string> } | undefined;
  const fetchImpl = mockFetch(async (url, init) => {
    captured = { url, headers: init.headers as Record<string, string> };
    return bytesResponse(MP3_BYTES);
  });
  await edgeTtsSynthesize("你好", "zh-CN-XiaoxiaoNeural", {
    baseUrl: "http://edge-tts:8080/", // 尾斜杠应被 strip
    authToken: "secret-token",
    fetchImpl,
  });
  assert.equal(captured?.url, "http://edge-tts:8080/v1/audio/speech", "尾斜杠已 strip，无 //v1 双斜杠");
  assert.equal(captured?.headers?.["X-Edge-TTS-Token"], "secret-token", "authToken 鉴权头发送");
});

test("edgeTtsSynthesize：空文本 → fail closed", async () => {
  await assert.rejects(
    () => edgeTtsSynthesize("", "zh-CN-XiaoxiaoNeural", { fetchImpl: mockFetch(async () => bytesResponse(MP3_BYTES)) }),
    (err: unknown) => err instanceof EdgeTtsError && (err as EdgeTtsError).code === "INVALID_ARGUMENT",
  );
});

// ─── OpenAI 协议兼容层 ───────────────────────────────────────────────────

test("openAiCompatibleAsr：自定义 OpenAI 协议 ASR 服务", async () => {
  const fetchImpl = mockFetch(async (url, init) => {
    assert.equal(url, "https://my-asr.example/v1/audio/transcriptions");
    assert.match((init.headers as Record<string, string>)["Authorization"] ?? "", /^Bearer /);
    return jsonResponse({ text: "自定义模型识别结果" });
  });
  const result = await openAiCompatibleAsr(MP3_BYTES, "a.mp3", {
    baseUrl: "https://my-asr.example",
    apiKey: "sk-custom",
    model: "custom-asr-v1",
    fetchImpl,
  });
  assert.equal(result.text, "自定义模型识别结果");
  assert.equal(result.model, "custom-asr-v1");
});

test("openAiCompatibleTts：自定义 OpenAI 协议 TTS 服务（返回 audio/mpeg）", async () => {
  const fetchImpl = mockFetch(async (url, _init) => {
    assert.equal(url, "https://my-tts.example/v1/audio/speech");
    return bytesResponse(MP3_BYTES, "audio/mpeg");
  });
  const result = await openAiCompatibleTts("你好", {
    baseUrl: "https://my-tts.example",
    model: "custom-tts-v1",
    voice: "voice-a",
    fetchImpl,
  });
  assert.equal(result.audio.length, MP3_BYTES.length);
  assert.equal(result.model, "custom-tts-v1");
  assert.equal(result.voice, "voice-a");
});

test("openAiCompatible：缺 baseUrl → fail closed", async () => {
  await assert.rejects(
    () => openAiCompatibleAsr(MP3_BYTES, "a.mp3", {}),
    (err: unknown) =>
      err instanceof OpenAiCompatibleError && (err as OpenAiCompatibleError).code === "MISSING_BASE_URL",
  );
  await assert.rejects(
    () => openAiCompatibleTts("hi", {}),
    (err: unknown) =>
      err instanceof OpenAiCompatibleError && (err as OpenAiCompatibleError).code === "MISSING_BASE_URL",
  );
});

// ─── 工厂（适配为 voice-service 接口） ───────────────────────────────────

test("createTtsProvider：edge_tts 默认 → 真调用，voice 用 env.ttsVoice 而非 voiceProfile", async () => {
  let captured: { url: string; body?: string } | undefined;
  const fetchImpl = mockFetch(async (url, init) => {
    captured = { url, body: typeof init.body === "string" ? init.body : undefined };
    return bytesResponse(MP3_BYTES);
  });
  const sinkCalls: Array<{ audio: Uint8Array; contentType: string }> = [];
  const tts = createTtsProvider(
    { ttsProvider: "edge_tts", edgeTtsBaseUrl: "http://edge-tts:8080", ttsVoice: "zh-CN-YunxiNeural", fetchImpl },
    async (audio, contentType, _request) => {
      sinkCalls.push({ audio, contentType });
      return { audioRef: "ref-1", audioHash: "hash-1", expiresAt: "2026-08-09T00:00:00Z" };
    },
  );
  const result = await tts.synthesize({
    text: "你好",
    voiceProfile: "companion-default-v1", // 内部 profile id，不应直传为 voice
    language: "zh-CN",
    requestId: "req-1",
  });
  assert.equal(result.audioRef, "ref-1");
  assert.equal(captured?.url, "http://edge-tts:8080/v1/audio/speech");
  assert.ok(captured?.body?.includes('"voice":"zh-CN-YunxiNeural"'), "voice 取 env.ttsVoice 而非 voiceProfile");
  assert.equal(captured?.body?.includes("companion-default-v1"), false, "voiceProfile 不得直传");
  assert.equal(sinkCalls.length, 1);
});

test("createAsrProvider：siliconflow 默认 → 真调用解析 audio 并产出结果", async () => {
  const fetchImpl = mockFetch(async (url, init) => {
    assert.equal(url, "https://api.siliconflow.cn/v1/audio/transcriptions");
    assert.match((init.headers as Record<string, string>)["Authorization"] ?? "", /^Bearer sk-/);
    return jsonResponse({ text: "测试语音。" });
  });
  const asr = createAsrProvider(
    { asrProvider: "siliconflow", asrApiKey: "sk-test", fetchImpl },
    async () => ({ buffer: MP3_BYTES, filename: "rec.mp3" }),
  );
  const result = await asr.transcribe({
    audioRef: "ref-1",
    audioHash: "hash-1",
    language: "zh-CN",
    requestId: "req-1",
  });
  assert.equal(result.transcript, "测试语音。");
  assert.equal(result.asrProvider, "siliconflow");
  assert.equal(result.asrModel, "FunAudioLLM/SenseVoiceSmall");
});
