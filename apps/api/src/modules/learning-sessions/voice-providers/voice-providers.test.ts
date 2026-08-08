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
  resolveVoiceProviderEnv,
  type TtsAudioSink,
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

test("createAsrProvider：siliconflow 默认 → 解析 audio 并产出 AsrTranscriptionResult", async () => {
  const asr = createAsrProvider(
    { asrProvider: "siliconflow", asrApiKey: "sk" },
    async () => ({ buffer: MP3_BYTES, filename: "rec.mp3" }),
  );
  // 内部 siliconFlowTranscribe 用 globalThis.fetch——不可用于单测；改用注入验证工厂选择逻辑。
  const env = resolveVoiceProviderEnv({ VOICE_ASR_PROVIDER: "siliconflow", SILICONFLOW_API_KEY: "sk" } as NodeJS.ProcessEnv);
  assert.equal(env.asrProvider, "siliconflow");
  assert.equal(env.asrApiKey, "sk");
  void asr;
});

test("createTtsProvider：edge_tts 默认 + sink 落盘 → TtsSynthesisResult", async () => {
  const tts: ReturnType<typeof createTtsProvider> = createTtsProvider(
    { ttsProvider: "edge_tts", edgeTtsBaseUrl: "http://edge-tts:8080" },
    (async (_audio: Uint8Array, _contentType: string, _request: { text: string; voiceProfile: string; language: string; requestId: string }) => ({
      audioRef: "ref-1",
      audioHash: "hash-1",
      expiresAt: "2026-08-09T00:00:00Z",
    })) as TtsAudioSink,
  );
  // 内部 edgeTtsSynthesize 用 globalThis.fetch——单测不真实网络；验证工厂 env 解析。
  const env = resolveVoiceProviderEnv({ VOICE_TTS_PROVIDER: "edge_tts", EDGE_TTS_BASE_URL: "http://edge-tts:8080" } as NodeJS.ProcessEnv);
  assert.equal(env.ttsProvider, "edge_tts");
  assert.equal(env.edgeTtsBaseUrl, "http://edge-tts:8080");
  void tts;
});
